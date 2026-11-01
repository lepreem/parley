/**
 * What preparing a file for transcription names it. The server stores the
 * prepared file's name as the source's, so the same file prepared again gets
 * the same name, which is how a file picked to play a source is matched to it.
 */

/** The name without its extension, with anything but word characters, dots and dashes made underscores. */
function safeBase(name: string, fallback: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_") || fallback;
}

/** What extractAudioFromVideo names a video's audio track. */
export function extractedAudioFileName(videoName: string): string {
  return `${safeBase(videoName, "recording")}-audio.wav`;
}

/** What compressAudioForSpeech names its output. */
export function speechFileName(audioName: string): string {
  return `${safeBase(audioName, "audio")}-speech.webm`;
}
