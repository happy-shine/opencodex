import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { BotInstance, getBtwForkSessionId } from "../bot-instance.js";
import type { InboundMessage } from "../channels/types.js";
import { parseConfig, resolveBots } from "../config/loader.js";
import type { GatewayConfig } from "../config/types.js";
import type { EngineAdapter, EngineEvent, EngineProcess } from "../engines/types.js";
import { MessageStore } from "../sessions/message-store.js";
import type { Session } from "../sessions/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getBtwForkSessionId", () => {
  it("requires engineSessionId for Codex", () => {
    expect(getBtwForkSessionId("codex", { claudeSessionId: "legacy-claude" })).toBeUndefined();
    expect(getBtwForkSessionId("codex", { engineSessionId: "thread-1" })).toBe("thread-1");
  });

  it("allows Claude to fall back to the legacy session id", () => {
    expect(getBtwForkSessionId("claude", { claudeSessionId: "claude-1" })).toBe("claude-1");
    expect(getBtwForkSessionId("claude", { engineSessionId: "engine-1", claudeSessionId: "claude-1" })).toBe("engine-1");
  });
});

describe("BotInstance /btw", () => {
  it("does not update the active session id from side session_started events", async () => {
    const bot = createBot("codex", [
      { type: "session_started", sessionId: "side-thread" },
      { type: "text", text: "side answer" },
      { type: "result", result: "side answer" },
    ]);
    const session = resolveBotSession(bot);
    updateBotSession(bot, session.sessionId, { engineType: "codex", engineSessionId: "main-thread" });

    await callHandleBtw(bot, createMessage("/btw quick check"));

    const updated = resolveBotSession(bot);
    expect(updated.engineSessionId).toBe("main-thread");
    expect(updated.claudeSessionId).toBeUndefined();
  });

  it("sends a visible /btw error when the side turn has no terminal event", async () => {
    const { bot, sent, edited } = createBotWithMessages("codex", [
      { type: "session_started", sessionId: "side-thread" },
    ]);
    const session = resolveBotSession(bot);
    updateBotSession(bot, session.sessionId, { engineType: "codex", engineSessionId: "main-thread" });

    await callHandleBtw(bot, createMessage("/btw quick check"));

    expect([...sent, ...edited].some((text) => text.includes("btw error: No response from side session."))).toBe(true);
  });
});

function createBot(engineType: GatewayConfig["engine"]["type"], forkEvents: EngineEvent[]): BotInstance {
  return createBotWithMessages(engineType, forkEvents).bot;
}

function createBotWithMessages(engineType: GatewayConfig["engine"]["type"], forkEvents: EngineEvent[]) {
  const dataDir = createTempDir();
  const config = createConfig(engineType, dataDir);
  const adapter = new FakeEngineAdapter(engineType, forkEvents);
  const bot = new BotInstance({
    botConfig: resolveBots(config)[0],
    gatewayConfig: config,
    processManager: adapter,
    messageStore: new MessageStore(dataDir),
    dataDir,
    log: pino({ enabled: false }),
  });

  const sent: string[] = [];
  const edited: string[] = [];
  Object.assign(bot.telegram, {
    send: async ({ text }: { text: string }) => {
      sent.push(text);
      return `msg-${sent.length}`;
    },
    editMessage: async (_chatId: string, _messageId: string, text: string) => {
      edited.push(text);
    },
  });

  return { bot, sent, edited };
}

function createConfig(engineType: GatewayConfig["engine"]["type"], dataDir: string): GatewayConfig {
  return parseConfig(`
gateway:
  dataDir: "${dataDir}"
engine:
  type: "${engineType}"
auth:
  defaultPolicy: open
bots:
  - name: "bot"
    token: "123:abc"
    auth:
      dmPolicy: open
      groupPolicy: disabled
`);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencodex-bot-btw-test-"));
  tempDirs.push(dir);
  return dir;
}

function resolveBotSession(bot: BotInstance): Session {
  return (bot as unknown as { sessionManager: { resolve(chatId: string, channelType: string): Session } })
    .sessionManager
    .resolve("chat-1", "telegram");
}

function updateBotSession(bot: BotInstance, sessionId: string, patch: Partial<Session>): void {
  (bot as unknown as { sessionManager: { update(sessionId: string, patch: Partial<Session>): void } })
    .sessionManager
    .update(sessionId, patch);
}

async function callHandleBtw(bot: BotInstance, msg: InboundMessage): Promise<void> {
  await (bot as unknown as { handleBtw(msg: InboundMessage): Promise<void> }).handleBtw(msg);
}

function createMessage(text: string): InboundMessage {
  return {
    channelType: "telegram",
    chatId: "chat-1",
    senderId: "111",
    senderName: "User",
    messageId: "message-1",
    text,
    isGroup: false,
    timestamp: Math.floor(Date.now() / 1000),
    raw: {},
  };
}

class FakeEngineAdapter implements EngineAdapter {
  readonly type: GatewayConfig["engine"]["type"];

  constructor(type: GatewayConfig["engine"]["type"], private readonly forkEvents: EngineEvent[]) {
    this.type = type;
  }

  acquire(session: Session): EngineProcess {
    return {
      sessionId: session.sessionId,
      engineSessionId: session.engineSessionId,
      busy: false,
      lastActiveAt: Date.now(),
      workspaceDir: createTempDir(),
    };
  }

  async *sendMessage(): AsyncGenerator<EngineEvent> {
    yield { type: "result", result: "ok" };
  }

  async *forkAndAsk(): AsyncGenerator<EngineEvent> {
    for (const event of this.forkEvents) {
      yield event;
    }
  }

  sendControl(): boolean {
    return false;
  }

  async sendControlAndWait(): Promise<Record<string, unknown> | null> {
    return null;
  }

  async shutdown(): Promise<void> {}

  updateConfig(): void {}

  getRunningCount(): number {
    return 0;
  }

  getWorkspaceDir(): string | undefined {
    return undefined;
  }

  hasProcess(): boolean {
    return false;
  }

  isBusy(): boolean {
    return false;
  }
}
