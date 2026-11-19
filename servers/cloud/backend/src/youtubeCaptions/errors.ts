/** What a failed fetch tells the person, whichever service fetched it. */

/** Shown to the person as the job's error. */
export const CAPTIONS_MESSAGES = {
  noCaptions:
    "This video has no captions, and Parley can't download YouTube audio yet. Upload the audio or video file instead.",
  notFound: "This video doesn't exist, or YouTube won't show it.",
  usedUp:
    "Parley has used this month's YouTube allowance. Upload the audio or video file instead.",
  /** Still refused after every retry: a long burst, or possibly credits run out. */
  busy: "Parley is fetching too many YouTube videos right now, or has used this month's allowance. Try again later, or upload the audio or video file.",
  unavailable: "YouTube captions are unavailable right now. Try again later.",
} as const;

/** A fetch that failed for a reason the person should be told. */
export class CaptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionsError";
  }
}
