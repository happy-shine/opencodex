import { describe, expect, it } from "vitest";
import {
  buildClaudeSpawnArgs,
  mapClaudeEvent,
  parseClaudeStreamEvent,
} from "../parser.js";

describe("parseClaudeStreamEvent", () => {
  it("parses system init event", () => {
    const event = parseClaudeStreamEvent(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "abc-123",
        model: "claude-sonnet-4-6",
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.type).toBe("system");
    expect(event?.session_id).toBe("abc-123");
  });

  it("returns null for invalid JSON", () => {
    expect(parseClaudeStreamEvent("not json")).toBeNull();
  });
});

describe("buildClaudeSpawnArgs", () => {
  it("builds args for new session", () => {
    const result = buildClaudeSpawnArgs({ binary: "claude", extraArgs: [] });

    expect(result.cmd).toBe("claude");
    expect(result.args).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("builds args for resumed session", () => {
    const result = buildClaudeSpawnArgs({
      binary: "claude",
      extraArgs: ["--model", "opus"],
      engineSessionId: "sess-123",
    });

    expect(result.args).toContain("--resume");
    expect(result.args).toContain("sess-123");
    expect(result.args).not.toContain("--session-id");
    expect(result.args.slice(-2)).toEqual(["--model", "opus"]);
  });
});

describe("mapClaudeEvent", () => {
  it("maps assistant text to EngineEvent text", () => {
    const events = mapClaudeEvent({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    });

    expect(events).toEqual([{ type: "text", text: "Hello!" }]);
  });

  it("maps result to EngineEvent result", () => {
    const events = mapClaudeEvent({
      type: "result",
      subtype: "success",
      result: "Done",
      is_error: false,
    });

    expect(events).toEqual([{ type: "result", result: "Done", isError: false }]);
  });
});
