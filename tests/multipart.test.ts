// 契约测试：multipart/form-data 构造（功能 3 发送侧纯逻辑）
// 运行：node --test tests/ （Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMultipart } from '../src/feishu-multipart.ts'

test('buildMultipart: 结构与结尾边界', () => {
  const fileData = Buffer.from('hello-binary')
  const { body, contentType } = buildMultipart(
    { chat_id: '123', caption: '说明' },
    { field: 'document', fileName: 'a.bin', data: fileData, contentType: 'application/octet-stream' },
  )
  assert.match(contentType, /^multipart\/form-data; boundary=.+$/)
  const boundary = contentType.split('boundary=')[1]
  const text = body.toString('latin1')
  assert.ok(text.includes(`--${boundary}\r\n`))
  assert.ok(text.includes('Content-Disposition: form-data; name="chat_id"'))
  assert.ok(text.includes('123'))
  assert.ok(text.includes('Content-Disposition: form-data; name="document"; filename="a.bin"'))
  assert.ok(text.endsWith(`--${boundary}--\r\n`))
})

test('buildMultipart: 二进制段字节完整', () => {
  const fileData = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x5a])
  const { body } = buildMultipart(
    { chat_id: '1' },
    { field: 'document', fileName: 'b.bin', data: fileData },
  )
  const idx = body.indexOf(fileData)
  assert.ok(idx > 0, '文件字节必须原样出现在 body 中')
})

test('buildMultipart: 文件名含引号时转义或拒绝', () => {
  assert.throws(() => buildMultipart(
    { chat_id: '1' },
    { field: 'document', fileName: 'evil"\r\nname', data: Buffer.from('x') },
  ))
})
