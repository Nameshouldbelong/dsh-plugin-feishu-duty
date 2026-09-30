/**
 * 浏览器宿主服务面的类型增广（模块文件，declare module 均为**增广**，
 * 目标模块在 node_modules 有实体；无实体模块的 ambient 声明见
 * seed-modules.d.ts —— 两类文件不可混用，原因见该文件头注）。
 *
 * 组成：
 * 1. 拉入旧版 `@deepseek-ai/dsh-client-runtime/client` 的 cordis 增广
 *    （slots/sessions/workspaces/conversationEvents/connection-reset 等），
 *    作为浏览器宿主服务面的编译期近似——0.1.5 重构只迁移了状态库
 *    （dsh-client-store），这些服务接口面未变。运行时不依赖旧包。
 * 2. `shell.overlay` 槽位增广：真实定义在宿主 ui-layout 包（node_modules
 *    无实体）。按宿主文档注释，它是 scope=root 的 list 槽。
 * 3. `ctx.locale` 服务增广：真实类型在宿主 dsh-client-locale（无实体），
 *    此处按插件实际用法给出最小面。
 */

// 1. 旧版宿主增广（slots/sessions/workspaces/connection-reset）
import type {} from '@deepseek-ai/dsh-client-runtime/client'

// 2. shell.overlay 槽位（宿主 ui-layout 提供；list 槽、root 作用域）
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 全应用浮层列表槽：additive，未启用指针事件前点击穿透。 */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
  }
}

// 3. locale 服务最小面（宿主 dsh-client-locale 提供）
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Web UI locale registry: namespace -> per-locale dictionaries. */
    locale: {
      register(
        ns: string,
        dicts: Record<string, Record<string, string>>,
      ): () => void
    }
  }
}

// 4. Remote 转发事件选择（真实选择由宿主 web assembly 合并；本插件消费
//    settings/document-updated，本地类型层面补该选择使 $on 回调可推断）
declare module '@deepseek-ai/dsh-typert-protocol/types' {
  interface TypertRemoteEventSelection {
    'settings/document-updated': true
  }
}

export {}
