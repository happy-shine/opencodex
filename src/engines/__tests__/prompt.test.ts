import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexPrompt, buildEnginePromptParts } from "../prompt.js";

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
    expect(prompt).toContain("/api/soul");
    expect(prompt).toContain("Interactive Buttons");
    expect(prompt).toContain("parse_mode=HTML");
    expect(prompt).toContain("chat history");
  });

  it("skips SOUL.md when it cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-prompt-"));
    const agentsDir = join(root, "agents");
    mkdirSync(join(agentsDir, "bot-1", "SOUL.md"), { recursive: true });

    expect(() =>
      buildEnginePromptParts({
        agentsDir,
        botId: "bot-1",
        apiPort: 18790,
        chatId: "chat-1",
        isGroup: false,
      }),
    ).not.toThrow();
  });
});

describe("buildCodexPrompt", () => {
  it("returns user text unchanged when system parts are empty", () => {
    const userText = "Hello\n\nKeep this exact.";

    expect(buildCodexPrompt([], userText)).toBe(userText);
  });

  it("wraps non-empty system parts before the user text", () => {
    const prompt = buildCodexPrompt(["part one", "part two"], "User message");

    expect(prompt).toBe([
      "<opencodex-system>",
      "part one\n\n---\n\npart two",
      "</opencodex-system>",
      "",
      "User message",
    ].join("\n"));
  });

  it("preserves user text exactly after the wrapper", () => {
    const userText = "First line\n\n  second line with spaces  \n<tag>&value";
    const prompt = buildCodexPrompt(["system"], userText);

    expect(prompt.endsWith(`\n\n${userText}`)).toBe(true);
    expect(prompt.slice(prompt.length - userText.length)).toBe(userText);
  });
});
