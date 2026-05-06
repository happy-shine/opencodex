import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageStore } from "../message-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MessageStore", () => {
  it("deduplicates repeated Telegram message ids in the same chat", () => {
    const store = new MessageStore(createTempDir());

    store.append("chat-1", {
      id: "message-1",
      ts: 100,
      sender: "User",
      senderId: "user-1",
      text: "hello",
    });
    store.append("chat-1", {
      id: "message-1",
      ts: 101,
      sender: "User",
      senderId: "user-1",
      text: "hello again",
    });

    expect(store.getRecent("chat-1", 10)).toEqual([
      {
        id: "message-1",
        ts: 100,
        sender: "User",
        senderId: "user-1",
        text: "hello",
      },
    ]);
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencodex-message-store-test-"));
  tempDirs.push(dir);
  return dir;
}
