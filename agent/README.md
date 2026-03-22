# wechatbot-agent — Pi Extension for WeChat

A **pi extension** that bridges WeChat to your Pi coding agent.
Scan a QR code in WeChat → chat with Pi from your phone.

## How It Works

```
┌──────────────┐      ┌──────────────┐      ┌──────────┐
│  WeChat User │ ←──→ │  iLink API   │ ←──→ │ Pi Agent │
│  (phone)     │      │  (Tencent)   │      │ (laptop) │
└──────────────┘      └──────────────┘      └──────────┘
                                                  ↑
                                           This extension
```

1. You run `/wechat` in pi
2. Extension calls WeChat iLink API → gets a QR code URL
3. Pi TUI displays the QR code link
4. You scan it in WeChat on your phone
5. Login completes → credentials saved to `~/.wechatbot/`
6. **WeChat messages → pi prompts** (via `pi.sendUserMessage()`)
7. **Pi responses → WeChat replies** (via `agent_end` event)
8. Typing indicator shown in WeChat while Pi thinks

## Install

### Option 1: Load directly

```bash
pi -e /path/to/wechatbot/agent/src/index.ts
```

### Option 2: Copy to extensions directory

```bash
# Global
cp -r agent/ ~/.pi/agent/extensions/wechat-bridge/

# Or project-local
cp -r agent/ .pi/extensions/wechat-bridge/
```

Then it auto-loads on every `pi` session.

## Usage

```
/wechat              # Start WeChat login (shows QR code)
/wechat --force      # Force re-login (new QR code)
/wechat-disconnect   # Disconnect WeChat
/wechat-send <text>  # Manually send text to WeChat user
```

### Typical flow:

```
> /wechat

  ╔══════════════════════════════════════════╗
  ║    📱 Scan this QR code in WeChat        ║
  ╚══════════════════════════════════════════╝

  https://weixin.qq.com/x/cAbCdEfGhIj

  Open this URL in WeChat to login.

[wechat] QR scanned — confirm in WeChat
[wechat] Login confirmed
✓ WeChat connected! Account: e06c1ceea05e@im.bot

# Now send "帮我看看这个项目的架构" from WeChat...
# Pi receives it as a prompt, processes it, sends the reply back to WeChat.
```

## Architecture (Pi Extension APIs Used)

| API | Purpose |
|-----|---------|
| `pi.registerCommand('wechat', ...)` | `/wechat` command to start login |
| `pi.sendUserMessage(text)` | Inject WeChat message as a pi prompt |
| `pi.on('agent_end', ...)` | Capture pi's final response → send to WeChat |
| `pi.on('message_update', ...)` | Track streaming text for reply assembly |
| `ctx.ui.setWidget(...)` | Show QR code URL in pi TUI |
| `ctx.ui.setStatus(...)` | Show connection status in footer |
| `ctx.ui.notify(...)` | Show notifications |
| `pi.on('session_shutdown', ...)` | Cleanup on exit |

## Message Flow

```
WeChat user sends "帮我重构 auth 模块"
         │
         ▼
  iLink API (long-poll getupdates)
         │
         ▼
  Extension receives IncomingMessage
         │
         ├── wechat.sendTyping(userId)     → "对方正在输入中..."
         │
         ├── pi.sendUserMessage(msg.text)  → becomes pi prompt
         │
         ▼
  Pi agent processes (tools, thinking, etc.)
         │
         ▼
  pi.on('agent_end') fires
         │
         ├── Extract assistant text from messages
         ├── wechat.stopTyping(userId)
         └── wechat.reply(msg, text)       → sent back to WeChat
```

## Features

- **Zero config** — just `/wechat` and scan
- **Credential persistence** — `~/.wechatbot/credentials.json`, skips QR on restart
- **Session recovery** — auto re-login on `-14` (session expired)
- **Typing indicator** — shows "对方正在输入中" while Pi thinks
- **Text chunking** — long replies split at 2000 chars
- **Graceful shutdown** — stops WeChat poll on `session_shutdown`

## Limitations

- Text messages only (images/voice/files acknowledged but not processed)
- Single user at a time (last message sender is the active user)
- QR code displayed as URL (not rendered as actual QR in terminal)
- Pi must be running in interactive mode (not print mode)

## Files

```
agent/
├── src/
│   ├── index.ts      # Pi extension — commands, events, bridge logic
│   └── wechat.ts     # WeChat iLink client (QR login, poll, send)
├── package.json
├── tsconfig.json
└── README.md
```
