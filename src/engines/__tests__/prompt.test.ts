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
