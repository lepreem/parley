from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from concurrent.futures import Future
from typing import Any

import pika

from contract import QueueName
from env import env

log = logging.getLogger(__name__)

# How long a handler waits for the broker to confirm a publish. Confirms
# normally take milliseconds; this only bounds a broker that has stopped
# answering.
PUBLISH_CONFIRM_TIMEOUT_S = 30

# Survives a broker restart. A message without it is dropped when RabbitMQ
# restarts, even in a durable queue. Same as amqplib's `persistent: true`.
PERSISTENT = pika.BasicProperties(
    content_type="application/json",
    delivery_mode=pika.DeliveryMode.Persistent,
)


class MQ:
    def __init__(self) -> None:
        self.connection: pika.BlockingConnection | None = None
        self.channel: pika.adapters.blocking_connection.BlockingChannel | None = None

    def connect(self) -> None:
        """Open the AMQP connection. Called by the startup preflight
        (startup.py) — nothing runs at import time."""
        if self.connection is not None:
            return

        params = pika.URLParameters(env.get("MQ_URL"))

        self.connection = pika.BlockingConnection(params)
        self.channel = self.connection.channel()

        # basic_publish now waits for the broker to take the message, and
        # raises if it refuses — the TS side's confirm channel.
        self.channel.confirm_delivery()

    def close(self) -> None:
        if self.connection is not None and self.connection.is_open:
            self.connection.close()

    def _publish(self, queue: QueueName, data: Any) -> None:
        assert self.channel is not None

        # amqplib's assertQueue defaults to durable — must match or RabbitMQ
        # rejects the redeclaration with PRECONDITION_FAILED.
        self.channel.queue_declare(queue=queue, durable=True)

        self.channel.basic_publish(
            exchange="",
            routing_key=queue,
            body=json.dumps(data).encode(),
            properties=PERSISTENT,
        )

    def publish_threadsafe(self, queue: QueueName, data: Any) -> None:
        """Publish from a handler (worker) thread: the connection is
        single-threaded, so hop onto its thread via add_callback_threadsafe.

        Returns once the broker has confirmed the message, and raises if it
        refused it or didn't answer in time, so the handler fails rather than
        carrying on as if the message were sent."""
        assert self.connection is not None
        sent: Future[None] = Future()

        def publish() -> None:
            try:
                self._publish(queue, data)
            except Exception as error:
                sent.set_exception(error)
            else:
                sent.set_result(None)

        self.connection.add_callback_threadsafe(publish)
        sent.result(timeout=PUBLISH_CONFIRM_TIMEOUT_S)

    def consume(
        self,
        queue: QueueName,
        handler: Callable[[dict[str, Any]], None],
        prefetch: int,
    ) -> None:
        """Hand each message on `queue` to `handler`, at most `prefetch` at
        once; the broker holds the rest back until one is settled. Nothing is
        delivered until run()."""
        assert self.connection is not None and self.channel is not None
        connection, channel = self.connection, self.channel

        channel.queue_declare(queue=queue, durable=True)

        # The connection is single-threaded: the worker may only reach it
        # through add_callback_threadsafe.
        def work(delivery_tag: int, body: bytes) -> None:
            try:
                data = json.loads(body.decode())

                handler(data)

                connection.add_callback_threadsafe(
                    lambda: channel.basic_ack(delivery_tag)
                )

            except Exception:
                log.exception("Failed to process message")

                # Drop the message (same as nack(false, false))
                connection.add_callback_threadsafe(
                    lambda: channel.basic_nack(delivery_tag, requeue=False)
                )

        def callback(
            ch: pika.adapters.blocking_connection.BlockingChannel,
            method: pika.spec.Basic.Deliver,
            properties: pika.BasicProperties,
            body: bytes,
        ) -> None:
            # Handlers run off-thread so this loop keeps pumping AMQP
            # heartbeats — a long download here would get the connection
            # dropped. The prefetch caps how many threads a queue has.
            threading.Thread(
                target=work, args=(method.delivery_tag, body), daemon=True
            ).start()

        # RabbitMQ applies a non-global prefetch to each consumer the channel
        # starts after it, so every queue keeps its own.
        channel.basic_qos(prefetch_count=prefetch)
        channel.basic_consume(queue=queue, on_message_callback=callback)

        log.info("Listening on %s, %d at a time", queue, prefetch)

    def run(self) -> None:
        """Deliver to every consumer until the process is told to stop."""
        assert self.channel is not None
        self.channel.start_consuming()


mq = MQ()
