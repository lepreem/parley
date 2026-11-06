"""Fail-fast preflight for the fetcher, mirroring
backend/src/startup.ts: aborts startup if any dependency is
unavailable."""

import bucket
import supadata
from contract import contract
from message_queue import mq
from preflight import verify_services


def verify_fetcher_services() -> None:
    # The contract comes first on its own: the queue names and bucket name
    # both come from it, so the other checks can't run without it.
    verify_services([("API /contract", contract.load)])
    verify_services(
        [
            ("RabbitMQ", mq.connect),
            ("Supabase Storage", bucket.ping_bucket),
            ("Supadata", supadata.ping),
        ]
    )
