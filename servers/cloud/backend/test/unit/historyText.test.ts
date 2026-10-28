import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  historyText,
  resetHistoryTextCache,
} from "../../src/memory/historyText";
import type { HistoryCandidate } from "../../src/data/index";

function turn(
  id: string,
  content: string,
  transcripts: HistoryCandidate["transcripts"] = [],
): HistoryCandidate {
  return {
    id,
    role: "user",
    content,
    createdAt: new Date(),
    transcripts,
    images: [],
  };
}

const savedTurn = {
  userMessageId: "message-3",
  content: "Follow-up",
  transcripts: [{ audioUploadId: "audio-3", content: "New transcript" }],
  assistantMessageId: "message-4",
  assistantContent: "Reply",
};

beforeEach(() => {
  resetHistoryTextCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("historyText", () => {
  it("holds nothing for a conversation's first turn", () => {
    historyText.rememberHistory("user-1", "conversation-1", []);
    historyText.rememberTurn("user-1", "conversation-1", savedTurn);

    expect(historyText.known("user-1", "conversation-1")).toBeUndefined();
  });

  it("holds what a read returned, then the turn saved after it", () => {
    historyText.rememberHistory("user-1", "conversation-1", [
      turn("message-2", "Answer"),
      turn("message-1", "Question", [
        { audioUploadId: "audio-1", content: "Transcript" },
      ]),
    ]);
    historyText.rememberTurn("user-1", "conversation-1", savedTurn);

    const known = historyText.known("user-1", "conversation-1");
    expect(Object.fromEntries(known!.messages)).toEqual({
      "message-1": "Question",
      "message-2": "Answer",
      "message-3": "Follow-up",
      "message-4": "Reply",
    });
    expect(Object.fromEntries(known!.transcripts)).toEqual({
      "audio-1": "Transcript",
      "audio-3": "New transcript",
    });
  });

  it("drops what a later read no longer returns", () => {
    historyText.rememberHistory("user-1", "conversation-1", [
      turn("message-2", "Answer"),
      turn("message-1", "Question"),
    ]);
    // An edit elsewhere deleted message-2 and wrote message-5.
    historyText.rememberHistory("user-1", "conversation-1", [
      turn("message-5", "Edited answer"),
      turn("message-1", "Question"),
    ]);

    expect([
      ...historyText.known("user-1", "conversation-1")!.messages.keys(),
    ]).toEqual(["message-5", "message-1"]);
  });

  it("hands out a copy a later store can't change", () => {
    historyText.rememberHistory("user-1", "conversation-1", [
      turn("message-1", "Question"),
    ]);
    const known = historyText.known("user-1", "conversation-1");
    historyText.rememberHistory("user-1", "conversation-1", [
      turn("message-2", "Other"),
    ]);

    expect([...known!.messages.keys()]).toEqual(["message-1"]);
  });

  it("serves and evicts only for the conversation's own user", () => {
    historyText.rememberHistory("user-1", "conversation-1", [
      turn("message-1", "Question"),
    ]);

    expect(historyText.known("user-2", "conversation-1")).toBeUndefined();
    // Not theirs, so the read finds nothing; that mustn't evict the owner's.
    historyText.rememberHistory("user-2", "conversation-1", []);
    expect(historyText.known("user-1", "conversation-1")).toBeDefined();
  });

  it("keeps a user's two most recently used conversations", () => {
    for (const conversationId of ["conversation-1", "conversation-2"]) {
      historyText.rememberHistory("user-1", conversationId, [
        turn(`${conversationId}-message`, "Text"),
      ]);
    }
    historyText.known("user-1", "conversation-1");
    historyText.rememberHistory("user-1", "conversation-3", [
      turn("conversation-3-message", "Text"),
    ]);
    historyText.rememberHistory("user-2", "conversation-4", [
      turn("conversation-4-message", "Text"),
    ]);

    expect(historyText.known("user-1", "conversation-1")).toBeDefined();
    expect(historyText.known("user-1", "conversation-2")).toBeUndefined();
    expect(historyText.known("user-1", "conversation-3")).toBeDefined();
    expect(historyText.known("user-2", "conversation-4")).toBeDefined();
  });

  it("forgets a conversation left idle for 15 minutes", () => {
    vi.useFakeTimers();
    historyText.rememberHistory("user-1", "conversation-1", [
      turn("message-1", "Question"),
    ]);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(historyText.known("user-1", "conversation-1")).toBeDefined();
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(historyText.known("user-1", "conversation-1")).toBeUndefined();
  });

  it("drops the least recently used conversations past the byte cap", () => {
    // Two conversations of ~48 MB each fit under 128 MB; a third doesn't.
    const text = "x".repeat(24 * 1024 * 1024);
    for (const userId of ["user-1", "user-2", "user-3"]) {
      historyText.rememberHistory(userId, `${userId}-conversation`, [
        turn(`${userId}-message`, text),
      ]);
    }

    expect(historyText.known("user-1", "user-1-conversation")).toBeUndefined();
    expect(historyText.known("user-2", "user-2-conversation")).toBeDefined();
    expect(historyText.known("user-3", "user-3-conversation")).toBeDefined();
  });
});
