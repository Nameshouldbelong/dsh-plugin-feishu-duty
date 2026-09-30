import path from 'node:path';
import type { FeishuIncomingMessage } from './feishu.ts'
import { FeishuClient } from './feishu.ts'

export interface FeishuAttachment {
  kind: 'photo' | 'document'
  messageId: string
  fileKey: string
  /** image 资源走 resources?type=image，其余走 type=file。 */
  resourceType: 'image' | 'file'
  fileName?: string
  mime?: string
  size?: number
}

/** Map a received message to a downloadable attachment; null for text-only messages. */
export function describeAttachment(message: FeishuIncomingMessage): FeishuAttachment | null {
  if (message.messageType === 'image') {
    const resource = FeishuClient.resourceOf(message.messageType, message.content)
    if (resource === null) return null
    return {
      kind: 'photo',
      messageId: message.messageId,
      fileKey: resource.fileKey,
      resourceType: resource.type,
      fileName: `${message.messageId}.jpg`,
      mime: 'image/jpeg',
    };
  }

  const DOCUMENT_TYPES = new Set(['file', 'audio', 'video', 'media'])
  if (DOCUMENT_TYPES.has(message.messageType)) {
    const resource = FeishuClient.resourceOf(message.messageType, message.content)
    if (resource === null) return null
    let fileName: string | undefined
    let mime: string | undefined
    try {
      const content = JSON.parse(message.content) as Record<string, unknown>
      if (typeof content.file_name === 'string') fileName = content.file_name
      if (typeof content.mime_type === 'string') mime = content.mime_type
    } catch {
      // Malformed content: name stays undefined below.
    }
    if (fileName === undefined && message.messageType === 'audio') fileName = `${message.messageId}.opus`
    if (fileName === undefined && message.messageType === 'video') fileName = `${message.messageId}.mp4`
    return {
      kind: 'document',
      messageId: message.messageId,
      fileKey: resource.fileKey,
      resourceType: resource.type,
      fileName,
      mime,
    };
  }

  return null;
}

export function inboxFileName(inboxDir: string, kind: 'photo' | 'document', fileKey: string, fileName?: string): string {
  if (!fileName) {
    fileName = kind === 'photo' ? `${fileKey}.jpg` : fileKey;
  }

  const baseName = path.basename(fileName);
  const safeName = baseName.replace(/\.\./g, '');

  return path.join(inboxDir, safeName);
}

export function attachmentNotice(info: {
  savedPath: string;
  kind: 'photo' | 'document';
  fileName?: string;
  mime?: string;
  provider: string;
  model: string;
  caption?: string;
}): string {
  let suggestion = '先用 bash `file` 命令探明文件类型，然后再决定后续操作。';
  if (info.mime) {
    if (info.mime.startsWith('image/')) {
      suggestion = '建议使用 `read_image` 工具读取并分析该图片。（先确认当前会话模型支持图像输入再调用；若为纯文本模型，请直接告知用户「当前模型不支持图片识别」，不要强行调用。）';
    } else if (info.mime.startsWith('text/') || info.mime === 'application/json' || info.fileName?.endsWith('.md') || info.fileName?.endsWith('.txt')) {
      suggestion = '建议使用 `read` 相关工具读取该文本文件的内容。';
    }
  }

  return `[System Notice] 收到来自飞书用户的多媒体附件。
文件已保存在本地路径：${info.savedPath}
当前提供商：${info.provider}，当前模型：${info.model}

读取建议：${suggestion}

用户附言 (caption): ${info.caption || '无'}`;
}
