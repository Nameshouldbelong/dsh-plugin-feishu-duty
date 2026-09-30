/**
 * Ambient declarations for browser-side platform seed modules that have no
 * node_modules presence: the web frontend bundles them into the module table
 * (by() seed dict) and resolves them at runtime; tsc only needs the types.
 *
 * 注意（TS 行为约束）：
 * - 本文件必须保持为**纯声明脚本**（无顶层 import/export），否则其中
 *   的 `declare module` 会变成模块增广，对无实体模块报"找不到模块"。
 * - 反之，对 node_modules 中**有实体**的模块（cordis、ui-slots 等），
 *   此处绝不可 `declare module` —— 全局脚本中的 ambient 声明会遮蔽
 *   node_modules 真实类型。有实体模块的增广见 host-augmentations.d.ts。
 *
 * 组成：
 * 1. `@deepseek-ai/dsh-client-store`：状态库最小类型面，移植自旧版
 *    `@deepseek-ai/dsh-client-runtime/client` 的 contract/store.d.ts。
 *    宿主升级种子模块时需同步。
 * 2. `@deepseek-ai/dsh-client-locale/client` 与
 *    `@deepseek-ai/dsh-client-ui-layout/client`：源码以 `import type {}`
 *    引入、仅用其声明合并副作用；此处声明为空模块使解析通过。
 */

// 1. dsh-client-store 最小类型面
declare module '@deepseek-ai/dsh-client-store' {
  /** Minimal observable snapshot source. */
  export interface ObservableSnapshot<T> {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
  }
  /** Writable snapshot store (bare data face). */
  export interface SnapshotStore<T> extends ObservableSnapshot<T> {
    /** Mutate the state through an immer draft. */
    update(mutator: (draft: T) => void): void
    /** Replace the state wholesale. */
    set(next: T): void
  }
  /** Create a writable snapshot store. */
  export function createSnapshotStore<T>(init: T, opts?: {
    flush?: 'raf' | 'sync'
    persist?: { name: string }
  }): SnapshotStore<T>

  // ---- slot 系统的 store 契约家族（移植自旧版 ui-slots store.d.ts；新版
  // ui-slots 自 dsh-client-store re-export，shim 必须提供这些名字）----

  /** Typed selector hook over a snapshot source. */
  export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S
  /** Selector hook over a source that follows the current session. */
  export type MaybeSnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S | undefined
  /** Action declaration table: pure immer-draft transforms over the store state. */
  export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>
  /** Draft-stripped callback form of an actions table. */
  export type BakedActions<T, A extends ActionsDecl<T>> = {
    [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
  }
  /** Store declaration spec: initial-state factory + optional persist key + actions. */
  export interface StoreSpec<T, A extends ActionsDecl<T>> {
    init: () => T
    persist?: string
    actions: A
  }
  /** Live engine instance. */
  export interface StoreInstance<T, A extends ActionsDecl<T>> {
    readonly actions: BakedActions<T, A>
    getSnapshot(): T
    subscribe(fn: () => void): () => void
    clearPersisted(): void
  }
  /** Store handle: spec + state/actions types + shared identity + instance factory. */
  export interface StoreHandle<T, A extends ActionsDecl<T>> {
    readonly spec: StoreSpec<T, A>
    create(scopeKey?: string): StoreInstance<T, A>
  }
  /** Exclusive-store registration form. */
  export type StoreFactory = () => StoreHandle<any, any>
  /** The register `store` option position: a shared handle or an exclusive factory. */
  export type StoreDecl = StoreHandle<any, any> | StoreFactory
  /** Normalize a store declaration to its handle type. */
  export type HandleOf<H> = H extends () => infer R ? R : H
  /** Handle-keyed baked actions. */
  export type BoundActions<H> = H extends StoreHandle<infer T, infer A> ? BakedActions<T, A> : never
  /** The store props share derived from the declared handle. */
  export type PropsStore<H> = H extends StoreHandle<infer T, infer A> ? {
    useStore: SnapshotSelectorHook<T>
    actions: BakedActions<T, A>
  } : object
  /** The defineStore contract: spec in, handle out. */
  export type DefineStore = <T, A extends ActionsDecl<T>>(spec: StoreSpec<T, A>) => StoreHandle<T, A>
}

// 2. 仅作声明合并副作用引入的宿主 client 入口
declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-layout/client' {}
