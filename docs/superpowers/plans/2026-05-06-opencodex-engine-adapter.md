# OpenCodex Engine Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert OpenClaude into OpenCodex by adding a Codex-default multi-engine adapter layer while preserving existing gateway behavior and keeping Claude as a selectable engine.

**Architecture:** Introduce neutral engine config, session, and event types, then move Claude-specific process logic behind a Claude adapter and add a Codex adapter that maps `codex exec --json` JSONL into the same internal events. Keep Telegram, auth, pairing, file, SOUL.md, bot relay, history, daemon, and hot-reload behavior unchanged above the engine manager.

**Tech Stack:** TypeScript ESM, Node.js child processes, commander, zod, yaml, grammy, pino, Vitest.

---

## File Structure

- Create `src/engines/types.ts`: shared engine types and adapter interface.
- Create `src/engines/prompt.ts`: SOUL.md plus built-in Telegram skill prompt composition.
- Create `src/engines/claude/adapter.ts`: Claude Code subprocess adapter.
- Create `src/engines/claude/parser.ts`: Claude stream-json parser and spawn arg builder.
- Create `src/engines/codex/adapter.ts`: Codex CLI turn subprocess adapter.
- Create `src/engines/codex/parser.ts`: Codex JSONL parser, spawn arg builder, and event mapping.
- Create `src/engines/manager.ts`: engine-neutral process manager used by the gateway.
- Create tests under `src/engines/**/__tests__/`.
- Modify `src/config/schema.ts`, `src/config/types.ts`, and `src/config/loader.ts`: engine config and defaults.
- Modify `src/sessions/types.ts` and `src/sessions/manager.ts`: neutral engine session id while preserving `claudeSessionId`.
- Modify `src/gateway.ts`: instantiate `EngineManager`.
- Modify `src/bot-instance.ts`: consume `EngineEvent` rather than Claude-shaped events.
- Modify `src/progress.ts`: support Codex tool names.
- Modify `src/index.ts`: OpenCodex CLI naming and engine checks.
- Modify `src/__tests__/integration.test.ts`: use neutral engine helpers.
- Modify `config.example.yaml`, `README.md`, `README_zh.md`, and `package.json`: OpenCodex branding and Codex default.
- Leave `src/process/*` in place until all imports are moved, then delete obsolete files in the cleanup task.

---

### Task 1: Engine Config And Session Types

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`
- Modify: `src/config/__tests__/loader.test.ts`
- Modify: `src/sessions/types.ts`
- Modify: `src/sessions/manager.ts`
- Modify: `src/sessions/__tests__/manager.test.ts`

- [ ] **Step 1: Write failing config tests**

Add these tests to `src/config/__tests__/loader.test.ts` inside `describe("parseConfig", ...)`:

```ts
  it("defaults to Codex engine and OpenCodex data dir", () => {
    const cfg = parseConfig(`
bots:
  - name: "bot"
    token: "123:abc"
`);
    expect(cfg.gateway.dataDir).toBe("~/.opencodex");
    expect(cfg.engine.type).toBe("codex");
    expect(cfg.engine.codex.binary).toBe("codex");
    expect(cfg.engine.maxProcesses).toBe(10);
  });

  it("loads legacy claude config into engine claude config", () => {
    const cfg = parseConfig(`
gateway:
  dataDir: "~/.openclaude"
claude:
  binary: "/usr/local/bin/claude"
  model: "opus"
  idleTimeoutMs: 12345
  maxProcesses: 3
  extraArgs: ["--debug"]
bots:
  - name: "bot"
    token: "123:abc"
`);
    expect(cfg.engine.type).toBe("codex");
    expect(cfg.engine.maxProcesses).toBe(3);
    expect(cfg.engine.idleTimeoutMs).toBe(12345);
    expect(cfg.engine.claude.binary).toBe("/usr/local/bin/claude");
    expect(cfg.engine.claude.model).toBe("opus");
    expect(cfg.engine.claude.extraArgs).toEqual(["--debug"]);
  });
```

- [ ] **Step 2: Write failing session tests**

Add this test to `src/sessions/__tests__/manager.test.ts`:

```ts
  it("updates neutral engine session fields while preserving claudeSessionId", () => {
    const s = mgr.resolve("chat1", "telegram");
    mgr.update(s.sessionId, {
      engineType: "codex",
      engineSessionId: "thread-123",
      claudeSessionId: "claude-123",
    });
    const updated = mgr.resolve("chat1", "telegram");
    expect(updated.engineType).toBe("codex");
    expect(updated.engineSessionId).toBe("thread-123");
    expect(updated.claudeSessionId).toBe("claude-123");
  });
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npm test -- src/config/__tests__/loader.test.ts src/sessions/__tests__/manager.test.ts
```

Expected: FAIL because `cfg.engine`, `~/.opencodex`, `engineType`, and `engineSessionId` do not exist yet.

- [ ] **Step 4: Add config types**

Replace the `GatewayConfig` engine-related section in `src/config/types.ts` with:

```ts
export type EngineType = "codex" | "claude";

export interface GatewayConfig {
  gateway: {
    port: number;
    dataDir: string;
    logLevel: "debug" | "info" | "warn" | "error";
    logFormat: "pretty" | "json";
  };
  engine: {
    type: EngineType;
    maxProcesses: number;
    idleTimeoutMs: number;
    codex: {
      binary: string;
      model?: string;
      sandbox: "read-only" | "workspace-write" | "danger-full-access";
      approvalPolicy: "untrusted" | "on-request" | "never";
      extraArgs: string[];
    };
    claude: {
      binary: string;
      model?: string;
      extraArgs: string[];
    };
  };
  claude: {
    binary: string;
    model?: string;
    idleTimeoutMs: number;
    maxProcesses: number;
    extraArgs: string[];
  };
  auth: {
    defaultPolicy: "open" | "pairing" | "allowlist" | "disabled";
  };
  channels?: {
    telegram?: TelegramChannelConfig;
  };
  bots?: BotConfig[];
}
```

Keep the existing `BotConfig`, `ResolvedBotConfig`, `TelegramChannelConfig`, and `TelegramGroupConfig` exports below it unchanged.

- [ ] **Step 5: Add config schema**

In `src/config/schema.ts`, add these schemas above `authSchema`:

```ts
const legacyClaudeSchema = z.object({
  binary: z.string().default("claude"),
  model: z.string().optional(),
  idleTimeoutMs: z.number().int().positive().default(600000),
  maxProcesses: z.number().int().positive().default(10),
  extraArgs: z.array(z.string()).default([]),
});

const codexEngineSchema = z.object({
  binary: z.string().default("codex"),
  model: z.string().nullable().optional().transform((v) => v ?? undefined),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access"),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).default("never"),
  extraArgs: z.array(z.string()).default([]),
});

const claudeEngineSchema = z.object({
  binary: z.string().default("claude"),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).default([]),
});

const engineSchema = z.object({
  type: z.enum(["codex", "claude"]).default("codex"),
  maxProcesses: z.number().int().positive().default(10),
  idleTimeoutMs: z.number().int().positive().default(600000),
  codex: codexEngineSchema.default(codexEngineSchema.parse({})),
  claude: claudeEngineSchema.default(claudeEngineSchema.parse({})),
});
```

Then replace the old `claudeSchema` with:

```ts
const claudeSchema = legacyClaudeSchema;
```

And replace `export const configSchema = ...` with this preprocessing schema:

```ts
export const configSchema = z.preprocess((input) => {
  const raw = (input ?? {}) as Record<string, unknown>;
  const legacyClaude = raw.claude as Record<string, unknown> | undefined;
  const engine = { ...((raw.engine as Record<string, unknown> | undefined) ?? {}) };

  if (legacyClaude) {
    engine.maxProcesses ??= legacyClaude.maxProcesses;
    engine.idleTimeoutMs ??= legacyClaude.idleTimeoutMs;
    engine.claude = {
      ...((engine.claude as Record<string, unknown> | undefined) ?? {}),
      binary: legacyClaude.binary,
      model: legacyClaude.model,
      extraArgs: legacyClaude.extraArgs,
    };
  }

  return { ...raw, engine };
}, z.object({
  gateway: gatewaySchema.default(gatewaySchema.parse({})),
  engine: engineSchema.default(engineSchema.parse({})),
  claude: claudeSchema.default(claudeSchema.parse({})),
  auth: authSchema.default(authSchema.parse({})),
  channels: channelsSchema.optional(),
  bots: z.array(botSchema).optional(),
}));
```

- [ ] **Step 6: Update loader defaults and bot resolution**

In `src/config/loader.ts`, replace `DEFAULT_CONFIG` with:

```ts
const DEFAULT_CONFIG = `# OpenCodex Configuration
# Docs: https://github.com/happy-shine/opencodex

gateway:
  port: 18790
  dataDir: "~/.opencodex"
  logLevel: "info"
  logFormat: "pretty"

engine:
  type: "codex"
  maxProcesses: 10
  idleTimeoutMs: 600000
  codex:
    binary: "codex"
    sandbox: "danger-full-access"
    approvalPolicy: "never"
    extraArgs: []
  claude:
    binary: "claude"
    model: "sonnet"
    extraArgs: []

auth:
  defaultPolicy: "pairing"

bots:
  - name: "my-bot"
    token: "\${TELEGRAM_BOT_TOKEN}"   # set env var or paste token here
`;
```

Change the default config path in `loadConfig` to:

```ts
const resolvedPath = configPath
  ?? resolve(process.env.HOME ?? "~", ".opencodex", "config.yaml");
```

Change the creation message to:

```ts
console.log(`Edit it to add your bot token under bots[], then run: opencodex gateway start`);
```

In `resolveBots`, replace default model and extra args with selected engine values:

```ts
const selectedEngine = config.engine.type;
const selectedEngineConfig = config.engine[selectedEngine];
const defaultModel = selectedEngineConfig.model;
const defaultExtraArgs = selectedEngineConfig.extraArgs;
```

- [ ] **Step 7: Update session types and manager update patch**

In `src/sessions/types.ts`, add neutral fields:

```ts
export interface Session {
  sessionId: string;
  chatId: string;
  channelType: string;
  engineType?: string;
  engineSessionId?: string;
  claudeSessionId?: string;
  createdAt: number;
  lastActiveAt: number;
  title?: string;
  isActive: boolean;
  sessionNum: number;
  isGroup?: boolean;
}
```

In `src/sessions/manager.ts`, replace the `update` signature with:

```ts
  update(sessionId: string, patch: Partial<Pick<Session,
    "title" | "engineType" | "engineSessionId" | "claudeSessionId" | "lastActiveAt"
  >>): void {
```

- [ ] **Step 8: Run tests and commit**

Run:

```bash
npm test -- src/config/__tests__/loader.test.ts src/sessions/__tests__/manager.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/config/types.ts src/config/schema.ts src/config/loader.ts src/config/__tests__/loader.test.ts src/sessions/types.ts src/sessions/manager.ts src/sessions/__tests__/manager.test.ts
git commit -m "feat: add engine config and session fields"
```

---

### Task 2: Engine Event Types And Prompt Composition

**Files:**
- Create: `src/engines/types.ts`
- Create: `src/engines/prompt.ts`
- Create: `src/engines/__tests__/prompt.test.ts`

- [ ] **Step 1: Write prompt composition tests**

Create `src/engines/__tests__/prompt.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEnginePromptParts } from "../prompt.js";

describe("buildEnginePromptParts", () => {
  it("includes SOUL.md and built-in Telegram skills", () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-prompt-"));
    const agentsDir = join(root, "agents");
    mkdirSync(join(agentsDir, "bot-1"), { recursive: true });
    writeFileSync(join(agentsDir, "bot-1", "SOUL.md"), "Speak warmly.");

    const prompt = buildEnginePromptParts({
      agentsDir,
      botId: "bot-1",
      apiPort: 18790,
      chatId: "chat-1",
      isGroup: true,
    }).join("\n\n---\n\n");

    expect(prompt).toContain("Speak warmly.");
    expect(prompt).toContain("send files");
    expect(prompt).toContain("SOUL.md");
    expect(prompt).toContain("chat history");
  });
});
```

- [ ] **Step 2: Run prompt test and verify failure**

Run:

```bash
npm test -- src/engines/__tests__/prompt.test.ts
```

Expected: FAIL because `src/engines/prompt.ts` does not exist.

- [ ] **Step 3: Add engine types**

Create `src/engines/types.ts`:

```ts
import type { ChildProcess } from "node:child_process";
import type { Session } from "../sessions/types.js";

export type EngineType = "codex" | "claude";

export interface EngineRuntimeConfig {
  type: EngineType;
  binary: string;
  model?: string;
  extraArgs: string[];
  maxProcesses: number;
  idleTimeoutMs: number;
  workspaceDir: string;
  apiPort: number;
  agentsDir: string;
  codex?: {
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "untrusted" | "on-request" | "never";
  };
}

export type EngineEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "thinking_started" }
  | { type: "tool_started"; name: string; detail?: string }
  | { type: "text"; text: string }
  | { type: "result"; result?: string; isError?: boolean }
  | { type: "error"; message: string };

export interface EngineProcess {
  sessionId: string;
  engineSessionId?: string;
  process?: ChildProcess;
  busy: boolean;
  lastActiveAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  workspaceDir: string;
}

export interface EngineAdapter {
  readonly type: EngineType;
  acquire(session: Session, botId: string, botExtraArgs?: string[]): EngineProcess;
  sendMessage(session: Session, text: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent>;
  forkAndAsk(session: Session, question: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent>;
  sendControl(sessionId: string, request: Record<string, unknown>): boolean;
  sendControlAndWait(sessionId: string, request: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown> | null>;
  shutdown(): Promise<void>;
  updateConfig(config: Partial<EngineRuntimeConfig>): void;
  getRunningCount(): number;
  getWorkspaceDir(sessionId: string): string | undefined;
  hasProcess(sessionId: string): boolean;
  isBusy(sessionId: string): boolean;
}
```

- [ ] **Step 4: Add prompt composition helper**

Create `src/engines/prompt.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTelegramFileSkill } from "../skills/telegram-file.js";
import { getSoulEditorSkill } from "../skills/soul-editor.js";
import { getButtonSkill } from "../skills/telegram-buttons.js";
import { getChatHistorySkill } from "../skills/chat-history.js";
import { getTelegramFormatSkill } from "../skills/telegram-format.js";

export interface EnginePromptPartsInput {
  agentsDir: string;
  botId: string;
  apiPort: number;
  chatId: string;
  isGroup: boolean;
}

export function buildEnginePromptParts(input: EnginePromptPartsInput): string[] {
  const parts: string[] = [];
  const soulPath = join(input.agentsDir, input.botId, "SOUL.md");

  if (existsSync(soulPath)) {
    const soul = readFileSync(soulPath, "utf-8").trim();
    if (soul) parts.push(soul);
  }

  parts.push(getTelegramFileSkill(input.apiPort, input.chatId, input.botId, input.isGroup));
  parts.push(getSoulEditorSkill(input.apiPort, input.botId));
  parts.push(getButtonSkill());
  parts.push(getTelegramFormatSkill());
  if (input.isGroup) {
    parts.push(getChatHistorySkill(input.apiPort, input.chatId));
  }

  return parts;
}

export function buildCodexPrompt(systemParts: string[], userText: string): string {
  if (systemParts.length === 0) return userText;
  return [
    "<opencodex-system>",
    systemParts.join("\n\n---\n\n"),
    "</opencodex-system>",
    "",
    userText,
  ].join("\n");
}
```

- [ ] **Step 5: Run test and commit**

Run:

```bash
npm test -- src/engines/__tests__/prompt.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/engines/types.ts src/engines/prompt.ts src/engines/__tests__/prompt.test.ts
git commit -m "feat: add engine contract and prompt builder"
```

---

### Task 3: Claude Adapter Extraction

**Files:**
- Create: `src/engines/claude/parser.ts`
- Create: `src/engines/claude/adapter.ts`
- Create: `src/engines/claude/__tests__/parser.test.ts`
- Modify: `src/process/claude-cli.ts`
- Modify: `src/process/__tests__/claude-cli.test.ts`

- [ ] **Step 1: Move parser tests to Claude engine path**

Create `src/engines/claude/__tests__/parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildClaudeSpawnArgs, mapClaudeEvent, parseClaudeStreamEvent } from "../parser.js";

describe("parseClaudeStreamEvent", () => {
  it("parses system init event", () => {
    const event = parseClaudeStreamEvent(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      model: "claude-sonnet-4-6",
    }));
    expect(event).not.toBeNull();
    expect(event!.type).toBe("system");
    expect(event!.session_id).toBe("abc-123");
  });

  it("returns null for invalid JSON", () => {
    expect(parseClaudeStreamEvent("not json")).toBeNull();
  });
});

describe("buildClaudeSpawnArgs", () => {
  it("builds args for new session", () => {
    const args = buildClaudeSpawnArgs({ binary: "claude", extraArgs: [] });
    expect(args.cmd).toBe("claude");
    expect(args.args).toContain("-p");
    expect(args.args).toContain("--input-format");
    expect(args.args).toContain("stream-json");
    expect(args.args).toContain("--output-format");
    expect(args.args).toContain("stream-json");
    expect(args.args).toContain("--verbose");
  });

  it("builds args for resume session", () => {
    const args = buildClaudeSpawnArgs({ binary: "claude", extraArgs: [], engineSessionId: "sess-123" });
    expect(args.args).toContain("--resume");
    expect(args.args).toContain("sess-123");
  });
});

describe("mapClaudeEvent", () => {
  it("maps assistant text and result events", () => {
    expect(mapClaudeEvent({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    })).toEqual([{ type: "text", text: "Hello" }]);
    expect(mapClaudeEvent({ type: "result", result: "Done", is_error: false }))
      .toEqual([{ type: "result", result: "Done", isError: false }]);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- src/engines/claude/__tests__/parser.test.ts
```

Expected: FAIL because `src/engines/claude/parser.ts` does not exist.

- [ ] **Step 3: Create Claude parser**

Create `src/engines/claude/parser.ts`:

```ts
import type { EngineEvent } from "../types.js";

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: { role: string; content: unknown };
  event?: unknown;
  [key: string]: unknown;
}

export interface ClaudeSpawnConfig {
  binary: string;
  extraArgs: string[];
  engineSessionId?: string;
}

export function parseClaudeStreamEvent(line: string): ClaudeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    return null;
  }
}

export function buildClaudeSpawnArgs(config: ClaudeSpawnConfig): { cmd: string; args: string[] } {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
  ];
  if (config.engineSessionId) {
    args.push("--resume", config.engineSessionId);
  }
  args.push(...config.extraArgs);
  return { cmd: config.binary, args };
}

export function mapClaudeEvent(event: ClaudeStreamEvent): EngineEvent[] {
  if (event.type === "system" && event.subtype === "init" && event.session_id) {
    return [{ type: "session_started", sessionId: event.session_id }];
  }

  if (event.type === "stream_event" && event.event) {
    const raw = event.event as Record<string, unknown>;
    if (raw.type === "content_block_start") {
      const block = raw.content_block as Record<string, unknown> | undefined;
      if (block?.type === "thinking") return [{ type: "thinking_started" }];
    }
  }

  if (event.type === "assistant" && event.message) {
    const mapped: EngineEvent[] = [];
    const content = event.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use" && typeof b.name === "string") {
          mapped.push({ type: "tool_started", name: b.name, detail: getClaudeToolDetail(b.name, b.input) });
        }
        if ("text" in b && typeof b.text === "string") {
          mapped.push({ type: "text", text: b.text });
        }
      }
    } else if (typeof content === "string") {
      mapped.push({ type: "text", text: content });
    }
    return mapped;
  }

  if (event.type === "result") {
    return [{ type: "result", result: event.result, isError: event.is_error }];
  }

  return [];
}

function getClaudeToolDetail(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const inp = input as Record<string, unknown>;
  if (name === "Read" || name === "Write" || name === "Edit") return shortPath(inp.file_path as string);
  if (name === "Bash") return truncate(String(inp.command ?? ""), 50);
  if (name === "Glob") return String(inp.pattern ?? "");
  if (name === "Grep") return truncate(String(inp.pattern ?? ""), 40);
  if (name === "Agent") return truncate(String(inp.description ?? inp.prompt ?? ""), 40);
  return undefined;
}

function shortPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "..." : value;
}
```

- [ ] **Step 4: Create Claude adapter**

Create `src/engines/claude/adapter.ts` by moving the current logic from `src/process/manager.ts` and `src/process/claude-cli.ts` behind `EngineAdapter`. Use this class skeleton and preserve the existing eviction, idle, retry, control, and `/btw` behavior:

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import type { Session } from "../../sessions/types.js";
import type { EngineAdapter, EngineEvent, EngineProcess, EngineRuntimeConfig } from "../types.js";
import { buildEnginePromptParts } from "../prompt.js";
import { buildClaudeSpawnArgs, mapClaudeEvent, parseClaudeStreamEvent } from "./parser.js";

export class ClaudeEngineAdapter implements EngineAdapter {
  readonly type = "claude" as const;
  private processes = new Map<string, EngineProcess>();
  private config: EngineRuntimeConfig;
  private log: Logger;

  constructor(config: EngineRuntimeConfig, log: Logger) {
    this.config = config;
    this.log = log.child({ module: "claude-engine" });
  }

  acquire(session: Session, botId: string, botExtraArgs?: string[]): EngineProcess {
    const existing = this.processes.get(session.sessionId);
    if (existing?.process && !existing.process.killed) {
      this.resetIdleTimer(session.sessionId);
      return existing;
    }
    if (this.processes.size >= this.config.maxProcesses) this.evictOldest();

    const sessionDir = this.sessionWorkspace(session, botId);
    mkdirSync(sessionDir, { recursive: true });
    const systemParts = buildEnginePromptParts({
      agentsDir: this.config.agentsDir,
      botId,
      apiPort: this.config.apiPort,
      chatId: session.chatId,
      isGroup: session.isGroup ?? false,
    });
    const extraArgs = [
      ...(botExtraArgs ?? this.config.extraArgs),
      "--append-system-prompt",
      systemParts.join("\n\n---\n\n"),
    ];
    const { cmd, args } = buildClaudeSpawnArgs({
      binary: this.config.binary,
      extraArgs,
      engineSessionId: session.engineSessionId ?? session.claudeSessionId,
    });
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd: sessionDir, env: { ...process.env } });
    const cp: EngineProcess = {
      sessionId: session.sessionId,
      engineSessionId: session.engineSessionId ?? session.claudeSessionId,
      process: proc,
      busy: false,
      lastActiveAt: Date.now(),
      workspaceDir: sessionDir,
    };
    proc.on("exit", (code) => {
      this.log.info({ sessionId: session.sessionId, code, pid: proc.pid }, "Claude process exited");
      if (this.processes.get(session.sessionId)?.process === proc) this.processes.delete(session.sessionId);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log.warn({ sessionId: session.sessionId }, `claude stderr: ${text}`);
    });
    this.processes.set(session.sessionId, cp);
    this.scheduleIdle(session.sessionId);
    return cp;
  }

  async *sendMessage(session: Session, text: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent> {
    let cp = this.acquire(session, botId, botExtraArgs);
    cp.busy = true;
    cp.lastActiveAt = Date.now();
    this.clearIdleTimer(session.sessionId);
    this.sendUserMessage(cp.process!, text);
    try {
      let gotEvents = false;
      for await (const event of this.readUntilResult(cp.process!)) {
        gotEvents = true;
        for (const mapped of mapClaudeEvent(event)) yield mapped;
      }
      if (!gotEvents && (session.engineSessionId || session.claudeSessionId)) {
        session.engineSessionId = undefined;
        session.claudeSessionId = undefined;
        this.processes.delete(session.sessionId);
        cp = this.acquire(session, botId, botExtraArgs);
        cp.busy = true;
        this.clearIdleTimer(session.sessionId);
        this.sendUserMessage(cp.process!, text);
        for await (const event of this.readUntilResult(cp.process!)) {
          for (const mapped of mapClaudeEvent(event)) yield mapped;
        }
      }
    } finally {
      cp.busy = false;
      cp.lastActiveAt = Date.now();
      this.scheduleIdle(session.sessionId);
    }
  }

  async *forkAndAsk(session: Session, question: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent> {
    const engineSessionId = session.engineSessionId ?? session.claudeSessionId;
    if (!engineSessionId) return;
    const cwd = this.sessionWorkspace(session, botId);
    mkdirSync(cwd, { recursive: true });
    const args = [
      "-p", "--verbose", "--output-format", "stream-json",
      "--resume", engineSessionId,
      "--fork-session",
      "--permission-mode", "bypassPermissions",
      ...(botExtraArgs ?? this.config.extraArgs),
      question,
    ];
    const proc = spawn(this.config.binary, args, { stdio: ["ignore", "pipe", "pipe"], cwd, env: { ...process.env } });
    for await (const event of this.readUntilResult(proc)) {
      for (const mapped of mapClaudeEvent(event)) yield mapped;
    }
  }

  sendControl(sessionId: string, request: Record<string, unknown>): boolean {
    const cp = this.processes.get(sessionId);
    if (!cp?.process || cp.process.killed) return false;
    cp.process.stdin!.write(JSON.stringify({
      type: "control_request",
      request_id: `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      request,
    }) + "\n");
    return true;
  }

  async sendControlAndWait(): Promise<Record<string, unknown> | null> {
    return null;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.processes.keys()]) this.kill(id);
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }

  updateConfig(updates: Partial<EngineRuntimeConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  getRunningCount(): number { return this.processes.size; }
  getWorkspaceDir(sessionId: string): string | undefined { return this.processes.get(sessionId)?.workspaceDir; }
  hasProcess(sessionId: string): boolean { return !!this.processes.get(sessionId)?.process && !this.processes.get(sessionId)!.process!.killed; }
  isBusy(sessionId: string): boolean { return this.processes.get(sessionId)?.busy ?? false; }

  private sessionWorkspace(session: Session, botId: string): string {
    const safeChatId = session.chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.config.workspaceDir, botId, `${safeChatId}_${session.sessionId}`);
  }

  private sendUserMessage(proc: ChildProcess, text: string): void {
    proc.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  }

  private async *readUntilResult(proc: ChildProcess) {
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const event = parseClaudeStreamEvent(line);
        if (!event) continue;
        yield event;
        if (event.type === "result") return;
      }
    } finally {
      rl.close();
    }
  }

  private scheduleIdle(sessionId: string): void {
    const cp = this.processes.get(sessionId);
    if (!cp) return;
    this.clearIdleTimer(sessionId);
    cp.idleTimer = setTimeout(() => {
      if (!cp.busy) this.kill(sessionId);
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.processes.get(sessionId)?.idleTimer;
    if (timer) clearTimeout(timer);
  }

  private resetIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId);
    this.scheduleIdle(sessionId);
  }

  private kill(sessionId: string): void {
    const cp = this.processes.get(sessionId);
    if (!cp?.process) return;
    this.clearIdleTimer(sessionId);
    cp.process.kill("SIGTERM");
    setTimeout(() => { if (!cp.process!.killed) cp.process!.kill("SIGKILL"); }, 5000);
    this.processes.delete(sessionId);
  }

  private evictOldest(): void {
    let oldest: EngineProcess | null = null;
    for (const cp of this.processes.values()) {
      if (cp.busy) continue;
      if (!oldest || cp.lastActiveAt < oldest.lastActiveAt) oldest = cp;
    }
    if (oldest) this.kill(oldest.sessionId);
  }
}
```

- [ ] **Step 5: Keep process wrapper imports working during transition**

Replace `src/process/claude-cli.ts` with compatibility re-exports:

```ts
export {
  parseClaudeStreamEvent as parseStreamEvent,
  buildClaudeSpawnArgs as buildSpawnArgs,
} from "../engines/claude/parser.js";
export type { ClaudeStreamEvent as StreamEvent } from "../engines/claude/parser.js";
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- src/engines/claude/__tests__/parser.test.ts src/process/__tests__/claude-cli.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/engines/claude src/process/claude-cli.ts src/process/__tests__/claude-cli.test.ts
git commit -m "refactor: extract Claude engine adapter"
```

---

### Task 4: Codex Parser And Spawn Args

**Files:**
- Create: `src/engines/codex/parser.ts`
- Create: `src/engines/codex/__tests__/parser.test.ts`

- [ ] **Step 1: Write Codex parser tests**

Create `src/engines/codex/__tests__/parser.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCodexSpawnArgs, mapCodexEvent, parseCodexJsonLine } from "../parser.js";

describe("buildCodexSpawnArgs", () => {
  it("builds args for a new Codex turn", () => {
    const args = buildCodexSpawnArgs({
      binary: "codex",
      prompt: "hello",
      extraArgs: [],
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    expect(args.cmd).toBe("codex");
    expect(args.args).toEqual([
      "exec",
      "--json",
      "--sandbox", "danger-full-access",
      "--ask-for-approval", "never",
      "--skip-git-repo-check",
      "hello",
    ]);
  });

  it("builds args for resumed Codex turn", () => {
    const args = buildCodexSpawnArgs({
      binary: "codex",
      prompt: "again",
      engineSessionId: "thread-123",
      extraArgs: ["--model", "gpt-5.4"],
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
    expect(args.args).toEqual([
      "exec",
      "resume", "thread-123",
      "--json",
      "--sandbox", "workspace-write",
      "--ask-for-approval", "never",
      "--skip-git-repo-check",
      "--model", "gpt-5.4",
      "again",
    ]);
  });
});

describe("parseCodexJsonLine", () => {
  it("parses valid JSON and ignores invalid JSON", () => {
    expect(parseCodexJsonLine('{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}'))
      .toMatchObject({ type: "turn.completed" });
    expect(parseCodexJsonLine("not json")).toBeNull();
  });
});

describe("mapCodexEvent", () => {
  it("maps thread, item, and turn events", () => {
    expect(mapCodexEvent({ type: "thread.started", thread_id: "thread-123" }))
      .toEqual([{ type: "session_started", sessionId: "thread-123" }]);
    expect(mapCodexEvent({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "Hello" },
    })).toEqual([{ type: "text", text: "Hello" }]);
    expect(mapCodexEvent({
      type: "item.started",
      item: { id: "item_2", type: "command_execution", command: "npm test", aggregated_output: "", exit_code: null, status: "in_progress" },
    })).toEqual([{ type: "tool_started", name: "Bash", detail: "npm test" }]);
    expect(mapCodexEvent({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }))
      .toEqual([{ type: "result" }]);
  });

  it("maps Codex failures", () => {
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "boom" } }))
      .toEqual([{ type: "error", message: "boom" }, { type: "result", result: "boom", isError: true }]);
    expect(mapCodexEvent({ type: "error", message: "fatal" }))
      .toEqual([{ type: "error", message: "fatal" }]);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- src/engines/codex/__tests__/parser.test.ts
```

Expected: FAIL because `src/engines/codex/parser.ts` does not exist.

- [ ] **Step 3: Create Codex parser**

Create `src/engines/codex/parser.ts`:

```ts
import type { EngineEvent } from "../types.js";

export interface CodexSpawnConfig {
  binary: string;
  prompt: string;
  engineSessionId?: string;
  extraArgs: string[];
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-request" | "never";
  ephemeral?: boolean;
}

export interface CodexJsonEvent {
  type: string;
  thread_id?: string;
  item?: Record<string, unknown>;
  error?: { message?: string };
  message?: string;
  [key: string]: unknown;
}

export function buildCodexSpawnArgs(config: CodexSpawnConfig): { cmd: string; args: string[] } {
  const args = config.engineSessionId
    ? ["exec", "resume", config.engineSessionId]
    : ["exec"];
  args.push(
    "--json",
    "--sandbox", config.sandbox,
    "--ask-for-approval", config.approvalPolicy,
    "--skip-git-repo-check",
  );
  if (config.ephemeral) args.push("--ephemeral");
  args.push(...config.extraArgs);
  args.push(config.prompt);
  return { cmd: config.binary, args };
}

export function parseCodexJsonLine(line: string): CodexJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CodexJsonEvent;
  } catch {
    return null;
  }
}

export function mapCodexEvent(event: CodexJsonEvent): EngineEvent[] {
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    return [{ type: "session_started", sessionId: event.thread_id }];
  }

  if ((event.type === "item.started" || event.type === "item.updated") && event.item) {
    const tool = mapCodexTool(event.item);
    return tool ? [tool] : [];
  }

  if (event.type === "item.completed" && event.item) {
    const itemType = event.item.type;
    if (itemType === "agent_message" && typeof event.item.text === "string") {
      return [{ type: "text", text: event.item.text }];
    }
    const tool = mapCodexTool(event.item);
    return tool ? [tool] : [];
  }

  if (event.type === "turn.completed") {
    return [{ type: "result" }];
  }

  if (event.type === "turn.failed") {
    const message = event.error?.message ?? "Codex turn failed";
    return [{ type: "error", message }, { type: "result", result: message, isError: true }];
  }

  if (event.type === "error") {
    return [{ type: "error", message: event.message ?? event.error?.message ?? "Codex error" }];
  }

  return [];
}

function mapCodexTool(item: Record<string, unknown>): EngineEvent | null {
  if (item.type === "command_execution" && typeof item.command === "string") {
    return { type: "tool_started", name: "Bash", detail: truncate(item.command, 50) };
  }
  if (item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "mcp";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return { type: "tool_started", name: "MCP", detail: `${server}.${tool}` };
  }
  if (item.type === "web_search" && typeof item.query === "string") {
    return { type: "tool_started", name: "WebSearch", detail: truncate(item.query, 50) };
  }
  if (item.type === "file_change") {
    return { type: "tool_started", name: "Edit", detail: "file changes" };
  }
  if (item.type === "collab_tool_call") {
    return { type: "tool_started", name: "Agent", detail: "collaboration" };
  }
  if (item.type === "reasoning") {
    return { type: "thinking_started" };
  }
  return null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "..." : value;
}
```

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- src/engines/codex/__tests__/parser.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/engines/codex
git commit -m "feat: add Codex JSONL parser"
```

---

### Task 5: Codex Adapter And Engine Manager

**Files:**
- Create: `src/engines/codex/adapter.ts`
- Create: `src/engines/manager.ts`
- Create: `src/engines/__tests__/manager.test.ts`
- Modify: `src/gateway.ts`

- [ ] **Step 1: Write engine manager tests**

Create `src/engines/__tests__/manager.test.ts`:

```ts
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createEngineManager } from "../manager.js";
import type { GatewayConfig } from "../../config/types.js";

const log = pino({ enabled: false });

function baseConfig(type: "codex" | "claude"): GatewayConfig {
  return {
    gateway: { port: 18790, dataDir: "~/.opencodex", logLevel: "info", logFormat: "pretty" },
    engine: {
      type,
      maxProcesses: 10,
      idleTimeoutMs: 600000,
      codex: { binary: "codex", sandbox: "danger-full-access", approvalPolicy: "never", extraArgs: [] },
      claude: { binary: "claude", model: "sonnet", extraArgs: [] },
    },
    claude: { binary: "claude", model: "sonnet", idleTimeoutMs: 600000, maxProcesses: 10, extraArgs: [] },
    auth: { defaultPolicy: "pairing" },
  };
}

describe("createEngineManager", () => {
  it("creates Codex engine by default", () => {
    const manager = createEngineManager(baseConfig("codex"), "/tmp/data", log);
    expect(manager.type).toBe("codex");
  });

  it("creates Claude engine when configured", () => {
    const manager = createEngineManager(baseConfig("claude"), "/tmp/data", log);
    expect(manager.type).toBe("claude");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test -- src/engines/__tests__/manager.test.ts
```

Expected: FAIL because `src/engines/manager.ts` and `src/engines/codex/adapter.ts` do not exist.

- [ ] **Step 3: Create Codex adapter**

Create `src/engines/codex/adapter.ts`:

```ts
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import type { Session } from "../../sessions/types.js";
import type { EngineAdapter, EngineEvent, EngineProcess, EngineRuntimeConfig } from "../types.js";
import { buildCodexPrompt, buildEnginePromptParts } from "../prompt.js";
import { buildCodexSpawnArgs, mapCodexEvent, parseCodexJsonLine } from "./parser.js";

export class CodexEngineAdapter implements EngineAdapter {
  readonly type = "codex" as const;
  private processes = new Map<string, EngineProcess>();
  private config: EngineRuntimeConfig;
  private log: Logger;

  constructor(config: EngineRuntimeConfig, log: Logger) {
    this.config = config;
    this.log = log.child({ module: "codex-engine" });
  }

  acquire(session: Session, botId: string): EngineProcess {
    const existing = this.processes.get(session.sessionId);
    if (existing?.process && !existing.process.killed) return existing;
    const workspaceDir = this.sessionWorkspace(session, botId);
    mkdirSync(workspaceDir, { recursive: true });
    const cp: EngineProcess = {
      sessionId: session.sessionId,
      engineSessionId: session.engineSessionId,
      busy: false,
      lastActiveAt: Date.now(),
      workspaceDir,
    };
    this.processes.set(session.sessionId, cp);
    return cp;
  }

  async *sendMessage(session: Session, text: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent> {
    const cp = this.acquire(session, botId);
    const prompt = this.promptFor(session, botId, text);
    yield* this.runTurn(cp, prompt, session.engineSessionId, botExtraArgs, false);
  }

  async *forkAndAsk(session: Session, question: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent> {
    if (!session.engineSessionId) return;
    const cp = this.acquire(session, botId);
    const prompt = this.promptFor(session, botId, question);
    yield* this.runTurn(cp, prompt, session.engineSessionId, botExtraArgs, true);
  }

  sendControl(sessionId: string, request: Record<string, unknown>): boolean {
    const cp = this.processes.get(sessionId);
    if (!cp?.process || cp.process.killed) return false;
    if (request.subtype !== "interrupt") return false;
    cp.process.kill("SIGTERM");
    return true;
  }

  async sendControlAndWait(): Promise<Record<string, unknown> | null> {
    return null;
  }

  async shutdown(): Promise<void> {
    for (const cp of this.processes.values()) {
      cp.process?.kill("SIGTERM");
    }
    this.processes.clear();
  }

  updateConfig(updates: Partial<EngineRuntimeConfig>): void {
    this.config = { ...this.config, ...updates, codex: { ...this.config.codex, ...updates.codex } };
  }

  getRunningCount(): number { return [...this.processes.values()].filter((p) => p.process && !p.process.killed).length; }
  getWorkspaceDir(sessionId: string): string | undefined { return this.processes.get(sessionId)?.workspaceDir; }
  hasProcess(sessionId: string): boolean { return !!this.processes.get(sessionId)?.process && !this.processes.get(sessionId)!.process!.killed; }
  isBusy(sessionId: string): boolean { return this.processes.get(sessionId)?.busy ?? false; }

  private async *runTurn(cp: EngineProcess, prompt: string, engineSessionId: string | undefined, botExtraArgs: string[] | undefined, ephemeral: boolean): AsyncGenerator<EngineEvent> {
    cp.busy = true;
    cp.lastActiveAt = Date.now();
    const extraArgs = [...this.config.extraArgs, ...(botExtraArgs ?? [])];
    if (this.config.model) extraArgs.push("--model", this.config.model);
    const { cmd, args } = buildCodexSpawnArgs({
      binary: this.config.binary,
      prompt,
      engineSessionId,
      extraArgs,
      sandbox: this.config.codex?.sandbox ?? "danger-full-access",
      approvalPolicy: this.config.codex?.approvalPolicy ?? "never",
      ephemeral,
    });
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: cp.workspaceDir, env: { ...process.env } });
    cp.process = proc;
    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log.warn({ sessionId: cp.sessionId }, `codex stderr: ${text}`);
    });
    try {
      for await (const event of this.readEvents(proc)) {
        for (const mapped of mapCodexEvent(event)) yield mapped;
      }
    } finally {
      cp.busy = false;
      cp.lastActiveAt = Date.now();
      cp.process = undefined;
    }
  }

  private async *readEvents(proc: ChildProcess) {
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const event = parseCodexJsonLine(line);
        if (event) yield event;
      }
    } finally {
      rl.close();
    }
  }

  private promptFor(session: Session, botId: string, text: string): string {
    const parts = buildEnginePromptParts({
      agentsDir: this.config.agentsDir,
      botId,
      apiPort: this.config.apiPort,
      chatId: session.chatId,
      isGroup: session.isGroup ?? false,
    });
    return buildCodexPrompt(parts, text);
  }

  private sessionWorkspace(session: Session, botId: string): string {
    const safeChatId = session.chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.config.workspaceDir, botId, `${safeChatId}_${session.sessionId}`);
  }
}
```

- [ ] **Step 4: Create engine manager factory**

Create `src/engines/manager.ts`:

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config/types.js";
import { ClaudeEngineAdapter } from "./claude/adapter.js";
import { CodexEngineAdapter } from "./codex/adapter.js";
import type { EngineAdapter, EngineRuntimeConfig } from "./types.js";

export function createEngineManager(config: GatewayConfig, dataDir: string, log: Logger): EngineAdapter {
  const workspaceDir = join(dataDir, "workspace");
  const agentsDir = join(dataDir, "agents");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const selected = config.engine.type;
  const selectedConfig = config.engine[selected];
  const runtime: EngineRuntimeConfig = {
    type: selected,
    binary: selectedConfig.binary,
    model: selectedConfig.model,
    extraArgs: selectedConfig.extraArgs,
    maxProcesses: config.engine.maxProcesses,
    idleTimeoutMs: config.engine.idleTimeoutMs,
    workspaceDir,
    apiPort: config.gateway.port,
    agentsDir,
    codex: selected === "codex" ? {
      sandbox: config.engine.codex.sandbox,
      approvalPolicy: config.engine.codex.approvalPolicy,
    } : undefined,
  };

  return selected === "claude"
    ? new ClaudeEngineAdapter(runtime, log)
    : new CodexEngineAdapter(runtime, log);
}

export function updateEngineFromConfig(adapter: EngineAdapter, config: GatewayConfig): void {
  const selected = config.engine.type;
  const selectedConfig = config.engine[selected];
  adapter.updateConfig({
    type: selected,
    binary: selectedConfig.binary,
    model: selectedConfig.model,
    extraArgs: selectedConfig.extraArgs,
    maxProcesses: config.engine.maxProcesses,
    idleTimeoutMs: config.engine.idleTimeoutMs,
    apiPort: config.gateway.port,
    codex: selected === "codex" ? {
      sandbox: config.engine.codex.sandbox,
      approvalPolicy: config.engine.codex.approvalPolicy,
    } : undefined,
  });
}
```

- [ ] **Step 5: Run engine tests and commit**

Run:

```bash
npm test -- src/engines/__tests__/manager.test.ts src/engines/codex/__tests__/parser.test.ts src/engines/claude/__tests__/parser.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/engines
git commit -m "feat: add Codex adapter and engine manager"
```

---

### Task 6: Wire Gateway And BotInstance To EngineEvent

**Files:**
- Modify: `src/gateway.ts`
- Modify: `src/bot-instance.ts`
- Modify: `src/progress.ts`
- Modify: `src/__tests__/integration.test.ts`

- [ ] **Step 1: Update integration test to use neutral engine fields**

In `src/__tests__/integration.test.ts`, replace Claude process imports:

```ts
import { buildCodexSpawnArgs, parseCodexJsonLine } from "../engines/codex/parser.js";
```

Replace the spawn/session assertions in the first test with:

```ts
    const spawnArgs = buildCodexSpawnArgs({
      binary: config.engine.codex.binary,
      extraArgs: config.engine.codex.extraArgs,
      sandbox: config.engine.codex.sandbox,
      approvalPolicy: config.engine.codex.approvalPolicy,
      prompt: "hello",
    });
    expect(spawnArgs.args).toContain("exec");
    expect(spawnArgs.args).toContain("--json");

    const initEvent = parseCodexJsonLine('{"type":"thread.started","thread_id":"thread-abc"}');
    expect(initEvent!.thread_id).toBe("thread-abc");

    sm.update(session.sessionId, { engineType: "codex", engineSessionId: "thread-abc" });
    const updated = sm.resolve("111", "telegram");
    expect(updated.engineSessionId).toBe("thread-abc");
```

- [ ] **Step 2: Run integration test and verify failure**

Run:

```bash
npm test -- src/__tests__/integration.test.ts
```

Expected: FAIL because `gateway.ts` and `bot-instance.ts` still use `ProcessManager` and Claude-shaped events.

- [ ] **Step 3: Update gateway construction**

In `src/gateway.ts`, replace:

```ts
import { ProcessManager } from "./process/manager.js";
```

with:

```ts
import { createEngineManager, updateEngineFromConfig } from "./engines/manager.js";
import type { EngineAdapter } from "./engines/types.js";
```

Change the class field:

```ts
  private processManager: EngineAdapter;
```

Replace the constructor's process manager setup with:

```ts
    this.processManager = createEngineManager(config, this.dataDir, log);
```

In `reloadConfig`, replace the Claude-specific update block with:

```ts
      if (newConfig.engine.type !== this.config.engine.type) {
        changes.push(`engine: ${this.config.engine.type} -> ${newConfig.engine.type}`);
      }
      if (newConfig.engine.maxProcesses !== this.config.engine.maxProcesses) {
        changes.push(`maxProcesses: ${this.config.engine.maxProcesses} -> ${newConfig.engine.maxProcesses}`);
      }
      if (newConfig.engine.idleTimeoutMs !== this.config.engine.idleTimeoutMs) {
        changes.push(`idleTimeoutMs: ${this.config.engine.idleTimeoutMs} -> ${newConfig.engine.idleTimeoutMs}`);
      }
      updateEngineFromConfig(this.processManager, newConfig);
```

- [ ] **Step 4: Update BotInstance imports and event loop**

In `src/bot-instance.ts`, replace:

```ts
import type { StreamEvent } from "./process/types.js";
import { ProcessManager } from "./process/manager.js";
```

with:

```ts
import type { EngineAdapter, EngineEvent } from "./engines/types.js";
```

Change the field and constructor option types from `ProcessManager` to `EngineAdapter`.

Replace the main `for await` event handling block in `handleMessage` with:

```ts
      for await (const event of this.processManager.sendMessage(session, messageText, this.botId, this.extraArgs)) {
        this.applyEngineSessionEvent(session.sessionId, event);

        if (event.type === "thinking_started") {
          progress.startThinking();
        } else if (event.type === "tool_started") {
          progress.startTool(event.name, event.detail);
        } else if (event.type === "text") {
          progress.appendText(event.text);
        } else if (event.type === "result") {
          await progress.finish();
          const buf = progress.getBuffer();
          const finalText = buf.length > 0
            ? buf
            : (typeof event.result === "string" && event.result) || "";

          if (finalText.length > 0) {
            const { text: cleanText, buttons } = extractButtons(finalText);
            const progressMsgId = progress.getMessageId();
            const chunks = splitMessage(cleanText);
            const plainChunks = chunks.map(stripHtml);

            if (buttons.length > 0) {
              if (progressMsgId) await this.telegram.deleteMessage(msg.chatId, progressMsgId);
              const btnMsgId = await this.telegram.sendWithButtons(
                msg.chatId, chunks[0], buttons, msg.messageId, "HTML", plainChunks[0],
              );
              this.lastButtonMsg.set(msg.chatId, btnMsgId);
              this.telegram.notifyOutbound(msg.chatId, cleanText, btnMsgId);
              for (let ci = 1; ci < chunks.length; ci++) {
                await this.telegram.send({ chatId: msg.chatId, text: chunks[ci], parseMode: "HTML", plainFallback: plainChunks[ci] });
              }
            } else if (progressMsgId) {
              await this.telegram.editMessage(msg.chatId, progressMsgId, chunks[0], undefined, "HTML", plainChunks[0]);
              this.telegram.notifyOutbound(msg.chatId, cleanText, progressMsgId);
              for (let ci = 1; ci < chunks.length; ci++) {
                await this.telegram.send({ chatId: msg.chatId, text: chunks[ci], parseMode: "HTML", plainFallback: plainChunks[ci] });
              }
            } else {
              for (let i = 0; i < chunks.length; i++) {
                await this.telegram.send({
                  chatId: msg.chatId,
                  text: chunks[i],
                  parseMode: "HTML",
                  plainFallback: plainChunks[i],
                  ...(i === 0 ? { replyToMessageId: msg.messageId } : {}),
                });
              }
            }
          } else if (event.isError) {
            await this.telegram.send({ chatId: msg.chatId, text: `Error: ${event.result ?? "Unknown error"}` });
          }
          break;
        }

        await progress.flush();
      }
```

Add this helper method inside the class:

```ts
  private applyEngineSessionEvent(sessionId: string, event: EngineEvent): void {
    if (event.type !== "session_started") return;
    const patch = {
      engineType: this.gatewayConfig.engine.type,
      engineSessionId: event.sessionId,
      ...(this.gatewayConfig.engine.type === "claude" ? { claudeSessionId: event.sessionId } : {}),
    };
    this.sessionManager.update(sessionId, patch);
  }
```

Make the same simplified `EngineEvent` handling in `handleBtw` and `handleTitle`: process `thinking_started`, `tool_started`, `text`, and `result`; remove direct checks for Claude `assistant`, `stream_event`, and `result`.

- [ ] **Step 5: Update progress tool labels**

In `src/progress.ts`, add Codex-oriented labels to `TOOL_ICONS`:

```ts
  MCP: "◇",
  WebSearch: "⊙",
  WebFetch: "⊙",
  Todo: "□",
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npm test -- src/__tests__/integration.test.ts src/engines/__tests__/manager.test.ts
npm run build
```

Expected: PASS.

Commit:

```bash
git add src/gateway.ts src/bot-instance.ts src/progress.ts src/__tests__/integration.test.ts
git commit -m "refactor: wire gateway to engine events"
```

---

### Task 7: OpenCodex CLI Branding And Engine Checks

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/index.ts`
- Modify: `config.example.yaml`

- [ ] **Step 1: Write a package metadata check**

Run:

```bash
node -e "const p=require('./package.json'); if (p.name !== 'opencodex' || !p.bin.opencodex) process.exit(1)"
```

Expected: FAIL because package metadata still says `openclaude`.

- [ ] **Step 2: Update package metadata**

In `package.json`, change:

```json
{
  "name": "opencodex",
  "description": "Gateway bridging chat platforms (Telegram, Discord, etc.) to Codex CLI",
  "bin": {
    "opencodex": "dist/index.js"
  }
}
```

Then run:

```bash
npm install --package-lock-only
```

Expected: `package-lock.json` updates package name references without installing dependencies.

- [ ] **Step 3: Update CLI naming and default paths**

In `src/index.ts`, replace:

```ts
  .name("openclaude")
  .description("Gateway bridging chat platforms to Claude Code CLI")
```

with:

```ts
  .name("opencodex")
  .description("Gateway bridging chat platforms to Codex CLI")
```

Replace default `".openclaude"` path occurrences with `".opencodex"`.

Rename `checkClaudeCli` to `checkEngineCli` and implement:

```ts
function checkEngineCli(configPath?: string): void {
  let binary = "codex";
  let engine = "codex";
  try {
    const config = loadConfig(configPath);
    engine = config.engine.type;
    binary = config.engine[engine].binary;
  } catch {}

  const result = spawnSync(binary, ["--version"], { stdio: "pipe", timeout: 5000 });
  if (result.error || result.status !== 0) {
    console.error(`Error: ${engine} CLI not found ("${binary}").`);
    console.error("");
    console.error("OpenCodex requires a local CLI engine.");
    console.error(engine === "codex"
      ? "Install Codex with: npm install -g @openai/codex"
      : "Install Claude Code with: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }

  const version = result.stdout?.toString().trim();
  if (version) console.log(`${engine} CLI: ${version}`);
}
```

Replace calls to `checkClaudeCli` with `checkEngineCli`.

Replace user-facing command text occurrences of `openclaude` with `opencodex`, including pairing prompts, bot add/remove hints, gateway restart hints, and SOUL.md hints.

- [ ] **Step 4: Update config example**

Replace `config.example.yaml` with Codex-default content:

```yaml
# OpenCodex Configuration
# Copy to ~/.opencodex/config.yaml and edit
# Docs: https://github.com/happy-shine/opencodex

gateway:
  port: 18790
  dataDir: "~/.opencodex"
  logLevel: "info"
  logFormat: "pretty"

engine:
  type: "codex"                 # codex | claude
  maxProcesses: 10
  idleTimeoutMs: 600000
  codex:
    binary: "codex"
    # model: "gpt-5.4"
    sandbox: "danger-full-access"
    approvalPolicy: "never"
    extraArgs: []
  claude:
    binary: "claude"
    model: "sonnet"
    extraArgs: []

auth:
  defaultPolicy: "pairing"

bots:
  - name: "my-bot"
    token: "${TELEGRAM_BOT_TOKEN}"
    auth:
      dmPolicy: "pairing"
      groupPolicy: "disabled"
      allowFrom: []
      groups:
        # "-1001234567890":
        #   enabled: true
        #   allowFrom: []
```

- [ ] **Step 5: Run metadata, build, and commit**

Run:

```bash
node -e "const p=require('./package.json'); if (p.name !== 'opencodex' || !p.bin.opencodex) process.exit(1)"
npm run build
```

Expected: PASS.

Commit:

```bash
git add package.json package-lock.json src/index.ts config.example.yaml
git commit -m "chore: rename CLI to OpenCodex"
```

---

### Task 8: Documentation Rename

**Files:**
- Modify: `README.md`
- Modify: `README_zh.md`

- [ ] **Step 1: Replace README content with Codex-first docs**

Update `README.md` to include these key sections and preserve existing feature coverage:

```md
# OpenCodex

A gateway that bridges chat platforms (Telegram, Discord, etc.) to Codex CLI by default, while keeping Claude Code available as an optional engine adapter.

```
Telegram <-> OpenCodex Gateway <-> Codex CLI / Claude Code CLI
```

Each conversation runs through a local CLI engine with session management, access control, file sharing, group chat history, and bot personality support.

## Features

- **Codex as default engine** — runs `codex exec --json` and resumes Codex threads for continuing sessions
- **Claude adapter retained** — set `engine.type: claude` to use the existing Claude Code behavior
- **Multi-bot support**
- **Bot-to-bot relay**
- **Session management**
- **`/btw` side questions**
- **Rich commands**
- **Access control**
- **Group chat support**
- **File sharing**
- **SOUL.md personality**
- **Live progress**
- **Daemon mode**
- **Hot-reload**
```

Also update install, quick start, config, CLI reference, architecture, and data directory examples from `openclaude`/`~/.openclaude`/Claude-only wording to `opencodex`/`~/.opencodex`/Codex-default wording.

- [ ] **Step 2: Replace Chinese README content consistently**

In `README_zh.md`, make the equivalent changes:

```md
# OpenCodex

将 Telegram 等聊天平台桥接到 Codex CLI 的网关；默认使用 Codex，同时保留 Claude Code 作为可选引擎适配器。
```

Update command examples to `opencodex`, data directory examples to `~/.opencodex`, and config examples to `engine.type: codex`.

- [ ] **Step 3: Scan docs for old brand leakage**

Run:

```bash
rg -n "OpenClaude|openclaude|\\.openclaude|Claude Code CLI \\(subprocess\\)" README.md README_zh.md config.example.yaml package.json src/index.ts
```

Expected: no matches except deliberate compatibility references that mention old OpenClaude data migration or Claude adapter.

- [ ] **Step 4: Commit docs**

Run:

```bash
git add README.md README_zh.md
git commit -m "docs: update README for OpenCodex"
```

---

### Task 9: Cleanup Obsolete Process Layer And Full Verification

**Files:**
- Delete when unused: `src/process/claude-cli.ts`
- Delete when unused: `src/process/manager.ts`
- Delete when unused: `src/process/types.ts`
- Delete when unused: `src/process/__tests__/claude-cli.test.ts`
- Modify: imports found by `rg`

- [ ] **Step 1: Find remaining old process imports**

Run:

```bash
rg -n "process/|claude-cli|ProcessManager|ClaudeProcess|StreamEvent|claudeSessionId|config\\.claude" src
```

Expected: matches only for deliberate compatibility fields such as `claudeSessionId`, tests for legacy config, and Claude adapter internals.

- [ ] **Step 2: Delete obsolete process files if no imports remain**

If `src/process/*` has no live imports, delete it:

```bash
git rm src/process/claude-cli.ts src/process/manager.ts src/process/types.ts src/process/__tests__/claude-cli.test.ts
```

Expected: files staged for deletion. If a live import remains, update that import to `src/engines/*` first, then rerun the `rg` command.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run build
```

Expected: PASS for all tests and TypeScript build.

- [ ] **Step 4: Smoke-check generated CLI help**

Run:

```bash
npm run build
node dist/index.js --help | sed -n '1,40p'
```

Expected output contains:

```text
Usage: opencodex
Gateway bridging chat platforms to Codex CLI
```

- [ ] **Step 5: Commit cleanup**

Run:

```bash
git add src package.json package-lock.json config.example.yaml README.md README_zh.md
git commit -m "refactor: remove obsolete Claude process layer"
```

---

### Task 10: Final Review Pack

**Files:**
- No code files unless verification exposes an issue.

- [ ] **Step 1: Review final diff**

Run:

```bash
git log --oneline --decorate -n 12
git status --short
git diff origin/main...HEAD --stat
```

Expected: working tree clean, commits show the spec plus implementation commits.

- [ ] **Step 2: Search for accidental brand misses**

Run:

```bash
rg -n "OpenClaude|openclaude|\\.openclaude|Claude Code Gateway|Claude process" .
```

Expected: matches only in the approved design/spec/plan compatibility sections and in Claude adapter-specific code. Any user-facing accidental match should be changed to OpenCodex or engine-neutral wording.

- [ ] **Step 3: Summarize verification**

Prepare final implementation summary with:

```md
Implemented:
- Engine adapter boundary with Codex default and Claude adapter retained.
- OpenCodex package/CLI/docs/config rename.
- Neutral session fields with legacy Claude compatibility.

Verified:
- npm test
- npm run build
- node dist/index.js --help
```

Do not claim a command passed unless it was run successfully.

---

## Self-Review

- Spec coverage:
  - Codex default engine: Tasks 1, 4, 5, 6, 7.
  - Claude retained as adapter: Tasks 3, 5, 6.
  - Existing gateway behavior unchanged above engine boundary: Tasks 2, 3, 6.
  - Config compatibility: Task 1.
  - Session compatibility: Task 1.
  - Branding and docs: Tasks 7 and 8.
  - Testing and verification: Tasks 1 through 10.
- Placeholder scan:
  - The plan contains no deferred work markers or empty implementation instructions.
- Type consistency:
  - `EngineAdapter`, `EngineEvent`, `EngineRuntimeConfig`, `engineSessionId`, and `engine.type` are used consistently across tasks.
