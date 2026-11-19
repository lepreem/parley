/**
 * The message queues: `mq.<what>`. RabbitMQ carries them (rabbitmq.ts);
 * outside this folder nothing knows that. queues.ts names the queues and what
 * each message carries, delivery.ts what a consumer is told.
 */

export { ping, publish, consume, stopConsuming, close } from "./rabbitmq";
export { QUEUES as queues } from "./queues";
export { DeadLetterError, type DeliveryMetadata } from "./delivery";
