// 契约测试：按钮固化钩子（v0.6.0）
// 运行：node --test tests/button-freeze.test.ts（Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FeishuAskManager } from '../src/ask.ts'
import { ApprovalManager } from '../src/approval.ts'

const mockStrings = {
  askQuestion: (q: string, _m: number) => q,
  askTimeout: (_m: number) => 'timeout',
  approvalQuestion: (_id: number, tool: string, _r: string, _m: number) => tool,
  approvalTimeout: (_id: number, _m: number) => 'timeout',
  approveButton: '✅ 批准',
  rejectButton: '❌ 拒绝',
} as never

test('ask settle（点选）触发 freeze：kind=selected 且 label 为所选项', async () => {
  const frozen: Array<{ label: string; kind: string }> = []
  const manager = new FeishuAskManager({
    timeoutMs: 500,
    strings: mockStrings,
    send: async () => {},
    freeze: (info: { label: string; kind: string }) => { frozen.push(info) },
  } as never)
  const p = manager.ask({ question: 'q', options: ['甲', '乙'] })
  manager.answerByIndex(1, 1)
  await p
  assert.deepEqual(frozen, [{ label: '乙', kind: 'selected' }])
})

test('ask settle（超时）触发 freeze：kind=timeout', async () => {
  const frozen: Array<{ label: string; kind: string }> = []
  const manager = new FeishuAskManager({
    timeoutMs: 30,
    strings: mockStrings,
    send: async () => {},
    freeze: (info: { label: string; kind: string }) => { frozen.push(info) },
  } as never)
  await manager.ask({ question: 'q', options: ['甲'] })
  assert.equal(frozen.length, 1)
  assert.equal(frozen[0]?.kind, 'timeout')
})

test('approval settle 触发 freeze：批准/拒绝均为 selected 带按钮文案', async () => {
  const frozen: Array<{ label: string; kind: string }> = []
  const deps = {
    timeoutMs: 500,
    strings: mockStrings,
    send: async () => {},
    freeze: (info: { label: string; kind: string }) => { frozen.push(info) },
  } as never
  const manager = new ApprovalManager(deps)
  const p = manager.ask({ toolName: 'bash' } as never)
  manager.answer(1, 'allowed-once')
  await p
  assert.deepEqual(frozen, [{ label: '✅ 批准', kind: 'selected' }])
})

test('approval 超时触发 freeze：kind=timeout', async () => {
  const frozen: Array<{ label: string; kind: string }> = []
  const manager = new ApprovalManager({
    timeoutMs: 30,
    strings: mockStrings,
    send: async () => {},
    freeze: (info: { label: string; kind: string }) => { frozen.push(info) },
  } as never)
  await manager.ask({ toolName: 'bash' } as never)
  assert.equal(frozen[0]?.kind, 'timeout')
})

test('无 freeze 钩子时不报错（向后兼容）', async () => {
  const manager = new FeishuAskManager({ timeoutMs: 500, strings: mockStrings, send: async () => {} } as never)
  const p = manager.ask({ question: 'q', options: ['甲'] })
  manager.answerByIndex(1, 0)
  const outcome = await p
  assert.equal(outcome.answered, true)
})
