/**
 * Markdown → lark_md conversion for Feishu cards and post/md messages.
 * Feishu renders bold / italic / strike / links natively; headings become
 * bold lines and everything unsupported (fences, tables, inline code) is
 * passed through as literal text.
 * @module @nameshouldbelong/dsh-feishu-duty/rich-text
 */

export function markdownToLarkMd(md: string): string {
  // 1. 标题行 → 粗体行（lark_md 无标题语法）
  let text = md.replace(/^#{1,6}\s+(.*)$/gm, '**$1**')
  // 2. 引用块 → 每行加 quote 前缀样式退化处理（保留原文，前缀引用符号）
  text = text.replace(/^>\s?(.*)$/gm, '▎$1')
  return text
}
