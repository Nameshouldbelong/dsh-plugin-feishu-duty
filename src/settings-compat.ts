/**
 * dsh 0.1.7 settings compatibility layer (#677 migration).
 *
 * dsh 0.1.7 removed `SettingsService.register()`: settings namespaces are now
 * derived from the plugin's exported `Config` schema (one namespace per loader
 * entry, ns = entry id), values are written through `settings.update(ns, patch)`
 * (which routes through the config editor and updates the entry config), and
 * the loader hands `apply()` a per-field LIVE REFERENCE object for the entry's
 * own config.
 *
 * Performance contract: a synchronous `settings.describe()` costs O(all live
 * namespaces) and takes seconds — it must NEVER run on an interaction hot
 * path. This facade therefore:
 *
 *  - reads the OWN namespace exclusively from the loader's live references
 *    (O(1); they reflect the profile patch AND runtime settings.update
 *    writes, exactly like the official agent-default-model service reads
 *    its config);
 *  - keeps cross-namespace reads in a memory cache seeded by ONE background
 *    describe fired at mount (boot-time blocking is free) and refreshed
 *    through write-through on cross-namespace writes;
 *  - implements watch() as a 1 s poll of the live references (O(1)), which
 *    sees both UI edits and in-process writes.
 *
 * State markers ride the main namespace's Config (`stateOn` / `stateOff`
 * optional fields) so the browser half keeps receiving them through the
 * forwarded settings events.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Minimal shape of the 0.1.5 settings handle the Gateway depends on. */
export interface CompatScope<T> {
  get(): T
  update(patch: Partial<T>): Promise<void>
  watch(callback: (next: T) => void): () => void
}

type SettingsPlane = {
  describe(options?: { redactSecrets?: boolean }): unknown
  update?(ns: string, patch: unknown, expectedRevision?: number): Promise<unknown>
}

function settingsPlane(ctx: Context): SettingsPlane | undefined {
  const settings = (ctx as { settings?: SettingsPlane }).settings
  return settings && typeof settings.describe === 'function' ? settings : undefined
}

function coerceField(value: unknown): unknown {
  return value && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value
}

function coerceConfig(source: unknown): Record<string, unknown> {
  if (!source || typeof source !== 'object') return {}
  const out: Record<string, unknown> = {}
  // The loader's volatile Config object exposes fields through NON-ENUMERABLE
  // prototype getters (each holding a live reference with .get()); walk the
  // full prototype chain — entries() and for-in see nothing.
  let proto: object | null = source as object
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || key in out) continue
      out[key] = coerceField((source as Record<string, unknown>)[key])
    }
    proto = Object.getPrototypeOf(proto)
  }
  return out
}

/** Live config view over the entry's own namespace — O(1) reference reads, no describe. */
export function liveScope<T extends object>(ctx: Context, ns: string, fallback: T): CompatScope<T> {
  void ns
  return {
    get(): T {
      // The loader's live references carry the composed config (profile patch
      // base + runtime settings.update writes) — reading them is O(1) and
      // always current.
      return coerceConfig(fallback) as T
    },
    async update(patch: Partial<T>): Promise<void> {
      const settings = settingsPlane(ctx)
      if (!settings?.update) return
      await settings.update(ns, patch)
      // The entry's live references reflect the edit; nothing else to refresh.
    },
    watch(callback: (next: T) => void): () => void {
      let previous = JSON.stringify(this.get())
      const timer = setInterval(() => {
        try {
          const next = JSON.stringify(this.get())
          if (next !== previous) {
            previous = next
            callback(this.get())
          }
        } catch { /* reference read may race shutdown; ignore */ }
      }, 1000)
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as NodeJS.Timeout).unref()
      return () => clearInterval(timer)
    },
  }
}

/** One duty state marker riding the main namespace's Config (`stateOn` / `stateOff`). */
export function markerScope(ctx: Context, ns: string, field: 'stateOn' | 'stateOff', fallback: object): CompatScope<{ n?: number }> {
  void ctx
  const read = (): { n?: number } => {
    const marker = coerceField((fallback as Record<string, unknown>)[field])
    return marker && typeof marker === 'object' ? marker as { n?: number } : {}
  }
  return {
    get: read,
    async update(patch: Partial<{ n?: number }>): Promise<void> {
      const settings = settingsPlane(ctx)
      if (!settings?.update) return
      await settings.update(ns, { [field]: { ...read(), ...patch } })
      // The live reference reflects the edit after the config editor commits.
    },
    watch(): () => void {
      return () => {} // markers are write-only state; nothing polls them host-side
    },
  }
}

// The loader hides another entry's references from us; cross-namespace reads
// fall back to a write-through memory cache seeded once at mount.
const crossCache = new Map<string, Record<string, unknown>>()

/** Cross-namespace read (gateway reads feishu-bridge-control's remembered session). */
export function readCrossNamespace(ctx: Context, ns: string): Record<string, unknown> | undefined {
  void ctx
  return crossCache.get(ns)
}

/** Cross-namespace write (gateway remembers feishu-bridge-control's target session). */
export async function writeCrossNamespace(ctx: Context, ns: string, patch: Record<string, unknown>): Promise<void> {
  crossCache.set(ns, { ...(crossCache.get(ns) ?? {}), ...patch })
  const settings = settingsPlane(ctx)
  if (!settings?.update) return
  await settings.update(ns, patch)
}

/** Seed the cross-namespace cache once at mount with a background describe. */
export function seedCrossNamespace(ctx: Context, ns: string): void {
  void (async () => {
    try {
      const settings = settingsPlane(ctx)
      if (!settings) return
      const views = settings.describe({ redactSecrets: true })
      const view = Array.isArray(views) ? views.find((v) => (v as { ns?: string }).ns === ns) : undefined
      const value = (view?.value ?? undefined) as Record<string, unknown> | undefined
      if (value && !crossCache.has(ns)) crossCache.set(ns, value)
    } catch { /* describe may race startup; the patch config covers it */ }
  })()
}
