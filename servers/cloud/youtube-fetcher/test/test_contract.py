from unittest.mock import MagicMock

import pytest

import contract as contract_module
from contract import _Contract

# /contract serves every backend queue (backend/src/app.ts).
FULL_CONTRACT = {
    "queues": {
        "YT_FETCH_CAPTIONS": "yt_fetch_captions",
        "YT_FETCH_AUDIO": "yt_fetch_audio",
        "YT_SAVE_CAPTIONS": "yt_save_captions",
        "TRANSCRIBE_AUDIO": "transcribe_audio",
        "YT_FAIL_JOB": "yt_fail_job",
    },
    "bucket": "uploads",
    "maxAudioBytes": 25 * 1024 * 1024,
}


def make_response(body):
    response = MagicMock()
    response.json.return_value = body
    return response


def test_load_reads_queues_and_limits(monkeypatch):
    get = MagicMock(return_value=make_response(FULL_CONTRACT))
    monkeypatch.setattr(contract_module.httpx, "get", get)

    c = _Contract()
    c.load()

    assert c.queues.YT_FETCH_CAPTIONS == "yt_fetch_captions"
    assert c.queues.YT_FETCH_AUDIO == "yt_fetch_audio"
    assert c.queues.YT_SAVE_CAPTIONS == "yt_save_captions"
    assert c.queues.TRANSCRIBE_AUDIO == "transcribe_audio"
    assert c.queues.YT_FAIL_JOB == "yt_fail_job"
    assert c.bucket == "uploads"
    assert c.maxAudioBytes == 25 * 1024 * 1024


def test_load_normalises_trailing_slash_in_base_url(monkeypatch):
    # conftest sets API_BASE_URL to "http://api.test/" (trailing slash)
    get = MagicMock(return_value=make_response(FULL_CONTRACT))
    monkeypatch.setattr(contract_module.httpx, "get", get)

    _Contract().load()

    (url,), _ = get.call_args
    assert url == "http://api.test/contract"


def test_load_raises_on_http_error(monkeypatch):
    response = make_response({})
    response.raise_for_status.side_effect = RuntimeError("HTTP 500")
    monkeypatch.setattr(contract_module.httpx, "get", MagicMock(return_value=response))

    with pytest.raises(RuntimeError):
        _Contract().load()
