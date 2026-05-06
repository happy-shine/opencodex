import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../../../sessions/types.js";
import type { EngineEvent, EngineRuntimeConfig } from "../../types.js";
import { ClaudeEngineAdapter } from "../adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ClaudeEngineAdapter", () => {
  it("does not restore stale session ids after retrying without resume", async () => {
    const script = createBinary(`
      const hasResume = process.argv.includes("--resume");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk.toString();
        if (!buffer.includes("\\n")) return;
        if (hasResume) {
          process.exit(0);
          return;
        }
        console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fresh-id" }));
        console.log(JSON.stringify({ type: "result", result: "ok", is_error: false }));
        process.exit(0);
      });
    `);
    const adapter = new ClaudeEngineAdapter(createConfig(script), pino({ enabled: false }));
    const session = createSession({ engineSessionId: "stale-engine-id", claudeSessionId: "stale-claude-id" });

    const events = await collect(adapter.sendMessage(session, "hello", "bot"));

    expect(events).toContainEqual({ type: "session_started", sessionId: "fresh-id" });
    expect(session.engineSessionId).toBeUndefined();
    expect(session.claudeSessionId).toBeUndefined();
  });

  it("waits for split control_response lines across stdout chunks", async () => {
    const script = createBinary(`
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\\n");
        if (newline === -1) return;
        const request = JSON.parse(buffer.slice(0, newline));
        const response = JSON.stringify({
          type: "control_response",
          response: { request_id: request.request_id, ok: true }
        });
        setTimeout(() => {
          process.stdout.write(response.slice(0, 20));
          setTimeout(() => {
            process.stdout.write(response.slice(20) + "\\n");
            setTimeout(() => process.exit(0), 5);
          }, 5);
        }, 20);
      });
    `);
    const adapter = new ClaudeEngineAdapter(createConfig(script), pino({ enabled: false }));
    const session = createSession();

    const processInfo = adapter.acquire(session, "bot");
    processInfo.busy = true;
    const response = await adapter.sendControlAndWait(session.sessionId, { command: "interrupt" }, 1500);

    expect(response).toMatchObject({ ok: true });
  });
});

function createBinary(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "opencodex-claude-adapter-test-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-claude.cjs");
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createConfig(binary: string): EngineRuntimeConfig {
  const workspaceDir = mkdtempSync(join(tmpdir(), "opencodex-workspace-test-"));
  const agentsDir = mkdtempSync(join(tmpdir(), "opencodex-agents-test-"));
  tempDirs.push(workspaceDir, agentsDir);
  return {
    type: "claude",
    binary,
    extraArgs: [],
    maxProcesses: 10,
    idleTimeoutMs: 250,
    workspaceDir,
    apiPort: 3000,
    agentsDir,
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

async function collect(generator: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}
