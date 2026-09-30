// 契约测试：/new 多级向导状态机（v0.6.0 纯逻辑）
// 运行：node --test tests/wizard.test.ts（Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeWizardCallback,
  decodeWizardCallback,
  wizardStart,
  wizardCallback,
  wizardText,
  wizardCancel,
  WIZARD_STEPS,
  type WizardState,
} from '../src/wizard.ts'

test('callback 编解码往返（索引制，防 64 字节上限）', () => {
  const data = encodeWizardCallback('model', 7)
  assert.ok(data.length <= 64)
  assert.deepEqual(decodeWizardCallback(data), { step: 'model', index: '7' })
  assert.equal(decodeWizardCallback('ask:1:2'), null)
  assert.equal(decodeWizardCallback('garbage'), null)
})

test('wizardStart: 初始状态位于首步 cwd', () => {
  const s = wizardStart()
  assert.equal(s.step, 'cwd')
})

test('步序固定：cwd→name→provider→model→reasoning→permission→preset→confirm', () => {
  assert.deepEqual(WIZARD_STEPS, ['cwd', 'name', 'provider', 'model', 'reasoning', 'permission', 'preset', 'confirm'])
})

test('全路径：选既有工作区→文本名称→点选 provider/model/permission/preset→confirm', () => {
  let s: WizardState = wizardStart()
  // cwd 步：点选已有工作区 index 0（数据由调用方注入）
  let r = wizardCallback(s, { step: 'cwd', index: '0' }, { workspaces: [{ path: '/home/user/proj' }] })
  s = r.state
  assert.equal(s.step, 'name')
  assert.equal(s.cwd, '/home/user/proj')
  // name 步：文本输入
  r = wizardText(s, '我的会话')
  s = r.state
  assert.equal(s.step, 'provider')
  assert.equal(s.name, '我的会话')
  // provider 步
  r = wizardCallback(s, { step: 'provider', index: '0' }, { providers: [{ id: 'kimi-coding' }] })
  s = r.state
  assert.equal(s.step, 'model')
  assert.equal(s.provider, 'kimi-coding')
  // model 步
  r = wizardCallback(s, { step: 'model', index: '1' }, { models: [{ id: 'k3' }, { id: 'k3-256k' }] })
  s = r.state
  assert.equal(s.step, 'permission')
  assert.equal(s.model, 'k3-256k')
  // permission 步
  r = wizardCallback(s, { step: 'permission', index: '1' }, { permissions: ['default', 'workspace-write'] })
  s = r.state
  assert.equal(s.step, 'preset')
  assert.equal(s.permission, 'workspace-write')
  // preset 步
  r = wizardCallback(s, { step: 'preset', index: '0' }, { presets: [{ id: 'standard' }] })
  s = r.state
  assert.equal(s.step, 'confirm')
  assert.equal(s.preset, 'standard')
  // confirm：确认 → done 动作携带完整参数
  r = wizardCallback(s, { step: 'confirm', index: 'yes' })
  assert.equal(r.action?.kind, 'done')
  assert.deepEqual((r.action as { params: unknown }).params, {
    cwd: '/home/user/proj', name: '我的会话', provider: 'kimi-coding',
    model: 'k3-256k', reasoningEffort: undefined, permission: 'workspace-write', preset: 'standard',
  })
})

test('cwd 步点「新建」→ 等待文本输入路径', () => {
  let s: WizardState = wizardStart()
  let r = wizardCallback(s, { step: 'cwd', index: 'new' }, { workspaces: [] })
  s = r.state
  assert.equal(r.action?.kind, 'awaitText') // 调用方进入 awaitingInput
  assert.equal(s.step, 'cwd') // 留在 cwd 步等文本
  r = wizardText(s, '/data/newdir')
  s = r.state
  assert.equal(s.cwd, '/data/newdir')
  assert.equal(s.step, 'name')
})

test('name 步发送 - 表示留空', () => {
  let s: WizardState = { step: 'name', cwd: '/x' }
  const r = wizardText(s, '-')
  assert.equal(r.state.step, 'provider')
  assert.equal(r.state.name, undefined)
})

test('confirm 步取消 → cancelled 动作；/cancel 任意步取消', () => {
  let s: WizardState = { step: 'confirm', cwd: '/x', provider: 'p', model: 'm' }
  let r = wizardCallback(s, { step: 'confirm', index: 'no' })
  assert.equal(r.action?.kind, 'cancelled')
  r = wizardCancel(s)
  assert.equal(r.action?.kind, 'cancelled')
})

test('乱序 callback（step 不匹配）被忽略', () => {
  const s: WizardState = { step: 'provider', cwd: '/x', name: 'n' }
  const r = wizardCallback(s, { step: 'model', index: '0' }, { models: [{ id: 'm' }] })
  assert.equal(r.state, s) // 状态不变
  assert.equal(r.action, undefined)
})
