/**
 * Gateway orchestration: whitelisted Feishu messages are routed to command
 * handling, approval answers, or the duty session; watch-mode transitions and
 * the global approval answerer live here. The control flow mirrors the
 * dsh-telegram-duty gateway one-to-one; the Feishu deltas are: events arrive
 * over the WebSocket long connection (no poller), buttons are card actions
 * whose toast doubles as the callback answer, and every edited message is a
 * card (Feishu cannot edit plain messages in place).
 * @module @nameshouldbelong/dsh-feishu-duty/gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CompatScope as SettingsScope } from './settings-compat.js'
import { readCrossNamespace, writeCrossNamespace } from './settings-compat.js'
import type { FeishuDutyConfig } from './config.ts'
import type { InlineKeyboard, FeishuCardAction, FeishuIncomingMessage, FeishuClient, CardActionResponse } from './feishu.ts'
import { extractText } from './feishu.ts'
import { createThrottle, formatProgress, type ProgressPhase } from './progress.ts'

interface SentinelTurnTracker {
  stepCount: number
  messageId?: string
  throttle: (fn: () => void) => void
  lastPhase?: ProgressPhase
  lastToolName?: string
  lastAssistantText: string
  sessionTitle?: string
}
import { DutySession } from './duty.ts'
import { ApprovalManager, parseApprovalCallback, parseApprovalReply } from './approval.ts'
import { FeishuAskManager, parseAskCallback } from './ask.ts'
import type { FeishuAskOutcome } from './ask.ts'
import { chunkText, parseCommand } from './router.ts'
import { resolveTargetSessionId, resolveAttachmentTarget } from './routing.ts'
import { stringsFor } from './i18n.ts'
import { markdownToLarkMd } from './rich-text.ts'
import type { Strings } from './i18n.ts'
import { describeAttachment, inboxFileName, attachmentNotice } from './media.ts'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseLocalCommand, CommandRegistry, registerCommands } from './local-commands.ts'
import { SessionRegistry, ModelRegistry, PermissionRegistry, PresetRegistry } from './registries.ts'
import { wizardStart, wizardCallback, wizardText, wizardCancel, decodeWizardCallback, type WizardState, type WizardAction } from './wizard.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { classifyDutyError } from './error-advice.ts'

export interface GatewayDeps {
  ctx: Context
  runtime: FeishuDutyConfig
  client: FeishuClient
  settings: SettingsScope<FeishuDutyConfig>
  stateOn: SettingsScope<{ n?: number }>
  stateOff: SettingsScope<{ n?: number }>
}

/** All gateway state for one plugin run. */
export class Gateway {
  private readonly ctx: Context
  private readonly runtime: FeishuDutyConfig
  private readonly client: FeishuClient
  private readonly settings: SettingsScope<FeishuDutyConfig>
  private readonly stateOn: SettingsScope<{ n?: number }>
  private readonly stateOff: SettingsScope<{ n?: number }>
  private readonly duty: DutySession
  private readonly approvals: ApprovalManager
  private readonly asks: FeishuAskManager
  private readonly strings: Strings
  private readonly inflight = new Set<Promise<void>>()
  private mode: 'local' | 'duty'
  /** v0.6.0: 本地命令层注册表与数据注册表 */
  private readonly commandRegistry = new CommandRegistry()
  private readonly sentinelTurns = new Map<string, SentinelTurnTracker>()
  private readonly sessionRegistry: SessionRegistry
  private readonly modelRegistry: ModelRegistry
  private readonly permissionRegistry: PermissionRegistry
  private readonly presetRegistry: PresetRegistry
  /** v0.6.0: /new 向导与 awaitingInput 状态（同 chat 单例） */
  private wizardState: WizardState | undefined
  private wizardLists: Record<string, any[]> = {}
  private wizardMessageId: string | undefined
  private awaitingInput: { kind: 'ask-custom' | 'wizard-cwd' | 'wizard-name'; id: number } | undefined
  /** v0.6.0: /delete 待确认的 session id */
  private pendingDeleteId: string | undefined

  constructor(deps: GatewayDeps) {
    this.ctx = deps.ctx
    this.runtime = deps.runtime
    this.client = deps.client
    this.settings = deps.settings
    this.stateOn = deps.stateOn
    this.stateOff = deps.stateOff
    this.mode = deps.settings.get().watchMode ?? 'local'
    this.strings = stringsFor(deps.settings.get().language ?? 'en')
    this.duty = new DutySession(deps.ctx, {
      sessionId: deps.runtime.sessionId ?? 'feishu-duty',
      cwd: deps.runtime.dutyCwd ?? process.cwd(),
      persona: this.strings.dutyPersona,
      client: deps.client,
      receiveId: deps.runtime.receiveId,
      receiveIdType: deps.runtime.receiveIdType,
      language: deps.settings.get().language ?? 'en',
      runtime: deps.runtime
    })
    // v0.6.0: 数据注册表（冷启动后异步填充，供本地命令与 /new 向导点选）
    this.sessionRegistry = new SessionRegistry(this.ctx)
    this.modelRegistry = new ModelRegistry(this.ctx)
    this.permissionRegistry = new PermissionRegistry(this.ctx)
    this.presetRegistry = new PresetRegistry(this.ctx)
    registerCommands(this.commandRegistry, {
      ctx: this.ctx,
      sessionRegistry: this.sessionRegistry,
      modelRegistry: this.modelRegistry,
      permissionRegistry: this.permissionRegistry,
      presetRegistry: this.presetRegistry,
      strings: this.strings,
      setTargetSessionId: async (id: string) => { await this.setTargetSessionId(id) },
    })
    // session 变化 → 注册表标脏（TTL 兜底在 fetch 内）
    try {
      this.ctx.on('session/event', () => { this.sessionRegistry.markDirty() })
    } catch { /* 事件不可用时仅靠 TTL */ }
    const editMarkup = async (messageId: string, keyboard: InlineKeyboard, text?: string): Promise<void> => {
      try {
        if (text !== undefined) {
          await this.client.editMessageText(this.receiveId(), messageId, text, { keyboard })
        } else {
          await this.client.editMessageReplyMarkup(messageId, keyboard)
        }
      } catch { /* 消息过旧等场景忽略 */ }
    }
    this.approvals = new ApprovalManager({
      timeoutMs: (deps.runtime.approvalTimeoutMinutes ?? 10) * 60_000,
      strings: this.strings,
      send: (text, keyboard) => this.sendChunked(text, keyboard),
      editMarkup,
      log: (message) => this.ctx.logger.warn('feishu-duty', message),
    })
    this.asks = new FeishuAskManager({
      timeoutMs: (deps.runtime.approvalTimeoutMinutes ?? 10) * 60_000,
      strings: this.strings,
      send: (text, keyboard) => this.sendChunked(text, keyboard),
      editMarkup,
      customVocabulary: ['自行输入', '自定义', '其他', '手动输入', '自己输入', 'other', 'custom', 'manual'],
      onAwaitingInput: (id) => { this.awaitingInput = { kind: 'ask-custom', id } },
      log: (message) => this.ctx.logger.warn('feishu-duty', message),
    })
    this.settings.watch((next) => {
      this.mode = next.watchMode ?? 'local'
    })
  }

  /** Run one message handler fire-and-forget, containing its failures. */
  private spawn(task: () => Promise<void>): void {
    const run = task().catch((error: unknown) => {
      this.ctx.logger.warn('feishu-duty', `message handler failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.inflight.add(run)
    void run.finally(() => {
      this.inflight.delete(run)
    })
  }

  start(): void {
    this.client.start({
      onMessage: (message) => {
        this.spawn(() => this.handleFeishuMessage(message))
      },
      onCardAction: (action) => this.handleCardAction(action),
    })
    void this.refreshStateMarker()
  }

  /**
   * Publish the current mode through the marker namespace whose name the
   * browser half reads from the forwarded settings event.
   */
  async refreshStateMarker(): Promise<void> {
    await this.pushStateMarker(this.mode)
  }

  /** feishu_ask tool body: push a question to Feishu and wait. */
  async askUser(question: string, options: string[], signal?: AbortSignal): Promise<FeishuAskOutcome> {
    return await this.asks.ask({
      question,
      options,
      ...(signal !== undefined ? { signal } : {}),
    })
  }

  /** Command body: switch duty back to local (and notify Feishu). */
  async switchToLocal(): Promise<void> {
    await this.setMode('local', true)
  }

  async sendFileToUser(fileAbsPath: string, caption?: string): Promise<void> {
    if (this.runtime.mediaEnabled !== false) {
      const res = await this.client.sendDocument(this.receiveId(), fileAbsPath, caption, { receiveIdType: this.runtime.receiveIdType })
      if (!res.ok) throw new Error(res.description ?? 'feishu sendDocument failed')
    }
  }

  private async pushStateMarker(mode: 'local' | 'duty'): Promise<void> {
    const scope = mode === 'duty' ? this.stateOn : this.stateOff
    try {
      await scope.update({ n: Date.now() })
    } catch (error) {
      this.ctx.logger.warn('feishu-duty', `state marker write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async stop(): Promise<void> {
    this.approvals.cancelAll()
    this.asks.cancelAll()
    // Let in-flight message handlers settle (a cancelled approval unwinds
    // the blocked duty turn) before tearing the client down.
    await Promise.allSettled([...this.inflight])
    for (const tracker of this.sentinelTurns.values()) {
      // Feishu has no typing chat action to clear; progress cards settle on
      // their own turn/end handler below.
      void tracker
    }
    this.sentinelTurns.clear()
    this.client.stop()
  }

  /** approval/request answerer: take over while on duty, else defer to web. */
  onApprovalRequest = async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> => {
    if (this.mode !== 'duty') return await next()
    return await this.approvals.ask({
      toolName: req.toolName,
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    })
  }

  /** session/event hook: monitor Sentinel turns and web UI user mode shifts. */
  onSessionEvent = async (session: Session, event: SessionEvent): Promise<void> => {
    const sessionId = String(session.id)

    // 1. Detect Sentinel prompt injection
    if (event.type === 'user/message') {
      const parts = (event.data as any)?.content
      let promptText = ''
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (p && p.type === 'text' && typeof p.text === 'string') {
            promptText += p.text + '\n'
          }
        }
      }

      const isSentinel = promptText.includes('[task-sentinel]')
      if (isSentinel) {
        const existing = this.sentinelTurns.get(sessionId)
        void existing

        let sessionTitle: string | undefined
        try {
          const item = this.sessionRegistry.resolveIndex(sessionId)
          if (item?.title) sessionTitle = item.title
        } catch { /* ignore */ }
        const ctxAny = this.ctx as any
        if (!sessionTitle && ctxAny.sessionQuery) {
          try {
            const t = await ctxAny.sessionQuery.readTitle(sessionId)
            if (t?.title) sessionTitle = t.title
          } catch { /* ignore */ }
        }

        const tracker: SentinelTurnTracker = {
          stepCount: 0,
          throttle: createThrottle(1500),
          lastAssistantText: '',
          sessionTitle,
        }

        const label = sessionTitle ? `${sessionTitle} (${sessionId})` : sessionId
        const initialText = `💭 [Task Sentinel 验收中]\n🎯 会话: ${label}\n🤔 DSH 正在分析任务验收报告…`

        const res = await this.client.sendMessage(this.receiveId(), initialText, { asCard: true, receiveIdType: this.runtime.receiveIdType }).catch(() => undefined)
        if (res?.ok && res.result) {
          tracker.messageId = res.result.message_id
        }

        this.sentinelTurns.set(sessionId, tracker)
        this.ctx.logger.info('feishu-duty', `Started Sentinel turn tracker for session ${sessionId}`)
        return
      }

      // Existing duty mode logic: user message from Web UI switches to local mode
      if (this.mode === 'duty' && (event.data as any)?.source?.kind === 'user') {
        void this.setMode('local', true)
        this.ctx.logger.info('feishu-duty', `user message in session ${sessionId} → local mode`)
      }
      return
    }

    // 2. Events during an active Sentinel turn
    const tracker = this.sentinelTurns.get(sessionId)
    if (!tracker) return

    if (event.type === 'step/start') {
      tracker.stepCount++
      return
    }

    // 注：dsh >=0.1.5-rc.2 移除了 assistant/chunk 流式事件（流式记录改由
    // assistant/message 的 stream 字段在 step 提交时携带），实时
    // thinking/writing 相位在新事件模型下不可得，Sentinel 进度降级为
    // step/tool 相位 + 完成后回复转发。

    if (event.type === 'tool/call') {
      tracker.lastPhase = 'tool'
      tracker.lastToolName = (event.data as any)?.name
      tracker.throttle(() => {
        if (!tracker.messageId) return
        const lang = this.settings.get().language ?? 'zh'
        const progress = formatProgress('tool', { step: tracker.stepCount, toolName: tracker.lastToolName }, lang)
        const label = tracker.sessionTitle ? `${tracker.sessionTitle} (${sessionId})` : sessionId
        const editContent = `💭 [Task Sentinel 思考中]\n🎯 会话: ${label}\n${progress}`
        this.client.editMessageText(this.receiveId(), tracker.messageId, editContent).catch(() => {})
      })
      return
    }

    if (event.type === 'assistant/message') {
      const msg = (event.data as any)?.message
      if (msg?.content && Array.isArray(msg.content)) {
        const textParts: string[] = []
        for (const block of msg.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text)
          }
        }
        const joined = textParts.join('').trim()
        if (joined) {
          tracker.lastAssistantText = joined
        }
      }
      return
    }

    if (event.type === 'turn/end') {
      this.sentinelTurns.delete(sessionId)
      if (tracker.messageId) {
        // Feishu 撤回会留下占位，进度卡就地固化为完成态（等价于 Telegram 的删除）。
        this.client.editMessageText(this.receiveId(), tracker.messageId, '✅ 验收完成').catch(() => {})
      }

      const reason = (event.data as any)?.reason
      const reply = tracker.lastAssistantText
      const label = tracker.sessionTitle ? `${tracker.sessionTitle} (${sessionId})` : sessionId

      if (reason && reason.kind === 'error') {
        const errMsg = reason.error?.message ?? JSON.stringify(reason.error)
        void this.sendChunked(`⚠️ **[Task Sentinel 验收异常]**\n🎯 会话: \`${label}\`\n错误: ${errMsg}`)
      } else if (reply) {
        void this.sendChunked(`📋 **[Task Sentinel 验收回复]**\n🎯 会话: \`${label}\`\n\n${reply}`)
      } else {
        void this.sendChunked(`📋 **[Task Sentinel 验收完毕]**\n🎯 会话: \`${label}\`\n（DSH 无文本回复输出）`)
      }
      this.ctx.logger.info('feishu-duty', `Finished Sentinel turn for session ${sessionId}`)
      return
    }
  }

  private resolveDutyTargetSessionId(): string {
    let bridged: string | null | undefined
    try {
      const target = readCrossNamespace(this.ctx, 'feishu-bridge-control') as { sessionId?: string } | undefined
      bridged = target?.sessionId
    } catch (e) {
      bridged = undefined // namespace 不存在时按无桥接处理
    }
    return resolveAttachmentTarget({ runtimeSessionId: this.runtime.sessionId ?? undefined, bridgedSessionId: bridged })
  }

  /** The whitelisted Feishu id all outgoing messages go to. */
  private receiveId(): string {
    return this.runtime.receiveId ?? ''
  }

  /** Whitelist: open_id mode serves the user's p2p chat only; chat_id mode serves one chat. */
  private isAllowed(message: FeishuIncomingMessage): boolean {
    const id = this.receiveId()
    if (id === '') return false
    if (this.runtime.receiveIdType === 'chat_id') return message.chatId === id
    return message.chatType === 'p2p' && message.senderOpenId === id
  }

  /** A card action is accepted from the whitelisted identity only. */
  private isActionAllowed(action: FeishuCardAction): boolean {
    const id = this.receiveId()
    if (id === '') return false
    if (this.runtime.receiveIdType === 'chat_id') return action.chatId === id
    return action.operatorOpenId === id
  }

  private async handleFeishuMessage(message: FeishuIncomingMessage): Promise<void> {
    // Bots (this one, or others) must never re-enter the pipeline.
    if (message.senderType === 'bot') return
    if (!this.isAllowed(message)) {
      this.ctx.logger.info('feishu-duty', `ignoring message from ${this.runtime.receiveIdType} ${this.runtime.receiveIdType === 'chat_id' ? message.chatId : message.senderOpenId} (whitelist is ${this.receiveId()})`)
      return
    }

    const mediaEnabled = this.runtime.mediaEnabled !== false
    const attachment = mediaEnabled ? describeAttachment(message) : null

    if (attachment) {
      const dataDir = this.runtime.dataDir ?? '.'
      const inboxDir = path.resolve(dataDir, 'inbox')
      await fs.promises.mkdir(inboxDir, { recursive: true })
      try {
        const savedPath = inboxFileName(inboxDir, attachment.kind, attachment.fileKey, attachment.fileName)
        await this.client.downloadResource(attachment.messageId, attachment.fileKey, attachment.resourceType, savedPath)

        await this.setMode('duty', true)
        const targetSessionId = this.resolveDutyTargetSessionId()
        const currentModel = this.ctx.agentDefaultModel.currentSelection() || { provider: 'unknown', model: 'unknown' }
        const notice = attachmentNotice({
          savedPath,
          kind: attachment.kind,
          fileName: attachment.fileName,
          mime: attachment.mime,
          provider: currentModel.provider,
          model: currentModel.model,
        })

        if (targetSessionId !== (this.runtime.sessionId ?? 'feishu-duty')) {
          await this.sendChunked(this.strings.routedTo(targetSessionId))
        }
        const outcome = await this.duty.run(notice, { sessionId: targetSessionId, userMessageId: message.messageId })
        if (outcome.error !== undefined) {
          const cls = classifyDutyError(outcome.error)
          if (cls.kind === 'context-overflow') {
            await this.sendChunked(this.strings.dutyContextOverflow(outcome.error, savedPath))
          } else {
            await this.sendChunked(this.strings.dutyError(outcome.error))
          }
        } else if (outcome.text.trim() === '') {
          await this.sendChunked(this.strings.dutyEmpty)
        } else {
          await this.sendChunked(outcome.text.trim())
        }
      } catch (error) {
        this.ctx.logger.warn('feishu-duty', `Failed to handle attachment: ${error instanceof Error ? error.message : String(error)}`)
        await this.sendChunked(`处理附件失败: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }

    let text = extractText(message)
    if (message.chatType === 'group') {
      // 群内消息经 @机器人 触达时，正文以 @机器人名 开头——剥掉再走命令解析。
      text = text.replace(/^@\S+\s*/, '')
    }
    if (text.trim() === '') return

    const trimmed = text.trim()

    // 0) awaitingInput（最高优先级）：ask-custom 直通 / 向导文本输入，不进 LLM
    //    /cancel 穿透拦截走命令分发（取消 awaitingInput 自身）
    if (this.awaitingInput !== undefined && trimmed !== '/cancel') {
      const awaiting = this.awaitingInput
      if (awaiting.kind === 'ask-custom') {
        if (this.asks.answerCustomInput(trimmed)) {
          this.awaitingInput = undefined
          return // 答案已直通 LLM 的 ask promise，无需任何提示消息
        }
      } else if (awaiting.kind === 'wizard-cwd' || awaiting.kind === 'wizard-name') {
        this.awaitingInput = undefined
        if (this.wizardState !== undefined) {
          const { state, action } = wizardText(this.wizardState, trimmed)
          this.wizardState = state
          await this.handleWizardAction(action)
        }
        return
      }
      // 未知 kind：清除防卡死，继续正常管线
      this.awaitingInput = undefined
    }

    // 1) approval answer
    const parse = parseApprovalReply(trimmed, this.approvals.pendingIds())
    if (parse.kind === 'answer') {
      if (this.approvals.answer(parse.id, parse.decision)) {
        await this.sendChunked(parse.decision === 'allowed-once'
          ? this.strings.approvalAccepted(parse.id)
          : this.strings.approvalRejected(parse.id))
      } else {
        await this.sendChunked(this.strings.approvalUnknown(parse.id))
      }
      return
    }
    if (parse.kind === 'ambiguous') {
      const first = this.approvals.pendingIds()[0]
      await this.sendChunked(this.strings.approvalAmbiguous(this.approvals.pendingIds().length, first ?? 1))
      return
    }

    // 1b) ask answer (exact option-label match)
    if (this.asks.answerByLabel(trimmed)) {
      await this.sendChunked(this.strings.askAnswered)
      return
    }

    // 2) commands
    const localCmd = parseLocalCommand(trimmed)
    if (localCmd) {
      if (localCmd.name === 'cancel') {
         await this.cancelAwaiting()
         return
      }

      if (localCmd.name === 'new') {
         this.wizardState = wizardStart()
         this.wizardLists = {}
         await this.sendWizardStep()
         return
      }

      const handlerInfo = this.commandRegistry.resolve(localCmd.name)
      if (handlerInfo) {
         let targetSessionId = this.runtime.sessionId ?? 'feishu-duty'
         try {
           const target = readCrossNamespace(this.ctx, 'feishu-bridge-control') as any
           targetSessionId = target?.sessionId || targetSessionId
         } catch (e) {}

         const env = { targetSessionId }
         try {
           const out = await handlerInfo.handler(localCmd.arg, env as any)
           if (typeof out === 'string') {
              await this.sendChunked(out)
           } else if (out && typeof out === 'object') {
              if ('type' in out && out.type === 'confirm-delete') {
                 const delSessionId = (out as { sessionId?: string }).sessionId
                 if (delSessionId === undefined) {
                   await this.sendChunked(this.strings.switchNotFound ?? '会话不存在')
                 } else {
                   this.pendingDeleteId = delSessionId
                   const delShortId = (out as { shortId?: string }).shortId ?? delSessionId
                   await this.sendChunked(this.strings.deleteConfirm(delShortId), [[
                     { text: this.strings.deleteConfirmYes, callback_data: 'cmd:del:yes' },
                     { text: this.strings.deleteConfirmNo, callback_data: 'cmd:del:no' },
                   ]])
                 }
              } else if ('type' in out && out.type === 'model-card') {
                 await this.sendModelCard()
              } else if ('type' in out && out.type === 'mode-card') {
                 await this.sendModeCard()
              } else if ('text' in out && 'keyboard' in out) {
                 await this.sendChunked((out as any).text, (out as any).keyboard)
              }
           }
         } catch (e) {
           await this.sendChunked('Error: ' + String(e))
         }
         return
      }
      // 未注册的斜杠命令继续走内建命令（/help /away /back /stop），
      // 避免本地命令层把 parseCommand 可达的内建命令提前吞成 unknown。
    }

    const command = parseCommand(trimmed)
    if (command === 'away') {
      if (this.mode === 'duty') {
        // Already on duty: confirm instead of silently ignoring the command.
        await this.sendChunked(this.strings.alreadyDuty + '\n' + this.strings.dutyOn)
      } else {
        await this.setMode('duty', true)
      }
      return
    }
    if (command === 'back') {
      if (this.mode === 'local') {
        await this.sendChunked(this.strings.alreadyLocal)
      } else {
        await this.setMode('local', true)
      }
      return
    }
    if (command === 'help') {
      await this.sendChunked(this.strings.help)
      return
    }
    if (command === 'stop') {
      if (this.duty.cancelCurrent()) {
        await this.sendChunked(this.strings.stopSuccess)
      } else {
        await this.sendChunked(this.strings.stopEmpty)
      }
      return
    }

    // 内建命令也未命中：以 / 开头按未知命令处理，其余进入任务路由。
    if (trimmed.startsWith('/')) {
      await this.sendChunked(this.strings.unknownCommand || '未知命令')
      return
    }

    // 3) task → duty session
    await this.setMode('duty', true)

    const targetSessionId = this.resolveDutyTargetSessionId()

    if (targetSessionId !== (this.runtime.sessionId ?? 'feishu-duty')) {
      await this.sendChunked(this.strings.routedTo(targetSessionId))
    }

    const outcome = await this.duty.run(trimmed, { sessionId: targetSessionId, userMessageId: message.messageId })
    if (outcome.error !== undefined) {
      const cls = classifyDutyError(outcome.error)
      if (cls.kind === 'context-overflow') {
        await this.sendChunked(this.strings.dutyContextOverflow(outcome.error, undefined))
      } else {
        await this.sendChunked(this.strings.dutyError(outcome.error))
      }
    } else if (outcome.text.trim() === '') {
      // Don't send empty message if cancelled
    } else {
      await this.sendChunked(outcome.text.trim())
    }
  }

  private async handleWizardAction(action?: any) {
    if (!action) {
       await this.sendWizardStep()
       return
    }
    if (action.kind === 'cancelled') {
       const msgId = this.wizardMessageId
       this.wizardState = undefined
       this.wizardMessageId = undefined
       this.awaitingInput = undefined
       if (msgId !== undefined) {
          try {
             await this.client.editMessageText(this.receiveId(), msgId, this.strings.wizardCancelled || '向导已取消', { keyboard: [] })
             return
          } catch {}
       }
       await this.sendChunked(this.strings.wizardCancelled || '向导已取消')
       return
    }
    if (action.kind === 'awaitText') {
       this.awaitingInput = { kind: this.wizardState?.step === 'cwd' ? 'wizard-cwd' : 'wizard-name', id: 0 }
       if (this.wizardState?.step === 'name') {
          await this.sendWizardStep()
       } else {
          await this.sendChunked(this.strings.wizardStepCwd || '请输入工作区绝对路径：')
       }
       return
    }
    if (action.kind === 'done') {
       this.wizardState = undefined
       this.wizardMessageId = undefined
       // 创建流程按 DESIGN-v0.6.0 §1.7 真实范例（feishu-bridge-control feishu_duty_create_session）
       try {
           const p = action.params as { cwd: string; name?: string; provider: string; model: string; reasoningEffort?: string; permission?: string; preset?: string }
           // cwd 归一化：支持 ~ 与相对路径（相对 duty 工作目录解析），
           // 目录不存在时自动创建，避免 realpath ENOENT（如直接输入 "科研任务"）
           let cwd = (p.cwd ?? '').trim()
           if (cwd === '~' || cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(1))
           if (!path.isAbsolute(cwd)) cwd = path.resolve(this.runtime.dutyCwd ?? process.cwd(), cwd)
           if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true })
           const created = await this.workspaceRegistry().create(cwd, undefined)
           const sessionId = SessionId(`session-${randomUUID()}`)
           const presets = this.ctx.get('agentPresets')
           const presetId = presets !== undefined ? (await presets.resolve(p.preset && p.preset !== 'default' ? p.preset : undefined)).id : undefined
           const selection = this.ctx.agentDefaultModel.currentSelection()
           const effort = p.reasoningEffort || selection.reasoningEffort
           const handle = await this.ctx.agents.create({
             sessionId,
             meta: { cwd: created.path, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
             agentOptions: { provider: p.provider, model: p.model, ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}) },
             setup: async (agentCtx: any) => {
               // No installModelSelection: agentOptions owns the initial route and the
               // session controller owns in-session switches. A static snapshot here
               // would outrank the controller's override in the agent/request waterfall
               // and silently pin every request to the creation-time model.
               if (presets !== undefined) {
                 const resolved = await presets.resolve(presetId)
                 await presets.mount(agentCtx, resolved.id)
               }
             },
           })
           if (p.name !== undefined && p.name !== '') {
             try { (this.ctx as any).sessionTitle.rename(handle.agent.session, p.name) } catch { /* best effort */ }
           }
           // 应用 /new 向导选择的权限预设：创建时 PermissionPresetService 只会
           // pin 全局 defaultPreset；这里按本次选择显式改写会话事实三元组。
           if (p.permission !== undefined && p.permission !== '') {
             try {
               (this.ctx as any).permissionPresets.set(handle.agent.session, p.permission)
             } catch (e) {
               this.ctx.logger.warn('feishu-duty', `apply permission preset failed: ${e instanceof Error ? e.message : String(e)}`)
             }
           }
           // 归组登记：workspace 成员为显式 attach（workspace/src/entity.ts attachSession）
           try {
             await created.attachSession(sessionId)
           } catch {
             // header 落盘延迟时重试一次
             await new Promise((r) => setTimeout(r, 500))
             try { await created.attachSession(sessionId) } catch (e) {
               this.ctx.logger.warn('feishu-duty', `attachSession failed: ${e instanceof Error ? e.message : String(e)}`)
             }
           }
           await this.setTargetSessionId(String(sessionId))
           this.sessionRegistry.markDirty()
           await this.sendChunked(this.strings.wizardCreated ?? '会话已创建并切换。')
       } catch (e) {
           await this.sendChunked('创建失败: ' + (e instanceof Error ? e.message : String(e)))
       }
       return
    }
  }

  /** v0.6.0: workspaceRegistry 访问器（运行时由 inject 保证存在）。 */
  private workspaceRegistry(): {
    create(cwd: string, title?: string): Promise<{ path: string; attachSession(id: SessionId): Promise<void> }>
    archiveSession(id: SessionId): Promise<void>
  } {
    return (this.ctx as any).workspaceRegistry
  }

  /** v0.6.0: /cancel 统一取消（方法内读取以避开 CFA 收窄）。 */
  private async cancelAwaiting(): Promise<void> {
    if (this.awaitingInput !== undefined) {
      if (this.awaitingInput.kind === 'ask-custom') this.asks.cancelCustomInput()
      this.awaitingInput = undefined
      await this.sendChunked(this.strings.cancelled)
      return
    }
    if (this.wizardState !== undefined) {
      const { action } = wizardCancel(this.wizardState)
      this.wizardState = undefined
      void action
      await this.sendChunked(this.strings.wizardCancelled)
      return
    }
    await this.sendChunked(this.strings.stopEmpty)
  }

  /**
   * v0.6.0: 写入 feishu-bridge-control 设置切换路由目标（v0.5.0 路由机制复用）。
   * 真实 API：SettingsProvider.update(ns, patch)（dsh-settings/lib/types/index.d.ts:240 附近），
   * 与 feishu-bridge-control 的 stateNs.update({ sessionId }) 同语义。
   */
  private async setTargetSessionId(id: string): Promise<void> {
    // dsh-settings >=0.1.5 移除了 settingsNamespace()；update 直接接受字符串。
    await writeCrossNamespace(this.ctx, 'feishu-bridge-control', { sessionId: id })
  }

  private getCurrentPermissionPreset(sessionId: string): string {
    try {
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (agent && (this.ctx as any).permissionPresets) {
        return (this.ctx as any).permissionPresets.get(agent.session) ?? 'default'
      }
    } catch {}
    return 'default'
  }

  private async sendModelCard(): Promise<void> {
    const cur = this.ctx.agentDefaultModel.currentSelection()
    let targetSessionId = this.runtime.sessionId ?? 'feishu-duty'
    try {
      const target = readCrossNamespace(this.ctx, 'feishu-bridge-control') as any
      targetSessionId = target?.sessionId || targetSessionId
    } catch {}
    const curMode = this.getCurrentPermissionPreset(targetSessionId)
    const { providers } = await this.modelRegistry.fetch()
    const text = this.strings.modelCardProvLevel(
      `${cur.provider}/${cur.model}`,
      curMode
    )
    const keyboard: InlineKeyboard = []
    providers.forEach((p: any, idx: number) => {
      keyboard.push([{ text: `🏢 ${p.id || p}`, callback_data: `mdl:p:${idx}` }])
    })
    keyboard.push([{ text: this.strings.btnCancel, callback_data: 'mdl:cancel' }])
    await this.sendChunked(text, keyboard)
  }

  private async sendModeCard(): Promise<void> {
    let targetSessionId = this.runtime.sessionId ?? 'feishu-duty'
    try {
      const target = readCrossNamespace(this.ctx, 'feishu-bridge-control') as any
      targetSessionId = target?.sessionId || targetSessionId
    } catch {}

    const { list } = await this.sessionRegistry.fetch(targetSessionId)
    const s = list.find((x) => x.id === targetSessionId)
    const title = s?.title || targetSessionId
    const curMode = this.getCurrentPermissionPreset(targetSessionId)
    const perms = this.permissionRegistry.fetch()

    const text = this.strings.modeCardTitle
      ? this.strings.modeCardTitle(title, curMode)
      : `🛡️ 权限模式配置 (Permission Mode)\n\n📌 目标会话：${title}\n⚙️ 当前模式：🛡️ ${curMode}\n\n请点选要切换的权限预设：`

    const keyboard: InlineKeyboard = []
    perms.forEach((pm: string, pIdx: number) => {
      const isCur = pm === curMode
      keyboard.push([{
        text: `${isCur ? '● ' : ''}🛡️ ${pm}${isCur ? ' (当前)' : ''}`,
        callback_data: `pmode:set:${pIdx}`,
      }])
    })
    keyboard.push([{ text: this.strings.btnClose || '❌ 关闭', callback_data: 'pmode:cancel' }])

    await this.sendChunked(text, keyboard)
  }

  private async sendWizardStep() {
     if (!this.wizardState) return
     const step = this.wizardState.step
     let text = ''
     let keyboard: any[] = []

     if (step === 'cwd') {
        const { groups } = await this.sessionRegistry.fetch('')
        this.wizardLists.workspaces = []
        text = this.strings.wizardStepCwd || '请选择工作区（或新建）：'
        let idx = 0
        for (const g of groups) {
           if (g.workspaceId === 'orphaned') continue
           this.wizardLists.workspaces.push(g)
           keyboard.push([{ text: g.title || g.path, callback_data: `wiz:cwd:${idx}` }])
           idx++
        }
        keyboard.push([{ text: '✏️ 新建工作目录', callback_data: 'wiz:cwd:new' }])
     } else if (step === 'name') {
        text = this.strings.wizardStepName || '✏️ 请输入会话名称：\n（直接在聊天框发送文字；或点击下方按钮快速跳过/取消）'
        keyboard.push([
           { text: '⏩ 跳过命名', callback_data: 'wiz:name:skip' },
           { text: '❌ 取消', callback_data: 'wiz:name:cancel' }
        ])
     } else if (step === 'provider') {
        const { providers } = await this.modelRegistry.fetch()
        this.wizardLists.providers = providers
        text = this.strings.wizardStepProvider || '请选择模型供应商：'
        providers.forEach((p: any, idx: number) => {
           keyboard.push([{ text: p.id || p, callback_data: `wiz:provider:${idx}` }])
        })
     } else if (step === 'model') {
        const { models } = await this.modelRegistry.fetch()
        const list = models[this.wizardState.provider!] || []
        this.wizardLists.models = list
        text = this.strings.wizardStepModel || '请选择模型：'
        list.slice(0, 20).forEach((m: any, idx: number) => {
           const mName = typeof m === 'string' ? m : (m as any)?.id
           keyboard.push([{ text: mName, callback_data: `wiz:model:${idx}` }])
        })
     } else if (step === 'reasoning') {
        const efforts = this.wizardLists.reasoningEfforts || []
        text = (this.strings.wizardStepReasoning ? this.strings.wizardStepReasoning(this.wizardState.provider || '', this.wizardState.model || '') : `🧠 思考强度 (Reasoning Effort) — 请选择思考等级：\n模型：${this.wizardState.provider}/${this.wizardState.model}`)
        efforts.forEach((eff: any, idx: number) => {
           keyboard.push([{ text: `🧠 ${eff.name || eff.id}`, callback_data: `wiz:reasoning:${idx}` }])
        })
        keyboard.push([
           { text: this.strings.btnSkip || '⏭ 跳过 / 默认', callback_data: 'wiz:reasoning:skip' },
           { text: this.strings.btnCancel || '❌ 取消', callback_data: 'wiz:reasoning:cancel' }
        ])
     } else if (step === 'permission') {
        const perms = this.permissionRegistry.fetch()
        this.wizardLists.permissions = perms
        text = this.strings.wizardStepPermission || '请选择权限预设：'
        perms.forEach((p: string, idx: number) => {
           keyboard.push([{ text: p, callback_data: `wiz:permission:${idx}` }])
        })
     } else if (step === 'preset') {
        const presets = await this.presetRegistry.fetch()
        this.wizardLists.presets = presets
        text = this.strings.wizardStepPreset || '请选择 Agent 模式：'
        presets.forEach((p: any, idx: number) => {
           keyboard.push([{ text: p.title || p.id, callback_data: `wiz:preset:${idx}` }])
        })
     } else if (step === 'confirm') {
         const effortText = this.wizardState.reasoningEffort ? this.wizardState.reasoningEffort : '默认 / 未设置'
         text = (this.strings.wizardConfirm || '请确认参数：') + `\nCwd: ${this.wizardState.cwd}\nName: ${this.wizardState.name || '未设置'}\nModel: ${this.wizardState.provider}/${this.wizardState.model}\nReasoning: ${effortText}\nPermission: ${this.wizardState.permission}\nPreset: ${this.wizardState.preset}`
        keyboard.push([
           { text: '✅ 创建', callback_data: 'wiz:confirm:yes' },
           { text: '❌ 取消', callback_data: 'wiz:confirm:no' }
        ])
     }

     if (text) {
        if (this.wizardMessageId !== undefined) {
           try {
              const res = await this.client.editMessageText(this.receiveId(), this.wizardMessageId, text, { keyboard })
              if (res.ok) return
           } catch {
              // fallback
           }
        }
        this.wizardMessageId = await this.sendChunked(text, keyboard)
     }
  }

  private async setMode(mode: 'local' | 'duty', notify: boolean): Promise<void> {
    if (this.mode === mode) return
    this.mode = mode
    try {
      await this.settings.update({ watchMode: mode })
    } catch (error) {
      this.ctx.logger.warn('feishu-duty', `persisting watchMode failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await this.pushStateMarker(mode)
    if (notify) await this.sendChunked(mode === 'duty' ? this.strings.dutyOn : this.strings.dutyOff)
  }

  /**
   * Handle one card action (the Feishu inline-button press): the ack the
   * Telegram port delivered via answerCallbackQuery travels back as the
   * action's toast response instead.
   */
  private async handleCardAction(action: FeishuCardAction): Promise<CardActionResponse | void> {
    if (!this.isActionAllowed(action)) {
      this.ctx.logger.info('feishu-duty', `ignoring card action from operator ${action.operatorOpenId ?? 'unknown'}`)
      return
    }
    const data = action.cb ?? ''
    if (data === '') return
    const messageId = action.messageId
    let ack: string | undefined

    // v0.8.0: /sessions 多级卡片菜单
    if (data.startsWith('sess:')) {
      const parts = data.split(':')
      const actionKind = parts[1]
      if (actionKind === 'cancel') {
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, '— ' + (this.strings.btnClose || '已关闭'), { keyboard: [] }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.btnClose || '已关闭' } }
      }
      if (actionKind === 'back' && parts[2] === 'ws') {
        const { groups } = await this.sessionRegistry.fetch('')
        const keyboard: InlineKeyboard = []
        let idx = 0
        for (const group of groups) {
          if (group.sessions.length === 0) continue
          keyboard.push([{ text: `📁 ${group.title || group.path} (${group.sessions.length})`, callback_data: `sess:ws:${idx}` }])
          idx++
        }
        keyboard.push([{ text: this.strings.btnClose, callback_data: 'sess:cancel' }])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.sessionCardWsLevel, { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.sessionCardWsLevel } }
      }
      if (actionKind === 'ws') {
        const groupIdx = parseInt(parts[2] ?? '', 10)
        const { groups } = await this.sessionRegistry.fetch('')
        const validGroups = groups.filter(g => g.sessions.length > 0)
        const g = validGroups[groupIdx]
        if (!g) {
          return { toast: { type: 'error', content: 'Workspace not found' } }
        }
        const keyboard: InlineKeyboard = []
        for (const s of g.sessions) {
          const currentMarker = s.isCurrent ? (this.strings.currentMarker || '●') : ''
          const shortId = s.id.split('-').pop()?.slice(0, 8) || s.id
          keyboard.push([{ text: `${s.index}.${currentMarker} ${s.title} (${shortId})`, callback_data: `sess:sw:${s.index}` }])
        }
        keyboard.push([
          { text: this.strings.btnBackToWs, callback_data: 'sess:back:ws' },
          { text: this.strings.btnClose, callback_data: 'sess:cancel' }
        ])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.sessionCardSessLevel(g.title || g.path), { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: g.title || g.path } }
      }
      if (actionKind === 'sw') {
        const sIndex = parts[2] ?? ''
        const s = this.sessionRegistry.resolveIndex(sIndex)
        if (!s) {
          return { toast: { type: 'error', content: this.strings.switchNotFound || 'Session not found' } }
        }
        await this.setTargetSessionId(s.id)
        this.sessionRegistry.markDirty()
        const shortId = s.id.split('-').pop()?.slice(0, 8) || s.id
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.sessionCardSwitched(s.title, shortId, s.cwd), { keyboard: [] }) } catch {}
        }
        return { toast: { type: 'success', content: (this.strings.switched || 'Switched: ') + s.title } }
      }
    }

    // v0.8.0: /archive 交互式软归档
    if (data.startsWith('arc:')) {
      const parts = data.split(':')
      const actionKind = parts[1]
      if (actionKind === 'cancel') {
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, '— ' + (this.strings.btnCancel || '已取消'), { keyboard: [] }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.btnCancel || '已取消' } }
      }
      if (actionKind === 'back' && parts[2] === 'ws') {
        const { groups } = await this.sessionRegistry.fetch('')
        const keyboard: InlineKeyboard = []
        let idx = 0
        for (const group of groups) {
          if (group.sessions.length === 0) continue
          keyboard.push([{ text: `📁 ${group.title || group.path} (${group.sessions.length})`, callback_data: `arc:ws:${idx}` }])
          idx++
        }
        keyboard.push([{ text: this.strings.btnCancel, callback_data: 'arc:cancel' }])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.archiveCardWsLevel, { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.archiveCardWsLevel } }
      }
      if (actionKind === 'ws') {
        const groupIdx = parseInt(parts[2] ?? '', 10)
        const { groups } = await this.sessionRegistry.fetch('')
        const validGroups = groups.filter(g => g.sessions.length > 0)
        const g = validGroups[groupIdx]
        if (!g) {
          return { toast: { type: 'error', content: 'Workspace not found' } }
        }
        const keyboard: InlineKeyboard = []
        for (const s of g.sessions) {
          const shortId = s.id.split('-').pop()?.slice(0, 8) || s.id
          keyboard.push([{ text: `📦 ${s.title} (${shortId})`, callback_data: `arc:target:${s.index}` }])
        }
        keyboard.push([
          { text: this.strings.btnBackToWs, callback_data: 'arc:back:ws' },
          { text: this.strings.btnCancel, callback_data: 'arc:cancel' }
        ])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.archiveCardSessLevel, { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.archiveCardSessLevel } }
      }
      if (actionKind === 'target') {
        const sIndex = parts[2] ?? ''
        const s = this.sessionRegistry.resolveIndex(sIndex)
        if (!s) {
          return { toast: { type: 'error', content: this.strings.switchNotFound || 'Session not found' } }
        }
        const keyboard: InlineKeyboard = [
          [{ text: this.strings.btnConfirmArchive, callback_data: `arc:confirm:${s.index}` }],
          [{ text: this.strings.btnBackToWs, callback_data: 'arc:back:ws' }, { text: this.strings.btnCancel, callback_data: 'arc:cancel' }]
        ]
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.archiveCardConfirm(s.title), { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.archiveCardConfirm(s.title) } }
      }
      if (actionKind === 'confirm') {
        const sIndex = parts[2] ?? ''
        const s = this.sessionRegistry.resolveIndex(sIndex)
        if (!s) {
          return { toast: { type: 'error', content: this.strings.switchNotFound || 'Session not found' } }
        }
        try {
          await this.workspaceRegistry().archiveSession(SessionId(s.id))
          this.sessionRegistry.markDirty()
          let currentTarget = this.runtime.sessionId ?? 'feishu-duty'
          try {
            const t = readCrossNamespace(this.ctx, 'feishu-bridge-control') as { sessionId?: string } | undefined
            currentTarget = t?.sessionId || currentTarget
          } catch {}
          if (currentTarget === s.id) await this.setTargetSessionId('feishu-duty')
          if (messageId !== undefined) {
            try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.archiveCardDone(s.title), { keyboard: [] }) } catch {}
          }
          return { toast: { type: 'success', content: this.strings.archiveCardDone(s.title) } }
        } catch (e) {
          return { toast: { type: 'error', content: 'Archive failed: ' + String(e) } }
        }
      }
    }

    // v0.8.0: /delete 交互式永久删除
    if (data.startsWith('del:')) {
      const parts = data.split(':')
      const actionKind = parts[1]
      if (actionKind === 'cancel') {
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, '— ' + (this.strings.btnCancel || '已取消'), { keyboard: [] }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.btnCancel || '已取消' } }
      }
      if (actionKind === 'back' && parts[2] === 'ws') {
        const { groups } = await this.sessionRegistry.fetch('')
        const keyboard: InlineKeyboard = []
        let idx = 0
        for (const group of groups) {
          if (group.sessions.length === 0) continue
          keyboard.push([{ text: `📁 ${group.title || group.path} (${group.sessions.length})`, callback_data: `del:ws:${idx}` }])
          idx++
        }
        keyboard.push([{ text: this.strings.btnCancel, callback_data: 'del:cancel' }])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.deleteCardWsLevel, { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.deleteCardWsLevel } }
      }
      if (actionKind === 'ws') {
        const groupIdx = parseInt(parts[2] ?? '', 10)
        const { groups } = await this.sessionRegistry.fetch('')
        const validGroups = groups.filter(g => g.sessions.length > 0)
        const g = validGroups[groupIdx]
        if (!g) {
          return { toast: { type: 'error', content: 'Workspace not found' } }
        }
        const keyboard: InlineKeyboard = []
        for (const s of g.sessions) {
          const shortId = s.id.split('-').pop()?.slice(0, 8) || s.id
          keyboard.push([{ text: `🗑 ${s.title} (${shortId})`, callback_data: `del:target:${s.index}` }])
        }
        keyboard.push([
          { text: this.strings.btnBackToWs, callback_data: 'del:back:ws' },
          { text: this.strings.btnCancel, callback_data: 'del:cancel' }
        ])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.deleteCardSessLevel, { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.deleteCardSessLevel } }
      }
      if (actionKind === 'target') {
        const sIndex = parts[2] ?? ''
        const s = this.sessionRegistry.resolveIndex(sIndex)
        if (!s) {
          return { toast: { type: 'error', content: this.strings.switchNotFound || 'Session not found' } }
        }
        const keyboard: InlineKeyboard = [
          [{ text: this.strings.btnConfirmDelete, callback_data: `del:confirm:${s.index}` }],
          [{ text: this.strings.btnBackToWs, callback_data: 'del:back:ws' }, { text: this.strings.btnCancel, callback_data: 'del:cancel' }]
        ]
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.deleteCardConfirm(s.title, s.cwd), { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.deleteCardConfirm(s.title, s.cwd) } }
      }
      if (actionKind === 'confirm') {
        const sIndex = parts[2] ?? ''
        const s = this.sessionRegistry.resolveIndex(sIndex)
        if (!s) {
          return { toast: { type: 'error', content: this.strings.switchNotFound || 'Session not found' } }
        }
        try {
          try { await (this.workspaceRegistry() as any).deleteSession?.(SessionId(s.id)) } catch {}
          await this.workspaceRegistry().archiveSession(SessionId(s.id))
          this.sessionRegistry.markDirty()
          let currentTarget = this.runtime.sessionId ?? 'feishu-duty'
          try {
            const t = readCrossNamespace(this.ctx, 'feishu-bridge-control') as { sessionId?: string } | undefined
            currentTarget = t?.sessionId || currentTarget
          } catch {}
          if (currentTarget === s.id) await this.setTargetSessionId('feishu-duty')
          if (messageId !== undefined) {
            try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.deleteCardDone(s.title), { keyboard: [] }) } catch {}
          }
          return { toast: { type: 'success', content: this.strings.deleteCardDone(s.title) } }
        } catch (e) {
          return { toast: { type: 'error', content: 'Delete failed: ' + String(e) } }
        }
      }
    }

    // v0.8.0: /model 逐级配置菜单 (Provider -> Model -> Mode)
    if (data.startsWith('mdl:')) {
      const parts = data.split(':')
      const actionKind = parts[1]
      if (actionKind === 'cancel') {
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, '— ' + (this.strings.btnCancel || '已取消'), { keyboard: [] }) } catch {}
        }
        return { toast: { type: 'info', content: this.strings.btnCancel || '已取消' } }
      }
      if (actionKind === 'back' && parts[2] === 'prov') {
        const cur = this.ctx.agentDefaultModel.currentSelection()
        let targetSessionId = this.runtime.sessionId ?? 'feishu-duty'
        try {
          const t = readCrossNamespace(this.ctx, 'feishu-bridge-control') as any
          targetSessionId = t?.sessionId || targetSessionId
        } catch {}
        const curMode = this.getCurrentPermissionPreset(targetSessionId)
        const { providers } = await this.modelRegistry.fetch()
        const text = this.strings.modelCardProvLevel(`${cur.provider}/${cur.model}`, curMode)
        const keyboard: InlineKeyboard = []
        providers.forEach((p: any, idx: number) => {
          keyboard.push([{ text: `🏢 ${p.id || p}`, callback_data: `mdl:p:${idx}` }])
        })
        keyboard.push([{ text: this.strings.btnCancel, callback_data: 'mdl:cancel' }])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, text, { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: text } }
      }
      if (actionKind === 'p') {
        const provIdx = parseInt(parts[2] ?? '', 10)
        const cur = this.ctx.agentDefaultModel.currentSelection()
        let targetSessionId = this.runtime.sessionId ?? 'feishu-duty'
        try {
          const t = readCrossNamespace(this.ctx, 'feishu-bridge-control') as any
          targetSessionId = t?.sessionId || targetSessionId
        } catch {}
        const curMode = this.getCurrentPermissionPreset(targetSessionId)
        const { providers, models } = await this.modelRegistry.fetch()
        const pObj = providers[provIdx]
        const pName = pObj?.id || pObj
        if (!pName) {
          return { toast: { type: 'error', content: 'Provider not found' } }
        }
        const mList = models[pName] || []
        const keyboard: InlineKeyboard = []
        mList.slice(0, 30).forEach((m: any, mIdx: number) => {
          const mName = m.id || m
          const isCur = cur.provider === pName && cur.model === mName
          keyboard.push([{ text: `${isCur ? '● ' : ''}${mName}`, callback_data: `mdl:m:${provIdx}:${mIdx}` }])
        })
        keyboard.push([
          { text: this.strings.btnBackToProv, callback_data: 'mdl:back:prov' },
          { text: this.strings.btnCancel, callback_data: 'mdl:cancel' }
        ])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.modelCardModelLevel(`${cur.provider}/${cur.model}`, curMode, pName), { keyboard }) } catch {}
        }
        return { toast: { type: 'info', content: `🏢 ${pName}` } }
      }
      if (actionKind === 'm') {
        const provIdx = parseInt(parts[2] ?? '', 10)
        const modelIdx = parseInt(parts[3] ?? '', 10)
        const { providers, models } = await this.modelRegistry.fetch()
        const pObj = providers[provIdx]
        const provider = pObj?.id || pObj
        const mList = models[provider] || []
        const mObj = mList[modelIdx]
        const model = (mObj as any)?.id || mObj
        if (!provider || !model) {
          return { toast: { type: 'error', content: 'Model not found' } }
        }
        await this.ctx.agentDefaultModel.saveSelection({ provider, model })
        let targetSessionId = this.runtime.sessionId ?? 'feishu-duty'
        try {
          const t = readCrossNamespace(this.ctx, 'feishu-bridge-control') as any
          targetSessionId = t?.sessionId || targetSessionId
        } catch {}
        const curMode = this.getCurrentPermissionPreset(targetSessionId)
        const perms = this.permissionRegistry.fetch()
        const keyboard: InlineKeyboard = []
        perms.forEach((pm: string, pIdx: number) => {
          keyboard.push([{ text: `🛡️ ${pm}${pm === curMode ? ' (当前)' : ''}`, callback_data: `mdl:mode:${provIdx}:${modelIdx}:${pIdx}` }])
        })
        keyboard.push([
          { text: this.strings.btnKeepMode, callback_data: `mdl:mode:${provIdx}:${modelIdx}:skip` },
          { text: this.strings.btnCancel, callback_data: 'mdl:cancel' }
        ])
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.modelCardModeLevel(provider, model), { keyboard }) } catch {}
        }
        return { toast: { type: 'success', content: (this.strings.modelSwitched || 'Switched to ') + `${provider}/${model}` } }
      }
      if (actionKind === 'mode') {
        const provIdx = parseInt(parts[2] ?? '', 10)
        const modelIdx = parseInt(parts[3] ?? '', 10)
        const modeChoice = parts[4] ?? 'skip'
        const { providers, models } = await this.modelRegistry.fetch()
        const pObj = providers[provIdx]
        const provider = pObj?.id || pObj
        const mList = models[provider] || []
        const mObj = mList[modelIdx]
        const model = (mObj as any)?.id || mObj
        let targetSessionId = this.runtime.sessionId ?? 'feishu-duty'
        try {
          const t = readCrossNamespace(this.ctx, 'feishu-bridge-control') as any
          targetSessionId = t?.sessionId || targetSessionId
        } catch {}
        let finalMode = this.getCurrentPermissionPreset(targetSessionId)
        if (modeChoice !== 'skip') {
          const perms = this.permissionRegistry.fetch()
          const chosen = perms[parseInt(modeChoice, 10)]
          if (chosen) {
            finalMode = chosen
            const agent = this.ctx.agents.get(SessionId(targetSessionId))
            if (agent && (this.ctx as any).permissionPresets) {
              try { (this.ctx as any).permissionPresets.set(agent.session, chosen) } catch {}
            }
          }
        }
        if (messageId !== undefined) {
          try { await this.client.editMessageText(this.receiveId(), messageId, this.strings.modelCardDone(provider || '', model || '', finalMode), { keyboard: [] }) } catch {}
        }
        return { toast: { type: 'success', content: this.strings.modelCardDone(provider || '', model || '', finalMode) } }
      }
    }

    // v0.6.0: noop（固化后的置灰按钮）
    if (data === 'noop') {
      return { toast: { type: 'info', content: this.strings.callbackUnknown } }
    }
    // v0.6.0: /delete 二次确认
    if (data === 'cmd:del:yes' || data === 'cmd:del:no') {
      const target = this.pendingDeleteId
      this.pendingDeleteId = undefined
      if (data === 'cmd:del:no' || target === undefined) {
        if (messageId !== undefined) {
          try { await this.client.editMessageReplyMarkup(messageId, [[{ text: this.strings.cancelledLabel ?? '— 已取消', callback_data: 'noop' }]]) } catch { /* ignore */ }
        }
        return { toast: { type: 'info', content: this.strings.cancelled ?? '已取消' } }
      }
      try {
        await this.workspaceRegistry().archiveSession(SessionId(target))
        this.sessionRegistry.markDirty()
        // 归档的是当前路由目标 → 回退默认
        let currentTarget = this.runtime.sessionId ?? 'feishu-duty'
        try {
          const t = readCrossNamespace(this.ctx, 'feishu-bridge-control') as { sessionId?: string } | undefined
          currentTarget = t?.sessionId || currentTarget
        } catch { /* ignore */ }
        if (currentTarget === target) await this.setTargetSessionId('feishu-duty')
        if (messageId !== undefined) {
          try { await this.client.editMessageReplyMarkup(messageId, [[{ text: this.strings.deleted, callback_data: 'noop' }]]) } catch { /* ignore */ }
        }
        ack = this.strings.deleted
      } catch (e) {
        ack = 'Error: ' + (e instanceof Error ? e.message : String(e))
      }
      return { toast: { type: ack?.startsWith('Error') ? 'error' : 'success', content: ack ?? '' } }
    }

    // v0.8.1: /mode 交互式卡片切换 (pmode:set:<idx>, pmode:cancel)
    if (data.startsWith('pmode:')) {
      const parts = data.split(':')
      const actionKind = parts[1]
      if (actionKind === 'cancel') {
        if (messageId !== undefined) {
          try {
            await this.client.editMessageText(this.receiveId(), messageId, '— ' + (this.strings.modeCardClosed || '权限模式配置已关闭。'), { keyboard: [] })
          } catch {}
        }
        return { toast: { type: 'info', content: this.strings.modeCardClosed || '已关闭' } }
      }
      if (actionKind === 'set') {
        const pIdx = parseInt(parts[2] ?? '', 10)
        const perms = this.permissionRegistry.fetch()
        const chosen = perms[pIdx]
        if (!chosen) {
          return { toast: { type: 'error', content: 'Permission preset not found' } }
        }

        let targetSessionId = this.runtime.sessionId ?? 'feishu-duty'
        try {
          const t = readCrossNamespace(this.ctx, 'feishu-bridge-control') as any
          targetSessionId = t?.sessionId || targetSessionId
        } catch {}

        let agent = this.ctx.agents.get(SessionId(targetSessionId))
        if (!agent && (this.ctx.agents as any).resolveAgent) {
          try { agent = await (this.ctx.agents as any).resolveAgent(targetSessionId) } catch {}
        }

        if (agent && (this.ctx as any).permissionPresets) {
          try {
            (this.ctx as any).permissionPresets.set(agent.session, chosen)
          } catch (e) {
            this.ctx.logger.warn('feishu-duty', `set permissionPreset failed: ${e}`)
          }
        }

        const { list } = await this.sessionRegistry.fetch(targetSessionId)
        const s = list.find((x) => x.id === targetSessionId)
        const title = s?.title || targetSessionId

        const doneText = this.strings.modeCardSwitched
          ? this.strings.modeCardSwitched(title, chosen)
          : `✅ 会话「${title}」权限模式已切换为：🛡️ ${chosen}\n\n新权限预设在后续操作中即刻生效。`

        if (messageId !== undefined) {
          try {
            await this.client.editMessageText(this.receiveId(), messageId, doneText, { keyboard: [] })
          } catch {}
        }
        return { toast: { type: 'success', content: (this.strings.modeSwitched || '已切换为 ') + chosen } }
      }
    }

    const wiz = decodeWizardCallback(data)
    if (wiz) {
       if (this.wizardState) {
          if (wiz.step === 'model') {
             const idx = parseInt(wiz.index, 10)
             const mList = this.wizardLists.models || []
             const mObj = mList[idx]
             const model = typeof mObj === 'string' ? mObj : (mObj as any)?.id
             if (this.wizardState.provider && model) {
                try {
                   this.wizardLists.reasoningEfforts = await this.modelRegistry.resolveReasoningEfforts(this.wizardState.provider, model)
                } catch {
                   this.wizardLists.reasoningEfforts = []
                }
             }
          }
          const { state, action } = wizardCallback(this.wizardState, wiz, this.wizardLists)
          this.wizardState = state
          await this.handleWizardAction(action)
          return { toast: { type: 'info', content: '已选择' } }
       } else {
          return { toast: { type: 'info', content: this.strings.callbackUnknown } }
       }
    }

    const approval = parseApprovalCallback(data)
    if (approval !== null) {
      if (this.approvals.answer(approval.id, approval.decision)) {
        ack = approval.decision === 'allowed-once'
          ? this.strings.approvalAccepted(approval.id)
          : this.strings.approvalRejected(approval.id)
      } else {
        ack = this.strings.approvalUnknown(approval.id)
      }
    } else {
      const ask = parseAskCallback(data)
      if (ask !== null) {
        ack = this.asks.answerByIndex(ask.id, ask.index) ? this.strings.askAnswered : this.strings.callbackUnknown
      } else {
        ack = this.strings.callbackUnknown
      }
    }
    return { toast: { type: 'info', content: ack ?? '' } }
  }

  /** Send one text, split under the configured chunk size; never throws. Returns the first chunk's message id when known. */
  private async sendChunked(text: string, keyboard?: InlineKeyboard): Promise<string | undefined> {
    const chunks = chunkText(text, this.runtime.replyChunkChars ?? 1800)
    let firstMessageId: string | undefined
    for (const [index, chunk] of chunks.entries()) {
      try {
        let content = chunk
        const opts: { keyboard?: InlineKeyboard; parseMode?: 'md' } = {}
        if (index === 0 && keyboard !== undefined) opts.keyboard = keyboard
        if (this.runtime.richText !== false) {
          if (opts.keyboard === undefined) {
            content = markdownToLarkMd(chunk)
            opts.parseMode = 'md'
          }
        }

        let res = await this.client.sendMessage(this.receiveId(), content, { ...opts, receiveIdType: this.runtime.receiveIdType })

        if (res.ok === false && opts.parseMode === 'md') {
          // fallback to pure text
          const fallbackOpts: { keyboard?: InlineKeyboard } = {}
          if (index === 0 && keyboard !== undefined) fallbackOpts.keyboard = keyboard
          res = await this.client.sendMessage(this.receiveId(), chunk, { ...fallbackOpts, receiveIdType: this.runtime.receiveIdType })
        }

        if (index === 0 && res.ok) firstMessageId = res.result?.message_id
      } catch (error) {
        this.ctx.logger.warn('feishu-duty', `sendMessage failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return firstMessageId
  }
}
