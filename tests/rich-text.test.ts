// 契约测试：Markdown → lark_md（feishu-duty 移植版纯逻辑）
// 运行：node --test tests/ （Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markdownToLarkMd } from '../src/rich-text.ts'

test('标题行转粗体行（lark_md 无标题语法）', () => {
  assert.equal(markdownToLarkMd('# 大标题'), '**大标题**')
  assert.equal(markdownToLarkMd('## 小节标题'), '**小节标题**')
  assert.equal(markdownToLarkMd('### 三级'), '**三级**')
})

test('粗体与链接原样保留（lark_md 原生支持）', () => {
  assert.equal(markdownToLarkMd('**加粗**'), '**加粗**')
  assert.equal(markdownToLarkMd('[点我](https://example.com)'), '[点我](https://example.com)')
})

test('正文不被误改', () => {
  assert.equal(markdownToLarkMd('你好世界'), '你好世界')
  assert.equal(markdownToLarkMd('行内 `code` 保持字面'), '行内 `code` 保持字面')
})

test('引用行加可视前缀（lark_md 无块引用）', () => {
  assert.equal(markdownToLarkMd('> 提示语'), '▎提示语')
})

test('多行混排：仅标题与引用行受影响', () => {
  const md = '# 标题\n正文一行\n> 引用\n**粗体保留**'
  assert.equal(markdownToLarkMd(md), '**标题**\n正文一行\n▎引用\n**粗体保留**')
})
