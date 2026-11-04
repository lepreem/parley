import { buildUserTurn, type ChatTurn } from "../ai";

const TRANSCRIPT_SEPARATOR = "\n\n";

/** A turn's text as the model reads it: its transcripts first, in link order. */
export function withTranscripts(
  content: string,
  transcripts: readonly string[],
) {
  if (transcripts.length === 0) return content;
  return `${transcripts.join(TRANSCRIPT_SEPARATOR)}${TRANSCRIPT_SEPARATOR}${content}`;
}

/**
 * A history turn as the model takes it. Images only ever ride on user turns,
 * so a turn without them keeps whichever role it had.
 */
function toHistoryTurn(
  role: ChatTurn["role"],
  content: string,
  imageUrls: readonly string[],
): ChatTurn {
  return imageUrls.length > 0
    ? buildUserTurn(content, imageUrls)
    : { role, content };
}

/** The whole prompt, oldest turn first, ending on the new one. */
export function buildPrompt(
  historyNewestFirst: readonly {
    role: ChatTurn["role"];
    promptContent: string;
    imageUrls: readonly string[];
  }[],
  newTurn: ChatTurn,
): ChatTurn[] {
  return [
    ...historyNewestFirst
      .map((turn) =>
        toHistoryTurn(turn.role, turn.promptContent, turn.imageUrls),
      )
      .reverse(),
    newTurn,
  ];
}

export function countImageInputs(turns: readonly ChatTurn[]) {
  return turns.reduce(
    (count, turn) =>
      Array.isArray(turn.content)
        ? count +
          turn.content.filter((content) => content.type === "image_url").length
        : count,
    0,
  );
}
