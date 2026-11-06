import { compressAudioForSpeech } from "./compressAudio";
import { extractAudioFromVideo } from "./extractAudio";
import { extractedAudioFileName, speechFileName } from "./fileNames";

/**
 * An audio or video file as it's uploaded for transcription: its audio,
 * compressed for speech. Run in the browser, so a video never leaves the
 * device.
 */
export async function prepareSpeech(
  file: File,
  kind: "audio" | "video",
  signal?: AbortSignal,
): Promise<File> {
  return compressAudioForSpeech(
    kind === "video" ? await extractAudioFromVideo(file, signal) : file,
    undefined,
    signal,
  );
}

/** What prepareSpeech names a file, without preparing it. */
export function preparedSpeechName(
  fileName: string,
  kind: "audio" | "video",
): string {
  return speechFileName(
    kind === "video" ? extractedAudioFileName(fileName) : fileName,
  );
}
