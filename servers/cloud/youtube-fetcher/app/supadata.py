"""YouTube captions through Supadata (https://supadata.ai), which fetches them
from its own IPs: YouTube blocks the server's own, a datacenter's, from both
the caption and the media endpoints. Every request spends one of the plan's
monthly credits, whatever the video's length, and so does an answer that the
video has no captions; one for a video that doesn't exist does not."""

import logging
import random
import time

import httpx

from env import env

log = logging.getLogger(__name__)

API_URL = "https://api.supadata.ai/v1"

# Answers took 1 to 7 seconds when measured, on videos up to two hours long.
TIMEOUT_SECONDS = 60

# The free plan answers one request a second and the captions queue runs five
# at once, so a burst gets 429s ("limit-exceeded"). Waits grow and are spread
# at random, so the jobs that collided don't all come back together.
ATTEMPTS = 5
RETRY_BACKOFF_SECONDS = 1

# Shown to the person as the job's error.
NO_CAPTIONS = (
    "This video has no captions, and Parley can't download YouTube audio yet."
    " Upload the audio or video file instead."
)
NOT_FOUND = "This video doesn't exist, or YouTube won't show it."
USED_UP = (
    "Parley has used this month's YouTube allowance."
    " Upload the audio or video file instead."
)
# A 429 after every retry: a long burst, or, possibly, credits run out.
BUSY = (
    "Parley is fetching too many YouTube videos right now, or has used this"
    " month's allowance. Try again later, or upload the audio or video file."
)
UNAVAILABLE = "YouTube captions are unavailable right now. Try again later."


class CaptionsError(Exception):
    """A fetch that failed for a reason the person should be told."""


def _headers() -> dict[str, str]:
    return {"x-api-key": env.get("SUPADATA_API_KEY")}


def ping() -> None:
    """Startup check: raises if the key is wrong. Spends no credit."""
    httpx.get(f"{API_URL}/me", headers=_headers(), timeout=10).raise_for_status()


def _error_code(response: httpx.Response) -> str | None:
    """Supadata's own name for what went wrong, e.g. "transcript-unavailable".
    Read whatever the status, since it isn't always a 4xx."""
    try:
        body = response.json()
    except ValueError:
        return None
    return body.get("error") if isinstance(body, dict) else None


def _worth_retrying(response: httpx.Response | None) -> bool:
    if response is None:
        return True
    return response.status_code == 429 or response.status_code >= 500


def _get_transcript(url: str) -> httpx.Response:
    params = {
        "url": url,
        # Only captions YouTube already has: the other modes have Supadata
        # transcribe the audio itself, at a credit per half minute.
        "mode": "native",
        # Parley is English first. A video with no English track answers in
        # the language it has, which is the one spoken: German news came back
        # German.
        "lang": "en",
    }
    response = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            response = httpx.get(
                f"{API_URL}/transcript",
                params=params,
                headers=_headers(),
                timeout=TIMEOUT_SECONDS,
            )
        except httpx.TransportError as error:
            log.warning("Supadata unreachable (attempt %d): %s", attempt, error)
            response = None
        if not _worth_retrying(response):
            return response
        if attempt < ATTEMPTS:
            time.sleep(RETRY_BACKOFF_SECONDS * attempt + random.uniform(0, 1))
    if response is None:
        raise CaptionsError(UNAVAILABLE)
    return response


def _is_made_up(content: list[dict]) -> bool:
    """Seen once, on a rain video with captions disabled: rather than saying
    there were none, Supadata answered with one invented English sentence
    about a cabin by a lake. Its timing was in seconds (9.9) where every real
    answer gives whole milliseconds, which is what gives it away."""
    return any(
        not float(line.get(field, 0)).is_integer()
        for line in content
        for field in ("offset", "duration")
    )


def fetch_captions(url: str) -> dict | None:
    """The video's captions as the yt_save_captions message carries them, or
    None when it has none: "segments", one per caption line in the shape the
    API's TranscriptSegment takes ({"start", "end", "text"}, in seconds), and
    "language", the track's language code. Raises CaptionsError for a failure
    the person should hear about."""
    response = _get_transcript(url)
    code = _error_code(response)

    # Untested, since no account here has run out: 402 is the usual status.
    if response.status_code == 402:
        log.error("Supadata credits are used up: %s", response.text[:300])
        raise CaptionsError(USED_UP)
    if response.status_code == 429:
        log.error("Supadata still refused after retries: %s", response.text[:300])
        raise CaptionsError(BUSY)
    if code == "transcript-unavailable":
        return None
    if code == "not-found":
        raise CaptionsError(NOT_FOUND)
    if response.status_code == 202:
        # The answer to a transcription Supadata runs itself, which "native"
        # should never start.
        log.error("Supadata started a job for %s: %s", url, response.text[:300])
        raise CaptionsError(UNAVAILABLE)
    if not response.is_success:
        log.error(
            "Supadata answered %d for %s: %s",
            response.status_code,
            url,
            response.text[:300],
        )
        raise CaptionsError(UNAVAILABLE)

    body = response.json()
    content = body.get("content")
    if not isinstance(content, list):
        log.error("Supadata sent no caption lines for %s: %s", url, str(body)[:300])
        raise CaptionsError(UNAVAILABLE)
    if _is_made_up(content):
        log.warning("Supadata made up captions for %s: %s", url, str(body)[:300])
        return None

    segments = [
        {
            "start": line["offset"] / 1000,
            "end": (line["offset"] + line["duration"]) / 1000,
            "text": line["text"].strip(),
        }
        for line in content
        if line.get("text", "").strip()
    ]
    if not segments:
        return None
    return {"segments": segments, "language": body.get("lang")}
