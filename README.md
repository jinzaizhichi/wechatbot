# wechatbot

WeChat iLink Bot SDK — modular, production-grade, multi-language.

Let any agent connect to WeChat in 5 minutes. Inspired by [tencent-weixin/openclaw-weixin-cli](https://github.com/nicepkg/openclaw-weixin).

## Pi Agent Extension

**Chat with Pi from WeChat** — scan a QR code, your WeChat messages become Pi prompts.

```bash
# Load the extension
pi -e /path/to/wechatbot/pi-agent/src/index.ts

# Then in pi:
/wechat          # Shows QR code → scan in WeChat → connected!
```

See [pi-agent/README.md](pi-agent/README.md) for full docs.

## SDKs

| SDK | Install | Status |
|---|---|---|
| [Node.js](nodejs/) | `npm install @wechatbot/wechatbot` | ✓ 42 files, 41 tests |
| [Python](python/) | `pip install wechatbot-sdk` | ✓ 7 files, 17 tests |
| [Go](golang/) | `go get github.com/anthropic/wechatbot-go` | ✓ |
| [Rust](rust/) | `wechatbot = "0.1"` | ✓ |

## Quick Start

### Node.js

```typescript
import { WeChatBot } from '@wechatbot/wechatbot'

const bot = new WeChatBot()
await bot.login()
bot.onMessage(async (msg) => {
  await bot.reply(msg, `Echo: ${msg.text}`)
})
await bot.start()
```

### Go

```go
bot := wechatbot.New()
bot.Login(ctx, false)
bot.OnMessage(func(msg *wechatbot.IncomingMessage) {
    bot.Reply(ctx, msg, fmt.Sprintf("Echo: %s", msg.Text))
})
bot.Run(ctx)
```

### Rust

```rust
let bot = WeChatBot::new(BotOptions::default());
bot.login(false).await?;
bot.on_message(Box::new(|msg| {
    println!("{}: {}", msg.user_id, msg.text);
})).await;
bot.run().await?;
```

## Features

All SDKs share the same capabilities:

- 🔐 **QR Code Login** — scan-to-login with credential persistence (`~/.wechatbot/`)
- 📨 **Long-Poll Messaging** — reliable message receiving with cursor management
- 💬 **Rich Media** — images, files, voice, video (upload + download)
- 🔗 **context_token** — automatic lifecycle management, persisted across restarts
- ⌨️ **Typing Indicators** — "对方正在输入中" with ticket caching
- 🔒 **CDN Crypto** — AES-128-ECB with dual key format support
- ♻️ **Session Recovery** — automatic re-login on session expiry (`-14`)
- 📝 **Smart Chunking** — text split at natural boundaries (paragraph → line → space)

### Node.js Extras

- 🧩 **Middleware Pipeline** — Express/Koa-style composable middleware
- 📦 **Pluggable Storage** — file, memory, or bring your own (Redis, SQLite...)
- 🎯 **Typed Events** — full IntelliSense for lifecycle monitoring
- 📝 **Structured Logging** — leveled, contextual, pluggable transports
- 🏗️ **Fluent MessageBuilder** — `.text().image().file().build()`

## Architecture

```
┌─────────────────────────────────────────┐
│              Your Bot Code               │
├─────────────────────────────────────────┤
│         Bot Client (orchestrator)        │
├──────────┬──────────┬──────────┬────────┤
│  Poller  │  Sender  │  Typing  │ Media  │
├──────────┴──────────┴──────────┴────────┤
│         Context Store (token cache)      │
├─────────────────────────────────────────┤
│         Protocol / API (HTTP calls)      │
├─────────────────────────────────────────┤
│         Storage (credentials + state)    │
└─────────────────────────────────────────┘
```

## Documentation

| Document | Description |
|---|---|
| [docs/protocol.md](docs/protocol.md) | iLink Bot API protocol reference |
| [pi-agent/README.md](pi-agent/README.md) | Pi extension (WeChat ↔ Pi bridge) |
| [docs/architecture.md](docs/architecture.md) | Architecture & SDK comparison |
| [nodejs/README.md](nodejs/README.md) | Node.js SDK docs |
| [python/README.md](python/README.md) | Python SDK docs |
| [golang/README.md](golang/README.md) | Go SDK docs |
| [rust/README.md](rust/README.md) | Rust SDK docs |

## Website

The project includes a [bilingual website](website/) (English + 中文) built with Next.js + next-intl.

```bash
cd website && npm run dev  # http://localhost:8045
```

## Project Structure

```
wechatbot/
├── pi-agent/              # Pi extension (WeChat ↔ Pi bridge)
│   ├── src/index.ts    # Extension entry (commands, events)
│   └── src/wechat.ts   # WeChat iLink client
├── nodejs/             # Node.js SDK (TypeScript, 42 files, 41 tests)
│   ├── src/            # 10 modules
│   ├── tests/          # 41 unit tests
│   └── examples/       # 3 example bots
├── python/             # Python SDK (async/aiohttp, 17 tests)
│   └── wechatbot/      # client, protocol, auth, crypto, types, errors
├── golang/             # Go SDK
│   ├── bot.go          # Bot client
│   ├── types.go        # All types
│   └── internal/       # protocol, auth, crypto
├── rust/               # Rust SDK
│   ├── src/            # 6 modules
│   └── examples/       # Echo bot
├── docs/               # Shared documentation
│   ├── protocol.md     # iLink API protocol spec
│   └── architecture.md # Architecture & comparison
└── website/            # Next.js marketing site (en/zh)
```

## License

MIT
