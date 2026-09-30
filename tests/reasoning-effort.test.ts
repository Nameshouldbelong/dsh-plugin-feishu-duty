// 契约测试：/new 向导模型思考强度状态机（v0.8.1 纯逻辑）
// 运行：node --test tests/reasoning-effort.test.ts（Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeWizardCallback,
  decodeWizardCallback,
  wizardStart,
  wizardCallback,
  WIZARD_STEPS,
  type WizardState,
} from '../src/wizard.ts'

test('callback 编解码往返：reasoning 步（防 64 字节上限）', () => {
  const data = encodeWizardCallback('reasoning', 2)
  assert.ok(data.length <= 64)
  assert.deepEqual(decodeWizardCallback(data), { step: 'reasoning', index: '2' })

  const skipData = encodeWizardCallback('reasoning', 'skip')
  assert.ok(skipData.length <= 64)
  assert.deepEqual(decodeWizardCallback(skipData), { step: 'reasoning', index: 'skip' })
})

test('步序包含 reasoning：cwd→name→provider→model→reasoning→permission→preset→confirm', () => {
  assert.deepEqual(WIZARD_STEPS, [
    'cwd',
    'name',
    'provider',
    'model',
    'reasoning',
    'permission',
    'preset',
    'confirm',
  ])
})

test('当模型支持思考强度时，model 步选定后进入 reasoning 步', () => {
  const s: WizardState = {
    step: 'model',
    cwd: '/data',
    name: 'test',
    provider: 'deepseek',
  }
  const efforts = [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ]
  const r = wizardCallback(
    s,
    { step: 'model', index: '0' },
    {
      models: [{ id: 'deepseek-reasoner' }],
      reasoningEfforts: efforts,
    }
  )
  assert.equal(r.state.step, 'reasoning')
  assert.equal(r.state.model, 'deepseek-reasoner')
})

test('在 reasoning 步点选思考强度进入 permission 步', () => {
  const s: WizardState = {
    step: 'reasoning',
    cwd: '/data',
    name: 'test',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
  }
  const efforts = [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
  ]
  const r = wizardCallback(
    s,
    { step: 'reasoning', index: '1' },
    { reasoningEfforts: efforts }
  )
  assert.equal(r.state.step, 'permission')
  assert.equal(r.state.reasoningEffort, 'high')
})

test('在 reasoning 步点选跳过 (skip) 进入 permission 步且 reasoningEffort 为 undefined', () => {
  const s: WizardState = {
    step: 'reasoning',
    cwd: '/data',
    name: 'test',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
  }
  const r = wizardCallback(s, { step: 'reasoning', index: 'skip' })
  assert.equal(r.state.step, 'permission')
  assert.equal(r.state.reasoningEffort, undefined)
})

test('当模型不支持思考强度（列表为空或未提供）时，model 步直接跳过 reasoning 进入 permission 步', () => {
  const s: WizardState = {
    step: 'model',
    cwd: '/data',
    name: 'test',
    provider: 'deepseek',
  }
  // 空列表
  const r1 = wizardCallback(
    s,
    { step: 'model', index: '0' },
    {
      models: [{ id: 'deepseek-chat' }],
      reasoningEfforts: [],
    }
  )
  assert.equal(r1.state.step, 'permission')
  assert.equal(r1.state.model, 'deepseek-chat')
  assert.equal(r1.state.reasoningEffort, undefined)

  // 未提供 reasoningEfforts
  const r2 = wizardCallback(
    s,
    { step: 'model', index: '0' },
    {
      models: [{ id: 'deepseek-chat' }],
    }
  )
  assert.equal(r2.state.step, 'permission')
  assert.equal(r2.state.model, 'deepseek-chat')
})

test('confirm 步带 reasoningEffort 确认生成 done 动作', () => {
  const s: WizardState = {
    step: 'confirm',
    cwd: '/data',
    name: 'test',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
    permission: 'full',
    preset: 'standard',
  }
  const r = wizardCallback(s, { step: 'confirm', index: 'yes' })
  assert.equal(r.action?.kind, 'done')
  assert.deepEqual((r.action as any).params, {
    cwd: '/data',
    name: 'test',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
    permission: 'full',
    preset: 'standard',
  })
})
