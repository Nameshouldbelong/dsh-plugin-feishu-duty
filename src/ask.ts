import type { Strings } from './i18n.ts'
import type { InlineKeyboard } from './feishu.ts'

export interface FeishuAsk {
  question: string
  options: string[]
  signal?: AbortSignal
}

export interface FeishuAskOutcome {
  answered: boolean
  optionIndex?: number
  answer?: string
}

export function parseAskCallback(data: string): { id: number; index: number } | null {
  const match = /^ask:(\d+):(\d+)$/.exec(data)
  if (match === null) return null
  const id = Number(match[1])
  const index = Number(match[2])
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(index)) return null
  return { id, index }
}

export interface FeishuAskManagerDeps {
  timeoutMs: number
  strings: Strings
  send: (text: string, keyboard?: InlineKeyboard) => Promise<string | undefined>
  editMarkup?: (messageId: string, keyboard: InlineKeyboard, text?: string) => Promise<void>
  onAwaitingInput?: (id: number, resolve: (outcome: FeishuAskOutcome) => void) => void
  log?: (message: string) => void
  customVocabulary?: string[]
  freeze?: (info: { label: string; kind: string }) => void
}

interface PendingAsk {
  options: string[]
  /** The question text the card was built from (for decided-card rebuilds). */
  text?: string
  resolve: (outcome: FeishuAskOutcome) => void
  timer: ReturnType<typeof setTimeout>
  onAbort: () => void
  messageId?: string
  awaitingInput?: boolean
}

export function isCustomOptionLabel(label: string, customLabels: string[]): boolean {
  const t = label.trim().toLowerCase()
  for (const word of customLabels) {
    if (t === word.toLowerCase() || t.startsWith(word.toLowerCase())) return true
  }
  return false
}

export class FeishuAskManager {
  private nextId = 1
  private readonly pending = new Map<number, PendingAsk>()
  deps: FeishuAskManagerDeps

  constructor(deps: FeishuAskManagerDeps) {
    this.deps = deps
  }

  ask(ask: FeishuAsk): Promise<FeishuAskOutcome> {
    const id = this.nextId
    this.nextId += 1
    return new Promise<FeishuAskOutcome>((resolve) => {
      let settled = false
      const settle = (outcome: FeishuAskOutcome): void => {
        if (settled) return
        settled = true
        const entry = this.pending.get(id)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          ask.signal?.removeEventListener('abort', entry.onAbort)

          if (entry.messageId && this.deps.editMarkup) {
            let btnText = this.deps.strings.cancelledLabel || '— 已取消'
            if (outcome.answered && outcome.answer) {
               btnText = (this.deps.strings.selectedLabel || '✅ 已选：') + outcome.answer
            }
            this.deps.editMarkup(entry.messageId, [[{ text: btnText, callback_data: 'noop' }]], entry.text).catch(() => {})
          }
          if (this.deps.freeze) {
             let kind = 'cancelled'
             let label = '— 已取消'
             if (outcome.answered && outcome.answer) {
                 kind = 'selected'
                 label = outcome.answer
             }
             this.deps.freeze({ label, kind })
          }
          this.pending.delete(id)
        }
        resolve(outcome)
      }

      const timeoutSettle = (): void => {
        if (settled) return
        settled = true
        const entry = this.pending.get(id)
        if (entry !== undefined) {
          clearTimeout(entry.timer)
          ask.signal?.removeEventListener('abort', entry.onAbort)

          if (entry.messageId && this.deps.editMarkup) {
            this.deps.editMarkup(entry.messageId, [[{ text: this.deps.strings.timeoutLabel || '⏱ 已超时', callback_data: 'noop' }]], entry.text).catch(() => {})
          }
          if (this.deps.freeze) {
              this.deps.freeze({ label: '⏱ 已超时', kind: 'timeout' })
          }
          this.pending.delete(id)
        }
        const minutes = Math.round(this.deps.timeoutMs / 60_000)
        void this.deps.send(this.deps.strings.askTimeout(minutes)).catch(() => undefined)
        resolve({ answered: false })
      }

      const onAbort = (): void => settle({ answered: false })

      const entry: PendingAsk = {
        options: ask.options,
        resolve: settle,
        onAbort,
        timer: setTimeout(timeoutSettle, this.deps.timeoutMs),
      }
      this.pending.set(id, entry)
      ask.signal?.addEventListener('abort', onAbort, { once: true })

      if (ask.signal?.aborted === true) {
        settle({ answered: false })
        return
      }

      const minutes = Math.round(this.deps.timeoutMs / 60_000)
      const keyboard: InlineKeyboard = ask.options.map((option, index) => [{
        text: option,
        callback_data: `ask:${id}:${index}`,
      }])
      const text = this.deps.strings.askQuestion(ask.question, minutes)

      void this.deps
        .send(text, keyboard)
        .then((mid) => {
          if (mid) {
            entry.messageId = mid
            entry.text = text
          }
        })
        .catch((error: unknown) => {
          this.deps.log?.(`failed to send ask #${id}: ${error instanceof Error ? error.message : String(error)}`)
        })
    })
  }

  answerByIndex(id: number, index: number): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    const option = entry.options[index]
    if (option === undefined) return false

    if (this.deps.customVocabulary && isCustomOptionLabel(option, this.deps.customVocabulary)) {
       entry.awaitingInput = true
       if (entry.messageId && this.deps.editMarkup) {
          this.deps.editMarkup(entry.messageId, [[{ text: this.deps.strings.customWaitLabel || '✏️ 等待输入…', callback_data: 'noop' }]], entry.text).catch(() => {})
       }
       if (this.deps.onAwaitingInput) {
          this.deps.onAwaitingInput(id, entry.resolve)
       }
       return true
    }

    entry.resolve({ answered: true, optionIndex: index, answer: option })
    return true
  }

  answerByLabel(label: string): boolean {
    const trimmed = label.trim().toLowerCase()
    const entries = [...this.pending.entries()].reverse()
    for (const [, entry] of entries) {
      const index = entry.options.findIndex(option => option.trim().toLowerCase() === trimmed)
      if (index === -1) continue
      const option = entry.options[index]
      if (option === undefined) continue

      if (this.deps.customVocabulary && isCustomOptionLabel(option, this.deps.customVocabulary)) {
         return false
      }

      entry.resolve({ answered: true, optionIndex: index, answer: option })
      return true
    }
    return false
  }

  answerCustomInput(text: string): boolean {
    for (const [, entry] of this.pending) {
      if (entry.awaitingInput) {
        entry.resolve({ answered: true, answer: text })
        return true
      }
    }
    return false
  }

  cancelCustomInput(): boolean {
    for (const [, entry] of this.pending) {
      if (entry.awaitingInput) {
        entry.resolve({ answered: false })
        return true
      }
    }
    return false
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) entry.resolve({ answered: false })
    this.pending.clear()
  }
}
