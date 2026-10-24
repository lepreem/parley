from dataclasses import dataclass
from typing import NewType

import httpx

from env import env

QueueName = NewType("QueueName", str)


@dataclass
class _Queues:
    YT_FETCH_CAPTIONS: QueueName
    YT_FETCH_AUDIO: QueueName
    YT_SAVE_CAPTIONS: QueueName
    TRANSCRIBE_AUDIO: QueueName
    YT_FAIL_JOB: QueueName


class _Contract:
    queues: _Queues
    bucket: str
    maxAudioBytes: int

    def load(self) -> None:
        """Fetch the cross-service contract from the API. Called by the
        startup preflight (startup.py) — nothing runs at import time."""
        api_base_url = env.get("API_BASE_URL")
        response = httpx.get(f"{api_base_url.rstrip('/')}/contract", timeout=5)
        response.raise_for_status()
        body = response.json()
        # /contract serves every backend queue, the fetcher's included.
        queues = body["queues"]
        self.queues = _Queues(
            YT_FETCH_CAPTIONS=QueueName(queues["YT_FETCH_CAPTIONS"]),
            YT_FETCH_AUDIO=QueueName(queues["YT_FETCH_AUDIO"]),
            YT_SAVE_CAPTIONS=QueueName(queues["YT_SAVE_CAPTIONS"]),
            TRANSCRIBE_AUDIO=QueueName(queues["TRANSCRIBE_AUDIO"]),
            YT_FAIL_JOB=QueueName(queues["YT_FAIL_JOB"]),
        )
        self.bucket = body["bucket"]
        self.maxAudioBytes = body["maxAudioBytes"]


contract = _Contract()
