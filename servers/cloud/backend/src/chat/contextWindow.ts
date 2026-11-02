import type { ChatModel, ReasoningEffort } from "@parley/contract";

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

/** Room for the reply a person reads. */
const MAX_RESPONSE_TOKENS = 4_000;

/**
 * Room for thinking on top of it. Providers count a model's thinking against
 * the same ceiling as its reply, so with no room for it, a model that thinks
 * hard spends the ceiling doing so and writes nothing.
 *
 * About twice what GPT-6 Luna spent on a hard question at each level (1,200 at
 * low, 4,400 at medium, 7,800 at high). The top levels stop at what the 8-minute
 * limit on a call leaves time for.
 */
const THINKING_TOKENS: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 2_000,
  low: 4_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 32_000,
  max: 32_000,
};

/**
 * The ceiling on one turn's completion, thinking and reply together, within
 * what the model can write. Any unspent thinking room can go to the reply, as
 * providers don't count the two apart. With no effort chosen, it's the model's
 * own default that needs the room, and a model that doesn't say gets plenty.
 */
export function completionTokenCeiling(
  model: Partial<Pick<ChatModel, "maxOutputTokens" | "reasoning">> | undefined,
  chosenEffort: ReasoningEffort | undefined,
) {
  const effort = chosenEffort ?? model?.reasoning?.defaultEffort ?? "high";
  return Math.min(
    MAX_RESPONSE_TOKENS + THINKING_TOKENS[effort],
    model?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
  );
}

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
