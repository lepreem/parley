"""Event handlers: fetch YouTube captions or audio and queue transcription."""

import functools
import logging
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

import yt_dlp
from youtube_transcript_api import CouldNotRetrieveTranscript, YouTubeTranscriptApi
from yt_dlp.extractor.youtube import YoutubeIE

import bucket
from contract import contract
from message_queue import mq

log = logging.getLogger(__name__)

# YouTube's media CDN intermittently rejects a signed download URL with 403,
# and the same URL will keep being rejected — so a retry has to re-extract to
# get fresh ones, which is why the whole fetch is retried rather than the
# request. Handlers run off the AMQP I/O thread (message_queue.consume), so
# sleeping here does not stall heartbeats.
FETCH_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 2

# Failures no amount of retrying will fix; retrying them only delays the job
# being marked failed. Matched against the message because yt-dlp raises one
# DownloadError type for everything.
PERMANENT_FAILURES = (
    "video unavailable",
    "private video",
    "removed by the uploader",
    "members-only",
    "sign in to confirm your age",
    "no video formats found",
    "unsupported url",
    "is not a valid url",
)

# Stored as the object's content type: the bucket only takes audio/* types,
# and storage serves it with the file when Deepgram fetches it.
EXT_CONTENT_TYPES = {
    "webm": "audio/webm",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "ogg": "audio/ogg",
    "wav": "audio/wav",
    "flac": "audio/flac",
}


def _is_retryable(error: Exception) -> bool:
    """Only yt-dlp download failures are worth another extraction. Our own
    RuntimeErrors (oversized audio, no output file) are deterministic."""
    if not isinstance(error, yt_dlp.utils.DownloadError):
        return False
    message = str(error).lower()
    return not any(marker in message for marker in PERMANENT_FAILURES)


def _fetch_with_retries(audio_upload_id: str, url: str, user_id: str) -> None:
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            _fetch_and_upload(audio_upload_id, url, user_id)
            return
        except Exception as error:
            if attempt == FETCH_ATTEMPTS or not _is_retryable(error):
                raise
            backoff = RETRY_BACKOFF_SECONDS * attempt
            log.warning(
                "Fetch %s attempt %d/%d failed (%s); re-extracting in %ds",
                audio_upload_id,
                attempt,
                FETCH_ATTEMPTS,
                str(error)[:200],
                backoff,
            )
            time.sleep(backoff)


def _fetch_captions(url: str) -> list[dict] | None:
    """The video's first caption track, one segment per caption line in the
    shape the API's TranscriptSegment takes ({"start", "end", "text"}, in
    seconds), or None when it has none worth using. The segments travel in the
    yt_save_captions message itself: even a many-hour video's captions are a
    few hundred KB."""
    video_id = YoutubeIE.extract_id(url)

    try:
        transcripts = YouTubeTranscriptApi().list(video_id)
        selected_transcript = next(iter(transcripts), None)
        if selected_transcript is None:
            return None
        fetched_transcript = selected_transcript.fetch()
    except CouldNotRetrieveTranscript as error:
        log.info("No usable captions for %s: %s", video_id, error)
        return None

    segments = [
        {
            "start": snippet.start,
            "end": snippet.start + snippet.duration,
            "text": snippet.text.strip(),
        }
        for snippet in fetched_transcript
        if snippet.text.strip()
    ]
    if not segments:
        log.info("Caption track for %s was empty", video_id)
        return None

    log.info(
        "Fetched %s captions for %s: %d segments",
        selected_transcript.language_code,
        video_id,
        len(segments),
    )
    return segments


def _fails_the_job(handler: Callable[[dict], None]) -> Callable[[dict], None]:
    """Tell the API when a fetch fails, so it can mark the job row failed. A
    malformed payload (missing url/userId) must still fail the job if we know
    which one it is. Re-raises so the dispatcher drops the message."""

    @functools.wraps(handler)
    def handle(event: dict) -> None:
        try:
            handler(event)
        except Exception as error:
            if isinstance(event, dict) and event.get("audioUploadId"):
                mq.publish_threadsafe(
                    contract.queues.YT_FAIL_JOB,
                    {
                        "audioUploadId": event["audioUploadId"],
                        "userId": event.get("userId", ""),
                        "error": str(error)[:500],
                    },
                )
            raise

    return handle


@_fails_the_job
def handle_yt_fetch_captions(event: dict) -> None:
    """Send the video's captions back as its transcript, or, when it has
    none, queue its audio to be fetched instead."""
    audio_upload_id: str = event["audioUploadId"]
    url: str = event["url"]
    user_id: str = event["userId"]

    segments = _fetch_captions(url)
    if segments:
        mq.publish_threadsafe(
            contract.queues.YT_SAVE_CAPTIONS,
            {"audioUploadId": audio_upload_id, "segments": segments},
        )
        log.info("Fetched captions for %s, queued yt_save_captions", audio_upload_id)
        return

    # Inside the handler: a fallback the broker refuses must fail the job, or
    # it would sit queued with nothing coming for it.
    mq.publish_threadsafe(
        contract.queues.YT_FETCH_AUDIO,
        {"audioUploadId": audio_upload_id, "url": url, "userId": user_id},
    )
    log.info("No captions for %s, queued yt_fetch_audio", audio_upload_id)


@_fails_the_job
def handle_yt_fetch_audio(event: dict) -> None:
    """Store the video's audio and queue it to be transcribed."""
    audio_upload_id: str = event["audioUploadId"]
    url: str = event["url"]
    user_id: str = event["userId"]

    _fetch_with_retries(audio_upload_id, url, user_id)
    # Inside the handler: a transcribe_audio the broker refuses must fail the
    # job, or it would sit queued with nothing coming for it.
    mq.publish_threadsafe(
        contract.queues.TRANSCRIBE_AUDIO,
        {"audioUploadId": audio_upload_id},
    )
    log.info("Fetched %s, queued transcribe_audio", audio_upload_id)


def _fetch_and_upload(audio_upload_id: str, url: str, user_id: str) -> None:
    max_bytes = contract.maxAudioBytes

    with tempfile.TemporaryDirectory() as tmp:
        options = {
            # Lowest-bitrate audio-only stream: STT downsamples to 16kHz mono,
            # so anything above ~48kbps is discarded work, and every byte
            # counts against the 50 MB storage limit.
            "format": "worstaudio/bestaudio/best",
            "outtmpl": f"{tmp}/audio.%(ext)s",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            # Same cap the API enforces on direct uploads (from /contract).
            # yt-dlp aborts the download when the limit is known up front.
            "max_filesize": max_bytes,
            # YouTube's media CDN can reject non-ranged downloads with 403.
            "http_chunk_size": 1024 * 1024,
            # A stalled connection shouldn't hold one of the audio queue's
            # few slots hostage; yt-dlp retries after a timeout.
            "socket_timeout": 30,
            # YouTube signs its media URLs with an `n` parameter that has to be
            # descrambled by running their player JS. yt-dlp only enables deno
            # by default; naming node as well means whichever exists is used.
            # Without a runtime (and the yt-dlp-ejs solver) metadata still
            # resolves and the download 403s, which reads as a network fault
            # and is not one.
            "js_runtimes": {"deno": {}, "node": {}},
            # The media servers also want a proof-of-origin token, minted by
            # the bgutil provider in requirements.txt. Client choice is not
            # cosmetic here: web and web_safari now return SABR-only formats
            # carrying no URL, and android_vr is refused even with a valid
            # token. web_embedded is the one whose formats have URLs *and*
            # accept the token.
            "extractor_args": {"youtube": {"player_client": ["web_embedded"]}},
        }
        with yt_dlp.YoutubeDL(options) as ydl:
            # Probe metadata first so oversized audio is rejected before any
            # bytes are downloaded.
            info = ydl.extract_info(url, download=False)
            if info and isinstance(info, dict):
                formats = info.get("requested_formats") or [info]
                expected = sum(
                    f.get("filesize") or f.get("filesize_approx") or 0 for f in formats
                )
                if expected > max_bytes:
                    raise RuntimeError(
                        f"audio is ~{expected} bytes, over the {max_bytes}-byte limit"
                    )

            ydl.download([url])

        # An aborted download (e.g. max_filesize hit mid-transfer) leaves a
        # truncated *.part file behind — never upload those.
        files = [
            p
            for p in Path(tmp).iterdir()
            if p.is_file() and not p.name.endswith((".part", ".ytdl"))
        ]

        if not files:
            raise RuntimeError(
                "yt-dlp produced no output file"
                f" (audio may exceed the {max_bytes // (1024 * 1024)}MB limit"
                " or the video may be unavailable)"
            )

        audio = files[0]
        size = audio.stat().st_size
        # Backstop: filesize/filesize_approx can be missing or undershoot, and
        # max_filesize can't abort formats whose size isn't known up front.
        if size > max_bytes:
            raise RuntimeError(
                f"audio is {size} bytes, over the {max_bytes}-byte limit"
            )
        content_type = EXT_CONTENT_TYPES.get(
            audio.suffix.removeprefix(".").lower(), "audio/mpeg"
        )
        log.info("Downloaded %s: %d bytes, %s", audio_upload_id, size, content_type)
        # upload_audio builds the "<userId>/audios/<storageObjectId>" key (same
        # convention as direct uploads, objectPath in backend/src/storage/core.ts),
        # so transcription finds it and ownership stays structural.
        bucket.upload_audio(user_id, audio_upload_id, str(audio), content_type)
