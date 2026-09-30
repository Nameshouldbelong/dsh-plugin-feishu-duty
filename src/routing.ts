export function resolveTargetSessionId(raw: string | undefined | null, defaultId: string): string {
  if (raw === undefined || raw === null) return defaultId
  const trimmed = raw.trim()
  return trimmed === '' ? defaultId : trimmed
}

/** Resolve the session a Telegram attachment turn runs in: bridged target wins, else duty. */
export function resolveAttachmentTarget(opts: { runtimeSessionId?: string; bridgedSessionId?: string | null }): string {
  const fallback = opts.runtimeSessionId ?? 'feishu-duty'
  return resolveTargetSessionId(opts.bridgedSessionId, fallback)
}

export class SessionChains {
  private readonly chains = new Map<string, Promise<void>>()
  private generation = 0
  private pending = 0

  enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    this.pending++
    const enqueuedGen = this.generation
    const currentChain = this.chains.get(sessionId) ?? Promise.resolve()
    
    const nextChain = currentChain
      .catch(() => {})
      .then(async () => {
        if (this.generation !== enqueuedGen) {
          this.pending--
          return
        }
        try {
          await task()
        } finally {
          this.pending--
        }
      })

    this.chains.set(sessionId, nextChain)
    nextChain.finally(() => {
      if (this.chains.get(sessionId) === nextChain) {
        this.chains.delete(sessionId)
      }
    })
    
    return nextChain
  }

  cancelAll(): void {
    this.generation++
  }

  pendingCount(): number {
    return this.pending
  }
}
