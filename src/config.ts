/**
 * Feishu duty gateway configuration. Explicit values in this schema
 * (settings / patch row config) always win; an optional `credentialsFile`
 * can supply appId / appSecret / receive_id defaults.
 * @module @nameshouldbelong/dsh-feishu-duty/config
 */

import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

/** Settings document namespace owned by this plugin. */
// dsh-settings >=0.1.5 移除了 settingsNamespace() 运行时导出；register/update
// 直接接受 lowercase kebab-case 字符串字面量（SettingsNamespaceInput 校验）。
export const FEISHU_DUTY_NAMESPACE = 'feishu-duty'

/**
 * State-marker namespaces: the web settings wire is allowlisted, so the
 * browser half cannot READ this plugin's configuration namespace. Instead the
 * host writes a timestamp into the marker namespace matching the current watch
 * mode; the forwarded `settings/document-updated` event carries the namespace
 * name verbatim, and the banner derives the mode from WHICH marker moved.
 */
export const DUTY_STATE_ON_NAMESPACE = 'feishu-duty-on'
export const DUTY_STATE_OFF_NAMESPACE = 'feishu-duty-off'

/** Trivial schema for the state-marker sections. */
export const StateMarkerConfig: Schema<any, any> = z.object({
  n: z.number().default(0),
})

/** User-facing configuration; every field defaults at the schema boundary. */
export interface FeishuDutyConfig {
  /** Feishu custom app id. Empty means "read from credentialsFile" when one is set. */
  appId?: string
  /** Feishu custom app secret (secret, hidden in the settings UI). */
  appSecret?: string
  /** API domain: feishu (默认，国内) or lark (国际版). */
  domain?: 'feishu' | 'lark'
  /** Whitelist id type: open_id（私聊发送者）或 chat_id（会话，含群）. */
  receiveIdType?: 'open_id' | 'chat_id'
  /** Allowed Feishu id (whitelist) — the open_id of the user, or a chat id. */
  receiveId?: string
  /** Stable DSH session id for the duty session (auto-created on first message). */
  sessionId?: string
  /** Absolute workspace cwd for the duty session (defaults to process cwd). */
  dutyCwd?: string
  /** Approval timeout in minutes; unanswered approvals are rejected. */
  approvalTimeoutMinutes?: number
  /** Watch toggle: local (web approvals) or duty (Feishu approvals). */
  watchMode?: 'local' | 'duty'
  /** Language of all Feishu messages: zh or en. */
  language?: 'zh' | 'en'
  /** Plugin data directory (inbox persistence); defaults under DSH_HOME. */
  dataDir?: string
  /** Optional JSON file holding appId / appSecret / receive_id defaults. */
  credentialsFile?: string
  /** Feishu reply chunk threshold; longer replies are split across messages. */
  replyChunkChars?: number
  /** Enable dynamic progress indicator during duty agent work. */
  progressIndicator?: boolean
  /** Enable multimedia receiving and sending. */
  mediaEnabled?: boolean
  /** Enable Feishu rich text (post/md + cards) rendering for replies. */
  richText?: boolean
  /** Disable the Feishu long-connection loop (safe compatibility verification mode). */
  disablePoller?: boolean
  /** Last duty-mode toggle timestamp (internal; browser mode channel rides it). */
  stateOn?: { n?: number }
  /** Last duty-mode toggle timestamp (internal; browser mode channel rides it). */
  stateOff?: { n?: number }
}

export const Config: Schema<any, any> = z.object({
  appId: z.string().role('secret').default('').volatile(),
  appSecret: z.string().role('secret').default('').volatile(),
  domain: z.union([z.const('feishu'), z.const('lark')]).default('feishu').volatile(),
  receiveIdType: z.union([z.const('open_id'), z.const('chat_id')]).default('open_id').volatile(),
  receiveId: z.string().default('').volatile(),
  sessionId: z.string().default('feishu-duty').volatile(),
  dutyCwd: z.string().default('').volatile(),
  approvalTimeoutMinutes: z.number().default(10).volatile(),
  watchMode: z.union([z.const('local'), z.const('duty')]).default('local').volatile(),
  language: z.union([z.const('zh'), z.const('en')]).default('en').volatile(),
  dataDir: z.string().default('').volatile(),
  credentialsFile: z.string().default('').volatile(),
  replyChunkChars: z.number().default(1800).volatile(),
  progressIndicator: z.boolean().default(true).volatile(),
  mediaEnabled: z.boolean().default(true).volatile(),
  richText: z.boolean().default(true).volatile(),
  disablePoller: z.boolean().default(false).volatile(),
  stateOn: z.object({ n: z.number() }).volatile(),
  stateOff: z.object({ n: z.number() }).volatile(),
})

/** Unwrap a volatile field reference (0.1.7 schemastery wraps parsed values
 * of .volatile() fields in live references with .get()). */
export function unwrapField<T>(value: T): T {
  return value && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? ((value as unknown as { get: () => unknown }).get() as T)
    : value
}

/** Apply schema defaults (and surface schema errors early). */
export function resolveConfig(config: FeishuDutyConfig = {}): FeishuDutyConfig {
  const parsed = Config(config) as FeishuDutyConfig
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) out[key] = unwrapField(value)
  return out as FeishuDutyConfig
}

/** Shape of the notify bridge credentials file (subset we use). */
export interface CredentialsFile {
  app_id?: string
  app_secret?: string
  receive_id?: string
  receive_id_type?: 'open_id' | 'chat_id'
}
