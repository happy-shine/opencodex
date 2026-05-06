import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import type { Session } from "../../sessions/types.js";
import { buildCodexPrompt, buildEnginePromptParts } from "../prompt.js";
import type { EngineAdapter, EngineEvent, EngineProcess, EngineRuntimeConfig } from "../types.js";
import {
  buildCodexSpawnArgs,
  mapCodexEvent,
  parseCodexJsonLine,
  type CodexJsonEvent,
} from "./parser.js";

type CodexEngineProcess = EngineProcess & { process?: ChildProcess };

export class CodexEngineAdapter implements EngineAdapter {
  readonly type = "codex" as const;

  private processes = new Map<string, CodexEngineProcess>();
  private config: EngineRuntimeConfig;
  private log: Logger;

  constructor(config: EngineRuntimeConfig, log: Logger) {
    this.config = config;
    this.log = log.child({ module: "codex-engine-adapter" });
  }

  acquire(session: Session, botId: string): EngineProcess {
    const existing = this.processes.get(session.sessionId);
    if (existing) {
      this.resetIdleTimer(session.sessionId);
      return existing;
    }

    if (this.processes.size >= this.config.maxProcesses) {
      this.evictOldest();
    }

    const sessionDir = this.getSessionDir(session, botId);
    mkdirSync(sessionDir, { recursive: true });

    const cp: CodexEngineProcess = {
      sessionId: session.sessionId,
      engineSessionId: session.engineSessionId,
      busy: false,
      lastActiveAt: Date.now(),
      workspaceDir: sessionDir,
    };

    this.processes.set(session.sessionId, cp);
    this.scheduleIdle(session.sessionId);
    return cp;
  }

  async *sendMessage(session: Session, text: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent> {
    const cp = this.acquire(session, botId) as CodexEngineProcess;
    cp.busy = true;
    cp.lastActiveAt = Date.now();
    this.clearIdleTimer(session.sessionId);

    const prompt = this.buildPrompt(session, text, botId);
    const proc = this.spawnCodex({
      prompt,
      cwd: cp.workspaceDir,
      engineSessionId: session.engineSessionId,
      extraArgs: this.getExtraArgs(botExtraArgs),
    });
    cp.process = proc;

    try {
      for await (const event of readCodexEvents(proc)) {
        const mappedEvents = mapCodexEvent(event);
        for (const mappedEvent of mappedEvents) {
          if (mappedEvent.type === "session_started") {
            cp.engineSessionId = mappedEvent.sessionId;
            session.engineSessionId = mappedEvent.sessionId;
          }
          yield mappedEvent;
        }
      }
    } finally {
      cp.busy = false;
      cp.lastActiveAt = Date.now();
      cp.process = undefined;
      this.scheduleIdle(session.sessionId);
    }
  }

  async *forkAndAsk(session: Session, question: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent> {
    if (!session.engineSessionId) return;

    const cwd = this.getSessionDir(session, botId);
    mkdirSync(cwd, { recursive: true });

    this.log.info(
      { sessionId: session.sessionId, engineSessionId: session.engineSessionId },
      "Forking Codex session for /btw side question",
    );

    const proc = this.spawnCodex({
      prompt: question,
      cwd,
      engineSessionId: session.engineSessionId,
      extraArgs: this.getExtraArgs(botExtraArgs),
      ephemeral: true,
    });

    for await (const event of readCodexEvents(proc)) {
      yield* mapCodexEvent(event);
    }
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
    this.log.info("Shutting down all Codex processes");
    for (const id of [...this.processes.keys()]) {
      this.kill(id);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }

  updateConfig(config: Partial<EngineRuntimeConfig>): void {
    this.config = { ...this.config, ...config };
    this.log.info({ keys: Object.keys(config) }, "Codex engine config updated (applies to new turns)");
  }

  getRunningCount(): number {
    let count = 0;
    for (const cp of this.processes.values()) {
      if (cp.process && !cp.process.killed) count += 1;
    }
    return count;
  }

  getWorkspaceDir(sessionId: string): string | undefined {
    return this.processes.get(sessionId)?.workspaceDir;
  }

  hasProcess(sessionId: string): boolean {
    const cp = this.processes.get(sessionId);
    return !!cp?.process && !cp.process.killed;
  }

  isBusy(sessionId: string): boolean {
    return this.processes.get(sessionId)?.busy ?? false;
  }

  private buildPrompt(session: Session, text: string, botId: string): string {
    const promptParts = buildEnginePromptParts({
      agentsDir: this.config.agentsDir,
      botId,
      apiPort: this.config.apiPort,
      chatId: session.chatId,
      isGroup: session.isGroup ?? false,
    });
    return buildCodexPrompt(promptParts, text);
  }

  private spawnCodex(input: {
    prompt: string;
    cwd: string;
    engineSessionId?: string;
    extraArgs: string[];
    ephemeral?: boolean;
  }): ChildProcess {
    const { cmd, args } = buildCodexSpawnArgs({
      binary: this.config.binary,
      prompt: input.prompt,
      engineSessionId: input.engineSessionId,
      extraArgs: input.extraArgs,
      sandbox: this.config.codex?.sandbox ?? "danger-full-access",
      approvalPolicy: this.config.codex?.approvalPolicy ?? "never",
      ephemeral: input.ephemeral,
    });

    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: input.cwd,
      env: { ...process.env },
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log.warn(`codex stderr: ${text}`);
    });

    proc.on("error", (err) => {
      this.log.error({ error: err instanceof Error ? err.message : String(err) }, "Codex process error");
    });

    return proc;
  }

  private getExtraArgs(botExtraArgs?: string[]): string[] {
    const extraArgs = [...(botExtraArgs ?? this.config.extraArgs)];
    if (this.config.model && !hasModelArg(extraArgs)) {
      extraArgs.push("--model", this.config.model);
    }
    return extraArgs;
  }

  private getSessionDir(session: Session, botId: string): string {
    const safeChatId = session.chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.config.workspaceDir, botId, `${safeChatId}_${session.sessionId}`);
  }

  private scheduleIdle(sessionId: string): void {
    const cp = this.processes.get(sessionId);
    if (!cp) return;
    this.clearIdleTimer(sessionId);
    cp.idleTimer = setTimeout(() => {
      if (!cp.busy) {
        this.log.info({ sessionId }, "Idle timeout, removing Codex session metadata");
        this.kill(sessionId);
      }
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(sessionId: string): void {
    const cp = this.processes.get(sessionId);
    if (cp?.idleTimer) {
      clearTimeout(cp.idleTimer);
      cp.idleTimer = undefined;
    }
  }

  private resetIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId);
    this.scheduleIdle(sessionId);
  }

  private kill(sessionId: string): void {
    const cp = this.processes.get(sessionId);
    if (!cp) return;
    this.clearIdleTimer(sessionId);
    if (cp.process && !cp.process.killed) {
      cp.process.kill("SIGTERM");
      setTimeout(() => {
        if (cp.process && !cp.process.killed) cp.process.kill("SIGKILL");
      }, 5000);
    }
    this.processes.delete(sessionId);
  }

  private evictOldest(): void {
    let oldest: CodexEngineProcess | null = null;
    for (const cp of this.processes.values()) {
      if (cp.busy) continue;
      if (!oldest || cp.lastActiveAt < oldest.lastActiveAt) oldest = cp;
    }
    if (oldest) {
      this.log.info({ sessionId: oldest.sessionId }, "Evicting oldest idle Codex metadata");
      this.kill(oldest.sessionId);
    }
  }
}

async function* readCodexEvents(proc: ChildProcess): AsyncGenerator<CodexJsonEvent> {
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

function hasModelArg(args: string[]): boolean {
  return args.some((arg, index) => (
    arg === "--model"
    || arg === "-m"
    || arg.startsWith("--model=")
    || (index > 0 && args[index - 1] === "--model")
  ));
}
