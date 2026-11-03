import { MAX_DICTATION_SECONDS } from "@parley/contract/limits";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/http";
import { transcribeRecording } from "../../api/speech";
import { useServer } from "../../hooks/server/useServer";

export type Dictation =
  | { status: "idle" }
  | { status: "recording"; seconds: number }
  | { status: "transcribing" }
  /** `canRetry`: the recording is still here to send again. */
  | { status: "failed"; message: string; canRetry: boolean };

/** Plenty for speech, and well inside the size the servers accept. */
const AUDIO_BITS_PER_SECOND = 32_000;

/** Opus where the browser records it; Safari records AAC in MP4 instead. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg"];

/** Browsers only offer the microphone to a page on HTTPS or localhost. */
export const canDictate = () =>
  typeof MediaRecorder !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia);

function microphoneError(error: unknown) {
  return error instanceof DOMException && error.name === "NotAllowedError"
    ? "Microphone access is blocked. Allow it in your browser's site settings."
    : "Couldn't start the microphone.";
}

function transcriptionError(error: unknown) {
  // Our own refusals say what's wrong; anything else means nothing to a reader.
  return error instanceof ApiError && error.status >= 400 && error.status < 500
    ? error.message
    : "Couldn't transcribe that.";
}

/**
 * Records from the microphone until told to stop, then hands what was said to
 * `onText`. A recording that couldn't be transcribed is held on to for a
 * retry, since it can be minutes of someone's speech. Changing `resetKey`
 * (another chat) or leaving drops whatever is under way.
 */
export function useDictation(onText: (text: string) => void, resetKey: string) {
  const server = useServer();
  const [dictation, setDictation] = useState<Dictation>({ status: "idle" });
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  });

  const stopRecorder = useRef<(() => void) | null>(null);
  const dropCurrent = useRef<(() => void) | null>(null);
  const heldRecording = useRef<Blob | null>(null);

  const send = useCallback(
    async (recording: Blob) => {
      const controller = new AbortController();
      dropCurrent.current = () => controller.abort();
      setDictation({ status: "transcribing" });
      try {
        const text = await transcribeRecording(
          server,
          recording,
          controller.signal,
        );
        heldRecording.current = null;
        if (text) {
          setDictation({ status: "idle" });
          onTextRef.current(text);
        } else {
          setDictation({
            status: "failed",
            message: "Didn't catch any speech.",
            canRetry: false,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        heldRecording.current = recording;
        setDictation({
          status: "failed",
          message: transcriptionError(error),
          canRetry: true,
        });
      }
    },
    [server],
  );

  const start = useCallback(async () => {
    heldRecording.current = null;
    let dropped = false;
    const drop = () => {
      dropped = true;
    };
    dropCurrent.current = drop;
    // Shown from the tap, since the browser may first ask for permission.
    setDictation({ status: "recording", seconds: 0 });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (!dropped) {
        setDictation({
          status: "failed",
          message: microphoneError(error),
          canRetry: false,
        });
      }
      return;
    }
    const release = () => stream.getTracks().forEach((track) => track.stop());
    if (dropped) {
      release();
      return;
    }

    const mimeType = RECORDING_TYPES.find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        ...(mimeType ? { mimeType } : {}),
      });
    } catch (error) {
      release();
      setDictation({
        status: "failed",
        message: microphoneError(error),
        canRetry: false,
      });
      return;
    }
    const chunks: Blob[] = [];
    let seconds = 0;
    const clock = setInterval(() => {
      seconds += 1;
      setDictation({ status: "recording", seconds });
      if (seconds >= MAX_DICTATION_SECONDS) stopRecorder.current?.();
    }, 1000);

    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => {
      clearInterval(clock);
      release();
      stopRecorder.current = null;
      if (!dropped) {
        void send(new Blob(chunks, { type: recorder.mimeType }));
      }
    };
    stopRecorder.current = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    dropCurrent.current = () => {
      drop();
      stopRecorder.current?.();
    };
    recorder.start();
  }, [send]);

  const stop = useCallback(() => stopRecorder.current?.(), []);

  const reset = useCallback(() => {
    dropCurrent.current?.();
    dropCurrent.current = null;
    heldRecording.current = null;
    setDictation({ status: "idle" });
  }, []);

  const retry = useCallback(() => {
    if (heldRecording.current) void send(heldRecording.current);
  }, [send]);

  useEffect(() => reset, [reset, resetKey]);

  return { dictation, start, stop, reset, retry };
}
