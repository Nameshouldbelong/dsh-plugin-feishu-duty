/**
 * Duty-mode store (browser half, feishu-duty). The web settings wire is allowlisted, so
 * the host publishes the mode through the 'feishu-duty' namespace (dsh
 * 0.1.7 #677: state markers ride the main namespace's Config as optional
 * stateOn / stateOff fields). A forwarded `settings/document-updated` event
 * carries the namespace NAME only, so the controller reads the effective
 * value (watchMode) through the settings.describe remote once per event.
 */

import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'

export const DUTY_MAIN_NS = 'feishu-duty'

export type DutyMode = 'local' | 'duty'

/** Reads the effective feishu-duty config from the settings plane. */
export type DutyConfigReader = () => Promise<{ watchMode?: DutyMode } | undefined>

/** Banner-relevant snapshot of the duty mode. */
export interface DutyWatchState {
  /** Latest mode learned from the namespace value. */
  mode: DutyMode
  /** Whether at least one mode observation has been made. */
  status: 'idle' | 'ready'
}

/** Keep the duty mode from the forwarded namespace events. */
export class DutyWatchController {
  /** Snapshot consumed through the slot-injected bound selector hook. */
  readonly store: SnapshotStore<DutyWatchState> = createSnapshotStore({
    mode: 'local',
    status: 'idle',
  })

  constructor(private readonly readDutyConfig: DutyConfigReader = async () => undefined) {}

  /** Handle one forwarded settings namespace; only the duty namespace matters. */
  onNamespace(ns: string): void {
    if (ns !== DUTY_MAIN_NS) return
    void this.refresh()
  }

  /** Read the effective mode from the settings plane and update the banner. */
  async refresh(): Promise<void> {
    try {
      const value = await this.readDutyConfig()
      this.setMode(value?.watchMode === 'duty' ? 'duty' : 'local')
    } catch { /* describe may race connect; the seed retry covers it */ }
  }

  private setMode(mode: DutyMode): void {
    const state = this.store.getSnapshot()
    if (state.mode === mode && state.status === 'ready') return
    this.store.update((next) => {
      next.mode = mode
      next.status = 'ready'
    })
  }
}
