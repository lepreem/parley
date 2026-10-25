import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DeadLetterError,
  mq,
  QUEUES,
  resetQueues,
} from "../../core/message-queue/messageQueue";

const first = {
  audioUploadId: "11111111-1111-4111-8111-111111111111",
} as const;
const second = {
  audioUploadId: "22222222-2222-4222-8222-222222222222",
} as const;

/** A promise to settle by hand, with whether it has been. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** Lets every message already handed out reach its handler. */
function aTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  resetQueues();
});

afterEach(async () => {
  vi.useRealTimers();
  await mq.stopConsuming();
});

describe("mq", () => {
  it("hands each message to its queue's consumer, with which attempt it is", async () => {
    const handler = vi.fn();
    mq.consume(QUEUES.TRANSCRIBE, handler, { attempts: 2 });

    mq.publish(QUEUES.TRANSCRIBE, first);
    await vi.waitFor(() =>
      expect(handler).toHaveBeenCalledWith(first, {
        attempt: 1,
        lastAttempt: false,
      }),
    );
  });

  it("never runs a handler inside publish", () => {
    const handler = vi.fn();
    mq.consume(QUEUES.TRANSCRIBE, handler, { attempts: 1 });

    mq.publish(QUEUES.TRANSCRIBE, first);

    expect(handler).not.toHaveBeenCalled();
  });

  it("hands a copy of the payload, as it would arrive over the wire", async () => {
    const handler = vi.fn();
    mq.consume(QUEUES.YT_FETCH, handler, { attempts: 1 });
    const payload = {
      audioUploadId: first.audioUploadId,
      url: "https://youtu.be/abc",
      useCaptionsIfAvailable: false,
    };

    mq.publish(QUEUES.YT_FETCH, payload);
    payload.url = "changed after publishing";

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(handler.mock.calls[0][0]).toEqual({
      audioUploadId: first.audioUploadId,
      url: "https://youtu.be/abc",
      useCaptionsIfAvailable: false,
    });
  });

  it("takes a queue's messages one at a time, in order", async () => {
    const finishFirst = deferred();
    const handled: string[] = [];
    mq.consume(
      QUEUES.TRANSCRIBE,
      async ({ audioUploadId }) => {
        handled.push(audioUploadId);
        if (audioUploadId === first.audioUploadId) await finishFirst.promise;
      },
      { attempts: 1 },
    );

    mq.publish(QUEUES.TRANSCRIBE, first);
    mq.publish(QUEUES.TRANSCRIBE, second);
    await aTurn();
    expect(handled).toEqual([first.audioUploadId]);

    finishFirst.resolve();
    await vi.waitFor(() =>
      expect(handled).toEqual([first.audioUploadId, second.audioUploadId]),
    );
  });

  it("lets other queues move while one is busy", async () => {
    const never = deferred();
    mq.consume(QUEUES.TRANSCRIBE, () => never.promise, { attempts: 1 });
    const done = vi.fn();
    mq.consume(QUEUES.TRANSCRIBE_DONE, done, { attempts: 1 });

    mq.publish(QUEUES.TRANSCRIBE, first);
    mq.publish(QUEUES.TRANSCRIBE_DONE, first);

    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
    never.resolve();
  });

  it("keeps what's published before there's a consumer, and hands it out once there is", async () => {
    mq.publish(QUEUES.TRANSCRIBE, first);
    await aTurn();
    const handler = vi.fn();

    mq.consume(QUEUES.TRANSCRIBE, handler, { attempts: 1 });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  });

  it("tries a failed message again after a pause, up to the attempts allowed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(undefined);
    mq.consume(QUEUES.TRANSCRIBE, handler, { attempts: 2 });

    mq.publish(QUEUES.TRANSCRIBE, first);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls[1][1]).toEqual({ attempt: 2, lastAttempt: true });
  });

  it("gives a message up after its last attempt, and moves on to the next", async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValueOnce(undefined);
    mq.consume(QUEUES.TRANSCRIBE, handler, { attempts: 1 });

    mq.publish(QUEUES.TRANSCRIBE, first);
    mq.publish(QUEUES.TRANSCRIBE, second);

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls[1][0]).toEqual(second);
  });

  it("gives a message up at once when the handler throws a DeadLetterError", async () => {
    const handler = vi.fn().mockRejectedValue(new DeadLetterError("hopeless"));
    mq.consume(QUEUES.TRANSCRIBE, handler, { attempts: 3 });

    mq.publish(QUEUES.TRANSCRIBE, first);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    await aTurn();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses a consumer with fewer than one attempt", () => {
    expect(() =>
      mq.consume(QUEUES.TRANSCRIBE, () => {}, { attempts: 0 }),
    ).toThrow("A consumer needs at least one attempt, got 0");
  });

  it("refuses a second consumer for a queue", () => {
    mq.consume(QUEUES.TRANSCRIBE, () => {}, { attempts: 1 });

    expect(() =>
      mq.consume(QUEUES.TRANSCRIBE, () => {}, { attempts: 1 }),
    ).toThrow("transcribe already has a consumer");
  });

  it("waits for the message being handled when stopped, and hands out no more", async () => {
    const finishFirst = deferred();
    const handler = vi.fn(() => finishFirst.promise);
    mq.consume(QUEUES.TRANSCRIBE, handler, { attempts: 1 });
    mq.publish(QUEUES.TRANSCRIBE, first);
    mq.publish(QUEUES.TRANSCRIBE, second);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());

    let stopped = false;
    const stopping = mq.stopConsuming().then(() => (stopped = true));
    await aTurn();
    expect(stopped).toBe(false);

    finishFirst.resolve();
    await stopping;
    expect(handler).toHaveBeenCalledOnce();
  });
});
