import { buildUserTurn, type ChatTurn } from "../ai";
import type { HistoryPage } from "../data";

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
 * What a past message carries of the pages the model read to answer it:
 * nothing when it read none.
 */
export function pagesReadBlock(pages: readonly HistoryPage[]) {
  if (pages.length === 0) return "";
  const read = pages.map(
    (page) =>
      `<page url="${attribute(page.url)}" title="${attribute(page.title)}">\n${page.content}\n</page>`,
  );
  return `\n\n<pages_read>\nYou opened these pages while answering this message, and they're kept here so you needn't open them again. Open one again only if it may have changed or the person asks you to.\n${read.join("\n")}\n</pages_read>`;
}

function attribute(value: string) {
  return value.replace(/"/g, "'").replace(/\s+/g, " ");
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
          turn.content.filter((content) => content.type === "input_image")
            .length
        : count,
    0,
  );
}
