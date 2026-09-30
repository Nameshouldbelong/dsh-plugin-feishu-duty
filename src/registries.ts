import type { Context } from '@deepseek-ai/cordis'

export interface SessionItem {
  index: number
  id: string
  title: string
  cwd: string
  live: boolean
  isCurrent: boolean
}

export interface WorkspaceGroup {
  workspaceId: string
  path: string
  title?: string
  sessions: SessionItem[]
}

export class SessionRegistry {
  private lastFetchTime = 0
  private dirty = true
  private cachedGroups: WorkspaceGroup[] = []
  private cachedList: SessionItem[] = []
  private ctx: any

  constructor(ctx: any) {
    this.ctx = ctx
  }

  markDirty() {
    this.dirty = true
  }

  async fetch(currentSessionId: string): Promise<{ groups: WorkspaceGroup[], list: SessionItem[] }> {
    const now = Date.now()
    if (!this.dirty && now - this.lastFetchTime < 30000) {
      return { groups: this.cachedGroups, list: this.cachedList }
    }
    
    let records: any[] = []
    try {
      records = await this.ctx.sessionQuery.listSessions()
    } catch (e) {}

    let workspaces: any[] = []
    try {
       workspaces = await this.ctx.workspaceRegistry.list()
    } catch (e) {}

    let archivedSet = new Set<string>()
    try {
      const ids = this.ctx.workspaceRegistry.archivedSessionIds
      if (ids) {
        archivedSet = new Set(ids)
      }
    } catch (e) {
      if (this.ctx.logger && this.ctx.logger.warn) {
        this.ctx.logger.warn(`Failed to read archivedSessionIds: ${e}`)
      }
    }

    let sessionProjectionCache: any
    try {
      sessionProjectionCache = this.ctx.get('sessionProjectionCache')
    } catch (e) {}

    const items: SessionItem[] = []
    let i = 1
    for (const record of records) {
       if (archivedSet.has(record.header.id)) {
         continue
       }

       let isBlank = false
       try {
         const meta = sessionProjectionCache?.cachedSnapshot(record.header)?.values?.sessionListMetadata
         if (meta?.blank === true) {
           isBlank = true
         }
       } catch (e) {}
       
       if (isBlank) {
         continue
       }

       let title = record.header.id
       try {
         const t = await this.ctx.sessionQuery.readTitle(record.header.id)
         if (t?.title) title = t.title
       } catch (e) {}

       items.push({
         index: i++,
         id: record.header.id,
         title,
         cwd: record.header.cwd || '',
         live: !!record.live,
         isCurrent: record.header.id === currentSessionId
       })
    }
    this.cachedList = items

    const groups: WorkspaceGroup[] = []
    const usedSessionIds = new Set<string>()

    for (const ws of workspaces) {
      const wss: SessionItem[] = []
      for (const sid of (ws.sessionIds || [])) {
         const item = items.find(s => s.id === sid)
         if (item) {
           wss.push(item)
           usedSessionIds.add(sid)
         }
      }
      groups.push({
        workspaceId: ws.id,
        path: ws.path,
        title: ws.title,
        sessions: wss
      })
    }

    const orphaned: SessionItem[] = []
    for (const item of items) {
      if (!usedSessionIds.has(item.id)) orphaned.push(item)
    }
    
    if (orphaned.length > 0) {
      groups.push({
        workspaceId: 'orphaned',
        path: 'No Workspace',
        sessions: orphaned
      })
    }

    this.cachedGroups = groups
    this.lastFetchTime = now
    this.dirty = false
    
    return { groups: this.cachedGroups, list: this.cachedList }
  }

  resolveIndex(indexOrId: string): SessionItem | undefined {
    const num = parseInt(indexOrId, 10)
    if (!isNaN(num) && num > 0 && num <= this.cachedList.length) {
      return this.cachedList[num - 1]
    }
    return this.cachedList.find(s => s.id === indexOrId || s.id.startsWith(indexOrId))
  }
}

export class ModelRegistry {
  private lastFetchTime = 0
  private cachedProviders: any[] = []
  private cachedModels: Record<string, string[]> = {}
  private ctx: any

  constructor(ctx: any) {
    this.ctx = ctx
  }

  async resolveReasoningEfforts(provider: string, model: string): Promise<{ id: string; name: string; description?: string }[]> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model)
      return info?.reasoning?.efforts || []
    } catch {
      return []
    }
  }

  async fetch() {
    const now = Date.now()
    if (now - this.lastFetchTime < 300000) return { providers: this.cachedProviders, models: this.cachedModels }
    
    try {
      const providers = this.ctx.llm.listProviders()
      this.cachedProviders = providers
      for (const p of providers) {
        const infos = await this.ctx.llm.listModels(p.id || p)
        this.cachedModels[p.id || p] = infos.map((info: any) => info.id)
      }
    } catch (e) {}
    
    this.lastFetchTime = now
    return { providers: this.cachedProviders, models: this.cachedModels }
  }
}

export class PermissionRegistry {
  private lastFetchTime = 0
  cachedNames: string[] = []
  private ctx: any

  constructor(ctx: any) {
    this.ctx = ctx
  }

  fetch() {
    const now = Date.now()
    if (now - this.lastFetchTime < 300000) return this.cachedNames
    try {
      this.cachedNames = this.ctx.permissionPresets.names || []
    } catch(e) {}
    this.lastFetchTime = now
    return this.cachedNames
  }
}

export class PresetRegistry {
  private lastFetchTime = 0
  cachedList: any[] = []
  private ctx: any

  constructor(ctx: any) {
    this.ctx = ctx
  }

  async fetch() {
    const now = Date.now()
    if (now - this.lastFetchTime < 300000) return this.cachedList
    const presets = this.ctx.get('agentPresets')
    if (presets) {
      try {
        this.cachedList = await presets.list()
      } catch (e) {}
    }
    this.lastFetchTime = now
    return this.cachedList
  }
}
