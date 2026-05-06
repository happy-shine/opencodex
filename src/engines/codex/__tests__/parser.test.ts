import { describe, expect, it } from "vitest";
import {
  buildCodexSpawnArgs,
  mapCodexEvent,
  parseCodexJsonLine,
} from "../parser.js";

describe("buildCodexSpawnArgs", () => {
  it("builds args for a new turn", () => {
    const result = buildCodexSpawnArgs({
      binary: "codex",
      prompt: "hello",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      extraArgs: [],
    });

    expect(result.cmd).toBe("codex");
    expect(result.args).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "danger-full-access",
      "exec",
      "--json",
      "--skip-git-repo-check",
      "hello",
    ]);
  });

  it("builds args for a resumed turn", () => {
    const result = buildCodexSpawnArgs({
      binary: "codex",
      prompt: "again",
      engineSessionId: "thread-123",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      extraArgs: ["--model", "gpt-5.4"],
    });

    expect(result.args).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "workspace-write",
      "exec",
      "resume",
      "thread-123",
      "--json",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4",
      "again",
    ]);
  });

  it("puts ephemeral after resume id and before extra args for a resumed turn", () => {
    const result = buildCodexSpawnArgs({
      binary: "codex",
      prompt: "continue",
      engineSessionId: "thread-456",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      ephemeral: true,
      extraArgs: ["--model", "gpt-5.4"],
    });

    expect(result.args).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "workspace-write",
      "exec",
      "resume",
      "thread-456",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--model",
      "gpt-5.4",
      "continue",
    ]);
  });
});

describe("parseCodexJsonLine", () => {
  it("parses valid JSON", () => {
    const event = parseCodexJsonLine(JSON.stringify({ type: "thread.started", thread_id: "thread-123" }));

    expect(event).toEqual({ type: "thread.started", thread_id: "thread-123" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseCodexJsonLine("not json")).toBeNull();
  });

  it("returns null for valid JSON primitives and arrays", () => {
    expect(parseCodexJsonLine("true")).toBeNull();
    expect(parseCodexJsonLine("[]")).toBeNull();
  });
});

describe("mapCodexEvent", () => {
  it("maps thread.started with thread_id to session_started", () => {
    const events = mapCodexEvent({ type: "thread.started", thread_id: "thread-123" });

    expect(events).toEqual([{ type: "session_started", sessionId: "thread-123" }]);
  });

  it("maps item.completed agent_message text to text", () => {
    const events = mapCodexEvent({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Hello from Codex",
      },
    });

    expect(events).toEqual([{ type: "text", text: "Hello from Codex" }]);
  });

  it("maps item.started command_execution to tool_started Bash with command detail", () => {
    const events = mapCodexEvent({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "npm test",
      },
    });

    expect(events).toEqual([{ type: "tool_started", name: "Bash", detail: "npm test" }]);
  });

  it("maps item.started reasoning to thinking_started", () => {
    const events = mapCodexEvent({
      type: "item.started",
      item: { type: "reasoning" },
    });

    expect(events).toEqual([{ type: "thinking_started" }]);
  });

  it("maps item.started mcp_tool_call to tool_started MCP with server.tool detail", () => {
    const events = mapCodexEvent({
      type: "item.started",
      item: {
        type: "mcp_tool_call",
        server: "github",
        tool: "search_issues",
      },
    });

    expect(events).toEqual([{ type: "tool_started", name: "MCP", detail: "github.search_issues" }]);
  });

  it("maps item.started web_search to tool_started WebSearch with query detail", () => {
    const events = mapCodexEvent({
      type: "item.started",
      item: {
        type: "web_search",
        query: "Codex CLI docs",
      },
    });

    expect(events).toEqual([{ type: "tool_started", name: "WebSearch", detail: "Codex CLI docs" }]);
  });

  it("maps item.started file_change to tool_started Edit", () => {
    const events = mapCodexEvent({
      type: "item.started",
      item: {
        type: "file_change",
        path: "src/index.ts",
      },
    });

    expect(events).toEqual([{ type: "tool_started", name: "Edit", detail: "src/index.ts" }]);
  });

  it("maps item.started collab_tool_call to tool_started Agent", () => {
    const events = mapCodexEvent({
      type: "item.started",
      item: {
        type: "collab_tool_call",
        name: "reviewer",
      },
    });

    expect(events).toEqual([{ type: "tool_started", name: "Agent", detail: "reviewer" }]);
  });

  it("maps turn.completed to result", () => {
    const events = mapCodexEvent({ type: "turn.completed", result: "done" });

    expect(events).toEqual([{ type: "result", result: "done", isError: false }]);
  });

  it("maps turn.failed to error and error result", () => {
    const events = mapCodexEvent({ type: "turn.failed", error: "boom" });

    expect(events).toEqual([
      { type: "error", message: "boom" },
      { type: "result", result: "boom", isError: true },
    ]);
  });

  it("maps top-level error to error", () => {
    const events = mapCodexEvent({ type: "error", message: "bad news" });

    expect(events).toEqual([{ type: "error", message: "bad news" }]);
  });

  it("maps unknown or ignored events to an empty list", () => {
    expect(mapCodexEvent({ type: "item.completed", item: { type: "command_execution" } })).toEqual([]);
    expect(mapCodexEvent({ type: "unexpected.event" })).toEqual([]);
  });
});
