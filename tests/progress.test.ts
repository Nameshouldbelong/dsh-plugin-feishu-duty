// 契约测试：工作状态提示（功能 1 纯逻辑）
// 运行：node --test tests/ （Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatProgress, createThrottle } from '../src/progress.ts'

test('formatProgress: 四阶段 zh 文案非空且互不相同的模板', () => {
  const phases = ['received', 'thinking', 'tool', 'writing']
  const texts = phases.map((p) => formatProgress(p, { step: 2, toolName: 'bash' }, 'zh'))
  for (const t of texts) assert.ok(typeof t === 'string' && t.length > 0)
  assert.notEqual(texts[0], texts[1])
})

test('formatProgress: tool 阶段必须包含工具名', () => {
  const t = formatProgress('tool', { step: 3, toolName: 'web_search' }, 'zh')
  assert.ok(t.includes('web_search'))
})

test('formatProgress: thinking/writing 阶段必须包含步数', () => {
  assert.ok(formatProgress('thinking', { step: 5 }, 'zh').includes('5'))
  assert.ok(formatProgress('writing', { step: 7 }, 'en').includes('7'))
})

test('formatProgress: 支持 en 文案', () => {
  const t = formatProgress('received', {}, 'en')
  assert.ok(typeof t === 'string' && t.length > 0)
})

test('createThrottle: 窗口期内合并，尾部保证执行', async () => {
  const calls = []
  const throttled = createThrottle(30)
  throttled(() => calls.push('a'))
  throttled(() => calls.push('b'))
  throttled(() => calls.push('c'))
  await new Promise((r) => setTimeout(r, 100))
  // 立即执行第一次，尾部只执行最后一次
  assert.deepEqual(calls, ['a', 'c'])
})

test('createThrottle: 间隔足够时逐次执行', async () => {
  const calls = []
  const throttled = createThrottle(20)
  throttled(() => calls.push(1))
  await new Promise((r) => setTimeout(r, 50))
  throttled(() => calls.push(2))
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(calls, [1, 2])
})
