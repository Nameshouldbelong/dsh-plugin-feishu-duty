/**
 * Feishu duty gateway plugin, browser half — a frame-wide duty banner
 * (shell.overlay slot). The host publishes the mode via the state-marker
 * settings namespaces (their forwarded events carry the mode); the banner
 * seeds itself by running the host `/feishu-duty-mode` command in the current
 * session, and switches back via `/feishu-duty-mode-local`.
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-layout's SlotMap declaration (shell.overlay) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { DutyBanner } from './DutyBanner.tsx'
import type { DutyBannerInjected } from './DutyBanner.tsx'
import { DutyWatchController } from './settings-store.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'remote', 'sessions', 'locale']

/**
 * Client plugin body: register the duty banner over the shell overlay,
 * driven by forwarded state-marker events with a command-based seed.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new DutyWatchController(async () => {
    const views = await (ctx.remote as any).settings.describe({ redactSecrets: true })
    const view = Array.isArray(views) ? views.find((v: { ns: string }) => v.ns === 'feishu-duty') : undefined
    return view?.value as { watchMode?: 'local' | 'duty' } | undefined
  })
  const sessions = ctx.sessions

  ctx.effect(() => ctx.locale.register('feishu-duty.banner', {
    zh: { title: '审批已转到手机', action: '切回本地' },
    en: { title: 'Approvals are on your phone', action: 'Back to local' },
  }), 'feishu-duty: banner dictionaries')

  /** Run one host command against the current session (no-op without one). */
  const runCommand = (line: string): void => {
    const current = sessions.list.getSnapshot().current
    if (current === undefined) return
    const face = sessions.binding(current)?.session
    if (face === undefined) return
    void face.command(line).catch(() => undefined)
  }

  const seed = (): void => {
    runCommand('/feishu-duty-mode')
  }
  const switchBack = (): void => {
    runCommand('/feishu-duty-mode-local')
  }

  ctx.effect(() => {
    const disposers = [
      // dsh >=0.1.5-rc.2 的 $on listener 类型是依赖泛型的条件类型，上下文
      // 推断会被延迟求值——回调参数必须显式标注（负载实为 SettingsNamespace，
      // 结构上是字符串）。
      ctx.remote.$on('settings/document-updated', (ns: string) => {
        controller.onNamespace(ns)
      }),
      ctx.on('connection/reset', () => {
        seed()
      }),
    ]
    seed()
    // Retry the seed until the first marker event is observed (covers boot
    // ordering and page loads that predate the connection).
    const retry = setInterval(() => {
      if (controller.store.getSnapshot().status === 'ready') return
      seed()
    }, 3000)
    return () => {
      clearInterval(retry)
      for (const dispose of disposers) dispose()
    }
  }, 'feishu-duty: mode feed')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'feishu-duty-banner',
    order: 100,
    locale: 'feishu-duty.banner',
    inject: (): DutyBannerInjected => ({ hooks: { duty: controller.store }, switchBack }),
  }, DutyBanner))
}
