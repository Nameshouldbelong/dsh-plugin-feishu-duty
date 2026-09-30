// 契约测试：会话路由与 /stop 取消（v0.5.0 纯逻辑）
// 运行：node --test tests/routing.test.ts（Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTargetSessionId, SessionChains } from '../src/routing.ts'

test('resolveTargetSessionId: 空值回退默认', () => {
  assert.equal(resolveTargetSessionId('', 'feishu-duty'), 'feishu-duty')
  assert.equal(resolveTargetSessionId('   ', 'feishu-duty'), 'feishu-duty')
  assert.equal(resolveTargetSessionId(undefined, 'feishu-duty'), 'feishu-duty')
  assert.equal(resolveTargetSessionId(null, 'feishu-duty'), 'feishu-duty')
})

test('resolveTargetSessionId: 有效值原样返回（含 trim）', () => {
  assert.equal(resolveTargetSessionId(' session-x ', 'feishu-duty'), 'session-x')
})

test('SessionChains: 同一会话串行执行', async () => {
  const chains = new SessionChains()
  const order = []
  await Promise.all([
    chains.enqueue('s1', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('a') }),
    chains.enqueue('s1', async () => { order.push('b') }),
  ])
  assert.deepEqual(order, ['a', 'b'])
})

test('SessionChains: 不同会话互不阻塞', async () => {
  const chains = new SessionChains()
  const order = []
  await Promise.all([
    chains.enqueue('s1', async () => { await new Promise((r) => setTimeout(r, 50)); order.push('slow') }),
    chains.enqueue('s2', async () => { order.push('fast') }),
  ])
  assert.deepEqual(order, ['fast', 'slow'])
})

test('SessionChains: cancelAll 跳过排队任务，进行中的任务完成当次', async () => {
  const chains = new SessionChains()
  const ran = []
  const first = chains.enqueue('s1', async () => { await new Promise((r) => setTimeout(r, 40)); ran.push('running') })
  const queued = chains.enqueue('s1', async () => { ran.push('queued') })
  await new Promise((r) => setTimeout(r, 10))
  chains.cancelAll()
  await Promise.all([first, queued])
  assert.deepEqual(ran, ['running'])
})

test('SessionChains: cancelAll 后新任务可正常入队', async () => {
  const chains = new SessionChains()
  const ran = []
  chains.cancelAll()
  await chains.enqueue('s1', async () => { ran.push('ok') })
  assert.deepEqual(ran, ['ok'])
})

test('SessionChains: pendingCount 反映排队数', async () => {
  const chains = new SessionChains()
  assert.equal(chains.pendingCount(), 0)
  const p1 = chains.enqueue('s1', async () => { await new Promise((r) => setTimeout(r, 30)) })
  const p2 = chains.enqueue('s1', async () => {})
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(chains.pendingCount() >= 1, true)
  await Promise.all([p1, p2])
  assert.equal(chains.pendingCount(), 0)
})
