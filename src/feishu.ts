/**
 * Feishu (Lark) transport client. Wraps @larksuiteoapi/node-sdk for the
 * WebSocket long connection and JSON REST calls, and keeps a raw node:https
 * path (self-managed tenant token) for binary upload/download, mirroring the
 * method surface of the original Telegram client so the gateway, duty session
 * and interaction managers port one-to-one:
 *
 *   getUpdates (long poll)  → im.message.receive_v1 over WSClient
 *   sendMessage             → im.message.create (post/md text or interactive card)
 *   editMessageText         → im.message.patch (card rebuild)
 *   editMessageReplyMarkup  → im.message.patch (card rebuild from the text cache)
 *   sendChatAction(typing)  → message reaction (native "typing" emoji)
 *   sendDocument/getFile    → im files/images REST (multipart, 30MB)
 *   answerCallbackQuery     → card-action response toast (no separate API)
 * @module @nameshouldbelong/dsh-feishu-duty/feishu
 */

import * as https from 'node:https'
import * as fs from 'node:fs'
import * as lark from '@larksuiteoapi/node-sdk'
import { buildMultipart } from './feishu-multipart.ts'

const debug = process.env.FEISHU_DUTY_DEBUG === '1'
const debugLog = (...args: unknown[]): void => {
  if (debug) console.log('[feishu-duty]', ...args)
}

/** One inline keyboard row: text buttons carrying short callback payloads. */
export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>

/** Telegram-shaped call result so ported call sites keep their structure. */
export interface FeishuResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

/** A message the bot sent (or that we address), reduced to what we use. */
export interface FeishuMessageSent {
  message_id: string
  chat_id?: string
}

/** Normalized im.message.receive_v1 event. */
export interface FeishuIncomingMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  messageType: string
  /** Raw JSON string as delivered by Feishu. */
  content: string
  senderOpenId: string
  senderType: string
  mentions: Array<{ key?: string; id?: { open_id?: string; user_id?: string }; name?: string; mentioned_type?: string }>
}

/** Normalized card.action.trigger event. */
export interface FeishuCardAction {
  messageId?: string
  chatId?: string
  operatorOpenId?: string
  /** The payload the pressed button carried (button value `{ cb: string }`). */
  cb?: string
  raw: unknown
}

/** Response returned from a card action (Feishu applies it within ~3s). */
export interface CardActionResponse {
  toast?: { type: 'success' | 'info' | 'error'; content: string }
  card?: unknown
}

export interface FeishuClientOptions {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  onState?: (up: boolean) => void
  onError?: (error: Error) => void
}

/** Feishu interactive card with a markdown body and optional button rows. */
export interface FeishuCard {
  config?: { wide_screen_mode?: boolean }
  header?: { title?: { tag: 'plain_text'; content: string }; template?: string }
  elements: Array<Record<string, unknown>>
}

/** Build a markdown card body with optional inline buttons (appr colors). */
export function buildCard(text: string, keyboard?: InlineKeyboard, header?: string, template?: string): FeishuCard {
  const elements: Array<Record<string, unknown>> = []
  if (text !== '') {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: text } })
  }
  for (const row of keyboard ?? []) {
    if (row.length === 0) continue
    elements.push({
      tag: 'action',
      actions: row.map((button) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: button.text },
        type: buttonStyleFor(button.callback_data),
        value: { cb: button.callback_data },
      })),
    })
  }
  const card: FeishuCard = { config: { wide_screen_mode: true }, elements }
  if (header !== undefined && header !== '') {
    card.header = { title: { tag: 'plain_text', content: header }, ...(template !== undefined ? { template } : {}) }
  }
  return card
}

function buttonStyleFor(callbackData: string): 'primary' | 'danger' | 'default' {
  if (/^appr:\d+:allow$/.test(callbackData)) return 'primary'
  if (/^appr:\d+:reject$/.test(callbackData)) return 'danger'
  if (/^cmd:del:yes$/.test(callbackData)) return 'danger'
  return 'default'
}

const DOMAIN_HOSTS: Record<'feishu' | 'lark', string> = {
  feishu: 'open.feishu.cn',
  lark: 'open.larksuite.com',
}

/** Plain GET/POST returning status + raw body (binary path only). */
function request(url: string, options: https.RequestOptions, body?: Buffer, timeoutMs = 60_000): Promise<{ status: number; body: Buffer }> {
  debugLog('request:', options.method ?? 'GET', url)
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, method: options.method ?? 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`feishu request timed out after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Feishu client scoped to one custom app. All calls never throw on network or
 * API errors when a `FeishuResponse` is returned; only programming errors and
 * local file problems throw.
 */
export class FeishuClient {
  private readonly client: lark.Client
  private wsClient: lark.WSClient | null = null
  private startTimer: NodeJS.Timeout | null = null
  private stopped = true
  private readonly opts: FeishuClientOptions
  /** Text of recently sent/edited cards, for reply-markup-only rebuilds. */
  private readonly cardTexts = new Map<string, string>()
  private tenantToken: { token: string; expiresAt: number } | null = null

  constructor(opts: FeishuClientOptions) {
    this.opts = opts
    this.client = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    })
  }

  /**
   * Start the WS long connection (idempotent, never throws): a failed first
   * start retries with fixed backoff — the Poller's reconnect loop, lifted
   * into the SDK client. Handlers are wrapped: one bad event must not kill
   * the host process.
   */
  start(handlers: {
    onMessage: (message: FeishuIncomingMessage) => Promise<void> | void
    onCardAction: (action: FeishuCardAction) => Promise<CardActionResponse | void> | CardActionResponse | void
  }): void {
    if (!this.stopped) return
    this.stopped = false
    const safeMessage = (data: unknown): Promise<void> => (async () => {
      const message = normalizeIncoming(data)
      if (message === undefined) return
      await handlers.onMessage(message)
    })().catch((error: unknown) => {
      this.opts.onError?.(error instanceof Error ? error : new Error(String(error)))
    })
    const safeCardAction = async (data: unknown): Promise<CardActionResponse | undefined> => {
      try {
        const action = normalizeCardAction(data)
        if (action === undefined) return undefined
        const response = await handlers.onCardAction(action)
        return response ?? undefined
      } catch (error) {
        this.opts.onError?.(error instanceof Error ? error : new Error(String(error)))
        return { toast: { type: 'error', content: '处理失败，请重试' } }
      }
    }
    const boot = async (): Promise<void> => {
      try {
        const dispatcher = new lark.EventDispatcher({})
          .register({
            'im.message.receive_v1': safeMessage,
            'card.action.trigger': safeCardAction,
          } as never)
        this.wsClient = new lark.WSClient({
          appId: this.opts.appId,
          appSecret: this.opts.appSecret,
          domain: this.opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
          loggerLevel: lark.LoggerLevel.info,
          autoReconnect: true,
          handshakeTimeoutMs: 30_000,
        })
        debugLog('ws starting')
        await this.wsClient.start({ eventDispatcher: dispatcher })
        this.opts.onState?.(true)
        debugLog('ws started')
      } catch (error) {
        this.opts.onState?.(false)
        this.opts.onError?.(error instanceof Error ? error : new Error(String(error)))
        if (!this.stopped && this.startTimer === null) {
          this.startTimer = setTimeout(() => {
            this.startTimer = null
            void boot()
          }, 15_000)
          if (typeof this.startTimer === 'object' && this.startTimer !== null) this.startTimer.unref()
        }
      }
    }
    void boot()
  }

  /** Wind the WS down (idempotent). */
  stop(): void {
    this.stopped = true
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    if (this.wsClient !== null) {
      try {
        this.wsClient.close()
      } catch (error) {
        this.opts.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
      this.wsClient = null
    }
  }

  /** Identity check (used at startup to validate appId/appSecret). */
  async getBotInfo(): Promise<FeishuResponse<{ app_name?: string; open_id?: string }>> {
    try {
      const res = await this.client.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
      const data = (res as { bot?: { app_name?: string; open_id?: string } })?.bot
      return { ok: true, result: data }
    } catch (error) {
      return { ok: false, description: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Send one message. With a keyboard (or asCard) it becomes an interactive
   * card; otherwise rich text goes out as a post (md) message and plain text
   * as a text message. Resolves Telegram-shaped; never throws for API errors.
   */
  async sendMessage(receiveId: string, text: string, options: {
    keyboard?: InlineKeyboard
    parseMode?: 'md'
    asCard?: boolean
    receiveIdType?: 'open_id' | 'chat_id'
  } = {}): Promise<FeishuResponse<FeishuMessageSent>> {
    const useCard = options.asCard === true || (options.keyboard !== undefined && options.keyboard.length > 0)
    try {
      let res: { data?: { message_id?: string; chat_id?: string }; code?: number; msg?: string }
      if (useCard) {
        const card = buildCard(text, options.keyboard)
        res = await this.client.im.message.create({
          params: { receive_id_type: options.receiveIdType ?? 'open_id' },
          data: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
        })
        if (res.data?.message_id !== undefined) this.cardTexts.set(res.data.message_id, text)
      } else if (options.parseMode === 'md') {
        res = await this.client.im.message.create({
          params: { receive_id_type: options.receiveIdType ?? 'open_id' },
          data: {
            receive_id: receiveId,
            msg_type: 'post',
            content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text }]] } }),
          },
        })
      } else {
        res = await this.client.im.message.create({
          params: { receive_id_type: options.receiveIdType ?? 'open_id' },
          data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
        })
      }
      if (res.code !== undefined && res.code !== 0) {
        return { ok: false, description: res.msg, error_code: res.code }
      }
      return { ok: true, result: { message_id: res.data?.message_id ?? '', chat_id: res.data?.chat_id } }
    } catch (error) {
      return { ok: false, description: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Reply under one message; returns the created message id (empty on failure). */
  async reply(messageId: string, msgType: string, content: string): Promise<string> {
    const res = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: msgType, content },
    })
    this.assertOk(res, 'reply')
    return res.data?.message_id ?? ''
  }

  /** Reply with an interactive card; returns the created message id. */
  async replyCard(messageId: string, card: FeishuCard): Promise<string> {
    return this.reply(messageId, 'interactive', JSON.stringify(card))
  }

  /** Update a card message in place (the Feishu editMessageText). */
  async patchCard(messageId: string, card: FeishuCard): Promise<FeishuResponse<FeishuMessageSent>> {
    try {
      const res = await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      if (res.code !== undefined && res.code !== 0) {
        return { ok: false, description: res.msg, error_code: res.code }
      }
      return { ok: true, result: { message_id: messageId } }
    } catch (error) {
      return { ok: false, description: error instanceof Error ? error.message : String(error) }
    }
  }

  async editMessageText(receiveId: string, messageId: string, text: string, options: {
    keyboard?: InlineKeyboard
  } = {}): Promise<FeishuResponse<FeishuMessageSent>> {
    void receiveId
    this.cardTexts.set(messageId, text)
    return this.patchCard(messageId, buildCard(text, options.keyboard))
  }

  /** Replace a card's buttons, keeping its last known text (button freeze). */
  async editMessageReplyMarkup(messageId: string, keyboard: InlineKeyboard): Promise<FeishuResponse<FeishuMessageSent>> {
    const text = this.cardTexts.get(messageId) ?? ''
    return this.patchCard(messageId, buildCard(text, keyboard))
  }

  /** Cap the card text cache so long-running hosts stay bounded. */
  pruneCardCache(max = 500): void {
    while (this.cardTexts.size > max) {
      const oldest = this.cardTexts.keys().next().value
      if (oldest === undefined) break
      this.cardTexts.delete(oldest)
    }
  }

  async deleteMessage(messageId: string): Promise<FeishuResponse<boolean>> {
    try {
      const res = await this.client.im.message.delete({ path: { message_id: messageId } })
      if (res.code !== undefined && res.code !== 0) {
        return { ok: false, description: res.msg, error_code: res.code }
      }
      return { ok: true, result: true }
    } catch (error) {
      return { ok: false, description: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Native "typing" indicator: a Typing reaction on the user's message. */
  async sendChatAction(receiveId: string, userMessageId?: string): Promise<FeishuResponse<boolean>> {
    void receiveId
    if (userMessageId === undefined || userMessageId === '') return { ok: false, description: 'no message to react on' }
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: userMessageId },
        data: { reaction_type: { emoji_type: 'Typing' } },
      })
      if (res.code !== undefined && res.code !== 0) return { ok: false, description: res.msg, error_code: res.code }
      return { ok: true, result: true }
    } catch (error) {
      return { ok: false, description: error instanceof Error ? error.message : String(error) }
    }
  }

  async removeChatAction(userMessageId: string): Promise<void> {
    if (userMessageId === '') return
    try {
      const list = await this.client.im.messageReaction.list({ path: { message_id: userMessageId }, params: { reaction_type: 'Typing' } })
      for (const item of (list.data ?? []) as Array<{ reaction_id?: string; operator?: { operator_id?: { open_id?: string } } }>) {
        const reactionId = item.reaction_id
        if (reactionId === undefined) continue
        await this.client.im.messageReaction.delete({
          path: { message_id: userMessageId, reaction_id: reactionId },
        }).catch(() => undefined)
      }
    } catch {
      // Liveness is cosmetic; never surface reaction cleanup failures.
    }
  }

  /**
   * Upload one local file as an im file (or image) and send it. Feishu caps
   * uploads at 30MB. Caption travels as a separate md message before the file.
   */
  async sendDocument(receiveId: string, fileAbsPath: string, caption?: string, options: {
    receiveIdType?: 'open_id' | 'chat_id'
  } = {}): Promise<FeishuResponse<FeishuMessageSent>> {
    const stat = await fs.promises.stat(fileAbsPath)
    if (stat.size > 30 * 1024 * 1024) {
      throw new Error('File exceeds 30MB limit')
    }
    const fileName = fileAbsPath.split('/').pop() || 'file'
    const isImage = /\.(png|jpe?g|gif|bmp|webp|ico|tiff?)$/i.test(fileName)
    try {
      if (caption !== undefined && caption !== '') {
        await this.sendMessage(receiveId, caption, { parseMode: 'md', receiveIdType: options.receiveIdType })
      }
      const key = isImage
        ? await this.uploadImage(fileAbsPath)
        : await this.uploadFile(fileAbsPath)
      const msgType = isImage ? 'image' : 'file'
      const content = isImage ? { image_key: key } : { file_id: key }
      const res = await this.client.im.message.create({
        params: { receive_id_type: options.receiveIdType ?? 'open_id' },
        data: { receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) },
      })
      if (res.code !== undefined && res.code !== 0) {
        return { ok: false, description: res.msg, error_code: res.code }
      }
      return { ok: true, result: { message_id: res.data?.message_id ?? '', chat_id: res.data?.chat_id } }
    } catch (error) {
      return { ok: false, description: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Download one message resource (image/file/audio/...) to destAbsPath.
   * Uses the raw REST path with a self-managed tenant token; the SDK client
   * is JSON-oriented. 30MB guard mirrors the upload cap.
   */
  async downloadResource(messageId: string, fileKey: string, type: 'image' | 'file', destAbsPath: string): Promise<void> {
    const token = await this.tenantAccessToken()
    const host = DOMAIN_HOSTS[this.opts.domain === 'lark' ? 'lark' : 'feishu']
    const url = `https://${host}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`
    const res = await request(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } })
    if (res.status !== 200) {
      throw new Error(`Failed to download resource: HTTP ${res.status}`)
    }
    if (res.body.length > 30 * 1024 * 1024) {
      throw new Error('File exceeds 30MB limit')
    }
    await fs.promises.writeFile(destAbsPath, res.body)
  }

  /** Upload one local file via im files API; resolves the file_key. */
  async uploadFile(fileAbsPath: string): Promise<string> {
    const data = await fs.promises.readFile(fileAbsPath)
    const fileName = fileAbsPath.split('/').pop() || 'file'
    const fileType = feishuFileType(fileName)
    const token = await this.tenantAccessToken()
    const host = DOMAIN_HOSTS[this.opts.domain === 'lark' ? 'lark' : 'feishu']
    const { body, contentType } = buildMultipart(
      { file_type: fileType, file_name: fileName },
      { field: 'file', fileName, data },
    )
    const res = await request(`https://${host}/open-apis/im/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': String(body.length) },
    }, body, 120_000)
    const parsed = JSON.parse(res.body.toString('utf-8')) as { code?: number; msg?: string; data?: { file_key?: string } }
    if (parsed.code !== 0 || parsed.data?.file_key === undefined) {
      throw new Error(`upload failed: code=${parsed.code}, msg=${parsed.msg ?? 'unknown'}`)
    }
    return parsed.data.file_key
  }

  /** Upload one local image via im images API; resolves the image_key. */
  async uploadImage(fileAbsPath: string): Promise<string> {
    const data = await fs.promises.readFile(fileAbsPath)
    const fileName = fileAbsPath.split('/').pop() || 'image'
    const token = await this.tenantAccessToken()
    const host = DOMAIN_HOSTS[this.opts.domain === 'lark' ? 'lark' : 'feishu']
    const { body, contentType } = buildMultipart(
      { image_type: 'message' },
      { field: 'image', fileName, data },
    )
    const res = await request(`https://${host}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': String(body.length) },
    }, body, 120_000)
    const parsed = JSON.parse(res.body.toString('utf-8')) as { code?: number; msg?: string; data?: { image_key?: string } }
    if (parsed.code !== 0 || parsed.data?.image_key === undefined) {
      throw new Error(`image upload failed: code=${parsed.code}, msg=${parsed.msg ?? 'unknown'}`)
    }
    return parsed.data.image_key
  }

  /** Extract { file_key, type } from a received message's content JSON. */
  static resourceOf(messageType: string, contentJson: string): { fileKey: string; type: 'image' | 'file' } | null {
    try {
      const content = JSON.parse(contentJson) as Record<string, unknown>
      if (messageType === 'image' && typeof content.image_key === 'string') {
        return { fileKey: content.image_key, type: 'image' }
      }
      const fileKey = content.file_key ?? content.audio_key ?? content.video_key ?? content.media_key
      if (typeof fileKey === 'string' && fileKey !== '') {
        return { fileKey, type: 'file' }
      }
    } catch {
      // Malformed content: treated as "no resource".
    }
    return null
  }

  /** Close pooled sockets (plugin teardown) — the WS is closed by stop(). */
  close(): void {
    this.stop()
  }

  private assertOk(res: { code?: number; msg?: string }, scope: string): void {
    if (res.code !== undefined && res.code !== 0) {
      throw new Error(`Feishu API error [${scope}]: code=${res.code}, msg=${res.msg}`)
    }
  }

  /** Self-managed tenant token for the raw binary REST path. */
  private async tenantAccessToken(): Promise<string> {
    if (this.tenantToken !== null && this.tenantToken.expiresAt > Date.now() + 60_000) {
      return this.tenantToken.token
    }
    const host = DOMAIN_HOSTS[this.opts.domain === 'lark' ? 'lark' : 'feishu']
    const payload = Buffer.from(JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }), 'utf-8')
    const res = await request(`https://${host}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(payload.length) },
    }, payload)
    const parsed = JSON.parse(res.body.toString('utf-8')) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (parsed.code !== 0 || parsed.tenant_access_token === undefined) {
      throw new Error(`tenant token failed: code=${parsed.code}, msg=${parsed.msg ?? 'unknown'}`)
    }
    this.tenantToken = { token: parsed.tenant_access_token, expiresAt: Date.now() + (parsed.expire ?? 7200) * 1000 }
    return this.tenantToken.token
  }
}

/** Map a filename to a Feishu file_type (best effort; stream is the catch-all). */
function feishuFileType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  const table: Record<string, string> = {
    opus: 'opus', mp4: 'mp4', pdf: 'pdf', doc: 'doc', docx: 'doc',
    xls: 'xls', xlsx: 'xls', ppt: 'ppt', pptx: 'ppt',
  }
  return table[ext] ?? 'stream'
}

/** Normalize one im.message.receive_v1 payload; undefined when unusable. */
export function normalizeIncoming(data: any): FeishuIncomingMessage | undefined {
  const message = data?.message
  if (message === undefined || message === null) return undefined
  return {
    messageId: String(message.message_id ?? ''),
    chatId: String(message.chat_id ?? ''),
    chatType: message.chat_type === 'group' ? 'group' : 'p2p',
    messageType: String(message.message_type ?? ''),
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? {}),
    senderOpenId: String(data?.sender?.sender_id?.open_id ?? ''),
    senderType: String(data?.sender?.sender_type ?? ''),
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
  }
}

/** Normalize a raw card.action.trigger payload; undefined when unusable. */
export function normalizeCardAction(data: any): FeishuCardAction | undefined {
  if (data === undefined || data === null || typeof data !== 'object') return undefined
  const context = typeof data.context === 'object' && data.context !== null ? data.context : {}
  const operator = typeof data.operator === 'object' && data.operator !== null ? data.operator : {}
  const action = typeof data.action === 'object' && data.action !== null ? data.action : {}
  const value = action.value
  const cb = value !== undefined && value !== null && typeof value === 'object' && typeof (value as { cb?: unknown }).cb === 'string'
    ? (value as { cb: string }).cb
    : undefined
  return {
    messageId: String(context.open_message_id ?? data.open_message_id ?? '') || undefined,
    chatId: String(context.open_chat_id ?? data.open_chat_id ?? '') || undefined,
    operatorOpenId: String(operator.open_id ?? '') || undefined,
    cb,
    raw: data,
  }
}

/** Extract plain text from a received message's content (best effort). */
export function extractText(message: FeishuIncomingMessage): string {
  try {
    const content = JSON.parse(message.content) as Record<string, unknown>
    if (message.messageType === 'text' && typeof content.text === 'string') {
      let text = content.text
      for (const mention of message.mentions) {
        const key = mention.key ?? ''
        if (key !== '') text = text.split(key).join(`@${mention.name ?? ''}`)
      }
      return text
    }
    if (message.messageType === 'post') {
      const parts: string[] = []
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const child of node) walk(child)
          return
        }
        if (node !== null && typeof node === 'object') {
          const record = node as Record<string, unknown>
          if (record.tag === 'text' || record.tag === 'a') {
            if (typeof record.text === 'string') parts.push(record.text)
          } else if (typeof record.content === 'string') {
            parts.push(record.content)
          } else {
            for (const value of Object.values(record)) walk(value)
          }
        }
      }
      walk(content)
      return parts.join('')
    }
  } catch {
    // Malformed content: fall through to empty text.
  }
  return ''
}
