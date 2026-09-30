// 契约测试：/sessions 与 /groups 可见性过滤（v0.6.1 纯逻辑）
// 规则出处：docs/DESIGN-v0.6.1.md §2（R1 归档隐藏 / R2 blank 隐藏 / R3 序号连续 / R4 空 orphan 组不生成）
// 运行：node --test tests/sessions-visibility.test.ts（Node 24，零依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionRegistry } from '../src/registries.ts'

// ---- fake ctx 工厂 --------------------------------------------------------

function makeCtx({ records, workspaces = [], archived = [], blankIds = [], throwOnArchived = false }) {
  const blankSet = new Set(blankIds)
  return {
    sessionQuery: {
      async listSessions() {
        return records.map(r => ({
          header: { id: r.id, cwd: r.cwd || '/w' },
          live: !!r.live,
          persisted: true,
        }))
      },
      async readTitle(id) {
        return { title: `title-${id}` }
      },
    },
    workspaceRegistry: {
      get archivedSessionIds() {
        if (throwOnArchived) throw new Error('state not ready')
        return archived
      },
      async list() {
        return workspaces
      },
    },
    get(name) {
      if (name !== 'sessionProjectionCache') return undefined
      return {
        cachedSnapshot(header) {
          // 无缓存行 → undefined（fail-soft 显示）；有行则给出 blank 标记
          return { asOfSeq: 1, values: { sessionListMetadata: { blank: blankSet.has(header.id), lastPromptAt: null } } }
        },
      }
    },
    logger: { warn() {} },
  }
}

const rec = id => ({ id })

// ---- R1 归档隐藏 -----------------------------------------------------------

test('R1: 归档会话从 list 与 groups 中隐藏', async () => {
  const ctx = makeCtx({
    records: [rec('s1'), rec('s2'), rec('s3')],
    workspaces: [{ id: 'w1', path: '/w', title: 'W', sessionIds: ['s1', 's2', 's3'] }],
    archived: ['s2'],
  })
  const reg = new SessionRegistry(ctx)
  const { groups, list } = await reg.fetch('s1')
  assert.deepEqual(list.map(s => s.id), ['s1', 's3'])
  assert.deepEqual(groups[0].sessions.map(s => s.id), ['s1', 's3'])
})

test('R1 降级: archivedSessionIds 读取抛错时 fail-soft 不过滤', async () => {
  const ctx = makeCtx({ records: [rec('s1'), rec('s2')], archived: ['s2'], throwOnArchived: true })
  const reg = new SessionRegistry(ctx)
  const { list } = await reg.fetch('')
  assert.equal(list.length, 2)
})

// ---- R2 blank 隐藏 ---------------------------------------------------------

test('R2: blank=true 会话隐藏；无缓存行按显示处理', async () => {
  const ctx = makeCtx({ records: [rec('s1'), rec('s2'), rec('s3')], blankIds: ['s2'] })
  // 模拟 s3 无缓存行：覆盖 get 返回的 cache
  const origGet = ctx.get.bind(ctx)
  ctx.get = name => {
    const svc = origGet(name)
    if (!svc) return svc
    return {
      cachedSnapshot(header) {
        if (header.id === 's3') return undefined
        return svc.cachedSnapshot(header)
      },
    }
  }
  const reg = new SessionRegistry(ctx)
  const { list } = await reg.fetch('')
  assert.deepEqual(list.map(s => s.id), ['s1', 's3'])
})

// ---- R3 序号连续 -----------------------------------------------------------

test('R3: 过滤后 index 连续且 resolveIndex 寻址与显示一致', async () => {
  const ctx = makeCtx({ records: [rec('s1'), rec('s2'), rec('s3')], archived: ['s1'] })
  const reg = new SessionRegistry(ctx)
  const { list } = await reg.fetch('')
  assert.deepEqual(list.map(s => s.index), [1, 2])
  assert.equal(reg.resolveIndex('1').id, 's2')
  assert.equal(reg.resolveIndex('2').id, 's3')
})

// ---- R4 空 orphan 组不生成 --------------------------------------------------

test('R4: 孤儿全部被过滤后不生成 No Workspace 组', async () => {
  const ctx = makeCtx({
    records: [rec('s1'), rec('s2')],
    workspaces: [{ id: 'w1', path: '/w', title: 'W', sessionIds: ['s1'] }],
    archived: ['s2'],
  })
  const reg = new SessionRegistry(ctx)
  const { groups } = await reg.fetch('')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].workspaceId, 'w1')
})

test('R4: 未归档非 blank 孤儿仍保留在 No Workspace 组', async () => {
  const ctx = makeCtx({
    records: [rec('s1'), rec('s2')],
    workspaces: [{ id: 'w1', path: '/w', title: 'W', sessionIds: ['s1'] }],
  })
  const reg = new SessionRegistry(ctx)
  const { groups } = await reg.fetch('')
  assert.equal(groups.length, 2)
  assert.equal(groups[1].workspaceId, 'orphaned')
  assert.deepEqual(groups[1].sessions.map(s => s.id), ['s2'])
})

// ---- 混合场景：对齐 2026-09-01 事故数据形态 ---------------------------------

test('混合: 13 归档 + 3 blank 孤儿 + 6 有效 → 仅 6 条可见', async () => {
  const valid = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6']
  const archivedIds = Array.from({ length: 13 }, (_, i) => `a${i}`)
  const blankIds = ['b0', 'b1', 'b2']
  const ctx = makeCtx({
    records: [...valid, ...archivedIds, ...blankIds].map(rec),
    workspaces: [
      { id: 'w1', path: '/w1', title: 'W1', sessionIds: ['v1', 'v2', 'v3', 'v4'] },
      { id: 'w2', path: '/w2', title: 'W2', sessionIds: ['v5', 'v6'] },
    ],
    archived: archivedIds,
    blankIds,
  })
  const reg = new SessionRegistry(ctx)
  const { groups, list } = await reg.fetch('')
  assert.equal(list.length, 6)
  assert.equal(groups.length, 2)
  assert.deepEqual(list.map(s => s.index), [1, 2, 3, 4, 5, 6])
})
