export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export function formatTodoBoard(todos: TodoItem[] | null | undefined, limit = 12, strings?: any): string {
  if (!todos || todos.length === 0) return ''
  let out = ''
  const displayCount = Math.min(todos.length, limit)
  for (let i = 0; i < displayCount; i++) {
    const t = todos[i]
    let icon = ''
    if (t.status === 'completed') icon = '✅'
    else if (t.status === 'in_progress') icon = '⚙️'
    else if (t.status === 'pending') icon = '⏱️'
    out += `${icon} ${t.content}\n`
  }
  if (todos.length > limit) {
    const diff = todos.length - limit
    const suffix = strings?.todoTruncated ? strings.todoTruncated(diff) : `... 等 ${diff} 项`
    out += `${suffix}\n`
  }
  return out.trimEnd()
}

export function composeProgress(phaseText: string, todos: TodoItem[] | null | undefined, strings?: any): string {
  const board = formatTodoBoard(todos, 12, strings)
  if (!board) return phaseText
  const separator = strings?.todoSeparator || '─────'
  return `${phaseText}\n${separator}\n${board}`
}
