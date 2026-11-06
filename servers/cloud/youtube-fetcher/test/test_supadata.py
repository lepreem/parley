from unittest.mock import MagicMock

import httpx
import pytest

import supadata

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def answer(status: int, body: dict) -> httpx.Response:
    return httpx.Response(
        status, json=body, request=httpx.Request("GET", supadata.API_URL)
    )


def captions(*lines: tuple[int, int, str], lang: str = "en") -> httpx.Response:
    return answer(
        200,
        {
            "lang": lang,
            "availableLangs": [lang],
            "content": [
                {"lang": lang, "text": text, "offset": offset, "duration": duration}
                for offset, duration, text in lines
            ],
        },
    )


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(supadata.time, "sleep", lambda _seconds: None)


@pytest.fixture
def get(monkeypatch):
    """Stands in for httpx.get; tests set its return_value or side_effect."""
    mock = MagicMock()
    monkeypatch.setattr(supadata.httpx, "get", mock)
    return mock


def test_converts_caption_lines_to_segments_in_seconds(get):
    get.return_value = captions(
        (0, 1500, "First caption"),
        (1500, 1000, "  "),
        (2500, 2000, "  Second caption  "),
        lang="de",
    )

    assert supadata.fetch_captions(URL) == {
        "segments": [
            {"start": 0.0, "end": 1.5, "text": "First caption"},
            {"start": 2.5, "end": 4.5, "text": "Second caption"},
        ],
        "language": "de",
    }


def test_asks_for_existing_english_captions_with_the_key(get):
    get.return_value = captions((0, 1000, "hi"))

    supadata.fetch_captions(URL)

    _, kwargs = get.call_args
    assert kwargs["params"] == {"url": URL, "mode": "native", "lang": "en"}
    assert kwargs["headers"] == {"x-api-key": "dummy-supadata-key"}


def test_a_video_without_captions_is_none(get):
    get.return_value = answer(
        206,
        {"error": "transcript-unavailable", "message": "Transcript Unavailable"},
    )

    assert supadata.fetch_captions(URL) is None


def test_only_blank_lines_is_none(get):
    get.return_value = captions((0, 1000, "  "))

    assert supadata.fetch_captions(URL) is None


def test_made_up_captions_are_none(get):
    # The answer seen for a rain video with captions disabled: one invented
    # sentence, timed in seconds instead of milliseconds.
    get.return_value = answer(
        200,
        {
            "lang": "en",
            "availableLangs": ["en"],
            "content": [
                {
                    "text": "The wind whipped through the branches of the pine.",
                    "offset": 0,
                    "duration": 9.9,
                }
            ],
        },
    )

    assert supadata.fetch_captions(URL) is None


def test_a_video_that_doesnt_exist_says_so(get):
    get.return_value = answer(404, {"error": "not-found"})

    with pytest.raises(supadata.CaptionsError, match="doesn't exist"):
        supadata.fetch_captions(URL)


def test_used_up_credits_say_so_without_retrying(get):
    get.return_value = answer(402, {"error": "payment-required"})

    with pytest.raises(supadata.CaptionsError, match="allowance"):
        supadata.fetch_captions(URL)

    assert get.call_count == 1


def test_a_rate_limit_that_never_clears_says_busy(get):
    # What a burst of requests gets on the free plan, seen 2026-11-06.
    get.return_value = answer(
        429,
        {
            "error": "limit-exceeded",
            "details": "Request rate limit on current plan was exceeded.",
        },
    )

    with pytest.raises(supadata.CaptionsError, match="too many YouTube videos"):
        supadata.fetch_captions(URL)

    assert get.call_count == supadata.ATTEMPTS


def test_retries_a_rate_limit_until_it_clears(get):
    get.side_effect = [
        answer(429, {"error": "limit-exceeded"}),
        captions((0, 1000, "hi")),
    ]

    assert supadata.fetch_captions(URL)["segments"][0]["text"] == "hi"
    assert get.call_count == 2


def test_gives_up_on_a_failing_service(get):
    get.return_value = answer(500, {"error": "internal-error"})

    with pytest.raises(supadata.CaptionsError, match="unavailable right now"):
        supadata.fetch_captions(URL)

    assert get.call_count == supadata.ATTEMPTS


def test_gives_up_when_unreachable(get):
    get.side_effect = httpx.ConnectError("refused")

    with pytest.raises(supadata.CaptionsError, match="unavailable right now"):
        supadata.fetch_captions(URL)

    assert get.call_count == supadata.ATTEMPTS


def test_a_wrong_key_isnt_retried_or_shown(get):
    get.return_value = answer(401, {"error": "unauthorized", "message": "Bad key"})

    with pytest.raises(supadata.CaptionsError) as raised:
        supadata.fetch_captions(URL)

    assert str(raised.value) == supadata.UNAVAILABLE
    assert get.call_count == 1
