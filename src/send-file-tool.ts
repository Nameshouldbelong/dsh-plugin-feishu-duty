/**
 * Model-facing feishu_send_file tool: the duty agent sends a local file to
 * the user's Feishu chat. Path is confined to the duty cwd, the bridge
 * inbox, or /tmp; files over Feishu's 30MB im-upload limit are rejected.
 * @module @nameshouldbelong/dsh-feishu-duty/send-file-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { Gateway } from './gateway.ts'

/** Register feishu_send_file bound to the gateway (unless media is disabled). */
export function setupSendFileTool(
  ctx: Context,
  runtime: { dutyCwd?: string; dataDir?: string; mediaEnabled?: boolean },
  gateway: Gateway,
): void {
  if (runtime.mediaEnabled === false) return

  const resolvedDutyCwd = path.resolve(runtime.dutyCwd ?? process.cwd())
  const inboxDir = path.resolve(runtime.dataDir ?? '.', 'inbox')
  const tmpDir = path.resolve('/tmp')

  ctx.tools.register(defineTool({
    name: 'feishu_send_file',
    description: 'Send a local file to the user via Feishu. '
      + 'Use it when the user asks you to send/deliver a file to their Feishu. '
      + 'path must be absolute and located under the duty workspace, the bridge inbox, or /tmp.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path of the file to send.',
      },
      caption: {
        type: 'string',
        description: 'Optional caption sent before the file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const fileAbsPath = path.resolve(String(args.path))
      if (!fileAbsPath.startsWith(resolvedDutyCwd + path.sep)
        && !fileAbsPath.startsWith(inboxDir + path.sep)
        && !fileAbsPath.startsWith(tmpDir + path.sep)) {
        return { sent: false, error: `path must be under ${resolvedDutyCwd}, ${inboxDir} or ${tmpDir}` }
      }
      let stat
      try {
        stat = await fs.promises.stat(fileAbsPath)
      } catch {
        return { sent: false, error: `file not found or unreadable: ${fileAbsPath}` }
      }
      if (!stat.isFile()) return { sent: false, error: `not a regular file: ${fileAbsPath}` }
      if (stat.size > 30 * 1024 * 1024) return { sent: false, error: 'file exceeds the 30MB Feishu upload limit' }
      try {
        await gateway.sendFileToUser(fileAbsPath, args.caption !== undefined ? String(args.caption) : undefined)
        return { sent: true }
      } catch (error) {
        return { sent: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }))
}
