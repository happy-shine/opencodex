import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../../../sessions/types.js";
import type { EngineEvent, EngineRuntimeConfig } from "../../types.js";
import { CodexEngineAdapter } from "../adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CodexEngineAdapter", () => {
  it("yields terminal error events when the subprocess exits non-zero without JSON", async () => {
    const script = createBinary(`
      process.stderr.write("fatal cli error\\n");
      process.exit(7);
    `);
    const adapter = new CodexEngineAdapter(createConfig({ binary: script }), pino({ enabled: false }));

    const events = await collect(adapter.sendMessage(createSession(), "hello", "bot"));

    expect(events).toEqual([
      { type: "error", message: expect.stringContaining("exited with code 7") },
      { type: "result", result: expect.stringContaining("exited with code 7"), isError: true },
    ]);
  });

  it("terminates the subprocess when the consumer closes the generator early", async () => {
    const marker = join(createTempDir(), "terminated.txt");
    const script = createBinary(`
      const fs = require("node:fs");
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
      console.log(JSON.stringify({ type: "turn.completed", result: "done" }));
      process.on("SIGTERM", () => {
        fs.writeFileSync(${JSON.stringify(marker)}, "terminated");
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 1000);
      setInterval(() => {}, 100);
    `);
    const adapter = new CodexEngineAdapter(createConfig({ binary: script }), pino({ enabled: false }));

    for await (const event of adapter.sendMessage(createSession(), "hello", "bot")) {
      if (event.type === "result") break;
    }

    expect(existsSync(marker)).toBe(true);
  });

  it("yields terminal error events when all process slots are busy", async () => {
    const script = createBinary(`
      console.log(JSON.stringify({ type: "turn.completed", result: "ok" }));
      process.exit(0);
    `);
    const adapter = new CodexEngineAdapter(createConfig({ binary: script, maxProcesses: 1 }), pino({ enabled: false }));
    const busySession = createSession({ sessionId: "busy-session" });
    const processInfo = adapter.acquire(busySession, "bot");
    processInfo.busy = true;

    const events = await collect(adapter.sendMessage(createSession({ sessionId: "next-session" }), "hello", "bot"));

    expect(events).toEqual([
      { type: "error", message: "No available Codex process slots" },
      { type: "result", result: "No available Codex process slots", isError: true },
    ]);
  });
});

function createBinary(source: string): string {
  const dir = createTempDir();
  const scriptPath = join(dir, "fake-codex.cjs");
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createConfig(overrides: Partial<EngineRuntimeConfig> = {}): EngineRuntimeConfig {
  const workspaceDir = createTempDir();
  const agentsDir = createTempDir();
  return {
    type: "codex",
    binary: "codex",
    extraArgs: [],
    maxProcesses: 10,
    idleTimeoutMs: 250,
    workspaceDir,
    apiPort: 3000,
    agentsDir,
    codex: {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    },
    ...overrides,
  };
}

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "session-1",
    chatId: "chat-1",
    channelType: "telegram",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    isActive: true,
    sessionNum: 1,
    ...overrides,
  };
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencodex-codex-adapter-test-"));
  tempDirs.push(dir);
  return dir;
}

async function collect(generator: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}
