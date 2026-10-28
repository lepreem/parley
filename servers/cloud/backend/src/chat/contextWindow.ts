/**
 * Bounds on what one turn can cost, and which past turns fit inside them. The
 * message cap alone isn't one: 50 turns of the 50k chars the schema allows is
 * a ~2.5M-char prompt, so the character budget is what actually holds the
 * line. Older turns simply fall off.
 */
const MAX_CONTEXT_MESSAGES = 50;

/** The most past turns a prompt replays: the cap, less the new turn. */
export const MAX_HISTORY_MESSAGES = MAX_CONTEXT_MESSAGES - 1;

export const MAX_CONTEXT_CHARS = 100_000;
export const MAX_RESPONSE_TOKENS = 4_000;

/**
 * Images in one prompt, the new turn's included. Attachments outlive the turn
 * they arrived on — a follow-up question about an image the user sent three
 * turns ago has to still see it — but they don't consume the character budget,
 * so this is their own ceiling on what one turn costs. The new turn's images
 * come first; history gets what's left, newest turn first.
 */
const MAX_CONTEXT_IMAGES = 8;

type Budgeted<Image> = {
  /** The turn's length as the prompt carries it, transcripts included. */
  contextCharCount: number;
  images: readonly Image[];
};

/**
 * The past turns that fit alongside a new turn of `newTurnCharCount` and
 * `newTurnImageCount`, newest first: every turn until the next would overrun
 * the character budget, with their images capped newest first.
 */
export function admitHistory<Image, Turn extends Budgeted<Image>>(
  candidatesNewestFirst: readonly Turn[],
  newTurnCharCount: number,
  newTurnImageCount: number,
): Turn[] {
  const admitted: Turn[] = [];
  let remainingChars = MAX_CONTEXT_CHARS - newTurnCharCount;
  let remainingImages = Math.max(0, MAX_CONTEXT_IMAGES - newTurnImageCount);

  for (const turn of candidatesNewestFirst) {
    if (turn.contextCharCount > remainingChars) break;
    remainingChars -= turn.contextCharCount;

    const images = turn.images.slice(0, remainingImages);
    remainingImages -= images.length;
    admitted.push({ ...turn, images });
  }

  return admitted;
}

/**
 * How many of a conversation's newest messages fit the budget, counting from
 * the reply just written. Stored on the conversation, so the next turn reads
 * no more history than this one could use.
 */
export function countMessagesInContextWindow(
  charCountsNewestFirst: readonly number[],
) {
  let charBudget = MAX_CONTEXT_CHARS;
  let messageCount = 0;

  for (const charCount of charCountsNewestFirst) {
    if (messageCount >= MAX_HISTORY_MESSAGES) break;
    if (charBudget - charCount < 0) break;
    charBudget -= charCount;
    messageCount += 1;
  }

  return messageCount;
}
