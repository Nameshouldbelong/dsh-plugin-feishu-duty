export interface LocalCommand {
  name: string
  aliases: string[]
  usage?: string
  handler: (args: string, env: CommandEnv) => Promise<string | { kind: 'action', type: string, sessionId?: string, shortId?: string } | undefined>
}

export interface CommandEnv {
  targetSessionId: string
}

export function parseLocalCommand(text: string): { name: string; arg: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  
  const match = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/)
  if (!match) return null
  
  let cmd = match[1]!.toLowerCase()
  const arg = match[2] ? match[2].trim() : ''
  
  const aliases: Record<string, string> = {
    '对话': 'sessions',
    'ls': 'sessions',
    '工作区': 'groups',
    '归档': 'archive',
    'rm': 'delete',
    '当前': 'current',
    '新建': 'new',
    '模式': 'agentmode',
    '重命名': 'rename'
  }
  
  if (aliases[cmd]) cmd = aliases[cmd]
  return { name: cmd, arg }
}

export function resolveSessionRef(ref: string, list: string[]): string | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const index = parseInt(trimmed, 10)
  if (!isNaN(index) && String(index) === trimmed) {
    if (index > 0 && index <= list.length) return list[index - 1]!
    return null
  }
  return trimmed
}

export class CommandRegistry {
  commands: LocalCommand[] = []
  register(command: LocalCommand) { this.commands.push(command) }
  resolve(name: string): LocalCommand | undefined {
    return this.commands.find(c => c.name === name || c.aliases.includes(name))
  }
}

import type { SessionRegistry, ModelRegistry, PermissionRegistry, PresetRegistry } from './registries.ts'

export interface CommandContext {
  ctx: any
  sessionRegistry: SessionRegistry
  modelRegistry: ModelRegistry
  permissionRegistry: PermissionRegistry
  presetRegistry: PresetRegistry
  strings: any
  setTargetSessionId: (id: string) => Promise<void>
}

export function registerCommands(registry: CommandRegistry, envCtx: CommandContext) {
  registry.register({
    name: 'sessions',
    aliases: ['对话', 'ls'],
    handler: async (args, env) => {
      const { groups, list } = await envCtx.sessionRegistry.fetch(env.targetSessionId)
      if (list.length === 0) return envCtx.strings.sessionsEmpty || 'No sessions found.'
      const keyboard: any[] = []
      let idx = 0
      for (const group of groups) {
        if (group.sessions.length === 0) continue
        keyboard.push([{ text: `📁 ${group.title || group.path} (${group.sessions.length})`, callback_data: `sess:ws:${idx}` }])
        idx++
      }
      keyboard.push([{ text: envCtx.strings.btnClose, callback_data: 'sess:cancel' }])
      return { kind: 'action', type: 'sessions-card', text: envCtx.strings.sessionCardWsLevel, keyboard } as any
    }
  })

  registry.register({
    name: 'groups',
    aliases: ['工作区'],
    handler: async (args, env) => {
      const { groups } = await envCtx.sessionRegistry.fetch(env.targetSessionId)
      if (groups.length === 0) return 'No workspaces found.'
      let output = envCtx.strings.groupsHeader || 'Workspaces:\n'
      let index = 1
      for (const group of groups) {
        if (group.workspaceId === 'orphaned') continue
        output += `${index++}. ${group.title || group.path} (${group.sessions.length})\n`
      }
      return output
    }
  })

  registry.register({
    name: 'archive',
    aliases: ['归档'],
    handler: async (args, env) => {
      const { groups, list } = await envCtx.sessionRegistry.fetch(env.targetSessionId)
      if (list.length === 0) return envCtx.strings.sessionsEmpty || 'No sessions found.'
      const keyboard: any[] = []
      let idx = 0
      for (const group of groups) {
        if (group.sessions.length === 0) continue
        keyboard.push([{ text: `📁 ${group.title || group.path} (${group.sessions.length})`, callback_data: `arc:ws:${idx}` }])
        idx++
      }
      keyboard.push([{ text: envCtx.strings.btnCancel, callback_data: 'arc:cancel' }])
      return { kind: 'action', type: 'archive-card', text: envCtx.strings.archiveCardWsLevel, keyboard } as any
    }
  })

  registry.register({
    name: 'delete',
    aliases: ['rm'],
    handler: async (args, env) => {
      const { groups, list } = await envCtx.sessionRegistry.fetch(env.targetSessionId)
      if (list.length === 0) return envCtx.strings.sessionsEmpty || 'No sessions found.'
      if (!args) {
        const keyboard: any[] = []
        let idx = 0
        for (const group of groups) {
          if (group.sessions.length === 0) continue
          keyboard.push([{ text: `📁 ${group.title || group.path} (${group.sessions.length})`, callback_data: `del:ws:${idx}` }])
          idx++
        }
        keyboard.push([{ text: envCtx.strings.btnCancel, callback_data: 'del:cancel' }])
        return { kind: 'action', type: 'delete-card', text: envCtx.strings.deleteCardWsLevel, keyboard } as any
      }
      const s = envCtx.sessionRegistry.resolveIndex(args)
      if (!s) return envCtx.strings.switchNotFound || 'Session not found.'
      const shortId = s.id.split('-').pop()?.slice(0, 8) || s.id
      return { kind: 'action', type: 'confirm-delete', sessionId: s.id, shortId } as any
    }
  })

  registry.register({
    name: 'current',
    aliases: ['当前'],
    handler: async (args, env) => {
      const { list } = await envCtx.sessionRegistry.fetch(env.targetSessionId)
      const s = list.find(x => x.id === env.targetSessionId)
      let title = s?.title || env.targetSessionId
      let cwd = s?.cwd || ''
      const currentSelection = envCtx.ctx.agentDefaultModel.currentSelection()
      return (envCtx.strings.currentStatus || 'Current session:\n') + 
        `ID: ${title}\nDir: ${cwd}\nModel: ${currentSelection.provider}/${currentSelection.model}\n`
    }
  })

  registry.register({
    name: 'model',
    aliases: [],
    handler: async (args, env) => {
      if (!args) return { kind: 'action', type: 'model-card' } as any
      const { models } = await envCtx.modelRegistry.fetch()
      const parts = args.split('/')
      if (parts.length !== 2) return 'Format: provider/model'
      const [prov, mod] = parts
      const infoList = models[prov]
      if (!infoList || !infoList.includes(mod)) return 'Model not found'
      await envCtx.ctx.agentDefaultModel.saveSelection({ provider: prov, model: mod })
      return envCtx.strings.modelSwitched || `Switched to ${prov}/${mod}`
    }
  })

  registry.register({
    name: 'rename',
    aliases: ['重命名'],
    handler: async (args, env) => {
      const newTitle = args.trim()
      if (!newTitle) {
        return envCtx.strings.renameUsage || '📝 请输入新会话名称，例如：\n/rename 算法优化研讨'
      }
      const targetId = env.targetSessionId
      if (!targetId) {
        return envCtx.strings.renameNoSession || '未找到目标会话。'
      }
      let agent = envCtx.ctx.agents.get(targetId)
      if (!agent && envCtx.ctx.agents.resolveAgent) {
        try { agent = await envCtx.ctx.agents.resolveAgent(targetId) } catch {}
      }
      if (!agent) {
        return envCtx.strings.renameNoSession || '未找到目标会话。'
      }
      const titles = envCtx.ctx.get('sessionTitle')
      if (!titles) {
        return 'sessionTitle service is not available.'
      }
      try {
        const accepted = titles.rename(agent.session, newTitle)
        envCtx.sessionRegistry.markDirty()
        const successFn = envCtx.strings.renameSuccess || ((t: string) => `✅ 会话名称已成功更改为「${t}」`)
        return successFn(accepted?.title || newTitle)
      } catch (err: any) {
        const failFn = envCtx.strings.renameFailed || ((e: string) => `重命名失败: ${e}`)
        return failFn(err?.message || String(err))
      }
    }
  })

  registry.register({
    name: 'mode',
    aliases: [],
    handler: async (args, env) => {
      if (!args) {
        return { kind: 'action', type: 'mode-card' } as any
      }
      const names = envCtx.permissionRegistry.fetch()
      if (!names.includes(args)) return 'Mode not found'
      let agent = envCtx.ctx.agents.get(env.targetSessionId)
      if (!agent && envCtx.ctx.agents.resolveAgent) {
        try { agent = await envCtx.ctx.agents.resolveAgent(env.targetSessionId) } catch {}
      }
      if (!agent) return envCtx.strings.modeNoAgent || 'Session inactive. Permissions will apply when active.'
      envCtx.ctx.permissionPresets.set(agent.session, args)
      return envCtx.strings.modeSwitched || `Permissions set to ${args}`
    }
  })

  registry.register({
    name: 'agentmode',
    aliases: ['模式'],
    handler: async (args, env) => {
      const list = await envCtx.presetRegistry.fetch()
      if (!args) {
        let output = envCtx.strings.agentModeListHeader || 'Agent presets:\n'
        for (const p of list) output += `- ${p.title || p.id}\n`
        return output
      }
      return 'Setting preset via command is unsupported. Please use /new'
    }
  })
}
