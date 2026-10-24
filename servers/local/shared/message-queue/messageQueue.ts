import { logger, messageOf } from "@parley/shared/logger";
import { QUEUES, type Queue, type QueuePayloads } from "./queues";
export { QUEUES } from "./queues";
export type { QueuePayloads } from "./queues";

const log = logger.child({ component: "message-queue" });

/** How long to wait before trying a failed message again, to ride out a brief outage. */
const RETRY_DELAY_MS = 2_000;

export type DeliveryMetadata = {
  /** 1 on the first try, counting up to the attempts the consumer allows. */
  attempt: number;
  /** A failure now gives the message up instead of trying again. */
  lastAttempt: boolean;
};

type Handler<Q extends Queue> = (
  payload: QueuePayloads[Q],
  delivery: DeliveryMetadata,
) => Promise<void> | void;

/**
 * Thrown by a handler to give its message up straight away, skipping the
 * attempts it has left: for a failure trying again can't fix, or one that
 * leaves nothing safe for the next attempt to pick up.
 */
export class DeadLetterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeadLetterError";
  }
}

/**
 * One queue's messages and the consumer that takes them, one at a time, in
 * the order they were published.
 */
type QueueState<Q extends Queue> = {
  waiting: QueuePayloads[Q][];
  consumer?: { handler: Handler<Q>; attempts: number };
  /** The run working through `waiting`, while there is one. */
  drainPromise?: Promise<void>;
};

const queues = new Map<Queue, QueueState<Queue>>();
let stopped = false;

function stateOf<Q extends Queue>(queue: Q): QueueState<Q> {
  let state = queues.get(queue);
  if (!state) {
    state = { waiting: [] };
    queues.set(queue, state);
  }
  // Each queue's state is only ever stored under its own name.
  return state as unknown as QueueState<Q>;
}

/** Why a message failed, with the cause a DeadLetterError wraps. */
function failureReason(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause === undefined
    ? messageOf(error)
    : `${messageOf(error)}: ${messageOf(cause)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs the handler until it succeeds or runs out of attempts, pausing between
 * them. A message that fails every attempt or throws a DeadLetterError is
 * given up, and logged with its payload.
 */
async function handle<Q extends Queue>(
  queue: Q,
  payload: QueuePayloads[Q],
  { handler, attempts }: NonNullable<QueueState<Q>["consumer"]>,
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const lastAttempt = attempt === attempts;
    try {
      await handler(payload, { attempt, lastAttempt });
      return;
    } catch (error) {
      if (lastAttempt || error instanceof DeadLetterError) {
        log.error("Failed to process message, giving it up", error, {
          queue,
          reason: failureReason(error),
          payload: JSON.stringify(payload),
        });
        return;
      }
      log.warn("Failed to process message, trying again", {
        queue,
        attempt,
        error: messageOf(error),
      });
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/** Hands the queue's waiting messages to its consumer, unless that's under way. */
function drain<Q extends Queue>(queue: Q) {
  const state = stateOf(queue);
  const { consumer } = state;
  if (!consumer || state.drainPromise || stopped) return;

  state.drainPromise = (async () => {
    // A turn first, so publishing never runs a handler inside the publisher.
    await new Promise((resolve) => setImmediate(resolve));
    while (!stopped) {
      const payload = state.waiting.shift();
      if (payload === undefined) break;
      await handle(queue, payload, consumer);
    }
  })().finally(() => {
    state.drainPromise = undefined;
  });
}

/**
 * The process's work queues, held in memory: publishing hands a message to
 * its queue's consumer, which takes them one at a time, in order.
 *
 * Nothing here outlives the process. The job rows do: at startup the API puts
 * every unfinished job back on its queue (resumeUnfinishedJobs).
 */
export const mq = {
  queues: QUEUES,

  /**
   * Queues a copy of `payload`, as it would arrive over the wire, so the
   * consumer shares nothing with the publisher.
   */
  publish<Q extends Queue>(queue: Q, payload: QueuePayloads[Q]) {
    stateOf(queue).waiting.push(JSON.parse(JSON.stringify(payload)));
    drain(queue);
  },

  /**
   * Hands each message on `queue` to `handler`, trying up to `attempts` times
   * before giving it up. A handler fails an attempt by throwing.
   */
  consume<Q extends Queue>(
    queue: Q,
    handler: Handler<Q>,
    { attempts }: { attempts: number },
  ) {
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new Error(`A consumer needs at least one attempt, got ${attempts}`);
    }
    const state = stateOf(queue);
    if (state.consumer) throw new Error(`${queue} already has a consumer`);
    state.consumer = { handler, attempts };
    drain(queue);
  },

  /**
   * Stops handing out messages, then waits for the ones being handled. What's
   * still waiting is dropped with the process; its jobs resume at startup.
   */
  async stopConsuming() {
    stopped = true;
    await Promise.allSettled(
      [...queues.values()].map((state) => state.drainPromise),
    );
  },
};

/** Test-only: forgets every queue, consumer and message, and starts again. */
export function resetQueues() {
  queues.clear();
  stopped = false;
}
