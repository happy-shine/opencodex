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

  const runtimeConfig = buildRuntimeConfig(config, workspaceDir, agentsDir);

  if (runtimeConfig.type === "claude") {
    return new ClaudeEngineAdapter(runtimeConfig, log);
  }

  return new CodexEngineAdapter(runtimeConfig, log);
}

export function updateEngineFromConfig(adapter: EngineAdapter, config: GatewayConfig): void {
  if (adapter.type !== config.engine.type) {
    throw new Error("Engine type changes require gateway restart");
  }

  const selected = config.engine[config.engine.type];
  adapter.updateConfig({
    type: config.engine.type,
    binary: selected.binary,
    model: selected.model,
    extraArgs: selected.extraArgs,
    maxProcesses: config.engine.maxProcesses,
    idleTimeoutMs: config.engine.idleTimeoutMs,
    apiPort: config.gateway.port,
    codex: config.engine.type === "codex"
      ? {
          sandbox: config.engine.codex.sandbox,
          approvalPolicy: config.engine.codex.approvalPolicy,
        }
      : undefined,
  });
}

function buildRuntimeConfig(config: GatewayConfig, workspaceDir: string, agentsDir: string): EngineRuntimeConfig {
  const selectedType = config.engine.type;
  const selected = config.engine[selectedType];

  return {
    type: selectedType,
    binary: selected.binary,
    model: selected.model,
    extraArgs: selected.extraArgs,
    maxProcesses: config.engine.maxProcesses,
    idleTimeoutMs: config.engine.idleTimeoutMs,
    workspaceDir,
    apiPort: config.gateway.port,
    agentsDir,
    codex: selectedType === "codex"
      ? {
          sandbox: config.engine.codex.sandbox,
          approvalPolicy: config.engine.codex.approvalPolicy,
        }
      : undefined,
  };
}
