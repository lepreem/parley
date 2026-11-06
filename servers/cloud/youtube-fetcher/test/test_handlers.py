import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock

import pytest
import yt_dlp

import handlers
from contract import QueueName, _Queues, contract

MAX_BYTES = 1000
CAPTIONS = {
    "segments": [{"start": 0.0, "end": 1.5, "text": "the captions"}],
    "language": "de",
}


@pytest.fixture(autouse=True)
def fake_contract():
    # The contract singleton is normally populated by the startup preflight.
    contract.queues = _Queues(
        YT_FETCH_CAPTIONS=QueueName("yt_fetch_captions"),
        YT_FETCH_AUDIO=QueueName("yt_fetch_audio"),
        YT_CANCEL_FETCH=QueueName("yt_cancel_fetch"),
        YT_SAVE_CAPTIONS=QueueName("yt_save_captions"),
        TRANSCRIBE_AUDIO=QueueName("transcribe_audio"),
        YT_FAIL_JOB=QueueName("yt_fail_job"),
    )
    contract.bucket = "uploads"
    contract.maxAudioBytes = MAX_BYTES


@pytest.fixture
def publish(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr(handlers.mq, "publish_threadsafe", mock)
    return mock


@pytest.fixture
def upload(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr(handlers.bucket, "upload_audio", mock)
    return mock


class FakeYDL:
    """Stands in for yt_dlp.YoutubeDL: "downloads" by writing the preset
    files into the outtmpl directory. Tests override the class attributes."""

    info: ClassVar[dict] = {"filesize": 10}
    files: ClassVar[dict[str, bytes]] = {"audio.webm": b"x" * 10}
    last: ClassVar[FakeYDL | None] = None

    def __init__(self, options):
        self.options = options
        type(self).last = self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=False):
        return self.info

    def download(self, urls):
        out_dir = Path(self.options["outtmpl"]).parent
        for name, content in self.files.items():
            (out_dir / name).write_bytes(content)


@pytest.fixture
def ydl(monkeypatch):
    class YDL(FakeYDL):
        pass

    monkeypatch.setattr(handlers.yt_dlp, "YoutubeDL", YDL)
    return YDL


class TestFetchAndUpload:
    def test_uploads_audio_with_derived_content_type(self, ydl, upload):
        handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")

        (user_id, audio_upload_id, local_path, content_type), _ = upload.call_args
        assert user_id == "usr"
        assert audio_upload_id == "u1"
        assert local_path.endswith("audio.webm")
        assert content_type == "audio/webm"

    def test_enforces_contract_size_cap_in_ydl_options(self, ydl, upload):
        handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")

        assert ydl.last.options["max_filesize"] == MAX_BYTES
        assert ydl.last.options["noplaylist"] is True

    def test_downloads_in_small_http_chunks(self, ydl, upload):
        handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")

        assert ydl.last.options["http_chunk_size"] == 1024 * 1024

    def test_rejects_oversized_audio_before_downloading(self, ydl, upload):
        ydl.info = {"filesize": MAX_BYTES + 1}
        ydl.files = {}

        with pytest.raises(RuntimeError, match="over the"):
            handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")
        upload.assert_not_called()

    def test_sums_sizes_across_requested_formats(self, ydl, upload):
        ydl.info = {
            "requested_formats": [
                {"filesize": 600},
                {"filesize_approx": 600},
            ]
        }
        ydl.files = {}

        with pytest.raises(RuntimeError, match="over the"):
            handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")
        upload.assert_not_called()

    def test_never_uploads_partial_download_leftovers(self, ydl, upload):
        # A download aborted mid-transfer leaves *.part (and sometimes the
        # *.ytdl resume-state sidecar) behind, with no finished file.
        ydl.info = {}
        ydl.files = {
            "audio.webm.part": b"x" * 5,
            "audio.webm.ytdl": b"{}",
        }

        with pytest.raises(RuntimeError, match="no output file"):
            handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")
        upload.assert_not_called()

    def test_picks_finished_file_over_stale_partials(self, ydl, upload):
        ydl.files = {
            "audio.webm": b"x" * 10,
            "audio.webm.part": b"x" * 5,
        }

        handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")

        (_, _, local_path, content_type), _ = upload.call_args
        assert local_path.endswith("audio.webm")
        assert content_type == "audio/webm"

    def test_size_backstop_when_metadata_had_no_size(self, ydl, upload):
        ydl.info = {}
        ydl.files = {"audio.webm": b"x" * (MAX_BYTES + 1)}

        with pytest.raises(RuntimeError, match="over the"):
            handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")
        upload.assert_not_called()

    def test_unknown_extension_falls_back_to_mpeg(self, ydl, upload):
        ydl.files = {"audio.weird": b"x" * 10}

        handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")

        (_, _, _, content_type), _ = upload.call_args
        assert content_type == "audio/mpeg"


EVENT = {"audioUploadId": "u1", "url": "https://youtu.be/x", "userId": "usr"}


@pytest.fixture(autouse=True)
def forget_cancelled():
    handlers._cancelled.clear()


CANCELLED_EVENT = {"audioUploadId": "u1"}


class TestCancelledFetch:
    def test_skips_a_job_cancelled_before_its_fetch_arrived(self, ydl, upload, publish):
        handlers.handle_yt_cancel_fetch(CANCELLED_EVENT)

        handlers.handle_yt_fetch_audio(EVENT)

        assert ydl.last is None
        upload.assert_not_called()
        publish.assert_not_called()

    def test_skips_captions_for_a_job_cancelled_before_its_fetch_arrived(
        self, publish, monkeypatch
    ):
        caption_fetch = MagicMock()
        monkeypatch.setattr(handlers.supadata, "fetch_captions", caption_fetch)
        handlers.handle_yt_cancel_fetch(CANCELLED_EVENT)

        handlers.handle_yt_fetch_captions(EVENT)

        caption_fetch.assert_not_called()
        publish.assert_not_called()

    def test_sends_nothing_when_cancelled_while_fetching_captions(
        self, publish, monkeypatch
    ):
        def caption_fetch(_url):
            handlers.handle_yt_cancel_fetch(CANCELLED_EVENT)
            return CAPTIONS

        monkeypatch.setattr(handlers.supadata, "fetch_captions", caption_fetch)

        handlers.handle_yt_fetch_captions(EVENT)

        publish.assert_not_called()

    def test_stores_nothing_when_cancelled_as_the_download_ends(
        self, ydl, upload, publish, monkeypatch
    ):
        class CancelledAsItEnds(ydl):
            def download(self, urls):
                super().download(urls)
                handlers.handle_yt_cancel_fetch(CANCELLED_EVENT)

        monkeypatch.setattr(handlers.yt_dlp, "YoutubeDL", CancelledAsItEnds)

        handlers.handle_yt_fetch_audio(EVENT)

        upload.assert_not_called()
        publish.assert_not_called()

    def test_doesnt_retry_a_cancelled_fetch(self, monkeypatch):
        fetch = MagicMock(side_effect=handlers.JobCancelled("u1"))
        monkeypatch.setattr(handlers, "_fetch_and_upload", fetch)

        with pytest.raises(handlers.JobCancelled):
            handlers._fetch_with_retries("u1", "https://youtu.be/x", "usr")

        assert fetch.call_count == 1

    def test_forgets_a_cancel_once_it_expires(self, monkeypatch):
        handlers.handle_yt_cancel_fetch(CANCELLED_EVENT)
        later = handlers.time.monotonic() + handlers.CANCELLED_TTL_SECONDS + 1
        monkeypatch.setattr(handlers.time, "monotonic", lambda: later)

        handlers.handle_yt_cancel_fetch({"audioUploadId": "u2"})

        assert list(handlers._cancelled) == ["u2"]

    def test_really_stops_yt_dlp_midway(self, upload, publish, monkeypatch, caplog):
        """Against the real yt-dlp: a fake couldn't show that an exception from
        a progress hook gets out of it, rather than being retried or wrapped."""

        class Audio(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(MAX_BYTES))
                self.end_headers()
                self.wfile.write(b"x" * MAX_BYTES)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Audio)
        threading.Thread(target=server.serve_forever, daemon=True).start()

        real_download = yt_dlp.YoutubeDL.download

        def cancel_then_download(ydl_self, urls):
            handlers.handle_yt_cancel_fetch(CANCELLED_EVENT)
            return real_download(ydl_self, urls)

        monkeypatch.setattr(yt_dlp.YoutubeDL, "download", cancel_then_download)
        caplog.set_level("INFO", logger=handlers.log.name)

        try:
            handlers.handle_yt_fetch_audio(
                {
                    **EVENT,
                    "url": f"http://127.0.0.1:{server.server_port}/a.mp3",
                }
            )
        finally:
            server.shutdown()

        assert "Stopped the fetch for cancelled job" in caplog.text
        # The check after the download comes later than this line, so its
        # absence means the hook is what stopped it.
        assert "Downloaded u1" not in caplog.text
        upload.assert_not_called()
        publish.assert_not_called()


class TestHandleYtFetchCaptions:
    def test_captions_travel_in_the_yt_save_captions_message(
        self, publish, monkeypatch
    ):
        caption_fetch = MagicMock(return_value=CAPTIONS)
        audio_fetch = MagicMock()
        monkeypatch.setattr(handlers.supadata, "fetch_captions", caption_fetch)
        monkeypatch.setattr(handlers, "_fetch_with_retries", audio_fetch)

        handlers.handle_yt_fetch_captions(EVENT)

        caption_fetch.assert_called_once_with("https://youtu.be/x")
        audio_fetch.assert_not_called()
        publish.assert_called_once_with(
            QueueName("yt_save_captions"),
            {"audioUploadId": "u1", **CAPTIONS},
        )

    def test_a_video_without_captions_fails_the_job(self, publish, monkeypatch):
        audio_fetch = MagicMock()
        monkeypatch.setattr(
            handlers.supadata, "fetch_captions", MagicMock(return_value=None)
        )
        monkeypatch.setattr(handlers, "_fetch_with_retries", audio_fetch)

        with pytest.raises(handlers.supadata.CaptionsError):
            handlers.handle_yt_fetch_captions(EVENT)

        # YouTube won't give the server the audio, so there is no fallback.
        audio_fetch.assert_not_called()
        publish.assert_called_once_with(
            QueueName("yt_fail_job"),
            {
                "audioUploadId": "u1",
                "userId": "usr",
                "error": handlers.supadata.NO_CAPTIONS,
            },
        )

    def test_caption_fetch_failure_fails_the_job(self, publish, monkeypatch):
        monkeypatch.setattr(
            handlers.supadata,
            "fetch_captions",
            MagicMock(side_effect=RuntimeError("boom")),
        )

        with pytest.raises(RuntimeError, match="boom"):
            handlers.handle_yt_fetch_captions(EVENT)

        publish.assert_called_once_with(
            QueueName("yt_fail_job"),
            {"audioUploadId": "u1", "userId": "usr", "error": "boom"},
        )


class TestHandleYtFetchAudio:
    def test_success_queues_transcribe_audio(self, publish, monkeypatch):
        audio_fetch = MagicMock()
        monkeypatch.setattr(handlers, "_fetch_with_retries", audio_fetch)

        handlers.handle_yt_fetch_audio(EVENT)

        audio_fetch.assert_called_once_with("u1", "https://youtu.be/x", "usr")
        publish.assert_called_once_with(
            QueueName("transcribe_audio"),
            {"audioUploadId": "u1"},
        )

    def test_never_fetches_captions(self, publish, monkeypatch):
        caption_fetch = MagicMock(return_value=CAPTIONS)
        monkeypatch.setattr(handlers.supadata, "fetch_captions", caption_fetch)
        monkeypatch.setattr(handlers, "_fetch_with_retries", MagicMock())

        handlers.handle_yt_fetch_audio(EVENT)

        caption_fetch.assert_not_called()

    def test_failure_notifies_api_and_reraises(self, publish, monkeypatch):
        monkeypatch.setattr(
            handlers,
            "_fetch_with_retries",
            MagicMock(side_effect=RuntimeError("boom")),
        )

        with pytest.raises(RuntimeError, match="boom"):
            handlers.handle_yt_fetch_audio(EVENT)

        publish.assert_called_once_with(
            QueueName("yt_fail_job"),
            {"audioUploadId": "u1", "userId": "usr", "error": "boom"},
        )

    def test_youtubes_bot_check_reads_as_a_block(self, publish, monkeypatch):
        bot_check = yt_dlp.utils.DownloadError(
            "ERROR: [youtube] x: Sign in to confirm you\u2019re not a bot."
            " Use --cookies-from-browser or --cookies for the authentication."
        )
        monkeypatch.setattr(
            handlers, "_fetch_with_retries", MagicMock(side_effect=bot_check)
        )

        with pytest.raises(RuntimeError, match="won't let Parley"):
            handlers.handle_yt_fetch_audio(EVENT)

        (_, payload), _ = publish.call_args
        assert payload["error"] == handlers.AUDIO_BLOCKED

    def test_refused_transcribe_publish_fails_the_job(self, publish, monkeypatch):
        monkeypatch.setattr(handlers, "_fetch_with_retries", MagicMock())
        # The transcribe_audio publish is refused; the failure report goes
        # through.
        publish.side_effect = [RuntimeError("nacked"), None]

        with pytest.raises(RuntimeError, match="nacked"):
            handlers.handle_yt_fetch_audio(EVENT)

        publish.assert_called_with(
            QueueName("yt_fail_job"),
            {"audioUploadId": "u1", "userId": "usr", "error": "nacked"},
        )

    def test_failure_error_message_is_truncated(self, publish, monkeypatch):
        monkeypatch.setattr(
            handlers,
            "_fetch_with_retries",
            MagicMock(side_effect=RuntimeError("x" * 600)),
        )

        with pytest.raises(RuntimeError):
            handlers.handle_yt_fetch_audio(EVENT)

        (_, payload), _ = publish.call_args
        assert len(payload["error"]) == 500


@pytest.mark.parametrize(
    "handler",
    [handlers.handle_yt_fetch_captions, handlers.handle_yt_fetch_audio],
)
class TestMalformedPayloads:
    def test_one_with_an_audio_upload_id_still_fails_the_job(self, handler, publish):
        with pytest.raises(KeyError):
            handler({"audioUploadId": "u1"})  # no url

        (queue, payload), _ = publish.call_args
        assert queue == "yt_fail_job"
        assert payload["audioUploadId"] == "u1"
        assert payload["userId"] == ""

    def test_an_unidentifiable_one_is_not_reported(self, handler, publish):
        with pytest.raises(KeyError):
            handler({})

        publish.assert_not_called()


class TestFetchWithRetries:
    """The CDN rejects a signed media URL with 403 often enough that a single
    attempt is not enough. Each retry must re-run the whole fetch, because the
    rejected URL is the thing that failed."""

    @pytest.fixture(autouse=True)
    def no_sleep(self, monkeypatch):
        monkeypatch.setattr(handlers.time, "sleep", lambda _seconds: None)

    def transient(self):
        return yt_dlp.utils.DownloadError(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden"
        )

    def test_retries_a_transient_failure_until_it_succeeds(self, monkeypatch):
        fetch = MagicMock(side_effect=[self.transient(), self.transient(), None])
        monkeypatch.setattr(handlers, "_fetch_and_upload", fetch)

        handlers._fetch_with_retries("u1", "https://youtu.be/x", "usr")

        assert fetch.call_count == 3

    def test_gives_up_after_the_attempt_limit(self, monkeypatch):
        fetch = MagicMock(side_effect=self.transient())
        monkeypatch.setattr(handlers, "_fetch_and_upload", fetch)

        with pytest.raises(yt_dlp.utils.DownloadError):
            handlers._fetch_with_retries("u1", "https://youtu.be/x", "usr")

        assert fetch.call_count == handlers.FETCH_ATTEMPTS

    def test_does_not_retry_a_permanently_unavailable_video(self, monkeypatch):
        fetch = MagicMock(
            side_effect=yt_dlp.utils.DownloadError("ERROR: Video unavailable")
        )
        monkeypatch.setattr(handlers, "_fetch_and_upload", fetch)

        with pytest.raises(yt_dlp.utils.DownloadError):
            handlers._fetch_with_retries("u1", "https://youtu.be/x", "usr")

        assert fetch.call_count == 1

    def test_does_not_retry_youtubes_bot_check(self, monkeypatch):
        # A block on the server's IP outlasts any retry.
        fetch = MagicMock(
            side_effect=yt_dlp.utils.DownloadError(
                "ERROR: [youtube] x: Sign in to confirm you\u2019re not a bot."
            )
        )
        monkeypatch.setattr(handlers, "_fetch_and_upload", fetch)

        with pytest.raises(yt_dlp.utils.DownloadError):
            handlers._fetch_with_retries("u1", "https://youtu.be/x", "usr")

        assert fetch.call_count == 1

    def test_does_not_retry_our_own_deterministic_failures(self, monkeypatch):
        # Oversized audio fails identically every time; retrying only delays
        # marking the job failed.
        fetch = MagicMock(side_effect=RuntimeError("audio is 999 bytes, over"))
        monkeypatch.setattr(handlers, "_fetch_and_upload", fetch)

        with pytest.raises(RuntimeError):
            handlers._fetch_with_retries("u1", "https://youtu.be/x", "usr")

        assert fetch.call_count == 1


class TestYoutubeAccess:
    """The options that decide whether YouTube serves us at all. Each of these
    fails the same way when wrong — metadata resolves, then the media download
    returns 403 — so they are asserted rather than left to be rediscovered."""

    def test_names_node_alongside_deno_as_a_js_runtime(self, ydl, upload):
        # The `n` parameter in a media URL is descrambled by running YouTube's
        # player JS; yt-dlp enables only deno by default.
        handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")

        assert set(ydl.last.options["js_runtimes"]) == {"deno", "node"}

    def test_uses_the_one_client_whose_formats_are_downloadable(self, ydl, upload):
        # web and web_safari return SABR-only formats with no URL; android_vr
        # is refused even holding a valid proof-of-origin token.
        handlers._fetch_and_upload("u1", "https://youtu.be/x", "usr")

        assert ydl.last.options["extractor_args"] == {
            "youtube": {"player_client": ["web_embedded"]}
        }
