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
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
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
      "exec",
      "resume",
      "thread-123",
      "--json",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4",
      "again",
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
});
