// 契约测试：本地命令解析与序号寻址（v0.6.0 纯逻辑）
// 运行：node --test tests/local-commands.test.ts（Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLocalCommand, resolveSessionRef } from '../src/local-commands.ts'

test('parseLocalCommand: 基本命令与参数', () => {
  assert.deepEqual(parseLocalCommand('/sessions'), { name: 'sessions', arg: '' })
  assert.deepEqual(parseLocalCommand('/archive session-abc'), { name: 'archive', arg: 'session-abc' })
  assert.deepEqual(parseLocalCommand('/delete   3  '), { name: 'delete', arg: '3' })
})

test('parseLocalCommand: 中文与短别名归一化', () => {
  assert.deepEqual(parseLocalCommand('/对话'), { name: 'sessions', arg: '' })
  assert.deepEqual(parseLocalCommand('/ls'), { name: 'sessions', arg: '' })
  assert.deepEqual(parseLocalCommand('/归档'), { name: 'archive', arg: '' })
  assert.deepEqual(parseLocalCommand('/工作区'), { name: 'groups', arg: '' })
  assert.deepEqual(parseLocalCommand('/rm 2'), { name: 'delete', arg: '2' })
  assert.deepEqual(parseLocalCommand('/当前'), { name: 'current', arg: '' })
  assert.deepEqual(parseLocalCommand('/新建'), { name: 'new', arg: '' })
  assert.deepEqual(parseLocalCommand('/模式'), { name: 'agentmode', arg: '' })
  assert.deepEqual(parseLocalCommand('/重命名 我的新会话'), { name: 'rename', arg: '我的新会话' })
})

test('parseLocalCommand: 其余新命令', () => {
  assert.deepEqual(parseLocalCommand('/groups'), { name: 'groups', arg: '' })
  assert.deepEqual(parseLocalCommand('/delete session-y'), { name: 'delete', arg: 'session-y' })
  assert.deepEqual(parseLocalCommand('/current'), { name: 'current', arg: '' })
  assert.deepEqual(parseLocalCommand('/new'), { name: 'new', arg: '' })
  assert.deepEqual(parseLocalCommand('/cancel'), { name: 'cancel', arg: '' })
  assert.deepEqual(parseLocalCommand('/model kimi-coding/k3'), { name: 'model', arg: 'kimi-coding/k3' })
  assert.deepEqual(parseLocalCommand('/mode'), { name: 'mode', arg: '' })
  assert.deepEqual(parseLocalCommand('/mode workspace-write'), { name: 'mode', arg: 'workspace-write' })
  assert.deepEqual(parseLocalCommand('/agentmode'), { name: 'agentmode', arg: '' })
  assert.deepEqual(parseLocalCommand('/rename my-session'), { name: 'rename', arg: 'my-session' })
})

test('parseLocalCommand: 非命令与未知命令', () => {
  assert.equal(parseLocalCommand('普通文本'), null)
  assert.equal(parseLocalCommand(''), null)
  assert.equal(parseLocalCommand('sessions'), null)
  // 未知命令：返回原始小写名（由分发层判定未知），不归一化
  assert.deepEqual(parseLocalCommand('/foobar x'), { name: 'foobar', arg: 'x' })
  // 大小写不敏感
  assert.deepEqual(parseLocalCommand('/SESSIONS'), { name: 'sessions', arg: '' })
})

test('resolveSessionRef: 序号寻址（1-based）', () => {
  const list = ['session-a', 'session-b', 'session-c']
  assert.equal(resolveSessionRef('1', list), 'session-a')
  assert.equal(resolveSessionRef('3', list), 'session-c')
  assert.equal(resolveSessionRef(' 2 ', list), 'session-b')
})

test('resolveSessionRef: 完整 id 直传', () => {
  const list = ['session-a', 'session-b']
  assert.equal(resolveSessionRef('session-a', list), 'session-a')
  assert.equal(resolveSessionRef('session-zzz', list), 'session-zzz') // 未在列表中的长 id 仍直传（由上层校验存在性）
})

test('resolveSessionRef: 越界与非法序号', () => {
  const list = ['session-a']
  assert.equal(resolveSessionRef('0', list), null)
  assert.equal(resolveSessionRef('2', list), null)
  assert.equal(resolveSessionRef('-1', list), null)
  assert.equal(resolveSessionRef('', list), null)
})
