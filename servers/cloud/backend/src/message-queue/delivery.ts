/**
 * How a consumer is handed a message, whichever broker delivers it: what it's
 * told about the delivery, and how it gives a message up for good.
 */

import type { Queue, QueuePayloads } from "./queues";

export type DeliveryMetadata = {
  /** 1 on the first try, counting up to the attempts the consumer allows. */
  attempt: number;
  /** A failure now dead-letters the message instead of trying again. */
  lastAttempt: boolean;
  /**
   * The broker delivered this message before, to a process that stopped
   * before settling it: that process may have started work on it.
   */
  redelivered: boolean;
};

export type Handler<Q extends Queue> = (
  payload: QueuePayloads[Q],
  delivery: DeliveryMetadata,
) => Promise<void> | void;

/**
 * Thrown by a handler to dead-letter its message straight away, skipping the
 * attempts it has left: for a failure trying again can't fix, or one that
 * leaves nothing safe for the next attempt to pick up.
 */
export class DeadLetterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeadLetterError";
  }
}
