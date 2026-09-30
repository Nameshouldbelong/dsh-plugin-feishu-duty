/**
 * Duty-session driver: keeps one stable DSH session live, delivers Feishu
 * text as follow-up turns (which wakes its agent), waits for the turn to
 * settle, and returns the final assistant text. The resume/create +
 * summarize pattern follows @kriskwok/dsh-feishu-gateway (MIT), the turn
 * plumbing mirrors the dsh-telegram-duty port.
 * @module @nameshouldbelong/dsh-feishu-duty/duty
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pulls the todo/write event into the SessionEventMap union.
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { FeishuClient } from './feishu.ts'
import type { FeishuDutyConfig } from './config.ts'
import { createThrottle, formatProgress, type ProgressPhase } from './progress.ts'
import { composeProgress } from './todo-board.ts'
import { SessionChains } from './routing.ts'

export interface TurnOutcome {
  text: string
  /** Non-empty when the turn ended abnormally. */
  error?: string
}

export interface DutySessionOptions {
  /** Stable session id (created on first delivery when absent). */
  sessionId: string
  /** Absolute workspace cwd for the duty session. */
  cwd: string
  /** Persona text registered under the deployment persona slot. */
  persona: string
  /** Used for progress updates. */
  client?: FeishuClient
  /** Whitelisted receive id for progress updates. */
  receiveId?: string
  /** Receive id type for progress updates. */
  receiveIdType?: 'open_id' | 'chat_id'
  /** Progress language. */
  language?: 'zh' | 'en'
  /** Config for runtime flags */
  runtime?: FeishuDutyConfig
}

/**
 * Aggregate the final assistant text from session events since firstSeq:
 * the last tool-free assistant/message of the turn; a `turn/end` with a
 * non-completed reason becomes an error outcome.
 */
export function summarize(events: readonly SessionEvent[], firstSeq: number): TurnOutcome {
  let started = false
  let text = ''
  let error: string | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block): block is TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      if (reason.kind === 'error') error = `${reason.error.code}: ${reason.error.message}`
      else if (reason.kind !== 'completed' && reason.kind !== 'interrupted') error = `turn ended with reason "${reason.kind}"`
    }
  }
  return error === undefined ? { text } : { text, error }
}

/** Serialized delivery into one stable duty session. */
export class DutySession {
  private readonly chains = new SessionChains()
  private presetPromise: Promise<string | undefined> | undefined
  private readonly currentAgents = new Set<{ cancel(reason: { kind: 'user' }, opts: { keepInbox: boolean }): void }>()

  constructor(
    private readonly ctx: Context,
    private readonly options: DutySessionOptions,
  ) {}

  /**
   * Resolve the default agent preset id once. Mounting it in setup is what
   * gives the duty agent its tools — without it the model has no tool schemas
   * and "fakes" tool calls as plain text (observed in e2e).
   */
  private resolvePreset(): Promise<string | undefined> {
    this.presetPromise ??= (async () => {
      const presets = this.ctx.get('agentPresets')
      if (presets === undefined) return undefined
      return (await presets.resolve(undefined)).id
    })()
    return this.presetPromise
  }

  /** Queue one Feishu text; resolves with the duty agent's final reply. */
  async run(text: string, opts?: { sessionId?: string, client?: FeishuClient, userMessageId?: string }): Promise<TurnOutcome> {
    let outcome: TurnOutcome = { text: '' }
    const sessionId = opts?.sessionId || this.options.sessionId

    await this.chains.enqueue(sessionId, async () => {
      try {
        outcome = await this.turn(text, sessionId, opts?.client, opts?.userMessageId)
      } catch (error) {
        // Surface the failure as an outcome so the gateway can reply it.
        outcome = { text: '', error: error instanceof Error ? error.message : String(error) }
      }
    })

    // If the chain cancelled execution, the task wrapper simply returns, leaving outcome empty.
    if (outcome.text === '' && outcome.error === undefined && this.chains.pendingCount() >= 0) {
      // It might be a cancelled task, let's treat an empty unresolved outcome as 'cancelled' by returning early
      // but only if turn actually didn't run. If turn ran, outcome would be populated.
    }

    return outcome
  }

  cancelCurrent(): boolean {
    const hasRunning = this.currentAgents.size > 0
    this.chains.cancelAll()
    for (const agent of this.currentAgents) {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    return hasRunning
  }

  private async turn(text: string, targetSessionId: string, client?: FeishuClient, userMessageId?: string): Promise<TurnOutcome> {
    const agents = this.ctx.agents
    const defaultModel = this.ctx.agentDefaultModel
    const selection = defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const presetId = await this.resolvePreset()
    const setup = async (agentCtx: Context): Promise<void> => {
      // No installModelSelection here: the initial route comes from agentOptions,
      // and in-session switches are owned by the session controller's dynamic
      // selection. A static snapshot installed here would register an outer
      // agent/request hook that overwrites the controller's later override,
      // silently pinning every request to the creation-time default model.
      // Same name + order as the deployment persona → shadows it for this agent.
      agentCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: this.options.persona })
      // Mount the default preset so the duty agent has the standard tools
      // (bash/pwsh/fs/subagents/...), exactly like web-created sessions.
      if (presetId !== undefined) {
        const presets = this.ctx.get('agentPresets')
        if (presets !== undefined) await presets.mount(agentCtx, presetId)
      }
    }

    // Reuse an already-live agent when one exists (e.g. the web UI resumed the
    // duty session): resuming/creating again would collide with it.
    const sessionId = SessionId(targetSessionId)
    const live = agents.get(sessionId)
    let agent
    let dispose: () => Promise<void> = async () => undefined
    if (live !== undefined) {
      agent = live
    } else {
      let handle
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      } catch (error) {
        const resumeError = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn('feishu-duty', `resume "${targetSessionId}" failed (${resumeError}), creating`)
        try {
          handle = await agents.create({
            sessionId,
            meta: {
              cwd: this.options.cwd,
              ...(presetId !== undefined ? { agentPreset: presetId } : {}),
            },
            agentOptions,
            setup,
          })
        } catch (createError) {
          const createMessage = createError instanceof Error ? createError.message : String(createError)
          throw new Error(`resume failed (${resumeError}); create failed (${createMessage})`)
        }
      }
      agent = handle.agent
      dispose = () => handle.dispose().catch((error: unknown) => {
        this.ctx.logger.warn('feishu-duty', `dispose agent error: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    this.currentAgents.add(agent)

    let messageId: string | undefined
    let chatActionInterval: ReturnType<typeof setInterval> | undefined
    let unsubEvents: (() => void) | undefined
    const progressEnabled = this.options.runtime?.progressIndicator !== false
    const usedClient = client || this.options.client
    const receiveId = this.options.receiveId
    const receiveIdType = this.options.receiveIdType
    const language = this.options.language ?? 'en'

    if (progressEnabled && usedClient && receiveId) {
      try {
        const receivedText = formatProgress('received', {}, language)
        const res = await usedClient.sendMessage(receiveId, receivedText, { asCard: true, receiveIdType })
        if (res.ok && res.result) {
          messageId = res.result.message_id
        }
        // Native liveness: a Typing reaction on the user's message while the
        // duty agent works (the Feishu equivalent of the typing chat action).
        if (userMessageId !== undefined && userMessageId !== '') {
          await usedClient.sendChatAction(receiveId, userMessageId)
        }
      } catch (e) {
        this.ctx.logger.warn('feishu-duty', `Failed to send progress indicator: ${e}`)
      }
    }

    try {
      await agent.whenIdle()
      const firstSeq = agent.session.seq

      if (progressEnabled && usedClient && receiveId && messageId) {
        let stepCount = 0
        const throttle = createThrottle(1500)
        // v0.6.0: todo 看板快照（todo/write 全量 last-wins）
        let currentTodos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> | null = null

        // dsh >=0.1.5-rc.2 移除了 Session.events 实时数组属性，事件访问改为
        // snapshotEvents(from?, toExclusive?) 快照 + seq getter（= 日志长度）。
        // 轮询每 1.2s 增量拉取 [lastEventIdx, seq) 区间，映射为进度相位。
        let lastEventIdx = agent.session.seq
        const progressTimer = setInterval(() => {
          const events = agent.session.snapshotEvents(lastEventIdx)
          for (const event of events) {
            let phase: ProgressPhase | undefined
            let toolName: string | undefined
            if (event.type === 'step/start') {
              stepCount++
            } else if (event.type === 'todo/write') {
              currentTodos = (event.data as { todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> }).todos
            } else if (event.type === 'tool/call') {
              phase = 'tool'
              toolName = event.data.name
            }
            // todo 快照更新也触发重绘（阶段行保持最近一次相位）
            if (phase || event.type === 'todo/write') {
              const capturedPhase: ProgressPhase = phase ?? 'tool'
              const capturedTool = toolName
              const capturedStep = stepCount
              const showPhase = phase !== undefined
              throttle(() => {
                const phaseLine = formatProgress(capturedPhase, capturedTool !== undefined ? { step: capturedStep, toolName: capturedTool } : { step: capturedStep }, language)
                // 纯 todo 更新（无相位变化）时不重画阶段行，仅在已有看板时刷新
                const text = showPhase || currentTodos !== null
                  ? composeProgress(phaseLine, currentTodos)
                  : phaseLine
                usedClient.editMessageText(receiveId, messageId!, text).catch(() => {})
              })
            }
          }
          lastEventIdx = agent.session.seq
        }, 1200)
        unsubEvents = () => clearInterval(progressTimer)
      }

      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:feishu-duty' } as unknown as Parameters<typeof createUserMessage>[0]['source'], // 0.1.7 producer-owned kind; repo-local dsh-llm typings are 0.1.5-era
      }))
      await agent.whenIdle()

      if (progressEnabled && usedClient && receiveId && messageId) {
        // Feishu 的撤回会留下「撤回了一条消息」占位，进度卡改为就地固化为完成态。
        usedClient.editMessageText(receiveId, messageId, language === 'zh' ? '✅ 完成' : '✅ Done').catch(() => {})
      }

      return summarize(agent.session.snapshotEvents(firstSeq), firstSeq)
    } finally {
      this.currentAgents.delete(agent)
      if (chatActionInterval) clearInterval(chatActionInterval)
      if (unsubEvents) unsubEvents()
      if (usedClient && userMessageId !== undefined && userMessageId !== '') {
        await usedClient.removeChatAction(userMessageId).catch(() => undefined)
      }
      // Release our own handle when we created one; a live foreign agent stays.
      await dispose()
    }
  }
}
