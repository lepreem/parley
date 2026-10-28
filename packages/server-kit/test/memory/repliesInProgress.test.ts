import { describe, expect, it } from "vitest";
import {
  createRepliesInProgress,
  ReplyStopped,
} from "@parley/server-kit/memory/repliesInProgress";

describe("createRepliesInProgress", () => {
  it("shows a reply as it's written, until its entry is removed", () => {
    const repliesInProgress = createRepliesInProgress();
    const entry = repliesInProgress.add("a", "Hi");
    entry.append("Hel");
    entry.append("lo");

    expect(repliesInProgress.find("a")).toEqual({
      content: "Hi",
      assistantContent: "Hello",
    });
    entry.remove();
    expect(repliesInProgress.find("a")).toBeNull();
  });

  it("aborts a stopped reply's signal", () => {
    const repliesInProgress = createRepliesInProgress();
    const entry = repliesInProgress.add("a", "Hi");

    expect(repliesInProgress.stop("a")).toBe(true);
    expect(entry.stopped).toBe(true);
    expect(entry.signal.reason).toBeInstanceOf(ReplyStopped);
  });

  it("has nothing to stop under a key with no reply", () => {
    const repliesInProgress = createRepliesInProgress();
    repliesInProgress.add("a", "Hi").remove();

    expect(repliesInProgress.stop("a")).toBe(false);
    expect(repliesInProgress.stop("b")).toBe(false);
  });

  it("leaves a newer reply under the same key when an older one is removed", () => {
    const repliesInProgress = createRepliesInProgress();
    const older = repliesInProgress.add("a", "first");
    repliesInProgress.add("a", "second");
    older.remove();

    expect(repliesInProgress.find("a")?.content).toBe("second");
  });
});
