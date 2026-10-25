import { describe, expect, it } from "vitest";
import {
  createReplyRegistry,
  ReplyStopped,
} from "@parley/server-kit/chat/replies";

describe("createReplyRegistry", () => {
  it("shows a reply as it's written, until it ends", () => {
    const replies = createReplyRegistry();
    const reply = replies.start("a", "Hi");
    reply.append("Hel");
    reply.append("lo");

    expect(replies.find("a")).toEqual({
      content: "Hi",
      assistantContent: "Hello",
    });
    reply.end();
    expect(replies.find("a")).toBeNull();
  });

  it("aborts a stopped reply's signal", () => {
    const replies = createReplyRegistry();
    const reply = replies.start("a", "Hi");

    expect(replies.stop("a")).toBe(true);
    expect(reply.stopped).toBe(true);
    expect(reply.signal.reason).toBeInstanceOf(ReplyStopped);
  });

  it("has nothing to stop under a key with no reply", () => {
    const replies = createReplyRegistry();
    replies.start("a", "Hi").end();

    expect(replies.stop("a")).toBe(false);
    expect(replies.stop("b")).toBe(false);
  });

  it("leaves a newer reply under the same key when an older one ends", () => {
    const replies = createReplyRegistry();
    const older = replies.start("a", "first");
    replies.start("a", "second");
    older.end();

    expect(replies.find("a")?.content).toBe("second");
  });
});
