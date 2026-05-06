import { describe, it, expect } from "vitest";
import { parseConfig } from "../config/loader.js";
import { SessionManager } from "../sessions/manager.js";
import { checkAccess } from "../auth/access.js";
import { PairingManager } from "../auth/pairing.js";
import { buildCodexSpawnArgs, parseCodexJsonLine } from "../engines/codex/parser.js";
import { splitMessage } from "../channels/telegram/formatter.js";

describe("Integration: full message flow (mocked)", () => {
  const configYaml = `
channels:
  telegram:
    botToken: "test-token"
    dmPolicy: pairing
    groupPolicy: disabled
    allowFrom: ["111"]
`;

  it("processes a message from allowed user through the full pipeline", () => {
    const config = parseConfig(configYaml);
    expect(config.channels!.telegram!.botToken).toBe("test-token");

    const access = checkAccess({
      senderId: "111", chatId: "111", isGroup: false,
      dmPolicy: config.channels!.telegram!.dmPolicy,
      groupPolicy: config.channels!.telegram!.groupPolicy,
      allowFrom: config.channels!.telegram!.allowFrom,
      groups: config.channels!.telegram!.groups,
    });
    expect(access.allowed).toBe(true);

    const sm = new SessionManager();
    const session = sm.resolve("111", "telegram");
    expect(session.isActive).toBe(true);

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

    const resumeArgs = buildCodexSpawnArgs({
      binary: "codex",
      extraArgs: [],
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      engineSessionId: "thread-abc",
      prompt: "hello again",
    });
    expect(resumeArgs.args).toContain("resume");
    expect(resumeArgs.args).toContain("thread-abc");
  });

  it("blocks unknown user and triggers pairing", () => {
    const config = parseConfig(configYaml);
    const access = checkAccess({
      senderId: "999", chatId: "999", isGroup: false,
      dmPolicy: config.channels!.telegram!.dmPolicy,
      groupPolicy: config.channels!.telegram!.groupPolicy,
      allowFrom: config.channels!.telegram!.allowFrom,
      groups: config.channels!.telegram!.groups,
    });
    expect(access.allowed).toBe(false);
    expect(access.reason).toBe("needs_pairing");

    const pm = new PairingManager();
    const req = pm.challenge("999", "Stranger", "telegram", "999");
    expect(req.code).toHaveLength(8);

    const result = pm.approve(req.code);
    expect(result!.senderId).toBe("999");
  });

  it("handles session lifecycle: new, switch, list", () => {
    const sm = new SessionManager();
    const s1 = sm.resolve("chat1", "telegram");
    sm.update(s1.sessionId, { title: "First chat" });
    const s2 = sm.createNew("chat1");
    sm.update(s2.sessionId, { title: "Second chat" });
    const all = sm.list("chat1");
    expect(all).toHaveLength(2);
    expect(all[0].title).toBe("First chat");
    expect(all[1].title).toBe("Second chat");
    const switched = sm.switchTo("chat1", 1);
    expect(switched!.title).toBe("First chat");
    expect(switched!.isActive).toBe(true);
  });

  it("splits long messages for Telegram", () => {
    const longText = "a".repeat(5000);
    const chunks = splitMessage(longText);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(4096);
    expect(chunks.join("").length).toBe(5000);
  });
});
