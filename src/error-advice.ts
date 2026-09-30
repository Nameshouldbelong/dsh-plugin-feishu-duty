export type DutyErrorClass = { kind: 'context-overflow' | 'generic' }

/** Classify a duty-turn error string; context-overflow gets actionable user advice. */
export function classifyDutyError(error: string): DutyErrorClass {
  const s = error.toLowerCase()
  if (/token limit|context window|context.{0,20}exceed|exceed.{0,20}(token|context|limit)|too many tokens|prompt is too long/.test(s)) {
    return { kind: 'context-overflow' }
  }
  return { kind: 'generic' }
}
