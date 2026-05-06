# OpenCodex Engine Adapter Design

Date: 2026-05-06
Status: Approved for planning

## Summary

OpenCodex will be a renamed and refactored version of OpenClaude. The product name, default CLI command, default data directory, and default engine become OpenCodex and Codex, but the gateway behavior above the engine boundary stays the same as OpenClaude.

The core change is to introduce a small engine adapter boundary. The existing Claude Code integration becomes `ClaudeEngineAdapter`, and a new `CodexEngineAdapter` becomes the default. Telegram handling, auth, pairing, multi-bot support, sessions, file sharing, SOUL.md, bot relay, chat history, progress display, daemon mode, and hot reload keep their current behavior unless an engine cannot expose an equivalent primitive. Those differences are contained inside the adapter.

## Goals

- Rename the project from OpenClaude to OpenCodex:
  - npm package name: `opencodex`
  - binary: `opencodex`
  - default data directory: `~/.opencodex`
  - docs and examples updated to Codex-first language
- Make Codex CLI the default engine.
- Keep the existing Claude implementation as a configurable adapter.
- Preserve OpenClaude's user-facing gateway behavior wherever possible.
- Isolate engine-specific CLI arguments, process lifecycle, session IDs, event parsing, prompt injection, and control operations.
- Add focused tests for engine selection, spawn args, event mapping, and backwards-compatible Claude behavior.

## Non-Goals

- No redesign of the Telegram UX.
- No change to access-control policies, pairing flow, group behavior, file download behavior, bot-to-bot relay, or message history semantics.
- No migration to a hosted API. The system remains a local CLI subprocess gateway.
- No attempt to make Codex expose Claude-only primitives outside the adapter.
- No removal of Claude support in this project.

## Current System

OpenClaude currently has a shared gateway with a Claude-specific process layer:

- `src/process/claude-cli.ts` builds Claude Code CLI args, writes stream-json messages to stdin, and parses stream-json stdout events.
- `src/process/manager.ts` owns per-session subprocesses and composes SOUL.md plus built-in Telegram skills as a Claude `--append-system-prompt`.
- `src/bot-instance.ts` consumes Claude-shaped events such as `system/init`, `assistant`, `stream_event`, and `result`.
- Session state stores `claudeSessionId`.
- Config stores engine settings under `claude`.

That coupling is narrow enough to preserve the rest of the gateway while replacing the engine boundary.

## Target Architecture

Add a neutral engine layer under `src/engines/`:

- `src/engines/types.ts`
  - Defines `EngineType`, `EngineRunConfig`, `EngineSession`, `EngineEvent`, `EngineControlRequest`, and `EngineAdapter`.
- `src/engines/manager.ts`
  - Replaces or wraps the current process manager with engine-neutral acquire/send/control APIs.
  - Enforces max concurrent active engine runs.
  - Keeps workspace and agent directory layout.
- `src/engines/claude/adapter.ts`
  - Moves the current Claude spawn, stdin, stdout, resume, fork, and control behavior behind the adapter.
- `src/engines/codex/adapter.ts`
  - Runs Codex CLI using non-interactive JSONL execution.
  - Maps Codex JSONL events into the same internal `EngineEvent` stream used by the bot layer.

The rest of the app should depend on `EngineManager` and `EngineEvent`, not on Claude-specific event names.

## Internal Engine Event Contract

The bot layer needs a compact stream with the concepts it already uses:

- `session_started`
  - Carries the engine session or thread id.
- `thinking_started`
  - Starts progress display's thinking phase when available.
- `tool_started`
  - Carries a tool name and optional detail for progress display.
- `text`
  - Carries assistant text to append to the response buffer.
- `result`
  - Marks turn completion and carries optional final text and error state.
- `error`
  - Carries fatal or turn-level errors.

Claude adapter mapping:

- `system/init` to `session_started`
- Claude thinking stream events to `thinking_started`
- Claude `tool_use` blocks to `tool_started`
- Claude assistant text blocks to `text`
- Claude `result` to `result`

Codex adapter mapping:

- `thread.started` to `session_started`
- `turn.started` to a normal turn start signal
- `item.started` command, MCP, web search, file change, collab, and todo items to progress events where useful
- `item.completed` agent messages to `text`
- `turn.completed` to `result`
- `turn.failed` and top-level `error` to `error` or error `result`

Unknown Codex JSONL event types are ignored after logging at debug level, so newer Codex versions do not break the gateway.

## Codex Adapter Behavior

Codex CLI is turn-oriented rather than a persistent stdin/stdout stream. The Codex adapter therefore runs one subprocess per turn:

- New session:
  - Spawn `codex exec --json ... <prompt>` with subprocess `cwd` set to the session workspace.
- Resume session:
  - Spawn `codex exec resume <thread_id> --json ... <prompt>` with subprocess `cwd` set to the session workspace.
- Thread id:
  - Captured from `thread.started` and stored on the OpenCodex session.
- Working directory:
  - The same per-bot, per-chat, per-session workspace path used by OpenClaude.
- Prompt injection:
  - Since Codex CLI does not use Claude's `--append-system-prompt` flag, the adapter prepends an OpenCodex instruction envelope containing SOUL.md and built-in Telegram skills to the prompt it passes to Codex.
  - The envelope is generated on each turn so SOUL.md and built-in skills stay current.
- Interrupt:
  - If a Codex subprocess is running for the session, `/stop` terminates that child process.
  - If no child is running, `/stop` returns the existing "Nothing to interrupt" behavior.
- `/btw`:
  - Runs a separate side subprocess with `codex exec resume <thread_id> --json --ephemeral ... <question>` so the answer can use current session context without interrupting the main turn or persisting the side question into the main session history.
  - If Codex rejects ephemeral resume, the adapter reports a `/btw` error instead of silently mutating the main session history.
- `/model` and `/effort`:
  - The command surface stays in place.
  - For Codex, changes are applied through CLI flags or config overrides on the next turn. Runtime control requests are no-ops unless Codex exposes a matching live control in the future.

## Claude Adapter Behavior

The Claude adapter preserves the current OpenClaude behavior:

- Persistent subprocess per active session.
- stdin `stream-json` user messages.
- stdout `stream-json` parsing.
- `--resume <claudeSessionId>`.
- `--fork-session` for `/btw`.
- `--append-system-prompt` for SOUL.md and built-in Telegram skills.
- `control_request` for `/stop`, `/model`, and `/effort`.

Existing Claude tests should continue to pass after names and types are adjusted.

## Configuration

OpenCodex uses a new engine-first config shape:

```yaml
gateway:
  port: 18790
  dataDir: "~/.opencodex"
  logLevel: "info"
  logFormat: "pretty"

engine:
  type: "codex"                 # codex | claude
  maxProcesses: 10
  idleTimeoutMs: 600000         # only meaningful for persistent adapters
  codex:
    binary: "codex"
    model: null                 # use Codex CLI default when omitted
    sandbox: "danger-full-access"
    approvalPolicy: "never"
    extraArgs: []
  claude:
    binary: "claude"
    model: "sonnet"
    extraArgs: []
```

Compatibility rules:

- If `engine` is omitted, default to Codex.
- If old `claude` config exists, load it into `engine.claude` and copy its `idleTimeoutMs` and `maxProcesses` into the neutral engine settings for backwards compatibility.
- `bots[].model` and `bots[].extraArgs` remain supported and are passed to the selected adapter.
- Existing `channels.telegram` and `bots` behavior is unchanged.

## Session Storage

Session state gains neutral engine fields while preserving old Claude data:

- Add `engineType?: "codex" | "claude" | string`.
- Add `engineSessionId?: string`.
- Keep reading `claudeSessionId` for existing stores.
- When using Claude, write both `engineSessionId` and `claudeSessionId` during the transition.
- New OpenCodex sessions use `engineSessionId`.

This avoids breaking existing OpenClaude session files if a user points OpenCodex at an old data directory.

## Naming And Branding

Required rename surface:

- `package.json` name, description, and bin command.
- CLI program name, help text, daemon messages, and install docs.
- Default data directory from `~/.openclaude` to `~/.opencodex`.
- README and README_zh content.
- Config example comments and docs URLs.
- Runtime log messages should say engine-neutral "engine process" unless the message is adapter-specific.

`SOUL.md` remains named `SOUL.md` to preserve user data and behavior.

## Error Handling

- Adapter spawn failures produce clear engine-specific install/auth messages.
- Codex JSON parse failures are ignored line-by-line like the current Claude parser, with debug logging for diagnostics.
- Codex turn failure maps to an error result sent to Telegram.
- Resume failure falls back to a fresh engine session for that OpenCodex session and records the new `engineSessionId`.
- Unsupported controls return `false` so existing command handlers can keep their "No active process" or "Nothing to interrupt" style responses.

## Testing

Add or update tests for:

- Config defaults: `engine.type` defaults to Codex and `dataDir` defaults to `~/.opencodex`.
- Legacy config: old `claude` block still loads into the Claude adapter config.
- Claude adapter spawn args match existing behavior.
- Codex adapter spawn args for new and resumed sessions.
- Codex JSONL parsing:
  - `thread.started`
  - `item.started` command execution
  - `item.completed` agent message
  - `turn.completed`
  - `turn.failed`
  - invalid JSON
- Bot event consumption using neutral `EngineEvent`.
- Existing auth/session/Telegram formatter tests continue to pass.
- Build and full test suite pass before implementation is considered complete.

## Implementation Notes

Keep the first implementation mechanical and low-risk:

1. Introduce neutral types and adapters while keeping behavior tests green.
2. Move Claude-specific code without changing its semantics.
3. Add Codex adapter and event mapping.
4. Switch gateway construction to choose an adapter from config.
5. Rename package, CLI, docs, and config examples.
6. Run build and tests.

The implementation should avoid broad refactors outside the engine boundary. Any cleanup beyond the adapter work should be justified by reduced coupling to Claude-specific types.
