import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { youtubeWatchUrl } from "@parley/contract/youtube";
import { fetchJobAudio, type Job } from "../../api/jobs";
import { errorMessage } from "../../api/http";
import { serverUrl } from "../../api/server";
import { useServer } from "../../hooks/server/useServer";
import { audioCopies } from "../../media/audioCopies";
import { classifyFile, MEDIA_ACCEPT } from "../../media/fileKind";
import { prepareSpeech, preparedSpeechName } from "../../media/speech";
import { youtubeEmbedUrl } from "../../media/youtube";

type MediaKind = "audio" | "video";

/**
 * Where getting a source's audio has got to. A copy in this browser plays
 * straight away; otherwise the server's is fetched on request, and once the
 * server no longer has it the user can pick the original file again.
 */
type Playback =
  | { state: "checking" }
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; url: string; autoPlay: boolean }
  | { state: "gone" }
  | { state: "mismatch"; file: File; kind: MediaKind }
  | { state: "preparing" }
  | { state: "failed"; message: string };

const buttonClass =
  "rounded-md border border-line px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:border-signal hover:text-ink";

function AudioPlayback({
  audioUploadId,
  fileName,
}: {
  audioUploadId: string;
  fileName: string;
}) {
  const server = useServer();
  const [playback, setPlayback] = useState<Playback>({ state: "checking" });
  const inputRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  const play = useCallback((audio: Blob, autoPlay: boolean) => {
    if (!mountedRef.current) return;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(audio);
    urlRef.current = url;
    setPlayback({ state: "ready", url, autoPlay });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void audioCopies.load(audioUploadId).then((audio) => {
      if (cancelled) return;
      if (audio) play(audio, false);
      else setPlayback({ state: "idle" });
    });
    return () => {
      cancelled = true;
    };
  }, [audioUploadId, play]);

  /** Fetches the server's copy, and keeps it here for once the server's is gone. */
  const loadFromServer = async () => {
    setPlayback({ state: "loading" });
    try {
      const { url } = await fetchJobAudio(server, audioUploadId);
      if (!url) {
        setPlayback({ state: "gone" });
        return;
      }
      const response = await fetch(serverUrl(server, url));
      if (!response.ok) throw new Error("Couldn't load the audio.");
      const audio = await response.blob();
      void audioCopies.save(audioUploadId, audio).catch(() => {});
      play(audio, true);
    } catch (error) {
      setPlayback({
        state: "failed",
        message: errorMessage(error, "Couldn't load the audio."),
      });
    }
  };

  /** Prepares a picked file the way its upload was, and keeps that copy. */
  const prepareAndPlay = async (file: File, kind: MediaKind) => {
    setPlayback({ state: "preparing" });
    try {
      const speech = await prepareSpeech(file, kind);
      void audioCopies.save(audioUploadId, speech).catch(() => {});
      play(speech, true);
    } catch (error) {
      setPlayback({
        state: "failed",
        message: errorMessage(error, "Couldn't read that file."),
      });
    }
  };

  const onPicked = (file: File) => {
    const kind = classifyFile(file);
    if (kind !== "audio" && kind !== "video") {
      setPlayback({
        state: "failed",
        message: `${file.name} isn't an audio or video file.`,
      });
      return;
    }
    // The upload named the source after the file it was prepared from.
    if (preparedSpeechName(file.name, kind) !== fileName) {
      setPlayback({ state: "mismatch", file, kind });
      return;
    }
    void prepareAndPlay(file, kind);
  };

  const locate = () => inputRef.current?.click();
  const locateButton = (
    <button type="button" onClick={locate} className={buttonClass}>
      Locate file
    </button>
  );

  let body: ReactNode = null;
  switch (playback.state) {
    case "checking":
      break;
    case "idle":
      body = (
        <button
          type="button"
          onClick={() => void loadFromServer()}
          className={buttonClass}
        >
          Play audio
        </button>
      );
      break;
    case "loading":
      body = <p className="text-[12px] text-faint">Loading audio…</p>;
      break;
    case "ready":
      body = (
        <audio
          controls
          autoPlay={playback.autoPlay}
          src={playback.url}
          className="h-9 w-full"
        />
      );
      break;
    case "gone":
      body = (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] text-faint">
            The server no longer keeps this audio, and this browser has no copy.
            Pick the original file to play it here.
          </p>
          {locateButton}
        </div>
      );
      break;
    case "mismatch":
      body = (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] text-faint">
            {playback.file.name} doesn't look like the file this source came
            from.
          </p>
          <button
            type="button"
            onClick={() => void prepareAndPlay(playback.file, playback.kind)}
            className={buttonClass}
          >
            Use it anyway
          </button>
          <button type="button" onClick={locate} className={buttonClass}>
            Pick another
          </button>
        </div>
      );
      break;
    case "preparing":
      body = <p className="text-[12px] text-faint">Preparing audio…</p>;
      break;
    case "failed":
      body = (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] text-live">
            {playback.message}
          </p>
          <button
            type="button"
            onClick={() => void loadFromServer()}
            className={buttonClass}
          >
            Try again
          </button>
          {locateButton}
        </div>
      );
      break;
  }

  if (!body) return null;
  return (
    <div className="shrink-0 border-b border-line px-5 py-2.5">
      {body}
      <input
        ref={inputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so picking the same file again still fires.
          event.target.value = "";
          if (file) onPicked(file);
        }}
      />
    </div>
  );
}

/** The video itself, from YouTube, where it stays. */
function YoutubePlayback({ videoId }: { videoId: string }) {
  return (
    <div className="flex shrink-0 flex-col items-start gap-2 border-b border-line px-5 py-3">
      <iframe
        src={youtubeEmbedUrl(videoId)}
        title="YouTube video"
        className="aspect-video w-full max-w-md rounded-lg border border-line"
        allow="encrypted-media; picture-in-picture; fullscreen"
        // YouTube refuses to play an embed it gets no referrer for.
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <a
        href={youtubeWatchUrl(videoId)}
        target="_blank"
        rel="noreferrer"
        className="text-[11px] font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        Open on YouTube
      </a>
    </div>
  );
}

/** What a source was made from, to play while reading its transcript. */
export function SourcePlayback({ job }: { job: Job }) {
  if (job.source === "youtube") {
    return job.youtubeVideoId ? (
      <YoutubePlayback videoId={job.youtubeVideoId} />
    ) : null;
  }
  return (
    <AudioPlayback audioUploadId={job.audioUploadId} fileName={job.fileName} />
  );
}
