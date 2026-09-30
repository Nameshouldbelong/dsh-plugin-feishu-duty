/**
 * User-facing string table for the Feishu channel. Every text the user can
 * see in their Feishu chat lives here; `language` selects the table ('zh' | 'en').
 * @module @nameshouldbelong/dsh-feishu-duty/i18n
 */

export type PluginLanguage = 'zh' | 'en'

export interface Strings {
  dutyOn: string
  dutyOff: string
  alreadyDuty: string
  alreadyLocal: string
  help: string
  dutyPersona: string
  approvalQuestion: (id: number, toolName: string, reason: string, minutes: number) => string
  approvalTimeout: (id: number, minutes: number) => string
  approvalAccepted: (id: number) => string
  approvalRejected: (id: number) => string
  approvalUnknown: (id: number) => string
  approvalAmbiguous: (count: number, first: number) => string
  dutyError: (error: string) => string
  dutyEmpty: string
  approveButton: string
  rejectButton: string
  askQuestion: (question: string, minutes: number) => string
  askTimeout: (minutes: number) => string
  askAnswered: string
  callbackUnknown: string
  routedTo: (target: string) => string
  stopSuccess: string
  stopEmpty: string
  /** v0.6.0 按钮固化标签 */
  selectedLabel: string
  timeoutLabel: string
  cancelledLabel: string
  customWaitLabel: string
  /** v0.6.0 本地命令 */
  unknownCommand: string
  cancelled: string
  switched: string
  switchNotFound: string
  deleted: string
  deleteConfirm: (shortId: string) => string
  deleteConfirmYes: string
  deleteConfirmNo: string
  sessionsHeader: string
  sessionsEmpty: string
  sessionsTruncated: string
  groupsHeader: string
  sessionCardWsLevel: string
  sessionCardSessLevel: (title: string) => string
  sessionCardSwitched: (title: string, shortId: string, cwd: string) => string
  archiveCardWsLevel: string
  archiveCardSessLevel: string
  archiveCardConfirm: (title: string) => string
  archiveCardDone: (title: string) => string
  deleteCardWsLevel: string
  deleteCardSessLevel: string
  deleteCardConfirm: (title: string, cwd: string) => string
  deleteCardDone: (title: string) => string
  modelCardProvLevel: (curModel: string, curMode: string) => string
  modelCardModelLevel: (curModel: string, curMode: string, provider: string) => string
  modelCardModeLevel: (provider: string, model: string) => string
  modelCardDone: (provider: string, model: string, finalMode: string) => string
  btnBackToWs: string
  btnBackToProv: string
  btnCancel: string
  btnConfirmArchive: string
  btnConfirmDelete: string
  btnKeepMode: string
  btnClose: string
  currentMarker: string
  liveMarker: string
  currentStatus: string
  modelListHeader: string
  modelSwitched: string
  modeListHeader: string
  modeSwitched: string
  modeNoAgent: string
  agentModeListHeader: string
  /** v0.6.0 /new 向导 */
  wizardStepCwd: string
  wizardStepName: string
  wizardStepProvider: string
  wizardStepModel: string
  wizardStepPermission: string
  wizardStepPreset: string
  wizardConfirm: string
  wizardCreated: string
  wizardCancelled: string
  wizardStepReasoning: (provider: string, model: string) => string
  btnSkip: string
  renameUsage: string
  renameSuccess: (title: string) => string
  renameNoSession: string
  renameFailed: (error: string) => string
  modeCardTitle: (title: string, mode: string) => string
  modeCardSwitched: (title: string, mode: string) => string
  modeCardClosed: string
  todoSeparator: string
  todoTruncated: (n: number) => string
  dutyContextOverflow: (error: string, savedPath?: string) => string
}

const zh: Strings = {
  dutyOn: '🔔 已进入值守模式：审批将转发到飞书，网页弹窗暂停。回复 /back 或回电脑后在网页发条消息即可切回。',
  dutyOff: '🖥 已回到本地模式：审批恢复网页弹窗。',
  alreadyDuty: '🔔 已在值守模式中。',
  alreadyLocal: '🖥 当前就是本地模式，审批在网页弹窗。',
  help: [
    '🤖 DSH 飞书值班机器人',
    '',
    '· 直接发消息 → 值班智能体开始干活，完成后回复你',
    '· /away → 进入值守模式（审批转到飞书）',
    '· /back → 回到本地模式（审批恢复网页弹窗）',
    '· 发消息即自动进入值守；回电脑在网页发条消息即自动切回本地',
    '· 审批回复格式：3 同意 / 3 拒绝',
  ].join('\n'),
  approvalQuestion: (id, toolName, reason, minutes) =>
    `【审批 #${id}】工具「${toolName}」请求批准${reason !== '' ? `：${reason}` : ''}\n回复 ${id} 同意 / ${id} 拒绝（${minutes} 分钟内有效）`,
  approvalTimeout: (id, minutes) => `【审批 #${id}】已超时（${minutes} 分钟），按拒绝处理。`,
  approvalAccepted: (id) => `【审批 #${id}】✅ 已同意。`,
  approvalRejected: (id) => `【审批 #${id}】⛔ 已拒绝。`,
  approvalUnknown: (id) => `【审批 #${id}】不存在或已超时。`,
  approvalAmbiguous: (count, first) => `有 ${count} 条审批待处理，请带编号回复，例如：${first} 同意`,
  dutyError: (error) => `😵 值班会话处理失败：${error}`,
  dutyEmpty: '😶 值班会话没有返回内容，请再试一次。',
  dutyPersona: [
    '你是用户的飞书值班助手，通过飞书消息与用户联系。',
    '要求：用简体中文回复，简洁务实；回答前先查看相关项目的进度文件（如工作区下的 task_plan.md、progress.md、HANDOFF.md、CLAUDE.md）再作答；',
    '执行任务时遵循工作区 CLAUDE.md 的用户规则；',
    '拿不准意图先问清楚再动手；需要向用户提问、让用户做选择或确认时，优先使用 feishu_ask 工具（把问题推送到用户飞书）；需要向用户发送文件时，优先使用 feishu_send_file 工具；',
    '重要操作完成后简短汇报结果。',
  ].join(''),
  approveButton: '✅ 同意',
  rejectButton: '⛔ 拒绝',
  askQuestion: (question, minutes) => `❓ ${question}\n（${minutes} 分钟内回复，点按钮或直接回复选项）`,
  askTimeout: (minutes) => `❓ 提问已超时（${minutes} 分钟），未收到回答。`,
  askAnswered: '✅ 已选择',
  callbackUnknown: '该按钮已失效或已处理。',
  routedTo: (target) => `[已路由至 ${target}]`,
  stopSuccess: '🛑 已停止当前任务',
  stopEmpty: '当前没有进行中的任务',
  selectedLabel: '✅ 已选：',
  timeoutLabel: '⏱ 已超时',
  cancelledLabel: '— 已取消',
  customWaitLabel: '✏️ 等待输入…',
  unknownCommand: '未知命令。发送 /help 查看可用命令。',
  cancelled: '已取消',
  switched: '✅ 已切换至：',
  switchNotFound: '会话不存在或已归档。发送 /sessions 查看列表。',
  deleted: '🗑 已归档该会话',
  deleteConfirm: (shortId) => `确认归档会话「${shortId}」？（归档后可在 web 端恢复）`,
  deleteConfirmYes: '🗑 确认归档',
  deleteConfirmNo: '取消',
  sessionsHeader: '📋 会话列表：\n',
  sessionsEmpty: '暂无会话。',
  sessionsTruncated: '\n…（已截断，仅显示前 50 条）',
  groupsHeader: '📁 工作区列表：\n',
  sessionCardWsLevel: '📋 会话管理 — 请选择工作区：',
  sessionCardSessLevel: (title: string) => `📁 工作区：${title}\n请选择要切换的会话：`,
  sessionCardSwitched: (title: string, shortId: string, cwd: string) => `✅ 已切换至会话：${title} (${shortId})\n📁 路径：${cwd}`,
  archiveCardWsLevel: '📦 归档会话 — 请选择所在工作区：',
  archiveCardSessLevel: '📦 请选择要归档的会话：',
  archiveCardConfirm: (title: string) => `📦 确认归档会话「${title}」？\n• 提示：归档后不会丢失文件与历史，可在 Web 端随时恢复。`,
  archiveCardDone: (title: string) => `📦 会话「${title}」已归档。`,
  deleteCardWsLevel: '🗑 永久删除会话 — 请选择目标工作区：',
  deleteCardSessLevel: '🗑 请选择要永久删除的会话：',
  deleteCardConfirm: (title: string, cwd: string) => `⚠️ 严重警告：您即将永久删除会话「${title}」！\n• 路径: ${cwd}\n• 此操作彻底清除该会话，不可恢复！`,
  deleteCardDone: (title: string) => `🗑 会话「${title}」已彻底删除。`,
  modelCardProvLevel: (curModel: string, curMode: string) => `🧠 模型与模式配置\n• 当前模型：${curModel}\n• 当前模式：${curMode}\n\n请选择模型供应商：`,
  modelCardModelLevel: (curModel: string, curMode: string, provider: string) => `🧠 模型与模式配置\n• 当前模型：${curModel}\n• 当前模式：${curMode}\n\n🏢 已选供应商：${provider}\n请选择模型：`,
  modelCardModeLevel: (provider: string, model: string) => `✅ 模型已更新为：${provider}/${model}\n\n🔐 请选择会话权限模式（Mode）：`,
  modelCardDone: (provider: string, model: string, finalMode: string) => `🎉 配置已全部生效！\n• 模型：${provider}/${model}\n• 模式：${finalMode}`,
  btnBackToWs: '◀️ 返回工作区',
  btnBackToProv: '◀️ 返回供应商',
  btnCancel: '❌ 取消',
  btnConfirmArchive: '📦 确认归档',
  btnConfirmDelete: '🔥 确认彻底删除',
  btnKeepMode: '⏩ 保持当前模式',
  btnClose: '❌ 关闭',
  currentMarker: '●',
  liveMarker: '⚡',
  currentStatus: '📍 当前路由目标：\n',
  modelListHeader: '🧠 可用模型：\n',
  modelSwitched: '✅ 模型已切换',
  modeListHeader: '🔐 权限预设：\n',
  modeSwitched: '✅ 权限预设已切换',
  modeNoAgent: '目标会话未激活：请先用 /switchto 切换后发一条消息激活，再设置权限。',
  agentModeListHeader: '🎭 模式预设：\n',
  wizardStepCwd: '请选择工作区（或新建）：',
  wizardStepName: '请输入会话名称（发送 - 留空）：',
  wizardStepProvider: '请选择模型供应商：',
  wizardStepModel: '请选择模型：',
  wizardStepPermission: '请选择权限预设：',
  wizardStepPreset: '请选择模式预设：',
  wizardConfirm: '确认创建？',
  wizardCreated: '✅ 会话已创建并切换为当前路由目标。',
  wizardCancelled: '向导已取消。',
  wizardStepReasoning: (provider, model) => `🧠 思考强度 (Reasoning Effort) — 请选择思考等级：\n模型：${provider}/${model}`,
  btnSkip: '⏭ 跳过 / 默认',
  renameUsage: '📝 请输入新会话名称，例如：\n/rename 算法优化研讨',
  renameSuccess: (title) => `✅ 会话名称已成功更改为「${title}」`,
  renameNoSession: '⚠️ 未找到目标会话或会话未激活。',
  renameFailed: (error) => `重命名失败: ${error}`,
  modeCardTitle: (title, mode) => `🛡️ 权限模式配置 (Permission Mode)\n\n📌 目标会话：${title}\n⚙️ 当前模式：🛡️ ${mode}\n\n请点选要切换的权限预设：`,
  modeCardSwitched: (title, mode) => `✅ 会话「${title}」权限模式已切换为：🛡️ ${mode}\n\n新权限预设在后续操作中即刻生效。`,
  modeCardClosed: '权限模式配置已关闭。',
  todoSeparator: '─────',
  todoTruncated: (n) => `…等 ${n} 项`,
  dutyContextOverflow: (error, savedPath) => `😵 处理失败：目标会话的历史消息已超出当前模型的上下文上限。\n建议：1) 用 /model 切回大上下文模型（如 k3，1M）；2) 或 /new 开新会话重发；3) 或对目标会话执行 /compact 压缩历史。${savedPath ? `\n附件已保存，不会丢失：\`${savedPath}\`` : ''}\n原始错误：\`${error}\``,
}

const en: Strings = {
  dutyOn: '🔔 Duty mode on: approvals are forwarded to Feishu and web popups are paused. Reply /back or send a message in the web UI to switch back.',
  dutyOff: '🖥 Local mode: approvals show in the web UI again.',
  alreadyDuty: '🔔 Already in duty mode.',
  alreadyLocal: '🖥 Already in local mode; approvals appear in the web UI.',
  help: [
    '🤖 DSH Feishu Duty Bot',
    '',
    '· Send a message → the duty agent works on it and replies',
    '· /away → enter duty mode (approvals go to Feishu)',
    '· /back → return to local mode (approvals stay in the web UI)',
    '· Any Feishu message switches to duty automatically; any web message switches back',
    '· Approval replies: 3 approve / 3 reject',
  ].join('\n'),
  approvalQuestion: (id, toolName, reason, minutes) =>
    `[Approval #${id}] Tool "${toolName}" requests approval${reason !== '' ? `: ${reason}` : ''}\nReply ${id} approve / ${id} reject (valid ${minutes} min)`,
  approvalTimeout: (id, minutes) => `[Approval #${id}] timed out (${minutes} min), treated as rejected.`,
  approvalAccepted: (id) => `[Approval #${id}] ✅ approved.`,
  approvalRejected: (id) => `[Approval #${id}] ⛔ rejected.`,
  approvalUnknown: (id) => `[Approval #${id}] does not exist or has timed out.`,
  approvalAmbiguous: (count, first) => `${count} approvals are pending; include the number, e.g. ${first} approve`,
  dutyError: (error) => `😵 Duty session failed: ${error}`,
  dutyEmpty: '😶 The duty session returned no content, please try again.',
  dutyPersona: [
    'You are the user\'s Feishu duty assistant, reached through Feishu messages.',
    'Reply in the user\'s language, concisely and practically; before answering, inspect the relevant project progress files (task_plan.md, progress.md, HANDOFF.md, CLAUDE.md) in the workspace;',
    'follow the workspace CLAUDE.md user rules when acting;',
    'when unsure of intent, ask before acting; when you need to ask the user a question, confirm something, or offer choices, prefer the feishu_ask tool (it pushes the question to the user\'s Feishu); when you need to send a file to the user, prefer the feishu_send_file tool;',
    'briefly report after important work completes.',
  ].join(' '),
  approveButton: '✅ Approve',
  rejectButton: '⛔ Reject',
  askQuestion: (question, minutes) => `❓ ${question}\n(Reply within ${minutes} min — tap a button or type an option)`,
  askTimeout: (minutes) => `❓ The question timed out (${minutes} min) with no answer.`,
  askAnswered: '✅ Answered',
  callbackUnknown: 'That button is no longer valid.',
  routedTo: (target) => `[Routed to ${target}]`,
  stopSuccess: '🛑 Current task stopped',
  stopEmpty: 'No ongoing task',
  selectedLabel: '✅ Selected: ',
  timeoutLabel: '⏱ Timed out',
  cancelledLabel: '— Cancelled',
  customWaitLabel: '✏️ Waiting for input…',
  unknownCommand: 'Unknown command. Send /help for the command list.',
  cancelled: 'Cancelled',
  switched: '✅ Switched to: ',
  switchNotFound: 'Session not found or archived. Send /sessions for the list.',
  deleted: '🗑 Session archived',
  deleteConfirm: (shortId) => `Archive session "${shortId}"? (Restorable from the web UI)`,
  deleteConfirmYes: '🗑 Archive',
  deleteConfirmNo: 'Cancel',
  sessionsHeader: '📋 Sessions:\n',
  sessionsEmpty: 'No sessions found.',
  sessionsTruncated: '\n… (truncated, first 50 shown)',
  groupsHeader: '📁 Workspaces:\n',
  sessionCardWsLevel: '📋 Session Management — Choose a workspace:',
  sessionCardSessLevel: (title: string) => `📁 Workspace: ${title}\nChoose a session to switch to:`,
  sessionCardSwitched: (title: string, shortId: string, cwd: string) => `✅ Switched to session: ${title} (${shortId})\n📁 Path: ${cwd}`,
  archiveCardWsLevel: '📦 Archive Session — Choose a workspace:',
  archiveCardSessLevel: '📦 Choose a session to archive:',
  archiveCardConfirm: (title: string) => `📦 Archive session "${title}"?\n• Note: Files and history are kept, and can be restored from the web UI anytime.`,
  archiveCardDone: (title: string) => `📦 Session "${title}" archived.`,
  deleteCardWsLevel: '🗑 Delete Session — Choose a workspace:',
  deleteCardSessLevel: '🗑 Choose a session to delete permanently:',
  deleteCardConfirm: (title: string, cwd: string) => `⚠️ WARNING: You are about to permanently delete session "${title}"!\n• Path: ${cwd}\n• This action is irreversible!`,
  deleteCardDone: (title: string) => `🗑 Session "${title}" deleted permanently.`,
  modelCardProvLevel: (curModel: string, curMode: string) => `🧠 Model & Mode Configuration\n• Current Model: ${curModel}\n• Current Mode: ${curMode}\n\nChoose a model provider:`,
  modelCardModelLevel: (curModel: string, curMode: string, provider: string) => `🧠 Model & Mode Configuration\n• Current Model: ${curModel}\n• Current Mode: ${curMode}\n\n🏢 Provider: ${provider}\nChoose a model:`,
  modelCardModeLevel: (provider: string, model: string) => `✅ Model updated to: ${provider}/${model}\n\n🔐 Choose a permission mode:`,
  modelCardDone: (provider: string, model: string, finalMode: string) => `🎉 Configuration applied!\n• Model: ${provider}/${model}\n• Mode: ${finalMode}`,
  btnBackToWs: '◀️ Back to workspaces',
  btnBackToProv: '◀️ Back to providers',
  btnCancel: '❌ Cancel',
  btnConfirmArchive: '📦 Confirm archive',
  btnConfirmDelete: '🔥 Confirm delete',
  btnKeepMode: '⏩ Keep current mode',
  btnClose: '❌ Close',
  currentMarker: '●',
  liveMarker: '⚡',
  currentStatus: '📍 Current route target:\n',
  modelListHeader: '🧠 Available models:\n',
  modelSwitched: '✅ Model switched',
  modeListHeader: '🔐 Permission presets:\n',
  modeSwitched: '✅ Permission preset switched',
  modeNoAgent: 'Target session is not live: /switchto it and send a message first, then set permissions.',
  agentModeListHeader: '🎭 Agent presets:\n',
  wizardStepCwd: 'Pick a workspace (or create one):',
  wizardStepName: 'Enter a session title (send - to skip):',
  wizardStepProvider: 'Pick a model provider:',
  wizardStepModel: 'Pick a model:',
  wizardStepPermission: 'Pick a permission preset:',
  wizardStepPreset: 'Pick an agent preset:',
  wizardConfirm: 'Create session?',
  wizardCreated: '✅ Session created and set as the route target.',
  wizardCancelled: 'Wizard cancelled.',
  wizardStepReasoning: (provider, model) => `🧠 Reasoning Effort — Select a thinking level:\nModel: ${provider}/${model}`,
  btnSkip: '⏭ Skip / Default',
  renameUsage: '📝 Please enter a new session title, e.g.:\n/rename Algorithm optimization',
  renameSuccess: (title) => `✅ Session title changed to "${title}"`,
  renameNoSession: '⚠️ Target session not found or inactive.',
  renameFailed: (error) => `Failed to rename: ${error}`,
  modeCardTitle: (title, mode) => `🛡️ Permission Mode Configuration\n\n📌 Target session: ${title}\n⚙️ Current mode: 🛡️ ${mode}\n\nSelect a permission preset:`,
  modeCardSwitched: (title, mode) => `✅ Session "${title}" permission mode switched to: 🛡️ ${mode}\n\nNew preset takes effect immediately.`,
  modeCardClosed: 'Permission mode configuration closed.',
  todoSeparator: '─────',
  todoTruncated: (n) => `…and ${n} more`,
  dutyContextOverflow: (error, savedPath) => `😵 Processing failed: The target session's message history exceeds the current model's context limit.\nSuggestions: 1) Use /model to switch to a large-context model (e.g. k3, 1M); 2) Or /new a session and resend; 3) Or run /compact on the target session.${savedPath ? `\nAttachment saved and won't be lost: \`${savedPath}\`` : ''}\nOriginal error: \`${error}\``,
}

/** Resolve the message table for one language. */
export function stringsFor(language: PluginLanguage): Strings {
  return language === 'zh' ? zh : en
}
