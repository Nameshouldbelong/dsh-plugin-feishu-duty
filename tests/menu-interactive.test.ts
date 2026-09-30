// 契约测试：v0.8.0 交互式多级卡片菜单与回调协议
// 运行：node --test tests/menu-interactive.test.ts （Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  wizardStart,
  wizardCallback,
  wizardText,
  encodeWizardCallback,
  decodeWizardCallback,
  type WizardState,
} from '../src/wizard.ts'

test('MI-01: 飞书卡片按钮 value 64 字节上限检验', () => {
  // 模拟各类多级卡片的回调编码，断言所有 callback_data 绝不超过 64 字节
  const samples = [
    'sess:ws:0',
    'sess:ws:99',
    'sess:sw:1',
    'sess:sw:999',
    'sess:back:ws',
    'sess:cancel',
    'arc:ws:0',
    'arc:target:12',
    'arc:confirm:12',
    'arc:back:ws',
    'arc:cancel',
    'del:ws:0',
    'del:target:12',
    'del:confirm:12',
    'del:back:ws',
    'del:cancel',
    'mdl:p:5',
    'mdl:m:5:10',
    'mdl:mode:3',
    'mdl:mode:skip',
    'mdl:back:prov',
    'mdl:cancel',
    encodeWizardCallback('cwd', 'new'),
    encodeWizardCallback('name', 'skip'),
    encodeWizardCallback('model', '25'),
    encodeWizardCallback('confirm', 'yes'),
  ]

  for (const s of samples) {
    const len = Buffer.byteLength(s, 'utf-8')
    assert.ok(len <= 64, `callback_data "${s}" 超过 64 字节 (${len})`)
  }
})

test('MI-02: 向导在 name 步支持跳过按钮 (wiz:name:skip)', () => {
  let s: WizardState = { step: 'name', cwd: '/workspace/demo' }
  const r = wizardCallback(s, { step: 'name', index: 'skip' })
  assert.equal(r.state.step, 'provider')
  assert.equal(r.state.name, undefined)
  assert.equal(r.state.cwd, '/workspace/demo')
})

test('MI-03: 向导在 name 步支持取消 (wiz:name:cancel)', () => {
  let s: WizardState = { step: 'name', cwd: '/workspace/demo' }
  const r = wizardCallback(s, { step: 'name', index: 'cancel' })
  assert.equal(r.action?.kind, 'cancelled')
})

test('MI-04: 向导在 name 步支持正常文本输入', () => {
  let s: WizardState = { step: 'name', cwd: '/workspace/demo' }
  const r = wizardText(s, 'My Project')
  assert.equal(r.state.step, 'provider')
  assert.equal(r.state.name, 'My Project')
})
