import type { EngineEvent } from "../types.js";

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: { role: string; content: unknown };
  event?: unknown;
  content_block?: unknown;
  delta?: unknown;
  [key: string]: unknown;
}

export interface ClaudeSpawnConfig {
  binary: string;
  extraArgs: string[];
  engineSessionId?: string;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  [key: string]: unknown;
}

export function parseClaudeStreamEvent(line: string): ClaudeStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    return null;
  }
}

export function buildClaudeSpawnArgs(config: ClaudeSpawnConfig): { cmd: string; args: string[] } {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (config.engineSessionId) {
    args.push("--resume", config.engineSessionId);
  }
  args.push(...config.extraArgs);
  return { cmd: config.binary, args };
}

export function mapClaudeEvent(event: ClaudeStreamEvent): EngineEvent[] {
  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    return [{ type: "session_started", sessionId: event.session_id }];
  }

  if (event.type === "result") {
    return [{
      type: "result",
      result: event.result,
      isError: event.is_error,
    }];
  }

  if (isThinkingContentBlockStart(event)) {
    return [{ type: "thinking_started" }];
  }

  if (event.type === "assistant" && event.message?.role === "assistant") {
    return mapAssistantContent(event.message.content);
  }

  return [];
}

function mapAssistantContent(content: unknown): EngineEvent[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) return [];

  const events: EngineEvent[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const block = item as ClaudeContentBlock;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      events.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      events.push({ type: "thinking_started" });
    } else if (block.type === "tool_use") {
      events.push({
        type: "tool_started",
        name: typeof block.name === "string" ? block.name : "tool",
        detail: buildToolDetail(block),
      });
    }
  }
  return events;
}

function isThinkingContentBlockStart(event: ClaudeStreamEvent): boolean {
  if (event.type !== "content_block_start") return false;
  const block = event.content_block;
  return isRecord(block) && block.type === "thinking";
}

function buildToolDetail(block: ClaudeContentBlock): string | undefined {
  if (block.input !== undefined) {
    try {
      return JSON.stringify(block.input);
    } catch {
      return undefined;
    }
  }
  return typeof block.id === "string" ? block.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
