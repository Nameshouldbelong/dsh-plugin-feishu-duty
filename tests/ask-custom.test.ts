// 契约测试：ask 自定义输入直通（v0.6.0）
// 运行：node --test tests/ask-custom.test.ts（Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FeishuAskManager, isCustomOptionLabel } from '../src/ask.ts'

const VOCAB = ['自行输入', '自定义', '其他', '手动输入', '自己输入', 'other', 'custom', 'manual']

const mockStrings = {
  askQuestion: (q: string, _m: number) => q,
  askTimeout: (_m: number) => 'timeout',
} as never

function makeManager(extra?: Record<string, unknown>) {
  const sent: Array<{ text: string }> = []
  const manager = new FeishuAskManager({
    timeoutMs: 200,
    strings: mockStrings,
    send: async (text: string) => { sent.push({ text }) },
    customVocabulary: VOCAB,
    ...extra,
  } as never)
  return { manager, sent }
}

test('isCustomOptionLabel: 词表识别', () => {
  assert.equal(isCustomOptionLabel('自行输入', VOCAB), true)
  assert.equal(isCustomOptionLabel('其他', VOCAB), true)
  assert.equal(isCustomOptionLabel('其他（自行说明）', VOCAB), true) // 前缀命中
  assert.equal(isCustomOptionLabel('Other', VOCAB), true) // 大小写不敏感
  assert.equal(isCustomOptionLabel('  custom ', VOCAB), true)
  assert.equal(isCustomOptionLabel('选项A', VOCAB), false)
  assert.equal(isCustomOptionLabel('使用默认值', VOCAB), false)
})

test('custom 选项点选：不立即 settle，等待文本输入', async () => {
  const { manager } = makeManager({ timeoutMs: 500 })
  const outcomeP = manager.ask({ question: '选哪个？', options: ['A', '其他'] })
  // 点「其他」（index 1）→ 进入等待输入，不 resolve
  const settledEarly = await Promise.race([
    outcomeP.then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('pending'), 40)),
  ])
  // answerByIndex 返回 true（识别为有效回调）但 outcome 不 resolve
  assert.equal((manager as never as { answerByIndex(id: number, i: number): boolean }).answerByIndex(1, 1), true)
  const stillPending = await Promise.race([
    outcomeP.then(() => 'settled'),
    new Promise((r) => setTimeout(() => r('pending'), 40)),
  ])
  assert.equal(stillPending, 'pending')
  assert.equal(settledEarly, 'pending')
  // 文本直通：作为 answer resolve
  assert.equal(manager.answerCustomInput('用户真实内容'), true)
  const outcome = await outcomeP
  assert.equal(outcome.answered, true)
  assert.equal(outcome.answer, '用户真实内容')
  assert.equal(outcome.optionIndex, undefined)
})

test('custom 等待中 /cancel：按未答 resolve', async () => {
  const { manager } = makeManager()
  const outcomeP = manager.ask({ question: '选？', options: ['A', '自行输入'] })
  manager.answerByIndex(1, 1)
  assert.equal(manager.cancelCustomInput(), true)
  const outcome = await outcomeP
  assert.equal(outcome.answered, false)
})

test('custom 等待中超时：按未答 resolve', async () => {
  const { manager } = makeManager()
  const outcomeP = manager.ask({ question: '选？', options: ['A', '其他'] })
  manager.answerByIndex(1, 1)
  const outcome = await outcomeP // timeoutMs=200 内无人输入
  assert.equal(outcome.answered, false)
})

test('普通选项不受 custom 机制影响', async () => {
  const { manager } = makeManager()
  const outcomeP = manager.ask({ question: '选？', options: ['A', '其他'] })
  manager.answerByIndex(1, 0)
  const outcome = await outcomeP
  assert.deepEqual(outcome, { answered: true, optionIndex: 0, answer: 'A' })
  // 无等待输入状态：answerCustomInput 返回 false
  assert.equal(manager.answerCustomInput('x'), false)
})

test('无 customVocabulary 时行为与 v0.4.0 完全一致（向后兼容）', async () => {
  const manager = new FeishuAskManager({ timeoutMs: 200, strings: mockStrings, send: async () => {} } as never)
  const outcomeP = manager.ask({ question: '选？', options: ['A', '其他'] })
  manager.answerByIndex(1, 1)
  const outcome = await outcomeP
  assert.deepEqual(outcome, { answered: true, optionIndex: 1, answer: '其他' })
})
