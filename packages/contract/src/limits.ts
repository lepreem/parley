/**
 * Limits both servers enforce and the client applies as you type, so an input
 * stops where the server would reject it.
 */

/** A conversation's title, after trimming. */
export const MAX_TITLE_LENGTH = 200;

/** How long one dictated message can run: the client stops recording here. */
export const MAX_DICTATION_SECONDS = 5 * 60;

/**
 * The most a dictated recording can weigh, in bytes. Five minutes at the
 * highest rate a browser's recorder is likely to pick fits well inside it.
 */
export const MAX_DICTATION_BYTES = 10 * 1024 * 1024;
