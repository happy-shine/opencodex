import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressTracker } from "../progress.js";

describe("ProgressTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps showing elapsed progress when partial text exists before a result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T08:00:00Z"));
    const sent: string[] = [];
    const edited: string[] = [];
    const telegram = {
      send: async ({ text }: { text: string }) => {
        sent.push(text);
        return "progress-1";
      },
      editMessage: async (_chatId: string, _messageId: string, text: string) => {
        edited.push(text);
      },
      sendTyping: async () => {},
    };
    const progress = new ProgressTracker(telegram as any, "chat-1", "reply-1");

    progress.appendText("partial response while image generation continues");
    await progress.flush();
    vi.advanceTimersByTime(4_000);
    await progress.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("partial response while image generation continues");
    expect(edited).toHaveLength(1);
    expect(edited[0]).toContain("(4s)");
  });
});
