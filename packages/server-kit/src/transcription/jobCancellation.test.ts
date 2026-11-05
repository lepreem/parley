import { describe, expect, it } from "vitest";
import { jobCancellation } from "./jobCancellation";

describe("jobCancellation", () => {
  it("aborts the signal of the job being worked on", () => {
    const { signal, finish } = jobCancellation.start("job");

    jobCancellation.cancel("job");
    finish();

    expect(signal.aborted).toBe(true);
  });

  it("does nothing for a job this process isn't working on", () => {
    const first = jobCancellation.start("finished");
    const other = jobCancellation.start("other");
    first.finish();

    jobCancellation.cancel("finished");
    jobCancellation.cancel("never started");
    other.finish();

    expect(first.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(false);
  });

  it("keeps a later run's signal when an earlier one finishes", () => {
    const earlier = jobCancellation.start("job");
    const later = jobCancellation.start("job");

    earlier.finish();
    jobCancellation.cancel("job");
    later.finish();

    expect(later.signal.aborted).toBe(true);
  });
});
