import json
from concurrent.futures import TimeoutError
from unittest.mock import MagicMock

import pika
import pytest

import message_queue
from message_queue import MQ


def make_mq():
    mq = MQ()
    mq.connection = MagicMock()
    mq.channel = MagicMock()
    mq.connection.is_open = True
    # Run thread-hops inline so the tests stay synchronous.
    mq.connection.add_callback_threadsafe.side_effect = lambda cb: cb()
    return mq


class SyncThread:
    """Replaces the handler worker thread so deliveries run inline."""

    def __init__(self, target=None, args=(), daemon=None):
        self._target, self._args = target, args

    def start(self):
        self._target(*self._args)


def deliver(mq, monkeypatch, body, handler):
    """Wire up a consumer and push one message through it."""
    monkeypatch.setattr(message_queue.threading, "Thread", SyncThread)
    mq.consume("q", handler, prefetch=1)

    callback = mq.channel.basic_consume.call_args.kwargs["on_message_callback"]
    method = MagicMock()
    method.delivery_tag = 7
    callback(mq.channel, method, MagicMock(), body)


def test_publish_declares_durable_queue_and_sends_json():
    mq = make_mq()

    mq._publish("q", {"a": 1})

    # amqplib's assertQueue on the TS side defaults to durable — the
    # declaration must match or RabbitMQ rejects it.
    mq.channel.queue_declare.assert_called_once_with(queue="q", durable=True)
    kwargs = mq.channel.basic_publish.call_args.kwargs
    assert kwargs["exchange"] == ""
    assert kwargs["routing_key"] == "q"
    assert json.loads(kwargs["body"]) == {"a": 1}
    # Without this RabbitMQ drops the message when it restarts, durable
    # queue or not.
    assert kwargs["properties"].delivery_mode == pika.DeliveryMode.Persistent.value


def test_connect_turns_on_publisher_confirms(monkeypatch):
    connection = MagicMock()
    monkeypatch.setattr(
        message_queue.pika, "BlockingConnection", MagicMock(return_value=connection)
    )
    mq = MQ()

    mq.connect()

    connection.channel.return_value.confirm_delivery.assert_called_once()


def test_publish_threadsafe_hops_to_the_connection_thread():
    mq = make_mq()

    mq.publish_threadsafe("q", "payload")

    mq.connection.add_callback_threadsafe.assert_called_once()
    body = mq.channel.basic_publish.call_args.kwargs["body"]
    assert json.loads(body) == "payload"


def test_publish_threadsafe_raises_when_the_broker_refuses():
    mq = make_mq()
    mq.channel.basic_publish.side_effect = pika.exceptions.NackError([])

    # Raised on the calling (handler) thread, so the handler fails.
    with pytest.raises(pika.exceptions.NackError):
        mq.publish_threadsafe("q", "payload")


def test_publish_threadsafe_gives_up_when_the_broker_never_answers(monkeypatch):
    mq = make_mq()
    # The connection thread never gets round to the publish.
    mq.connection.add_callback_threadsafe.side_effect = lambda cb: None
    monkeypatch.setattr(message_queue, "PUBLISH_CONFIRM_TIMEOUT_S", 0.01)

    with pytest.raises(TimeoutError):
        mq.publish_threadsafe("q", "payload")


def test_close_only_closes_an_open_connection():
    mq = make_mq()
    mq.connection.is_open = False
    mq.close()
    mq.connection.close.assert_not_called()

    mq.connection.is_open = True
    mq.close()
    mq.connection.close.assert_called_once()

    MQ().close()  # never connected: no-op, must not raise


def test_consume_sets_each_queues_prefetch_right_before_starting_it():
    mq = make_mq()
    calls = MagicMock()
    mq.channel.basic_qos = calls.basic_qos
    mq.channel.basic_consume = calls.basic_consume

    mq.consume("captions", lambda data: None, prefetch=5)
    mq.consume("audio", lambda data: None, prefetch=3)

    # RabbitMQ gives each consumer the prefetch set last before it started.
    steps = [
        (call[0], call.kwargs.get("prefetch_count") or call.kwargs.get("queue"))
        for call in calls.mock_calls
    ]
    assert steps == [
        ("basic_qos", 5),
        ("basic_consume", "captions"),
        ("basic_qos", 3),
        ("basic_consume", "audio"),
    ]
    mq.channel.start_consuming.assert_not_called()


def test_run_starts_delivering():
    mq = make_mq()

    mq.run()

    mq.channel.start_consuming.assert_called_once()


def test_consume_acks_after_successful_handling(monkeypatch):
    mq = make_mq()
    seen = []

    deliver(mq, monkeypatch, b'{"audioUploadId": "u1"}', seen.append)

    assert seen == [{"audioUploadId": "u1"}]
    mq.channel.basic_ack.assert_called_once_with(7)
    mq.channel.basic_nack.assert_not_called()


def test_consume_drops_message_when_handler_fails(monkeypatch):
    mq = make_mq()

    def handler(data):
        raise RuntimeError("boom")

    deliver(mq, monkeypatch, b"{}", handler)

    mq.channel.basic_nack.assert_called_once_with(7, requeue=False)
    mq.channel.basic_ack.assert_not_called()


def test_consume_drops_undecodable_message(monkeypatch):
    mq = make_mq()
    seen = []

    deliver(mq, monkeypatch, b"not json", seen.append)

    assert seen == []
    mq.channel.basic_nack.assert_called_once_with(7, requeue=False)
    mq.channel.basic_ack.assert_not_called()
