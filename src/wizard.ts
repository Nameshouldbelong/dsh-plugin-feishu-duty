export const WIZARD_STEPS = ['cwd', 'name', 'provider', 'model', 'reasoning', 'permission', 'preset', 'confirm']

export interface WizardState {
  step: string
  cwd?: string
  name?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  permission?: string
  preset?: string
}

export function encodeWizardCallback(step: string, index: number | string): string {
  return `wiz:${step}:${index}`
}

export function decodeWizardCallback(data: string): { step: string; index: string } | null {
  const match = /^wiz:([^:]+):([^:]+)$/.exec(data)
  if (!match) return null
  return { step: match[1]!, index: match[2]! }
}

export function wizardStart(): WizardState { return { step: 'cwd' } }

export type WizardAction =
  | { kind: 'done'; params: Omit<WizardState, 'step'> }
  | { kind: 'awaitText' }
  | { kind: 'cancelled' }

export function wizardCallback(state: WizardState, payload: { step: string, index: string }, lists?: any): { state: WizardState, action?: WizardAction } {
  if (state.step !== payload.step) return { state }

  const ns = { ...state }
  
  if (ns.step === 'cwd') {
    if (payload.index === 'new') return { state: ns, action: { kind: 'awaitText' } }
    const idx = parseInt(payload.index, 10)
    if (lists && lists.workspaces && lists.workspaces[idx]) {
       ns.cwd = lists.workspaces[idx].path
       ns.step = 'name'
       return { state: ns, action: { kind: 'awaitText' } }
    }
    return { state: ns }
  }

  if (ns.step === 'name') {
    if (payload.index === 'skip') {
      ns.step = 'provider'
      return { state: ns }
    }
    if (payload.index === 'cancel') {
      return { state: ns, action: { kind: 'cancelled' } }
    }
    return { state: ns }
  }
  
  if (ns.step === 'provider') {
     const idx = parseInt(payload.index, 10)
     if (lists && lists.providers && lists.providers[idx]) {
        ns.provider = lists.providers[idx].id || lists.providers[idx]
        ns.step = 'model'
     }
     return { state: ns }
  }

  if (ns.step === 'model') {
     const idx = parseInt(payload.index, 10)
     if (lists && lists.models && lists.models[idx]) {
        ns.model = lists.models[idx].id || lists.models[idx]
        if (lists.reasoningEfforts && lists.reasoningEfforts.length > 0) {
          ns.step = 'reasoning'
        } else {
          ns.step = 'permission'
        }
     }
     return { state: ns }
  }
  
  if (ns.step === 'reasoning') {
     if (payload.index === 'cancel') {
        return { state: ns, action: { kind: 'cancelled' } }
     }
     if (payload.index === 'skip') {
        ns.reasoningEffort = undefined
        ns.step = 'permission'
     } else {
        const idx = parseInt(payload.index, 10)
        if (lists && lists.reasoningEfforts && lists.reasoningEfforts[idx]) {
           ns.reasoningEffort = lists.reasoningEfforts[idx].id
           ns.step = 'permission'
        }
     }
     return { state: ns }
  }

  if (ns.step === 'permission') {
     const idx = parseInt(payload.index, 10)
     if (lists && lists.permissions && lists.permissions[idx]) {
        ns.permission = lists.permissions[idx]
        ns.step = 'preset'
     }
     return { state: ns }
  }

  if (ns.step === 'preset') {
     const idx = parseInt(payload.index, 10)
     if (lists && lists.presets && lists.presets[idx]) {
        ns.preset = lists.presets[idx].id || lists.presets[idx]
        ns.step = 'confirm'
     }
     return { state: ns }
  }

  if (ns.step === 'confirm') {
     if (payload.index === 'yes') {
        return { state: ns, action: { kind: 'done', params: { cwd: ns.cwd, name: ns.name, provider: ns.provider, model: ns.model, reasoningEffort: ns.reasoningEffort, permission: ns.permission, preset: ns.preset } } }
     } else if (payload.index === 'no') {
        return { state: ns, action: { kind: 'cancelled' } }
     }
  }

  return { state: ns }
}

export function wizardText(state: WizardState, text: string): { state: WizardState, action?: WizardAction } {
  const ns = { ...state }
  const trimmed = text.trim()
  if (ns.step === 'cwd') {
    ns.cwd = trimmed
    ns.step = 'name'
    return { state: ns, action: { kind: 'awaitText' } }
  }
  if (ns.step === 'name') {
    ns.name = trimmed !== '-' ? trimmed : undefined
    ns.step = 'provider'
    return { state: ns }
  }
  return { state: ns }
}

export function wizardCancel(state: WizardState): { state: WizardState, action: WizardAction } {
  return { state, action: { kind: 'cancelled' } }
}
