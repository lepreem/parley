# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "faster-whisper==1.2.1",
#   # PyAV 19 dropped an argument faster-whisper 1.2.1 passes when it opens
#   # the audio, so every transcription would fail with a TypeError.
#   "av<19",
# ]
# ///
"""
Transcribes one audio file with faster-whisper, for the API's transcription
handler, which runs it with `uv run --script` so uv installs what the header
above declares.

Prints one JSON object per line, one per segment as it's transcribed:
{"start": seconds, "end": seconds, "text": "..."}. Models are downloaded into
--models-dir the first time they're used.

With --check it only loads faster-whisper: the API's startup check, so a
first run installs the dependencies at startup rather than during a job.
"""

import argparse
import json


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--model")
    parser.add_argument("--models-dir")
    parser.add_argument("audio", nargs="?")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    if args.check:
        return

    model = WhisperModel(
        args.model,
        device="auto",
        compute_type="auto",
        download_root=args.models_dir,
    )
    # Skips the stretches without speech, where Whisper tends to invent text.
    segments, _info = model.transcribe(args.audio, vad_filter=True)
    for segment in segments:
        print(
            json.dumps(
                {"start": segment.start, "end": segment.end, "text": segment.text}
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
