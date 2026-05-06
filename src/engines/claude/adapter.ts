import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import type { Session } from "../../sessions/types.js";
import { buildEnginePromptParts } from "../prompt.js";
import type { BotIdentity, EngineAdapter, EngineEvent, EngineProcess, EngineRuntimeConfig } from "../types.js";
import {
  buildClaudeSpawnArgs,
  mapClaudeEvent,
  parseClaudeStreamEvent,
  type ClaudeSpawnConfig,
  type ClaudeStreamEvent,
} from "./parser.js";

type ClaudeEngineProcess = EngineProcess & { process: ChildProcess };

export class ClaudeEngineAdapter implements EngineAdapter {
  readonly type = "claude" as const;

  private processes = new Map<string, ClaudeEngineProcess>();
  private config: EngineRuntimeConfig;
  private log: Logger;

  constructor(config: EngineRuntimeConfig, log: Logger) {
    this.config = config;
    this.log = log.child({ module: "claude-engine-adapter" });
  }

  acquire(session: Session, botId: string, botExtraArgs?: string[], identity?: BotIdentity): EngineProcess {
    const existing = this.processes.get(session.sessionId);
    if (existing && !existing.process.killed) {
      this.resetIdleTimer(session.sessionId);
      return existing;
    }

    if (this.processes.size >= this.config.maxProcesses) {
      this.evictOldest();
    }

    const sessionDir = this.getSessionDir(session, botId);
    mkdirSync(sessionDir, { recursive: true });

    const promptParts = buildEnginePromptParts({
      agentsDir: this.config.agentsDir,
      botId,
      apiPort: this.config.apiPort,
      chatId: session.chatId,
      isGroup: session.isGroup ?? false,
      identity,
    });
    const baseArgs = botExtraArgs ?? this.config.extraArgs;
    const extraArgs = [
      ...baseArgs,
      "--append-system-prompt",
      promptParts.join("\n\n---\n\n"),
    ];
    const engineSessionId = session.engineSessionId ?? session.claudeSessionId;
    const proc = spawnClaude({
      binary: this.config.binary,
      extraArgs,
      engineSessionId,
    }, sessionDir);

    const cp: ClaudeEngineProcess = {
      sessionId: session.sessionId,
      engineSessionId,
      process: proc,
      busy: false,
      lastActiveAt: Date.now(),
      workspaceDir: sessionDir,
    };

    proc.on("exit", (code) => {
      this.log.info({ sessionId: session.sessionId, code, pid: proc.pid }, "Claude process exited");
      const current = this.processes.get(session.sessionId);
      if (current && current.process === proc) {
        this.processes.delete(session.sessionId);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log.warn({ sessionId: session.sessionId }, `claude stderr: ${text}`);
    });

    this.processes.set(session.sessionId, cp);
    this.scheduleIdle(session.sessionId);
    this.log.info({ sessionId: session.sessionId, pid: proc.pid }, "Spawned Claude process");
    return cp;
  }

  async *sendMessage(session: Session, text: string, botId: string, botExtraArgs?: string[], identity?: BotIdentity): AsyncGenerator<EngineEvent> {
    let cp = this.acquire(session, botId, botExtraArgs, identity) as ClaudeEngineProcess;
    cp.busy = true;
    cp.lastActiveAt = Date.now();
    this.clearIdleTimer(session.sessionId);

    sendUserMessage(cp.process, text);

    try {
      let gotEvents = false;
      for await (const event of readUntilResult(cp.process)) {
        gotEvents = true;
        yield* mapClaudeEvent(event);
      }

      const resumeSessionId = session.engineSessionId ?? session.claudeSessionId;
      if (!gotEvents && resumeSessionId) {
        this.log.warn({ sessionId: session.sessionId }, "Resume failed, retrying as new session");
        session.engineSessionId = undefined;
        session.claudeSessionId = undefined;
        this.processes.delete(session.sessionId);

        cp = this.acquire(session, botId, botExtraArgs, identity) as ClaudeEngineProcess;
        cp.busy = true;
        this.clearIdleTimer(session.sessionId);
        sendUserMessage(cp.process, text);

        for await (const event of readUntilResult(cp.process)) {
          yield* mapClaudeEvent(event);
        }
      }
    } finally {
      cp.busy = false;
      cp.lastActiveAt = Date.now();
      this.scheduleIdle(session.sessionId);
    }
  }

  async *forkAndAsk(session: Session, question: string, botId: string, botExtraArgs?: string[]): AsyncGenerator<EngineEvent> {
    const resumeSessionId = session.engineSessionId ?? session.claudeSessionId;
    if (!resumeSessionId) return;

    const cwd = this.getSessionDir(session, botId);
    mkdirSync(cwd, { recursive: true });
    const baseArgs = botExtraArgs ?? this.config.extraArgs;

    const args = [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--resume",
      resumeSessionId,
      "--fork-session",
      "--permission-mode",
      "bypassPermissions",
      ...baseArgs,
      question,
    ];

    this.log.info(
      { sessionId: session.sessionId, engineSessionId: resumeSessionId },
      "Forking Claude session for /btw side question",
    );

    const proc = spawn(this.config.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: { ...process.env },
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log.warn("btw stderr: " + text);
    });

    for await (const event of readUntilResult(proc)) {
      yield* mapClaudeEvent(event);
    }
  }

  sendControl(sessionId: string, request: Record<string, unknown>): boolean {
    const cp = this.processes.get(sessionId);
    if (!cp || cp.process.killed) return false;
    sendControlRequest(cp.process, request);
    return true;
  }

  async sendControlAndWait(sessionId: string, request: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown> | null> {
    const cp = this.processes.get(sessionId);
    if (!cp || cp.process.killed) return null;

    const requestId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg = JSON.stringify({ type: "control_request", request_id: requestId, request });
    cp.process.stdin!.write(msg + "\n");

    return new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);

      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const parsed = parseClaudeStreamEvent(line);
          if (parsed?.type === "control_response" && isRecord(parsed.response)) {
            if (parsed.response.request_id === requestId) {
              cleanup();
              resolve(parsed.response);
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        cp.process.stdout?.off("data", onData);
      };

      cp.process.stdout?.on("data", onData);
    });
  }

  async shutdown(): Promise<void> {
    this.log.info("Shutting down all Claude processes");
    for (const id of [...this.processes.keys()]) {
      this.kill(id);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }

  updateConfig(config: Partial<EngineRuntimeConfig>): void {
    this.config = { ...this.config, ...config };
    this.log.info({ keys: Object.keys(config) }, "Claude engine config updated (applies to new processes)");
  }

  getRunningCount(): number {
    return this.processes.size;
  }

  getWorkspaceDir(sessionId: string): string | undefined {
    return this.processes.get(sessionId)?.workspaceDir;
  }

  hasProcess(sessionId: string): boolean {
    const cp = this.processes.get(sessionId);
    return !!cp && !cp.process.killed;
  }

  isBusy(sessionId: string): boolean {
    return this.processes.get(sessionId)?.busy ?? false;
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
        this.log.info({ sessionId }, "Idle timeout, killing Claude process");
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
    cp.process.kill("SIGTERM");
    setTimeout(() => {
      if (!cp.process.killed) cp.process.kill("SIGKILL");
    }, 5000);
    this.processes.delete(sessionId);
  }

  private evictOldest(): void {
    let oldest: ClaudeEngineProcess | null = null;
    for (const cp of this.processes.values()) {
      if (cp.busy) continue;
      if (!oldest || cp.lastActiveAt < oldest.lastActiveAt) oldest = cp;
    }
    if (oldest) {
      this.log.info({ sessionId: oldest.sessionId }, "Evicting oldest idle Claude process");
      this.kill(oldest.sessionId);
    }
  }
}

function spawnClaude(config: ClaudeSpawnConfig, cwd: string): ChildProcess {
  const { cmd, args } = buildClaudeSpawnArgs(config);
  return spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env },
  });
}

function sendUserMessage(proc: ChildProcess, text: string): void {
  const msg = JSON.stringify({ type: "user", message: { role: "user", content: text } });
  proc.stdin!.write(msg + "\n");
}

function sendControlRequest(proc: ChildProcess, request: Record<string, unknown>): void {
  const msg = JSON.stringify({
    type: "control_request",
    request_id: `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    request,
  });
  proc.stdin!.write(msg + "\n");
}

async function* readUntilResult(proc: ChildProcess): AsyncGenerator<ClaudeStreamEvent> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
