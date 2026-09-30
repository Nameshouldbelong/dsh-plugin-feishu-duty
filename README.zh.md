# dsh-feishu-duty（中文说明）

[![npm](https://img.shields.io/npm/v/@nameshouldbelong/dsh-feishu-duty)](https://www.npmjs.com/package/@nameshouldbelong/dsh-feishu-duty)

把 DeepSeek Harness（DSH）变成随身值班室：手机飞书发消息 → 值班智能体干活 → 结果回复到飞书。空闲时零 token（飞书 WebSocket 长连接事件订阅，消息到达才唤醒智能体；WSL 无公网 IP 也能用）。

[English](README.md)

本插件是 [dsh-plugin-telegram-duty](https://github.com/Nameshouldbelong/dsh-plugin-telegram-duty) 的**飞书原样复刻**：命令管线、审批转发、卡片菜单、/new 向导、进度看板全部一一对应；传输层把 Telegram 长轮询换成飞书长连接、inline keyboard 换成交互卡片按钮。

## 快速开始

1. **创建飞书自建应用**：[飞书开放平台](https://open.feishu.cn/app) → 创建企业自建应用，拿到 `App ID` / `App Secret`。
2. **开通机器人能力与权限**：应用内添加「机器人」能力；开通 `im:message`（收消息）、`im:message:send_as_bot`（发消息）等权限；事件订阅方式选 **长连接（WebSocket）**，订阅 `im.message.receive_v1`。
3. **查自己的 open_id**：给机器人发条消息，在开放平台「事件订阅」日志里看到，或用任何 open_id 查询工具。
4. **安装插件**：在 DeepSeek Harness checkout 目录里执行：

   ```bash
   dsh plugin --profile web add @nameshouldbelong/dsh-feishu-duty
   ```

5. **填写配置**：在 `~/.dsh/profiles/web/cordis.patch.yml` 中加上：

   ```yaml
   - id: feishu-duty
     config:
       appId: 'cli_xxxx'
       appSecret: '你的appSecret'
       receiveIdType: open_id        # 白名单类型
       receiveId: 'ou_你的open_id'   # 白名单
       language: zh
   ```

6. **重启** `dsh web`，用飞书给机器人发条消息——搞定，值班智能体开始回话。

## 功能

- 📱 任务闭环：飞书消息 → 专属"值班会话"（带标准工具集）→ 最终回复回传飞书；长回复自动分段。
- 🔐 白名单：只服务你自己的 open_id（或 chat_id），其他人仅记日志。
- ✅ 全局审批转发：值守模式下，**所有会话**的审批都发到飞书，**带 [✅ 同意] [⛔ 拒绝] 卡片按钮**（点按钮即答，打字 `3 同意 / 3 拒绝` 仍兼容）；超时（默认 10 分钟）按拒绝处理（保守安全）。
- ❓ feishu_ask 提问工具：智能体需要您选择方案、确认事项或补充信息时，把问题推送到飞书（**每个选项一个卡片按钮**，点选即答）。
- 🔀 值守/本地切换：飞书发任意消息或 `/away` 进入值守；网页任意会话发消息或 `/back` 回到本地。
- 🚩 值守横幅：值守期间网页顶部显示"审批已转到飞书"横幅，一键切回本地。
- 🗂 会话管理卡片：`/sessions` `/new` `/rename` `/archive` `/delete` `/model` `/mode` `/current` `/groups` 全套多级卡片菜单。
- 📎 附件收发：接收图片/文件（存入 inbox 并引导智能体读取），`feishu_send_file` 发送本地文件（≤30MB，飞书上传上限）。
- 💭 进度指示：值班智能体工作期间，进度卡片实时刷新阶段与 todo 看板，用户消息挂「输入中」表情回应。
- 🌐 中英双语：所有飞书消息跟随 `language` 配置（`zh` | `en`，默认 `en`）。
- 🔌 直连友好：飞书长连接从本机直出（国内直连 open.feishu.cn），无需代理、无需公网回调。

## 与 Telegram 版的差异（传输层适配）

| Telegram 版 | 飞书版 |
|---|---|
| 长轮询 getUpdates + 游标持久化 | WebSocket 长连接（SDK autoReconnect + 启动重试） |
| inline keyboard | 交互卡片按钮（点击回应以 toast 形式即时反馈） |
| 编辑消息文本 | 卡片整体重建（飞书不支持编辑纯文本） |
| 发送 typing chat action | 用户消息挂 `Typing` 表情回应 |
| 进度消息完成后删除 | 进度卡就地固化为「✅ 完成」（撤回会留占位） |
| 50MB 发送 / 20MB 下载上限 | 30MB 上传 / 30MB 下载（飞书 im 上限） |
| 机器人命令菜单 setMyCommands | 飞书无对应免审 API，暂缺（命令仍可文本输入） |

## 配置（feishu-duty 命名空间）

| 字段 | 默认 | 说明 |
|------|------|------|
| appId | — | 飞书自建应用 App ID（secret） |
| appSecret | — | 飞书自建应用 App Secret（secret） |
| domain | feishu | feishu（国内）/ lark（国际版） |
| receiveIdType | open_id | 白名单 id 类型：open_id（仅私聊）/ chat_id（指定会话，可含群） |
| receiveId | — | 白名单 id |
| sessionId | feishu-duty | 值班会话 id，首次消息自动创建 |
| dutyCwd | 进程 cwd | 值班会话工作目录 |
| approvalTimeoutMinutes | 10 | 审批超时（分钟），超时按拒绝 |
| watchMode | local | local / duty |
| language | en | 飞书消息语言：en / zh |
| dataDir | <DSH_HOME>/storages/feishu-duty | inbox 持久化目录 |
| credentialsFile | — | 可选凭据 JSON 文件 {app_id, app_secret, receive_id, receive_id_type} |
| replyChunkChars | 1800 | 长回复分段阈值 |
| progressIndicator | true | 值班工作期间进度卡开关 |
| mediaEnabled | true | 多媒体收发开关 |
| richText | true | 飞书富文本（post/md + 卡片）渲染开关 |
| disablePoller | false | true 时禁用飞书长连接（安全兼容验证模式，零网络活动） |

## 飞书命令

`/help`、`/away`、`/back`、`/stop`、`/sessions`、`/new`、`/rename`、`/archive`、`/delete`、`/model`、`/mode`、`/current`、`/groups`、`/cancel`；审批点按钮或回复 `3 同意 / 3 拒绝`（仅一条待批时直接回"同意/拒绝"）；提问点选项按钮或直接回复选项文字。

## 搭档插件：feishu-bridge-control

`packages/feishu-bridge-control` 是 [telebot-bridge-control](https://github.com/Nameshouldbelong/dsh-plugin-telegram-duty) 的移植，注册 `feishu_duty_*` 智能体工具：`feishu_duty_status` / `feishu_duty_set_model` / `feishu_duty_set_permission` / `feishu_duty_list_sessions` / `feishu_duty_switch_session` / `feishu_duty_list_workspaces` / `feishu_duty_switch_workspace` / `feishu_duty_create_session` / `feishu_duty_send_message`。工具名带 `feishu_duty_` 前缀，可与 Telegram 版桥接在同一 DSH 实例共存。

## 常见问题（FAQ）

- **机器人不回消息？** 按顺序排查：① appId/appSecret 是否填对；② 是否开通机器人能力并订阅 `im.message.receive_v1`（长连接方式）；③ receiveId 是否是**你本人**的 open_id（其他人的消息只记日志）；④ DSH 日志里有没有 feishu-duty 报错。
- **群聊能用吗？** `receiveIdType: chat_id` 且 receiveId 填群 id 时可用，机器人只处理 @ 它的消息；默认 open_id 模式只服务私聊。
- **空闲时耗 token 吗？** 不耗。长连接只是挂着收事件，消息到达才唤醒智能体。
- **电脑关机还能用吗？** 不能，插件随 DSH 一起运行；飞书侧不重投历史积压，重启即从当下继续。

## 开发

```bash
pnpm install
pnpm build          # tsc 服务端 + 客户端声明 + tsdown client face
pnpm typecheck
pnpm test           # node --test tests/（Node 24 原生测试器，零依赖）
```

## 许可证

MIT。会话驱动模式（resume/create + summarize）参考 [@kriskwok/dsh-feishu-gateway](https://github.com/kriskwok/dsh-feishu-gateway)（MIT）；飞书卡片交互范式参考其 interactions 实现；整体结构与行为复刻自 [dsh-plugin-telegram-duty](https://github.com/Nameshouldbelong/dsh-plugin-telegram-duty)（MIT），见 LICENSE。
