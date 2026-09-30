// 契约测试：飞书附件识别与收发纯逻辑（feishu-duty 移植版）
// 运行：node --test tests/ （Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { describeAttachment, inboxFileName, attachmentNotice } from '../src/media.ts'
import { FeishuClient, normalizeIncoming } from '../src/feishu.ts'

function incoming(messageType: string, content: object | string) {
  return normalizeIncoming({
    sender: { sender_id: { open_id: 'ou_x' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: messageType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    },
  })!
}

test('describeAttachment: image 消息 → photo 附件（resources?type=image）', () => {
  const a = describeAttachment(incoming('image', { image_key: 'img_v1' }))
  assert.ok(a)
  assert.equal(a.kind, 'photo')
  assert.equal(a.fileKey, 'img_v1')
  assert.equal(a.resourceType, 'image')
  assert.equal(a.messageId, 'om_1')
})

test('describeAttachment: file 消息 → document 附件并带文件名', () => {
  const a = describeAttachment(incoming('file', { file_key: 'file_v2', file_name: '报告.pdf' }))
  assert.ok(a)
  assert.equal(a.kind, 'document')
  assert.equal(a.fileKey, 'file_v2')
  assert.equal(a.resourceType, 'file')
  assert.equal(a.fileName, '报告.pdf')
})

test('describeAttachment: audio/video/media 消息 → document 附件并补全文件名', () => {
  const audio = describeAttachment(incoming('audio', { file_key: 'op1', duration: 100 }))
  assert.ok(audio)
  assert.equal(audio.kind, 'document')
  assert.match(audio.fileName ?? '', /\.opus$/)
  const video = describeAttachment(incoming('video', { file_key: 'v1' }))
  assert.ok(video)
  assert.match(video.fileName ?? '', /\.mp4$/)
})

test('describeAttachment: text 消息 → null', () => {
  assert.equal(describeAttachment(incoming('text', { text: '你好' })), null)
})

test('FeishuClient.resourceOf: 恶劣 JSON 返回 null', () => {
  assert.equal(FeishuClient.resourceOf('image', '{oops'), null)
  assert.equal(FeishuClient.resourceOf('text', '{"text":"hi"}'), null)
})

test('inboxFileName: 去路径穿越并落到 inbox 目录', () => {
  const p = inboxFileName('/data/inbox', 'document', 'fk', '../../etc/passwd')
  assert.equal(p, path.resolve('/data/inbox/passwd'))
  const q = inboxFileName('/data/inbox', 'photo', 'img_v2')
  assert.equal(q, path.resolve('/data/inbox/img_v2.jpg'))
})

test('attachmentNotice: 图片引导 read_image，文本引导 read', () => {
  const image = attachmentNotice({ savedPath: '/x/a.jpg', kind: 'photo', mime: 'image/jpeg', provider: 'p', model: 'm' })
  assert.match(image, /read_image/)
  assert.match(image, /飞书用户/)
  const text = attachmentNotice({ savedPath: '/x/a.txt', kind: 'document', fileName: 'a.txt', mime: 'text/plain', provider: 'p', model: 'm' })
  assert.match(text, /`read`/)
})
