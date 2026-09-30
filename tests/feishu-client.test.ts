// 契约测试：飞书事件归一化 / 卡片构建 / 回调协议（feishu-duty 传输层纯逻辑）
// 运行：node --test tests/ （Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeIncoming,
  normalizeCardAction,
  extractText,
  buildCard,
  FeishuClient,
  type InlineKeyboard,
} from '../src/feishu.ts'

const RAW_MESSAGE = {
  sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
  message: {
    message_id: 'om_123',
    chat_id: 'oc_456',
    chat_type: 'p2p',
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 你好' }),
    mentions: [{ key: '@_user_1', name: '值班机器人', id: { open_id: 'ou_bot' } }],
  },
}

test('normalizeIncoming: 归一化字段齐全', () => {
  const m = normalizeIncoming(RAW_MESSAGE)!
  assert.equal(m.messageId, 'om_123')
  assert.equal(m.chatId, 'oc_456')
  assert.equal(m.chatType, 'p2p')
  assert.equal(m.messageType, 'text')
  assert.equal(m.senderOpenId, 'ou_abc')
  assert.equal(m.senderType, 'user')
})

test('normalizeIncoming: 缺 message 返回 undefined；group 归一化为 group', () => {
  assert.equal(normalizeIncoming({}), undefined)
  const m = normalizeIncoming({ message: { message_id: 'om_2', chat_id: 'oc_9', chat_type: 'group', message_type: 'text', content: '{}' } })!
  assert.equal(m.chatType, 'group')
})

test('normalizeIncoming: content 非字符串时序列化兜底', () => {
  const m = normalizeIncoming({ message: { message_id: 'om_3', message_type: 'text', content: { text: 'hi' } } })!
  assert.equal(m.content, JSON.stringify({ text: 'hi' }))
})

test('extractText: text 消息替换 @ 占位为名字', () => {
  const m = normalizeIncoming(RAW_MESSAGE)!
  assert.equal(extractText(m), '@值班机器人 你好')
})

test('extractText: 恶劣 JSON 回退空串', () => {
  const m = normalizeIncoming({ message: { message_id: 'om_4', message_type: 'text', content: '{bad' } })!
  assert.equal(extractText(m), '')
})

test('normalizeCardAction: 提取 value.cb 与上下文 id', () => {
  const a = normalizeCardAction({
    context: { open_message_id: 'om_card', open_chat_id: 'oc_1' },
    operator: { open_id: 'ou_user' },
    action: { value: { cb: 'appr:1:allow' }, tag: 'button' },
  })!
  assert.equal(a.messageId, 'om_card')
  assert.equal(a.chatId, 'oc_1')
  assert.equal(a.operatorOpenId, 'ou_user')
  assert.equal(a.cb, 'appr:1:allow')
})

test('normalizeCardAction: 无 cb 或畸形输入返回 undefined / cb undefined', () => {
  assert.equal(normalizeCardAction(undefined), undefined)
  const noCb = normalizeCardAction({ action: { value: 'plain-string' } })!
  assert.equal(noCb.cb, undefined)
})

test('buildCard: lark_md 正文 + 每行一个 action 按钮，payload 装进 value.cb', () => {
  const keyboard: InlineKeyboard = [
    [{ text: '✅ 同意', callback_data: 'appr:1:allow' }, { text: '⛔ 拒绝', callback_data: 'appr:1:reject' }],
    [{ text: '❌ 取消', callback_data: 'x:cancel' }],
  ]
  const card = buildCard('【审批 #1】', keyboard)
  const div = card.elements[0] as { tag: string; text: { tag: string; content: string } }
  assert.equal(div.tag, 'div')
  assert.equal(div.text.tag, 'lark_md')
  assert.equal(div.text.content, '【审批 #1】')
  const row1 = card.elements[1] as { tag: string; actions: Array<{ tag: string; type: string; value: { cb: string } }> }
  assert.equal(row1.tag, 'action')
  assert.equal(row1.actions.length, 2)
  assert.equal(row1.actions[0].value.cb, 'appr:1:allow')
  // 审批按钮语义化配色
  assert.equal(row1.actions[0].type, 'primary')
  assert.equal(row1.actions[1].type, 'danger')
  const row2 = card.elements[2] as { actions: Array<{ type: string }> }
  assert.equal(row2.actions[0].type, 'default')
})

test('buildCard: 空 keyboard 时不含 action 元素；header 可选', () => {
  const plain = buildCard('只有正文')
  assert.deepEqual(plain.elements.map((e) => (e as { tag: string }).tag), ['div'])
  const titled = buildCard('正文', undefined, '🔐 需要授权', 'orange')
  assert.equal(titled.header?.title.content, '🔐 需要授权')
  assert.equal(titled.header?.template, 'orange')
})

test('FeishuClient.resourceOf: image/file/音视频键位归一', () => {
  assert.deepEqual(FeishuClient.resourceOf('image', '{"image_key":"k1"}'), { fileKey: 'k1', type: 'image' })
  assert.deepEqual(FeishuClient.resourceOf('file', '{"file_key":"k2","file_name":"a"}'), { fileKey: 'k2', type: 'file' })
  assert.deepEqual(FeishuClient.resourceOf('audio', '{"file_key":"k3"}'), { fileKey: 'k3', type: 'file' })
  assert.deepEqual(FeishuClient.resourceOf('media', '{"file_key":"k4"}'), { fileKey: 'k4', type: 'file' })
})
