// 契约测试：任务阶段看板渲染（v0.6.0 纯逻辑）
// 运行：node --test tests/todo-board.test.ts（Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTodoBoard, composeProgress } from '../src/todo-board.ts'

test('formatTodoBoard: 三态映射 ✅/⚙️/⏱️', () => {
  const out = formatTodoBoard([
    { content: '任务理解', status: 'completed' },
    { content: '任务规划', status: 'in_progress' },
    { content: '任务执行', status: 'pending' },
  ])
  const lines = out.split('\n')
  assert.equal(lines[0], '✅ 任务理解')
  assert.equal(lines[1], '⚙️ 任务规划')
  assert.equal(lines[2], '⏱️ 任务执行')
})

test('formatTodoBoard: 空输入回退空串', () => {
  assert.equal(formatTodoBoard(null), '')
  assert.equal(formatTodoBoard(undefined), '')
  assert.equal(formatTodoBoard([]), '')
})

test('formatTodoBoard: 超行截断并提示剩余项数', () => {
  const todos = Array.from({ length: 15 }, (_, i) => ({ content: `项${i + 1}`, status: 'pending' as const }))
  const out = formatTodoBoard(todos, 12)
  const lines = out.split('\n')
  assert.equal(lines.length, 13) // 12 项 + 1 截断行
  assert.match(lines[12] as string, /3/) // 剩余 3 项
})

test('composeProgress: 无 todo 时保持单行阶段文案（v0.4.0 回退）', () => {
  assert.equal(composeProgress('🔧 执行工具：bash', null), '🔧 执行工具：bash')
  assert.equal(composeProgress('💭 思考中…', []), '💭 思考中…')
})

test('composeProgress: 有 todo 时拼接分隔线与看板', () => {
  const out = composeProgress('🔧 执行工具：bash', [
    { content: '读代码', status: 'completed' },
    { content: '改代码', status: 'in_progress' },
  ])
  assert.ok(out.startsWith('🔧 执行工具：bash'))
  assert.ok(out.includes('✅ 读代码'))
  assert.ok(out.includes('⚙️ 改代码'))
  // 分隔线在阶段行与看板之间
  const phaseEnd = out.indexOf('\n')
  const boardStart = out.indexOf('✅')
  assert.ok(phaseEnd > 0 && boardStart > phaseEnd)
})
