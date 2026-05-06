import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getTelegramFileSkill } from "../skills/telegram-file.js";
import { getSoulEditorSkill } from "../skills/soul-editor.js";
import { getButtonSkill } from "../skills/telegram-buttons.js";
import { getChatHistorySkill } from "../skills/chat-history.js";
import { getTelegramFormatSkill } from "../skills/telegram-format.js";

export interface EnginePromptPartsInput {
  agentsDir: string;
  botId: string;
  apiPort: number;
  chatId: string;
  isGroup: boolean;
}

export function buildEnginePromptParts(input: EnginePromptPartsInput): string[] {
  const parts: string[] = [];
  const soulPath = join(input.agentsDir, input.botId, "SOUL.md");

  try {
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, "utf-8").trim();
      if (soul) parts.push(soul);
    }
  } catch {
    // Skip SOUL.md if it is missing, unreadable, or not a regular file.
  }

  parts.push(getTelegramFileSkill(input.apiPort, input.chatId, input.botId, input.isGroup));
  parts.push(getSoulEditorSkill(input.apiPort, input.botId));
  parts.push(getButtonSkill());
  parts.push(getTelegramFormatSkill());
  if (input.isGroup) {
    parts.push(getChatHistorySkill(input.apiPort, input.chatId));
  }

  return parts;
}

export function buildCodexPrompt(systemParts: string[], userText: string): string {
  if (systemParts.length === 0) return userText;
  return [
    "<opencodex-system>",
    systemParts.join("\n\n---\n\n"),
    "</opencodex-system>",
    "",
    userText,
  ].join("\n");
}
