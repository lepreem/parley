"""Entrypoint: run the preflight, then consume both fetch queues until SIGTERM."""

import logging
import signal

from contract import contract
from handlers import handle_fetch_youtube_audio, handle_fetch_youtube_captions
from message_queue import mq
from startup import verify_fetcher_services

log = logging.getLogger(__name__)

# A caption fetch is one small request to YouTube, so a queue of them clears
# quickly, and on its own queue it never waits behind an audio download. Every
# fetch goes out from the server's one IP, though, and YouTube blocks IPs that
# ask for too many transcripts.
CAPTIONS_PREFETCH = 5

# An audio fetch downloads up to 50 MB and uploads it again, while yt-dlp runs
# a JS runtime to get past YouTube's player challenge, all inside the
# container's 1 GB (compose.prod.yaml). Raise this once production shows
# there's room.
AUDIO_PREFETCH = 3


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    verify_fetcher_services()

    # Raise in the main thread so start_consuming unwinds; calling
    # stop_consuming from inside the connection's own I/O loop hangs.
    def stop(signum: int, frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)

    try:
        mq.consume(
            contract.queues.FETCH_YOUTUBE_CAPTIONS,
            handle_fetch_youtube_captions,
            prefetch=CAPTIONS_PREFETCH,
        )
        mq.consume(
            contract.queues.FETCH_YOUTUBE_AUDIO,
            handle_fetch_youtube_audio,
            prefetch=AUDIO_PREFETCH,
        )
        mq.run()
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        mq.close()


if __name__ == "__main__":
    main()
