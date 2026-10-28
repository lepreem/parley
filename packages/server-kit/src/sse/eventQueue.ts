import type { SSEStreamingApi } from "hono/streaming";

/**
 * Emits a named SSE event with a JSON payload. Returns writeSSE's promise so
 * callers can await it for ordering/backpressure.
 */
function sendEvent(stream: SSEStreamingApi, event: string, payload: unknown) {
  return stream.writeSSE({ event, data: JSON.stringify(payload) });
}

/** Resolves when `signal` aborts (immediately if it already has). Never rejects. */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

type QueuedEvent = { event: string; payload: unknown };

/**
 * A queue of SSE events produced independently of whoever is reading them.
 *
 * `push` and `end` are synchronous and never throw, so the work generating the
 * events is never coupled to the client's connection. That matters because
 * Node's HTTP layer does not cancel the response stream when the socket closes:
 * writing straight to the stream keeps resolving until its buffer fills and
 * then blocks *forever*, which would strand the producer mid-run. Here a
 * departed client can only stall `pipeTo`, and `disconnectSignal` unblocks
 * that too.
 *
 * Typed by the events it carries, by name, so a payload that doesn't match its
 * event fails the type check where it's pushed.
 */
export class SSEEventQueue<Events extends Record<string, unknown>> {
  private queue: QueuedEvent[] = [];
  private ended = false;
  /** Set once no reader can return: further events go nowhere, so drop them. */
  private detached = false;
  private wake: (() => void) | null = null;

  push<Name extends keyof Events & string>(event: Name, payload: Events[Name]) {
    if (this.detached) return;
    this.queue.push({ event, payload });
    this.signal();
  }

  /** Marks the producer done; `pipeTo` returns once the queue drains. */
  end() {
    this.ended = true;
    this.signal();
  }

  /**
   * Forwards events to `stream` until `end()` and the queue is drained, or
   * until `disconnectSignal` fires — the producer keeps running either way.
   */
  async pipeTo(stream: SSEStreamingApi, disconnectSignal: AbortSignal) {
    const disconnected = whenAborted(disconnectSignal);

    while (!disconnectSignal.aborted) {
      const next = this.queue.shift();
      if (!next) {
        if (this.ended) return;
        await Promise.race([this.nextPush(), disconnected]);
        continue;
      }
      await Promise.race([
        sendEvent(stream, next.event, next.payload),
        disconnected,
      ]);
    }

    this.detached = true;
    this.queue = [];
  }

  private nextPush() {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  private signal() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
