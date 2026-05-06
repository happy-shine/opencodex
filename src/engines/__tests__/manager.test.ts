import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../../config/types.js";
import { ClaudeEngineAdapter } from "../claude/adapter.js";
import { CodexEngineAdapter } from "../codex/adapter.js";
import { createEngineManager, updateEngineFromConfig } from "../manager.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createEngineManager", () => {
  it("creates Codex engine by default", () => {
    const dataDir = createTempDir();
    const adapter = createEngineManager(createConfig(), dataDir, pino({ enabled: false }));

    expect(adapter).toBeInstanceOf(CodexEngineAdapter);
    expect(adapter.type).toBe("codex");
    expect(existsSync(join(dataDir, "workspace"))).toBe(true);
    expect(existsSync(join(dataDir, "agents"))).toBe(true);
  });

  it("creates Claude engine when configured", () => {
    const dataDir = createTempDir();
    const adapter = createEngineManager(createConfig({ type: "claude" }), dataDir, pino({ enabled: false }));

    expect(adapter).toBeInstanceOf(ClaudeEngineAdapter);
    expect(adapter.type).toBe("claude");
  });
});

describe("updateEngineFromConfig", () => {
  it("throws when the configured engine type differs from the adapter type", () => {
    const dataDir = createTempDir();
    const adapter = createEngineManager(createConfig(), dataDir, pino({ enabled: false }));

    expect(() => updateEngineFromConfig(adapter, createConfig({ type: "claude" }))).toThrow(
      "Engine type changes require gateway restart",
    );
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencodex-engine-manager-test-"));
  tempDirs.push(dir);
  return dir;
}

function createConfig(overrides: Partial<GatewayConfig["engine"]> = {}): GatewayConfig {
  return {
    gateway: {
      port: 18790,
      dataDir: "~/.opencodex",
      logLevel: "info",
      logFormat: "json",
    },
    engine: {
      type: "codex",
      maxProcesses: 10,
      idleTimeoutMs: 600000,
      codex: {
        binary: "codex",
        model: "gpt-5",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        extraArgs: ["--codex-extra"],
      },
      claude: {
        binary: "claude",
        model: "sonnet",
        extraArgs: ["--claude-extra"],
      },
      ...overrides,
    },
    claude: {
      binary: "claude",
      idleTimeoutMs: 600000,
      maxProcesses: 10,
      extraArgs: [],
    },
    auth: {
      defaultPolicy: "pairing",
    },
    bots: [
      {
        name: "bot",
        token: "123:abc",
      },
    ],
  };
}
