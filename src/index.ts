/**
 * Feishu duty gateway for DeepSeek Harness.
 *
 * Mounts a Feishu (Lark) WebSocket long-connection listener; whitelisted
 * messages are delivered into a dedicated "duty" DSH session and wake its
 * agent, and the final assistant text is replied to Feishu. While the gateway
 * is in `duty` mode, approval requests from ALL sessions are forwarded to
 * Feishu instead of the web UI; in `local` mode the web approval popup
 * behaves normally.
 * @module @nameshouldbelong/dsh-feishu-duty
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  Config, FEISHU_DUTY_NAMESPACE, resolveConfig, type CredentialsFile, type FeishuDutyConfig,
} from './config.ts'
import { FeishuClient } from './feishu.ts'
import { Gateway } from './gateway.ts'
import { feishuAskTool } from './ask-tool.ts'
import { setupSendFileTool } from './send-file-tool.ts'
import { resolveDataDir } from './paths.ts'
import { liveScope, markerScope, seedCrossNamespace } from './settings-compat.ts'

export { Config } from './config.ts'

export const name = 'feishu-duty'
export const inject = ['settings', 'agents', 'agentDefaultModel', 'tools', 'commands', 'sessionQuery', 'workspaceRegistry', 'sessionTitle', 'llm', 'permissionPresets']

/** Schema values win; empty appId/receiveId fall back to the credentials file. */
export function resolveRuntime(config: FeishuDutyConfig): FeishuDutyConfig {
  const resolved = resolveConfig(config)
  let credentials: CredentialsFile = {}
  if (resolved.credentialsFile) {
    try {
      credentials = JSON.parse(fs.readFileSync(resolved.credentialsFile, 'utf-8')) as CredentialsFile
    } catch {
      // Missing/unreadable credentials file: fall through to explicit values.
    }
  }
  return {
    ...resolved,
    appId: resolved.appId || credentials.app_id || '',
    appSecret: resolved.appSecret || credentials.app_secret || '',
    receiveId: resolved.receiveId || credentials.receive_id || '',
    receiveIdType: resolved.receiveIdType || credentials.receive_id_type || 'open_id',
  }
}

/** Fill generic defaults for the two paths that must exist at runtime. */
export function effectiveRuntime(config: FeishuDutyConfig): FeishuDutyConfig {
  return {
    ...config,
    dataDir: resolveDataDir(config.dataDir, process.env, os.homedir()),
    dutyCwd: config.dutyCwd && config.dutyCwd !== '' ? config.dutyCwd : process.cwd(),
  }
}

/** Plugin entry: register settings, then mount the gateway. */
export async function apply(ctx: Context, config: FeishuDutyConfig = {}): Promise<void> {
  try {
    await mount(ctx, config)
  } catch (error) {
    // Leave an on-disk breadcrumb before the loader rolls the row back.
    try {
      const resolved = effectiveRuntime(resolveConfig(config))
      fs.mkdirSync(resolved.dataDir ?? '.', { recursive: true })
      fs.writeFileSync(
        `${resolved.dataDir ?? '.'}/startup-error.json`,
        JSON.stringify({ time: Date.now(), error: error instanceof Error ? error.stack ?? error.message : String(error) }, null, 2),
        'utf-8',
      )
    } catch {
      // Best effort only.
    }
    throw error
  }
}

async function mount(ctx: Context, config: FeishuDutyConfig): Promise<void> {
  // dsh 0.1.7 (#677): settings namespaces derive from the exported Config
  // schema; the 0.1.5-style scopes are rebuilt in settings-compat.ts so the
  // Gateway interface is unchanged. State markers ride the main namespace's
  // Config (stateOn / stateOff) and stay visible to the browser half.
  // Seed the cross-namespace cache (feishu-bridge-control's remembered
  // session) with ONE boot-time background describe — never on a hot path.
  seedCrossNamespace(ctx, 'feishu-bridge-control')
  const settings = liveScope(ctx, FEISHU_DUTY_NAMESPACE, config)
  const stateOn = markerScope(ctx, FEISHU_DUTY_NAMESPACE, 'stateOn', config)
  const stateOff = markerScope(ctx, FEISHU_DUTY_NAMESPACE, 'stateOff', config)
  const runtime = effectiveRuntime(resolveRuntime(settings.get()))

  if (!runtime.appId && !runtime.disablePoller) {
    throw new Error('feishu-duty: appId is required (set it in the patch config or in credentialsFile)')
  }
  if (!runtime.appSecret && !runtime.disablePoller) {
    throw new Error('feishu-duty: appSecret is required (set it in the patch config or in credentialsFile)')
  }
  if (!runtime.receiveId && !runtime.disablePoller) {
    throw new Error('feishu-duty: receiveId is required (whitelist open_id/chat_id; set it in the patch config or in credentialsFile)')
  }

  ctx.logger.info(
    'feishu-duty',
    `config ready: sessionId=${runtime.sessionId} receiveIdType=${runtime.receiveIdType} receiveId=${runtime.receiveId} dutyCwd=${runtime.dutyCwd} watchMode=${runtime.watchMode} dataDir=${runtime.dataDir} approvalTimeoutMinutes=${runtime.approvalTimeoutMinutes} disablePoller=${Boolean(runtime.disablePoller)} domain=${runtime.domain ?? 'feishu'}`,
  )

  // Smoke-test marker: proves apply() completed inside the live dsh process.
  try {
    fs.mkdirSync(runtime.dataDir ?? '', { recursive: true })
    fs.writeFileSync(
      `${runtime.dataDir ?? '.'}/startup.json`,
      JSON.stringify({ time: Date.now(), sessionId: runtime.sessionId, receiveId: runtime.receiveId }, null, 2),
      'utf-8',
    )
  } catch (error) {
    ctx.logger.warn('feishu-duty', `could not write startup marker: ${error instanceof Error ? error.message : String(error)}`)
  }

  const client = new FeishuClient({
    appId: runtime.appId ?? '',
    appSecret: runtime.appSecret ?? '',
    domain: runtime.domain === 'lark' ? 'lark' : 'feishu',
    onState: (up) => {
      ctx.logger.info('feishu-duty', up ? 'Feishu channel up' : 'Feishu channel down')
    },
    onError: (error) => {
      ctx.logger.warn('feishu-duty', `feishu error: ${error.message}`)
    },
  })
  const gateway = new Gateway({ ctx, runtime, client, settings, stateOn, stateOff })

  ctx.effect(function* () {
    ctx.on('approval/request', gateway.onApprovalRequest, { prepend: true })
    ctx.on('session/event', gateway.onSessionEvent)
    ctx.tools.register(feishuAskTool(gateway))
    setupSendFileTool(ctx, runtime, gateway)
    ctx.commands.register({
      name: 'feishu-duty-mode',
      description: 'Show the Feishu duty state (local / duty)',
      recordInput: false,
      handler: async () => {
        await gateway.refreshStateMarker()
        return { kind: 'success' }
      },
    })
    ctx.commands.register({
      name: 'feishu-duty-mode-local',
      description: 'Switch the Feishu duty back to local mode',
      recordInput: false,
      handler: async () => {
        await gateway.switchToLocal()
        return { kind: 'success' }
      },
    })
    if (!runtime.disablePoller) {
      gateway.start()
    } else {
      ctx.logger.info('feishu-duty', 'disablePoller=true: Feishu long connection disabled for safe compatibility testing.')
    }
    yield async () => {
      if (!runtime.disablePoller) {
        await gateway.stop()
      }
    }
  }, 'feishu-duty lifecycle')

  if (!runtime.disablePoller && runtime.appId && runtime.appSecret) {
    // Validate credentials in the background; the WS keeps retrying anyway.
    void client.getBotInfo().then(
      (res) => {
        if (res.ok) {
          ctx.logger.info('feishu-duty', `Feishu bot connected: ${res.result?.app_name ?? res.result?.open_id ?? 'unknown'}`)
        } else {
          ctx.logger.warn('feishu-duty', `bot info rejected: ${res.description ?? 'unknown error'}`)
        }
      },
      (error: unknown) => {
        ctx.logger.warn('feishu-duty', `bot info failed: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  }
}
