# OpenCodex

A gateway that bridges chat platforms (Telegram, Discord, etc.) to Codex CLI by default, while keeping Claude Code available as an optional adapter. It turns a local CLI engine into an always-on chatbot with session management, access control, group history, personality, and file sharing.

```
Telegram <-> OpenCodex Gateway <-> Codex CLI / Claude Code CLI
```

Each conversation runs through a real local CLI engine. OpenCodex manages engine sessions, access policy, files, group chat history, and per-bot personality so the same assistant experience is available from Telegram.

[中文文档](README_zh.md)

## Features

- **Codex as default engine** — runs `codex exec --json`, resumes Codex threads, and keeps local CLI behavior instead of wrapping a hosted chat API
- **Claude adapter retained** — set `engine.type: claude` to run Claude Code through the same gateway
- **Multi-bot support** — run multiple bots on a single gateway, each with independent config, personality, and access control
- **Bot-to-bot relay** — bots can @mention each other in group chats; the gateway routes messages internally without relying on Telegram's bot-to-bot delivery
- **Session management** — `/new`, `/sessions` with inline buttons. Multiple sessions per chat, each with its own workspace
- **`/btw` side questions** — ask a non-blocking question in parallel without interrupting the current session
- **Rich commands** — `/model` and `/effort` are engine-dependent; `/stop` interrupts the current response
- **Inline buttons** — session picker and choices rendered as tappable Telegram buttons; stale buttons auto-removed
- **Access control** — allowlist + pairing code flow for both DMs and groups. No strangers can use your bot
- **Group chat support** — responds to @mentions and replies; full message history (including bot replies) with sender/timestamp context injected into the engine
- **File sharing** — upload files to the engine, receive files back, and forward reply attachments. The engine can also retrieve previously shared files via chat history
- **SOUL.md personality** — customize your bot's personality per-bot. The assistant can even edit its own SOUL via user instructions
- **Live progress** — pulsing status indicator shows what the engine is doing (thinking, reading, writing, running commands)
- **Daemon mode** — runs in background with log persistence, auto-restart on crash
- **Hot-reload** — config changes (including adding/removing bots) are picked up without restart

## Prerequisites

- **Node.js** >= 22
- **Codex CLI** installed and authenticated (`npm install -g @openai/codex`, then run `codex`)
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)
- **Claude Code CLI** only if using the optional Claude adapter (`engine.type: claude`)

## Install

```bash
git clone https://github.com/happy-shine/openclaude.git opencodex
cd opencodex
npm install
npm run build
npm link        # makes `opencodex` available globally
```

## Quick Start

**1. Create config**

```bash
mkdir -p ~/.opencodex
cp config.example.yaml ~/.opencodex/config.yaml
```

Edit `~/.opencodex/config.yaml` and set your bot token:

```yaml
bots:
  - name: "mybot"
    token: "123456:ABC-DEF..."   # from @BotFather
    auth:
      dmPolicy: "pairing"       # pairing | open | allowlist | disabled
      groupPolicy: "pairing"    # pairing | open | allowlist | disabled
```

**2. Start the gateway**

```bash
opencodex gateway start          # background daemon
opencodex gateway start -f       # foreground (for debugging)
```

**3. Pair your account**

Message your bot on Telegram. It will reply with a pairing code. Approve it:

```bash
opencodex pairing list
opencodex pairing approve <code>
```

Done. Start chatting with Codex via Telegram.

## Configuration

Full config example (`config.example.yaml`):

```yaml
gateway:
  port: 18790                 # local API port (for file sending)
  dataDir: "~/.opencodex"
  logLevel: "info"            # debug | info | warn | error
  logFormat: "pretty"

engine:
  type: "codex"               # codex | claude
  maxProcesses: 10            # max concurrent engine processes
  idleTimeoutMs: 600000       # kill idle processes after 10min
  codex:
    binary: "codex"           # path to Codex CLI
    # model: "gpt-5.4"
    sandbox: "danger-full-access"
    approvalPolicy: "never"
    extraArgs: []             # additional CLI flags
  claude:
    binary: "claude"          # optional Claude Code adapter
    model: "sonnet"
    extraArgs: []

auth:
  defaultPolicy: "pairing"    # default policy for new bots

bots:
  - name: "assistant"
    token: "${TELEGRAM_BOT_TOKEN}"  # supports env var expansion
    auth:
      dmPolicy: "pairing"          # DM access policy
      groupPolicy: "pairing"       # group access policy
      allowFrom: []                # pre-approved Telegram user IDs
      groups:                      # per-group config
        "-1001234567890":
          enabled: true
  - name: "helper"
    token: "another-bot-token"
    auth:
      dmPolicy: "pairing"
      groupPolicy: "disabled"
```

### Access Policies

| Policy | Behavior |
|--------|----------|
| `open` | Anyone can use the bot |
| `pairing` | New users/groups get a pairing code, owner approves via CLI |
| `allowlist` | Only pre-approved user IDs |
| `disabled` | Channel disabled |

## CLI Reference

```
opencodex gateway start [options]  Start the gateway
  -f, --foreground                  Run in foreground
  -c, --config <path>               Config file path
  -v, --verbose                     Debug logging
opencodex gateway stop             Stop the running gateway
opencodex gateway restart          Restart the gateway
opencodex gateway status           Check if gateway is running
opencodex gateway logs [-f] [-n 50] Tail gateway logs

opencodex bot list                 List all configured bots
opencodex bot add <token> [--name] Add a bot (auto-detects username via Telegram API)
opencodex bot remove <name>        Remove a bot from config

opencodex pairing list             List pending pairing requests
opencodex pairing approve <code>   Approve a pairing code (auto-detects which bot)

opencodex group list               List configured groups
opencodex group add <chatId>       Add a group to allowlist
opencodex group remove <chatId>    Remove a group
opencodex group approve <code>     Approve a group pairing code
opencodex group disable <chatId>   Disable a group without removing

opencodex allow list [channel]     List allowed users
opencodex allow add <ch> <id>      Add user to allowlist
opencodex allow remove <ch> <id>   Remove user from allowlist

opencodex bot soul show            Show current SOUL.md
opencodex bot soul edit            Edit SOUL.md in $EDITOR
opencodex bot soul reset           Delete SOUL.md (reset personality)
opencodex bot soul path            Print SOUL.md file path
```

All `pairing`, `group`, `allow`, and `bot soul` commands support `--bot <name>` to target a specific bot. When only one bot is configured, the flag is optional.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/sessions` | List all sessions with inline picker buttons |
| `/btw <question>` | Ask a side question without interrupting the current session |
| `/model [name]` | Engine-dependent. Claude supports live `opus`/`sonnet`/`haiku`; set Codex models in `engine.codex.model` or `extraArgs` for new turns/sessions |
| `/effort [level]` | Engine-dependent. Claude supports live effort control; configure Codex reasoning/effort through Codex config or CLI options when supported |
| `/stop` | Interrupt the engine's current response |
| `/help` | Show help |

In groups, the bot responds when **@mentioned** or **replied to**.

### `/btw` — Non-blocking Side Questions

`/btw` forks the current engine session to answer a quick question in parallel, without interrupting the main conversation. Useful for asking something while the assistant is still working on a longer task.

```
/btw what's the capital of France?
```

## Multi-Bot

Run multiple bots on a single gateway. Each bot has its own personality, access control, and session state, but they share the same engine process pool.

```bash
opencodex bot add 123456:ABC-DEF      # auto-detects name from Telegram
opencodex bot add 789012:GHI-JKL --name helper
opencodex bot list
```

Adding or removing bots triggers a hot-reload, with no gateway restart needed.

### Bot-to-Bot Relay

In group chats, when one bot's reply contains `@another_bot`, the gateway automatically relays the message internally. This works even though Telegram doesn't deliver bot-to-bot messages natively.

Each bot knows which other bots are in the gateway and will only @mention them when the user explicitly asks for bot-to-bot interaction.

## Group Chat

In group chats, OpenCodex records all messages (including bot replies) to a persistent chat history. The local engine can query this history via a local HTTP endpoint for context about past conversations.

Groups can be authorized via pairing (bot sends a code, owner approves) or pre-configured in `config.yaml`.

## SOUL.md — Bot Personality

Customize your bot's personality by creating a `SOUL.md` file:

```bash
opencodex bot soul edit
```

Or let the assistant edit it: tell your bot "from now on, speak like a pirate" and it will update its own SOUL.md.

Changes take effect on the next `/new` session.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────────┐
│   Telegram   │<--->│  OpenCodex GW    │<--->│  Codex CLI /       │
│   (grammY)   │     │                  │     │  Claude Code CLI   │
└──────────────┘     │  - Multi-bot     │     │  - CLI process     │
                     │  - Bot Relay     │     │  - Tool use        │
                     │  - Session Mgr   │     │  - File I/O        │
                     │  - Process Pool  │     │  - Bash access     │
                     │  - Access Ctrl   │     │  - Web search      │
                     │  - Progress UI   │     └────────────────────┘
                     │  - HTTP API      │
                     │  - Chat History  │
                     └──────────────────┘
```

**Data directory** (`~/.opencodex/`):

```
~/.opencodex/
├── config.yaml              # configuration
├── logs/gateway.log         # daemon logs
├── sessions/                # session state per chat
├── credentials/             # allowlists, pairing data, runtime groups
├── messages/                # persistent group chat history (JSONL)
├── workspace/{botId}/       # per-session working directories
│   └── {chatId}_{sessionId}/
└── agents/{botId}/          # per-bot personality
    └── SOUL.md
```

## Community

This project is shared with the [LINUX DO](https://linux.do/) community.

## License

MIT
