# dsh-feishu-duty

[![npm](https://img.shields.io/npm/v/@nameshouldbelong/dsh-feishu-duty)](https://www.npmjs.com/package/@nameshouldbelong/dsh-feishu-duty)

Turn DeepSeek Harness (DSH) into a pocket duty station: send a Feishu message from your phone → the duty agent works on it → the result comes back to Feishu. Zero tokens while idle (Feishu WebSocket long-connection event subscription; the agent wakes only when a message arrives, and no public IP is needed).

[中文说明](README.zh.md)

This plugin is a **faithful Feishu port** of [dsh-plugin-telegram-duty](https://github.com/Nameshouldbelong/dsh-plugin-telegram-duty): the command pipeline, approval forwarding, interactive menus, /new wizard, and progress board map one-to-one; the transport swaps Telegram long-polling for the Feishu long connection and inline keyboards for interactive card buttons.

## Quick start

1. Create a Feishu custom app on the [open platform](https://open.feishu.cn/app) and copy the `App ID` / `App Secret`.
2. Add the bot capability, grant `im:message` + `im:message:send_as_bot`, choose the **long connection (WebSocket)** subscription mode, and subscribe to `im.message.receive_v1`.
3. Find your own `open_id` (send the bot any message and read the event log on the open platform).
4. Install: `dsh plugin --profile web add @nameshouldbelong/dsh-feishu-duty`
5. Configure in `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - id: feishu-duty
     config:
       appId: 'cli_xxxx'
       appSecret: 'your-app-secret'
       receiveIdType: open_id
       receiveId: 'ou_your-open-id'
       language: zh
   ```

6. Restart `dsh web` and message the bot in Feishu — the duty agent starts answering.

## Features

- 📱 Task loop: Feishu message → dedicated duty session (standard toolset) → final reply back to Feishu; long replies are chunked.
- 🔐 Whitelist: only your open_id (or chat_id) is served; everyone else is logged and ignored.
- ✅ Global approval forwarding: in duty mode, approvals from ALL sessions go to Feishu with ✅/⛔ card buttons (text replies `3 approve / 3 reject` still work); timeout (10 min default) resolves as rejected (fail-closed).
- ❓ feishu_ask tool: pushes questions with one card button per option.
- 🔀 Duty/local switching: any Feishu message or `/away` enters duty; any web message or `/back` returns to local.
- 🚩 Web banner: "approvals are on Feishu" while on duty, one click back to local.
- 🗂 Session management cards: `/sessions` `/new` `/rename` `/archive` `/delete` `/model` `/mode` `/current` `/groups`.
- 📎 Attachments: receive images/files into the inbox; `feishu_send_file` delivers local files (≤30MB, Feishu im upload cap).
- 💭 Progress indicator: a progress card refreshes phases and the todo board while the agent works; a `Typing` reaction marks liveness.
- 🌐 Bilingual: `language` (`zh` | `en`, default `en`).
- 🔌 Connectivity friendly: the long connection dials out from the machine itself — no proxy, no public webhook.

## Transport deltas vs the Telegram edition

| Telegram edition | Feishu edition |
|---|---|
| getUpdates long-poll + persisted offset | WebSocket long connection (SDK autoReconnect + boot retry) |
| inline keyboards | interactive card buttons (clicks answer via toast) |
| editMessageText | full card rebuild (Feishu cannot edit plain messages) |
| typing chat action | `Typing` reaction on the user's message |
| progress message deleted when done | progress card patched to a settled "✅ done" state (recall leaves a placeholder) |
| 50MB send / 20MB download caps | 30MB upload / 30MB download (Feishu im caps) |
| setMyCommands bot menu | no audit-free Feishu equivalent yet; commands still work as text |

## Configuration (feishu-duty namespace)

| Field | Default | Notes |
|---|---|---|
| appId / appSecret | — | Feishu custom app credentials (secret) |
| domain | feishu | feishu (CN) / lark (international) |
| receiveIdType | open_id | open_id (p2p only) / chat_id (one chat, groups included) |
| receiveId | — | whitelisted id |
| sessionId | feishu-duty | duty session id, auto-created on first message |
| dutyCwd | process cwd | duty session working directory |
| approvalTimeoutMinutes | 10 | unanswered approvals resolve as rejected |
| watchMode | local | local / duty |
| language | en | zh / en |
| dataDir | <DSH_HOME>/storages/feishu-duty | inbox persistence |
| credentialsFile | — | optional JSON {app_id, app_secret, receive_id, receive_id_type} |
| replyChunkChars | 1800 | reply chunk threshold |
| progressIndicator / mediaEnabled / richText | true | feature toggles |
| disablePoller | false | true disables the long connection (safe compatibility mode, zero network) |

## Companion: feishu-bridge-control

`packages/feishu-bridge-control` ports telebot-bridge-control: `feishu_duty_status`, `feishu_duty_set_model`, `feishu_duty_set_permission`, `feishu_duty_list_sessions`, `feishu_duty_switch_session`, `feishu_duty_list_workspaces`, `feishu_duty_switch_workspace`, `feishu_duty_create_session`, `feishu_duty_send_message`. The `feishu_duty_` prefix lets it coexist with the Telegram bridge in one host.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test   # node --test tests/ (Node 24 native runner, zero deps)
```

## License

MIT. The session-driving pattern (resume/create + summarize) references [@kriskwok/dsh-feishu-gateway](https://github.com/kriskwok/dsh-feishu-gateway) (MIT); the overall structure and behavior replicate [dsh-plugin-telegram-duty](https://github.com/Nameshouldbelong/dsh-plugin-telegram-duty) (MIT). See LICENSE.
