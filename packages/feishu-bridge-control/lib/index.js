/**
 * feishu-bridge-control — Feishu duty bridge control toolset.
 * Registers the feishu_duty_* tools for the DSH Feishu duty assistant:
 * status audit, model/effort switching, permission switching,
 * session/workspace browsing, session creation, and message delivery.
 * The remembered target session survives dsh restarts via the
 * 'feishu-bridge-control' settings namespace, and the duty session
 * gets a recognizable title so the bridge conversation is visible
 * in the web session list.
 *
 * A one-to-one port of telebot-bridge-control (dsh-plugin-telegram-duty,
 * MIT); tool names carry the feishu_duty_ prefix so the Telegram and Feishu
 * bridges can coexist in one host without colliding in the tool registry.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

export const name = 'feishu-bridge-control'
export const inject = [
  'agentDefaultModel',
  'permissionPresets',
  'sessionQuery',
  'workspaceRegistry',
  'llm',
  'settings',
  'tools',
  'agents',
  'agentPresets',
  'sessionTitle',
]

const OWN_NAMESPACE = 'feishu-bridge-control'
const DUTY_NAMESPACE = 'feishu-duty'

/** Fold a turn's final assistant text from session events since firstSeq. */
function summarizeTurn(events, firstSeq) {
  let started = false
  let text = ''
  let error
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = (event.data.message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason
      if (reason.kind === 'error') error = `${reason.error.code}: ${reason.error.message}`
      else if (reason.kind !== 'completed') error = `turn ended with reason "${reason.kind}"`
    }
  }
  return error === undefined ? { text } : { text, error }
}

export const Config = z.object({ sessionId: z.string().default('') }).volatile()

export function apply(ctx) {
  // Durable bridge state: the remembered target session survives restarts.
  // dsh 0.1.7 (#677): the 'feishu-bridge-control' namespace derives from the
  // exported Config schema. The remembered session is read via describe();
  // feishu-duty's gateway writes it cross-namespace via settings.update().
  const readOwnSession = () => {
    try {
      const views = ctx.settings.describe({ redactSecrets: true })
      const view = Array.isArray(views) ? views.find((v) => v && v.ns === OWN_NAMESPACE) : undefined
      return view && view.value ? view.value.sessionId || null : null
    } catch { return null }
  }
  const state = {
    session: readOwnSession(),
    workspace: (() => {
      try {
        const views = ctx.settings.describe({ redactSecrets: true })
        const view = Array.isArray(views) ? views.find((v) => v && v.ns === DUTY_NAMESPACE) : undefined
        const duty = view && view.value
        return duty && duty.dutyCwd ? duty.dutyCwd : null
      } catch { return null }
    })(),
  }
  const renderText = (value) => [{ type: 'text', text: JSON.stringify(value) }]
  const register = (tool) => ctx.effect(() => ctx.tools.register(defineTool(tool)))

  // Give the duty session a recognizable title so the Feishu bridge
  // conversation is visible in the web session list (once, on first activity).
  try {
    ctx.on('session/event', (session, event) => {
      if (session.id !== SessionId('feishu-duty')) return
      if (event.type !== 'user/message' && event.type !== 'turn/end') return
      try {
        const st = ctx.sessionTitle
        if (st === undefined) return
        if (st.get(session) === undefined) st.rename(session, '飞书值班')
      } catch {}
    })
  } catch {}

  // Shared agent-boot plumbing for create/send tools (mirrors duty.ts).
  const bootSetup = (_selection, presetId) => async (agentCtx) => {
    // No installModelSelection: agentOptions owns the initial route and the
    // session controller owns in-session switches. A static snapshot here
    // would outrank the controller's override in the agent/request waterfall
    // and silently pin every request to the creation-time model (Pitfall 6).
    const presets = ctx.get('agentPresets')
    if (presets !== undefined) {
      const resolved = await presets.resolve(presetId === undefined ? undefined : presetId)
      await presets.mount(agentCtx, resolved.id)
    }
  }

  // 1) feishu_duty_status: audit current model / effort / permission preset / targets
  register({
    name: 'feishu_duty_status',
    description: 'Audit the current Feishu duty bridge state: default model and reasoning effort, the calling session\'s permission preset, the remembered target session and workspace, and every available permission preset. Call this first before switching anything.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoningEffort: { type: 'string' },
          preset: { type: 'string', required: true },
          availablePresets: { type: 'array', items: { type: 'string' } },
          currentSession: { type: 'string' },
          currentWorkspace: { type: 'string' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(_args, exec) {
      const current = ctx.agentDefaultModel.currentSelection()
      let presetName = 'unknown'
      if (exec.agent) {
        try { presetName = ctx.permissionPresets.current(exec.agent.session.events) } catch {}
      }
      return {
        provider: current.provider,
        model: current.model,
        reasoningEffort: current.reasoningEffort ?? '',
        preset: presetName,
        availablePresets: ctx.permissionPresets.names,
        currentSession: state.session ?? '',
        currentWorkspace: state.workspace ?? '',
      }
    },
  })

  // 2) feishu_duty_set_model: switch default model / reasoning effort (next turn applies)
  register({
    name: 'feishu_duty_set_model',
    description: 'Switch the default model selection (provider, model, reasoning effort) used by new sessions and the Feishu duty session\'s next message. Omit a field to keep its current value. Reasoning effort values: off, minimal, low, medium, high, xhigh, max.',
    parameters: {
      provider: { type: 'string', description: 'Provider route, e.g. deepseek-official or kimi-coding. Defaults to the current provider.' },
      model: { type: 'string', description: 'Model id under the provider, e.g. deepseek-v4-flash, deepseek-v4-pro, or k3-256k. Defaults to the current model.' },
      reasoningEffort: { type: 'string', description: 'Thinking strength: off, minimal, low, medium, high, xhigh, max. Omit to keep the current value.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoningEffort: { type: 'string' },
          availableModels: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args) {
      const current = ctx.agentDefaultModel.currentSelection()
      const provider = args.provider && args.provider !== '' ? String(args.provider) : current.provider
      const model = args.model && args.model !== '' ? String(args.model) : current.model
      let effort = current.reasoningEffort ?? null
      if (args.reasoningEffort !== undefined && args.reasoningEffort !== null && args.reasoningEffort !== '') {
        effort = String(args.reasoningEffort)
      }
      let available = []
      try {
        const infos = await ctx.llm.listModels(provider)
        available = infos.map((info) => info.id)
        if (available.length > 0 && !available.includes(model)) {
          throw new Error(`model "${model}" is not available under provider "${provider}" (available: ${available.join(', ')})`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('model "')) throw error
      }
      await ctx.agentDefaultModel.saveSelection({
        provider,
        model,
        ...(effort !== null ? { reasoningEffort: effort } : {}),
      })
      return {
        provider,
        model,
        reasoningEffort: effort ?? '',
        availableModels: available,
        note: 'Saved as the default selection; the Feishu duty session picks it up on its next message.',
      }
    },
  })

  // 3) feishu_duty_set_permission: switch the calling session permission preset
  register({
    name: 'feishu_duty_set_permission',
    description: 'Switch the calling session\'s permission preset (sandbox mode + approval policy bundle). This affects the current conversation\'s operation permissions immediately. Available presets come from feishu_duty_status.',
    parameters: {
      preset: { type: 'string', required: true, description: 'Permission preset name: read-only, workspace-write, or danger-full-access.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: { type: 'string', required: true },
          sandbox: { type: 'string', required: true },
          approval: { type: 'string', required: true },
          sessionId: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('feishu_duty_set_permission requires a calling agent')
      const name = String(args.preset)
      const presets = ctx.permissionPresets
      if (!presets.names.includes(name)) {
        throw new Error(`unknown preset "${name}" (available: ${presets.names.join(', ')})`)
      }
      presets.set(exec.agent.session, name)
      const spec = presets.resolve(name)
      return {
        preset: name,
        sandbox: spec.sandbox,
        approval: spec.approval,
        sessionId: exec.agent.session.id,
        note: 'Applied to the calling session; approval answers keep flowing through the Feishu bridge.',
      }
    },
  })

  // 4) feishu_duty_list_sessions
  register({
    name: 'feishu_duty_list_sessions',
    description: 'List every DSH session (id, title, working directory, live/persisted flags). Use this before feishu_duty_switch_session to pick a target.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string' },
                cwd: { type: 'string' },
                live: { type: 'boolean' },
                persisted: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute() {
      const records = await ctx.sessionQuery.listSessions()
      const sessions = []
      for (const record of records.slice(0, 50)) {
        let title = ''
        try {
          const t = await ctx.sessionQuery.readTitle(record.header.id)
          title = t ? t.title : ''
        } catch {}
        sessions.push({
          id: record.header.id,
          title,
          cwd: record.header.cwd ?? '',
          live: record.live,
          persisted: record.persisted,
        })
      }
      return { sessions }
    },
  })

  // 5) feishu_duty_switch_session: remember a target session and return its recent context
  register({
    name: 'feishu_duty_switch_session',
    description: 'Switch the remembered target session for the Feishu bridge. Validates the session exists, remembers its id (persisted across restarts), and returns its title, working directory, and the recent conversation context so you can continue working based on that session\'s history.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Exact session id from feishu_duty_list_sessions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          switchedTo: { type: 'string', required: true },
          title: { type: 'string' },
          cwd: { type: 'string' },
          recentContext: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args) {
      const id = String(args.sessionId)
      const records = await ctx.sessionQuery.listSessions()
      const target = records.find((r) => r.header.id === id)
      if (!target) {
        throw new Error(`session "${id}" not found (use feishu_duty_list_sessions to see all sessions)`)
      }
      state.session = id
      try {
        await ctx.settings.update(OWN_NAMESPACE, { sessionId: id })
      } catch {
        // Persisting the target session is best effort; the in-memory switch still applies.
      }
      let title = ''
      try {
        const t = await ctx.sessionQuery.readTitle(id)
        title = t ? t.title : ''
      } catch {}
      let recentContext = ''
      try {
        const surface = await ctx.sessionQuery.readSurface(id)
        const lines = []
        for (const event of surface.events) {
          if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
          const blocks = event.data && event.data.message ? event.data.message.content : null
          if (!Array.isArray(blocks)) continue
          const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
          if (text) lines.push(`${event.type === 'user/message' ? 'user' : 'assistant'}: ${text}`)
        }
        recentContext = lines.slice(-6).join('\n')
      } catch {}
      return {
        switchedTo: id,
        title,
        cwd: target.header.cwd ?? '',
        recentContext,
        note: 'Remembered as the current target session; continue working based on its context.',
      }
    },
  })

  // 6) feishu_duty_list_workspaces
  register({
    name: 'feishu_duty_list_workspaces',
    description: 'List every registered DSH workspace (id, title, canonical path, attached session ids). Use this before feishu_duty_switch_workspace.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaces: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                path: { type: 'string', required: true },
                sessionIds: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute() {
      const workspaces = ctx.workspaceRegistry.list().map((w) => ({
        id: w.id,
        title: w.title,
        path: w.path,
        sessionIds: [...w.sessionIds],
      }))
      return { workspaces }
    },
  })

  // 7) feishu_duty_switch_workspace: validate, register, remember, persist dutyCwd
  register({
    name: 'feishu_duty_switch_workspace',
    description: 'Switch the working directory for the Feishu bridge. Validates that the path is an existing directory, registers it as a DSH workspace, remembers it as the current workspace, and persists it as the Feishu duty session working directory. After switching, use this path as workdir/cwd for all subsequent file and command tool calls.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path to an existing directory.' },
      title: { type: 'string', description: 'Optional display title for the workspace; defaults to the directory basename.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          switchedTo: { type: 'string', required: true },
          title: { type: 'string' },
          id: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args) {
      const path = String(args.path)
      const created = await ctx.workspaceRegistry.create(path, args.title && args.title !== '' ? String(args.title) : undefined)
      state.workspace = created.path
      try {
        await ctx.settings.update(DUTY_NAMESPACE, { dutyCwd: created.path })
      } catch (error) {
        // Persisting the duty cwd is best effort; the in-memory switch still applies.
      }
      return {
        switchedTo: created.path,
        title: created.title,
        id: created.id,
        note: 'Remembered as the current workspace and persisted as the feishu-duty session cwd. Use this path as workdir/cwd for all subsequent file and command tool calls.',
      }
    },
  })

  // 8) feishu_duty_create_session: open a new conversation
  register({
    name: 'feishu_duty_create_session',
    description: 'Create (open) a new DSH conversation. Specify the working directory; optionally a title (visible in the web session list) and a model/provider override for this session (defaults to the global default). After creation use feishu_duty_send_message to enter it, or feishu_duty_switch_session to remember it as the target.',
    parameters: {
      cwd: { type: 'string', required: true, description: 'Absolute working directory for the new session.' },
      title: { type: 'string', description: 'Optional session title shown in the web session list.' },
      model: { type: 'string', description: 'Optional model id override for this session (defaults to the global default model).' },
      provider: { type: 'string', description: 'Optional provider route (defaults to the global default provider).' },
      reasoningEffort: { type: 'string', description: 'Thinking strength: off, minimal, low, medium, high, xhigh, max. Omit to use global default.' },
      preset: { type: 'string', description: 'Optional agent preset id (模式), e.g. minimal (极简模式). Defaults to the global default preset.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          title: { type: 'string' },
          cwd: { type: 'string' },
          model: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args) {
      const cwd = String(args.cwd)
      const created = await ctx.workspaceRegistry.create(cwd, undefined)
      const selection = ctx.agentDefaultModel.currentSelection()
      const provider = args.provider && args.provider !== '' ? String(args.provider) : selection.provider
      const model = args.model && args.model !== '' ? String(args.model) : selection.model
      let effort = selection.reasoningEffort
      if (args.reasoningEffort !== undefined && args.reasoningEffort !== null && args.reasoningEffort !== '') {
        effort = String(args.reasoningEffort)
      }
      const sessionId = SessionId(`session-${randomUUID()}`)
      const presets = ctx.get('agentPresets')
      const requestedPreset = args.preset && args.preset !== '' ? String(args.preset) : undefined
      const presetId = presets !== undefined ? (await presets.resolve(requestedPreset)).id : undefined
      const handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: created.path,
          ...(presetId !== undefined ? { agentPreset: presetId } : {}),
        },
        agentOptions: { provider, model, ...(effort ? { reasoningEffort: effort } : {}) },
        setup: bootSetup(selection, presetId),
      })
      if (args.title && args.title !== '') {
        try { ctx.sessionTitle.rename(handle.agent.session, String(args.title)) } catch {}
      }
      return {
        sessionId: String(sessionId),
        title: args.title && args.title !== '' ? String(args.title) : '',
        cwd: created.path,
        model,
        note: 'New conversation created and is live. Use feishu_duty_send_message to enter it, or feishu_duty_switch_session to remember it as the target.',
      }
    },
  })

  // 9) feishu_duty_send_message: enter a conversation (deliver a message, return the reply)
  register({
    name: 'feishu_duty_send_message',
    description: 'Send a message into a conversation (enters it). Delivers the text as a follow-up turn to the target session, waits for the agent to settle, and returns its final reply. Defaults to the remembered target session (feishu_duty_switch_session) when sessionId is omitted.',
    parameters: {
      text: { type: 'string', required: true, description: 'Message text to send.' },
      sessionId: { type: 'string', description: 'Target session id; defaults to the remembered target session (see feishu_duty_switch_session).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          reply: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (args, value) => renderText(value),
    },
    async execute(args) {
      const id = args.sessionId && args.sessionId !== '' ? String(args.sessionId) : state.session
      if (!id) throw new Error('no target session: call feishu_duty_switch_session first or pass sessionId')
      const sessionId = SessionId(id)
      const selection = ctx.agentDefaultModel.currentSelection()
      const agentOptions = { provider: selection.provider, model: selection.model }
      const live = ctx.agents.get(sessionId)
      let agent
      let dispose = async () => undefined
      if (live !== undefined) {
        agent = live
      } else {
        let handle
        try {
          handle = await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions,
            setup: bootSetup(selection),
          })
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          throw new Error(`session "${id}" is not resumable (${msg}) — use feishu_duty_list_sessions or feishu_duty_create_session`)
        }
        agent = handle.agent
        dispose = () => handle.dispose().catch(() => undefined)
      }
      try {
        await agent.whenIdle()
        const firstSeq = agent.session.seq
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: String(args.text) }],
          source: { kind: 'plugin:feishu-bridge-control' },
        }))
        await agent.whenIdle()
        // dsh >=0.1.5-rc.2 removed the live Session.events array; snapshotEvents
        // is the supported read path for the turn's events.
        const outcome = summarizeTurn(agent.session.snapshotEvents(firstSeq), firstSeq)
        if (outcome.error !== undefined) throw new Error(outcome.error)
        return {
          sessionId: id,
          reply: outcome.text,
          note: 'Message delivered to the conversation; reply is the session agent\'s final text of this turn.',
        }
      } finally {
        await dispose()
      }
    },
  })
}
