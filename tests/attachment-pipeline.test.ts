// 契约测试：v0.7.1 附件路由目标解析 / dataDir 绝对化 / 超限错误分类 / 通知能力引导
// 运行：node --test tests/ （Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveAttachmentTarget } from '../src/routing.ts'
import { resolveDataDir } from '../src/paths.ts'
import { attachmentNotice } from '../src/media.ts'
import { classifyDutyError } from '../src/error-advice.ts'

// ---- R1: resolveAttachmentTarget ----
test('resolveAttachmentTarget: 桥接目标优先', () => {
  assert.equal(resolveAttachmentTarget({ runtimeSessionId: 'feishu-duty', bridgedSessionId: 'session-abc' }), 'session-abc')
})
test('resolveAttachmentTarget: 桥接为 undefined/null/空串/纯空白时落回 runtime', () => {
  assert.equal(resolveAttachmentTarget({ runtimeSessionId: 'sess-run', bridgedSessionId: undefined }), 'sess-run')
  assert.equal(resolveAttachmentTarget({ runtimeSessionId: 'sess-run', bridgedSessionId: null }), 'sess-run')
  assert.equal(resolveAttachmentTarget({ runtimeSessionId: 'sess-run', bridgedSessionId: '' }), 'sess-run')
  assert.equal(resolveAttachmentTarget({ runtimeSessionId: 'sess-run', bridgedSessionId: '   ' }), 'sess-run')
})
test('resolveAttachmentTarget: runtime 也缺失时默认 feishu-duty', () => {
  assert.equal(resolveAttachmentTarget({}), 'feishu-duty')
  assert.equal(resolveAttachmentTarget({ bridgedSessionId: 'session-x' }), 'session-x')
})

// ---- R2: resolveDataDir ----
test('resolveDataDir: 显式配置相对路径被绝对化', () => {
  const p = resolveDataDir('storages/feishu-duty', {}, '/home/u')
  assert.ok(path.isAbsolute(p))
})
test('resolveDataDir: 未配置时优先 DSH_HOME', () => {
  assert.equal(resolveDataDir('', { DSH_HOME: '/x' }, '/home/u'), path.resolve('/x/storages/feishu-duty'))
  assert.equal(resolveDataDir(undefined, { DSH_HOME: '/x' }, '/home/u'), path.resolve('/x/storages/feishu-duty'))
})
test('resolveDataDir: DSH_HOME 缺失时回退 homeDir/.dsh 且绝对', () => {
  const p = resolveDataDir(undefined, {}, '/home/u')
  assert.equal(p, path.resolve('/home/u/.dsh/storages/feishu-duty'))
  assert.ok(path.isAbsolute(p))
})
test('resolveDataDir: 空白配置视为未配置', () => {
  const p = resolveDataDir('   ', { DSH_HOME: '/x' }, '/home/u')
  assert.equal(p, path.resolve('/x/storages/feishu-duty'))
})

// ---- R3: attachmentNotice 能力条件引导 ----
test('attachmentNotice: 图片通知保留 read_image 建议且含能力确认引导', () => {
  const t = attachmentNotice({
    savedPath: '/data/inbox/x.jpg', kind: 'photo', fileName: 'x.jpg',
    mime: 'image/jpeg', provider: 'kimi-coding', model: 'k3', caption: '',
  })
  assert.ok(t.includes('read_image'))
  assert.ok(t.includes('支持图像输入'))
  assert.ok(t.includes('不支持图片识别'))
})
test('attachmentNotice: 文本文档建议不含图像引导', () => {
  const t = attachmentNotice({
    savedPath: '/data/inbox/a.md', kind: 'document', fileName: 'a.md',
    mime: 'text/markdown', provider: 'p', model: 'm', caption: '',
  })
  assert.ok(!t.includes('不支持图片识别'))
})

// ---- R4: classifyDutyError ----
test('classifyDutyError: 真实 k3-256k 超限报文判为 context-overflow', () => {
  const real = '400 {"error":{"type":"invalid_request_error","message":"Your request exceeded k3-256k model token limit: 262144"},"type":"error"}'
  assert.equal(classifyDutyError(real).kind, 'context-overflow')
})
test('classifyDutyError: context window 变体判为 context-overflow', () => {
  assert.equal(classifyDutyError('Error: context window exceeded for this model').kind, 'context-overflow')
  assert.equal(classifyDutyError('prompt is too long: 300000 tokens').kind, 'context-overflow')
})
test('classifyDutyError: 普通错误与空串判为 generic', () => {
  assert.equal(classifyDutyError('Error: 401 unauthorized').kind, 'generic')
  assert.equal(classifyDutyError('').kind, 'generic')
})
