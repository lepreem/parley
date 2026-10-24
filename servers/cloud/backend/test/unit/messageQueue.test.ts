import type { EventEmitter } from "node:events";
import type { ConsumeMessage } from "amqplib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Confirmation = (error: Error | null) => void;
type FakeChannel = EventEmitter & {
  publish: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  prefetch: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
};

/** The fake broker: the connection, its two channels, and what they saw. */
const broker = vi.hoisted(() => ({
  connection: null as EventEmitter | null,
  publisher: null as FakeChannel | null,
  consumer: null as FakeChannel | null,
  /** Publishes are confirmed at once unless a test holds them here. */
  heldConfirmations: null as Confirmation[] | null,
  deliver: null as ((message: ConsumeMessage | null) => void) | null,
}));

vi.mock("amqplib", async () => {
  const { EventEmitter } = await import("node:events");
  const channel = () =>
    Object.assign(new EventEmitter(), {
      assertExchange: vi.fn(),
      assertQueue: vi.fn(),
      bindQueue: vi.fn(),
      prefetch: vi.fn(),
      publish: vi.fn(
        (
          _exchange: string,
          _routingKey: string,
          _content: Buffer,
          _options: unknown,
          confirmation: Confirmation,
        ) => {
          if (broker.heldConfirmations) {
            broker.heldConfirmations.push(confirmation);
          } else confirmation(null);
          return true;
        },
      ),
      consume: vi.fn(
        async (
          _queue: string,
          deliver: (message: ConsumeMessage | null) => void,
        ) => {
          broker.deliver = deliver;
          return { consumerTag: "consumer-1" };
        },
      ),
      cancel: vi.fn(),
      ack: vi.fn(),
      nack: vi.fn(),
    });
  return {
    default: {
      connect: vi.fn(async () => {
        const connection = Object.assign(new EventEmitter(), {
          createConfirmChannel: async () => (broker.publisher = channel()),
          createChannel: async () => (broker.consumer = channel()),
          close: vi.fn(async function (this: EventEmitter) {
            this.emit("close");
          }),
        });
        broker.connection = connection;
        return connection;
      }),
    },
  };
});

import { DeadLetterError, mq } from "../../src/message-queue/messageQueue";
import { QUEUES } from "../../src/message-queue/queues";

const payload = {
  audioUploadId: "550e8400-e29b-41d4-a716-446655440000",
} as const;

function deliveryOf(content: string, redelivered = false) {
  return {
    content: Buffer.from(content),
    fields: { redelivered },
  } as unknown as ConsumeMessage;
}

/** Lets the handler, and whatever settles its message, run to the end. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  broker.heldConfirmations = null;
  broker.deliver = null;
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});

afterEach(async () => {
  await mq.close();
  exit.mockRestore();
});

describe("publishing", () => {
  it("settles each concurrent publish from its own confirmation", async () => {
    await mq.consume(QUEUES.TRANSCRIBE_AUDIO, () => {}, { attempts: 1 }); // opens the connection
    broker.heldConfirmations = [];

    const firstPublish = mq.publish(QUEUES.TRANSCRIBE_AUDIO, payload);
    const secondPublish = mq.publish(QUEUES.TRANSCRIBE_AUDIO, {
      audioUploadId: "c56a4180-65aa-42ec-a945-5fd21dec0538",
    });
    const firstPublishResult = expect(firstPublish).rejects.toThrow(
      "first publish rejected",
    );
    await flush();

    broker.heldConfirmations[1](null);
    await expect(secondPublish).resolves.toBeUndefined();

    broker.heldConfirmations[0](new Error("first publish rejected"));
    await firstPublishResult;
  });
});

describe("consuming", () => {
  const RETRY_DELAY_MS = 2_000;

  beforeEach(() => {
    // Only the pause between attempts; setImmediate stays real for flush().
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function consumeWith(
    handler: () => Promise<void> | void,
    attempts = 2,
  ) {
    await mq.consume(QUEUES.TRANSCRIBE_AUDIO, handler, { attempts });
    return async (message: ConsumeMessage) => {
      broker.deliver!(message);
      await flush();
    };
  }

  async function waitOutRetryDelay() {
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    await flush();
  }

  function deadLetters() {
    return broker.publisher!.publish.mock.calls.filter(
      ([exchange]) => exchange === "dead_letter",
    );
  }

  function failureReasons() {
    return deadLetters().map(
      ([, , , options]) =>
        (options as { headers: Record<string, string> }).headers[
          "x-failure-reason"
        ],
    );
  }

  it("hands the handler its attempt and the redelivery flag, then acks", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const deliver = await consumeWith(handler);

    const message = deliveryOf(JSON.stringify(payload), true);
    await deliver(message);

    expect(handler).toHaveBeenCalledWith(payload, {
      attempt: 1,
      lastAttempt: false,
      redelivered: true,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(broker.consumer!.ack).toHaveBeenCalledOnce();
  });

  it("tries a failed message again after a pause, then acks it", async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);
    const deliver = await consumeWith(handler);

    const message = deliveryOf(JSON.stringify(payload));
    await deliver(message);
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
    expect(handler).toHaveBeenCalledTimes(1);

    await waitOutRetryDelay();

    expect(handler).toHaveBeenLastCalledWith(payload, {
      attempt: 2,
      lastAttempt: true,
      redelivered: false,
    });
    expect(broker.consumer!.ack).toHaveBeenCalledOnce();
    expect(broker.consumer!.nack).not.toHaveBeenCalled();
    expect(deadLetters()).toHaveLength(0);
  });

  it("dead-letters a message that fails every attempt, then acks it", async () => {
    const handler = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));
    const deliver = await consumeWith(handler);

    const message = deliveryOf(JSON.stringify(payload));
    await deliver(message);
    await waitOutRetryDelay();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(deadLetters()).toEqual([
      [
        "dead_letter",
        QUEUES.TRANSCRIBE_AUDIO,
        message.content,
        expect.anything(),
        expect.any(Function),
      ],
    ]);
    expect(failureReasons()).toEqual(["database unavailable"]);
    expect(broker.consumer!.ack).toHaveBeenCalledWith(message);
    expect(broker.consumer!.nack).not.toHaveBeenCalled();
  });

  it("dead-letters on the first failure when only one attempt is allowed", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("socket gone"));
    const deliver = await consumeWith(handler, 1);

    await deliver(deliveryOf(JSON.stringify(payload)));

    expect(handler).toHaveBeenCalledOnce();
    expect(failureReasons()).toEqual(["socket gone"]);
  });

  it("dead-letters a DeadLetterError at once, with its cause", async () => {
    const handler = vi.fn().mockRejectedValue(
      new DeadLetterError("Could not unclaim the job", {
        cause: new Error("database unavailable"),
      }),
    );
    const deliver = await consumeWith(handler);

    const message = deliveryOf(JSON.stringify(payload));
    await deliver(message);

    expect(handler).toHaveBeenCalledOnce();
    expect(failureReasons()).toEqual([
      "Could not unclaim the job: database unavailable",
    ]);
    expect(broker.consumer!.ack).toHaveBeenCalledWith(message);
  });

  it("dead-letters a malformed payload without running the handler", async () => {
    const handler = vi.fn();
    const deliver = await consumeWith(handler);

    const message = deliveryOf("{not json");
    await deliver(message);

    expect(handler).not.toHaveBeenCalled();
    expect(failureReasons()).toEqual([
      expect.stringMatching(/^Malformed payload: /),
    ]);
    expect(broker.consumer!.ack).toHaveBeenCalledWith(message);
  });

  it("dead-letters a payload that isn't its queue's shape without running the handler", async () => {
    const handler = vi.fn();
    const deliver = await consumeWith(handler);

    // A field renamed on the publishing side.
    const message = deliveryOf(
      JSON.stringify({ uploadId: payload.audioUploadId }),
    );
    await deliver(message);

    expect(handler).not.toHaveBeenCalled();
    expect(failureReasons()).toEqual([
      expect.stringMatching(/^Malformed payload: /),
    ]);
    expect(broker.consumer!.ack).toHaveBeenCalledWith(message);
  });

  it("drops the message rather than requeueing it when dead-lettering fails", async () => {
    const deliver = await consumeWith(() => {
      throw new Error("database unavailable");
    }, 1);
    broker.publisher!.publish.mockImplementationOnce(
      (
        _exchange: string,
        _routingKey: string,
        _content: Buffer,
        _options: unknown,
        confirmation: Confirmation,
      ) => {
        confirmation(new Error("broker refused"));
        return true;
      },
    );

    const message = deliveryOf(JSON.stringify(payload));
    await deliver(message);

    expect(broker.consumer!.nack).toHaveBeenCalledWith(message, false, false);
    expect(broker.consumer!.ack).not.toHaveBeenCalled();
  });

  it("refuses a consumer with no attempts", async () => {
    await expect(
      mq.consume(QUEUES.TRANSCRIBE_AUDIO, () => {}, { attempts: 0 }),
    ).rejects.toThrow("at least one attempt");
  });

  it("sets each consumer's prefetch right before starting it, 1 by default", async () => {
    await mq.consume(QUEUES.TRANSCRIBE_AUDIO, () => {}, {
      attempts: 1,
      prefetch: 40,
    });
    await mq.consume(QUEUES.YT_FAIL_JOB, () => {}, { attempts: 1 });

    const { prefetch, consume } = broker.consumer!;
    expect(prefetch.mock.calls).toEqual([[40], [1]]);
    expect(consume.mock.calls.map(([queue]) => queue)).toEqual([
      QUEUES.TRANSCRIBE_AUDIO,
      QUEUES.YT_FAIL_JOB,
    ]);
    expect([
      prefetch.mock.invocationCallOrder[0],
      consume.mock.invocationCallOrder[0],
      prefetch.mock.invocationCallOrder[1],
      consume.mock.invocationCallOrder[1],
    ]).toEqual(
      [
        ...prefetch.mock.invocationCallOrder,
        ...consume.mock.invocationCallOrder,
      ].sort((a, b) => a - b),
    );
  });

  it("refuses a consumer with no prefetch", async () => {
    await expect(
      mq.consume(QUEUES.TRANSCRIBE_AUDIO, () => {}, {
        attempts: 1,
        prefetch: 0,
      }),
    ).rejects.toThrow("prefetch of at least 1");
  });
});

describe("stopConsuming", () => {
  it("cancels every consumer, then waits for the handler still running", async () => {
    let finishHandler!: () => void;
    await mq.consume(
      QUEUES.TRANSCRIBE_AUDIO,
      () => new Promise<void>((resolve) => (finishHandler = resolve)),
      { attempts: 1 },
    );
    const message = deliveryOf(JSON.stringify(payload));
    broker.deliver!(message);
    await mq.consume(QUEUES.YT_SAVE_CAPTIONS, () => {}, { attempts: 1 });

    let stopped = false;
    const stopping = mq.stopConsuming().then(() => (stopped = true));
    await flush();

    expect(broker.consumer!.cancel).toHaveBeenCalledTimes(2);
    expect(stopped).toBe(false);

    finishHandler();
    await stopping;
    expect(broker.consumer!.ack).toHaveBeenCalledWith(message);
  });

  it("does nothing before anything has connected", async () => {
    await expect(mq.stopConsuming()).resolves.toBeUndefined();
  });
});

describe("connection loss", () => {
  it("exits when the broker closes the connection", async () => {
    await mq.consume(QUEUES.YT_FAIL_JOB, () => {}, { attempts: 1 });

    broker.connection!.emit("close", new Error("CONNECTION_FORCED"));
    await flush();

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits once when a channel closes, however many events follow", async () => {
    await mq.consume(QUEUES.YT_FAIL_JOB, () => {}, { attempts: 1 });

    broker.consumer!.emit("error", new Error("PRECONDITION_FAILED"));
    broker.consumer!.emit("close");
    broker.connection!.emit("close");
    await flush();

    expect(exit).toHaveBeenCalledOnce();
  });

  it("does not exit when this process closes the connection", async () => {
    await mq.consume(QUEUES.YT_FAIL_JOB, () => {}, { attempts: 1 });

    await mq.close();
    await flush();

    expect(exit).not.toHaveBeenCalled();
  });

  it("does not exit when the startup ping closes its connection", async () => {
    await mq.ping();
    await flush();

    expect(exit).not.toHaveBeenCalled();
  });
});
