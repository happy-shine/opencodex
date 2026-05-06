import type { EngineEvent } from "../types.js";

const MAX_DETAIL_LENGTH = 500;

export interface CodexSpawnConfig {
  binary: string;
  prompt: string;
  engineSessionId?: string;
  extraArgs: string[];
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-request" | "never";
  ephemeral?: boolean;
}

export interface CodexJsonEvent {
  type?: string;
  [key: string]: unknown;
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  input?: unknown;
  output?: unknown;
  query?: string;
  path?: string;
  action?: string;
  summary?: string;
  content?: unknown;
  [key: string]: unknown;
}

export function buildCodexSpawnArgs(config: CodexSpawnConfig): { cmd: string; args: string[] } {
  const args = ["exec"];
  if (config.engineSessionId) {
    args.push("resume", config.engineSessionId);
  }

  args.push(
    "--json",
    "--sandbox",
    config.sandbox,
    "--ask-for-approval",
    config.approvalPolicy,
    "--skip-git-repo-check",
  );

  if (config.ephemeral) {
    args.push("--ephemeral");
  }

  args.push(...config.extraArgs, config.prompt);
  return { cmd: config.binary, args };
}

export function parseCodexJsonLine(line: string): CodexJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CodexJsonEvent;
  } catch {
    return null;
  }
}

export function mapCodexEvent(event: CodexJsonEvent): EngineEvent[] {
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    return [{ type: "session_started", sessionId: event.thread_id }];
  }

  if (event.type === "item.started") {
    return mapCodexTool(asCodexItem(event.item));
  }

  if (event.type === "item.completed") {
    const item = asCodexItem(event.item);
    if (item?.type === "agent_message") {
      const text = extractText(item);
      return text ? [{ type: "text", text }] : [];
    }
    return [];
  }

  if (event.type === "turn.completed") {
    return [{ type: "result", result: extractResult(event), isError: false }];
  }

  if (event.type === "turn.failed") {
    const message = extractErrorMessage(event);
    return [
      { type: "error", message },
      { type: "result", result: message, isError: true },
    ];
  }

  if (event.type === "error") {
    return [{ type: "error", message: extractErrorMessage(event) }];
  }

  return [];
}

export function mapCodexTool(item: CodexItem | null): EngineEvent[] {
  if (!item?.type) return [];

  if (item.type === "reasoning") {
    return [{ type: "thinking_started" }];
  }

  if (item.type === "command_execution") {
    return [{
      type: "tool_started",
      name: "Bash",
      detail: detailFromValue(item.command ?? item.input ?? item.arguments),
    }];
  }

  if (item.type === "mcp_tool_call") {
    return [{
      type: "tool_started",
      name: item.name ?? "MCP Tool",
      detail: detailFromValue(item.arguments ?? item.input ?? item.id),
    }];
  }

  if (item.type === "web_search") {
    return [{
      type: "tool_started",
      name: "Web Search",
      detail: detailFromValue(item.query ?? item.input ?? item.arguments),
    }];
  }

  if (item.type === "file_change") {
    return [{
      type: "tool_started",
      name: "File Change",
      detail: detailFromValue(item.path ?? item.action ?? item.input ?? item.arguments),
    }];
  }

  if (item.type === "collab_tool_call") {
    return [{
      type: "tool_started",
      name: item.name ?? "Collab Tool",
      detail: detailFromValue(item.arguments ?? item.input ?? item.id),
    }];
  }

  return [];
}

function asCodexItem(value: unknown): CodexItem | null {
  return isRecord(value) ? value : null;
}

function extractText(item: CodexItem): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;

  if (Array.isArray(item.content)) {
    const text = item.content
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isRecord(entry) && typeof entry.text === "string") return entry.text;
        return "";
      })
      .filter(Boolean)
      .join("");
    return text || undefined;
  }

  return undefined;
}

function extractResult(event: CodexJsonEvent): string | undefined {
  if (typeof event.result === "string") return event.result;
  if (typeof event.output === "string") return event.output;
  if (typeof event.message === "string") return event.message;
  return undefined;
}

function extractErrorMessage(event: CodexJsonEvent): string {
  if (typeof event.message === "string") return event.message;
  if (typeof event.error === "string") return event.error;
  if (isRecord(event.error) && typeof event.error.message === "string") return event.error.message;
  return "Codex turn failed";
}

function detailFromValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function truncate(value: string): string {
  if (value.length <= MAX_DETAIL_LENGTH) return value;
  return `${value.slice(0, MAX_DETAIL_LENGTH - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
