import type {
  HistoryCandidate,
  HistoryTranscript,
  KnownHistoryText,
} from "../data/index";

/**
 * In-process cache of message and transcript text, per conversation. A turn
 * hands the ids held here to its history read, which leaves their text out:
 * sending the text is most of what that read costs. Filled from each history
 * read and from each turn once it's saved.
 *
 * Entries are never invalidated, because the text never changes: a message's
 * content and a transcript's content are written once (an edit deletes
 * messages and writes new ones, under new ids), and the database refuses an
 * update to either (drizzle/0004_immutable_messages.sql).
 *
 * The history query still decides which turns are in the window and what
 * they carry; this only fills in text for ids it returned. So each process
 * keeps its own copy and nothing is routed or shared: an entry another
 * process made obsolete is only memory, and it goes when the next read here
 * rebuilds the entry or the limits below drop it.
 */

/** Most conversations held per user; their least recently used goes first. */
const MAX_CONVERSATIONS_PER_USER = 2;
/** An entry not used for this long is dropped the next time anything is stored. */
const IDLE_TTL_MS = 15 * 60 * 1000;
/** All entries together, estimated from string lengths. */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

type Entry = {
  userId: string;
  messages: Map<string, string>;
  transcripts: Map<string, string>;
  bytes: number;
  lastUsedAt: number;
};

/** By conversation id, least recently used first: using an entry re-inserts it. */
const entries = new Map<string, Entry>();
let totalBytes = 0;

/** UTF-16, two bytes a character: an estimate, not V8's exact accounting. */
function bytesOf(texts: ReadonlyMap<string, string>) {
  let bytes = 0;
  for (const [id, text] of texts) bytes += 2 * (id.length + text.length);
  return bytes;
}

function remove(conversationId: string) {
  const entry = entries.get(conversationId);
  if (!entry) return;
  entries.delete(conversationId);
  totalBytes -= entry.bytes;
}

/**
 * The entry, if it's this user's and still fresh. Another user's is left
 * alone: a request naming a conversation that isn't theirs mustn't evict it.
 */
function usable(userId: string, conversationId: string, now: number) {
  const entry = entries.get(conversationId);
  if (!entry || entry.userId !== userId) return undefined;
  if (now - entry.lastUsedAt > IDLE_TTL_MS) {
    remove(conversationId);
    return undefined;
  }
  return entry;
}

function store(conversationId: string, entry: Entry, now: number) {
  remove(conversationId);
  entries.set(conversationId, entry);
  totalBytes += entry.bytes;

  let userEntries = 0;
  for (const [id, other] of [...entries].reverse()) {
    if (now - other.lastUsedAt > IDLE_TTL_MS) remove(id);
    else if (other.userId === entry.userId) {
      userEntries += 1;
      if (userEntries > MAX_CONVERSATIONS_PER_USER) remove(id);
    }
  }
  for (const id of entries.keys()) {
    if (totalBytes <= MAX_TOTAL_BYTES) break;
    remove(id);
  }
}

/**
 * The text held for a conversation, for its history read to leave out. A
 * copy, so evicting or rebuilding the entry while the read is in flight can't
 * take text the read was told it needn't send.
 */
function known(
  userId: string,
  conversationId: string,
): KnownHistoryText | undefined {
  const now = Date.now();
  const entry = usable(userId, conversationId, now);
  if (!entry) return undefined;

  entry.lastUsedAt = now;
  entries.delete(conversationId);
  entries.set(conversationId, entry);
  return {
    messages: new Map(entry.messages),
    transcripts: new Map(entry.transcripts),
  };
}

/**
 * Replaces the entry with exactly what a history read returned, so messages
 * that left the window or were deleted go with it. A read that found no
 * history is a conversation's first turn, which isn't held: most
 * conversations never get a second.
 */
function rememberHistory(
  userId: string,
  conversationId: string,
  history: readonly HistoryCandidate[],
) {
  if (history.length === 0) {
    if (entries.get(conversationId)?.userId === userId) remove(conversationId);
    return;
  }

  const messages = new Map<string, string>();
  const transcripts = new Map<string, string>();
  for (const message of history) {
    messages.set(message.id, message.content);
    for (const transcript of message.transcripts) {
      transcripts.set(transcript.audioUploadId, transcript.content);
    }
  }

  const now = Date.now();
  store(
    conversationId,
    {
      userId,
      messages,
      transcripts,
      bytes: bytesOf(messages) + bytesOf(transcripts),
      lastUsedAt: now,
    },
    now,
  );
}

/**
 * Adds a turn just saved, so the next turn here reads none of it. Only to a
 * conversation already held: a first turn starts nothing.
 */
function rememberTurn(
  userId: string,
  conversationId: string,
  turn: {
    userMessageId: string;
    content: string;
    transcripts: readonly HistoryTranscript[];
    assistantMessageId: string;
    assistantContent: string;
  },
) {
  const now = Date.now();
  const entry = usable(userId, conversationId, now);
  if (!entry) return;

  const messages = new Map(entry.messages)
    .set(turn.userMessageId, turn.content)
    .set(turn.assistantMessageId, turn.assistantContent);
  const transcripts = new Map(entry.transcripts);
  for (const transcript of turn.transcripts) {
    transcripts.set(transcript.audioUploadId, transcript.content);
  }

  store(
    conversationId,
    {
      userId,
      messages,
      transcripts,
      bytes: bytesOf(messages) + bytesOf(transcripts),
      lastUsedAt: now,
    },
    now,
  );
}

/** Test-only: drops every entry so cases don't leak into each other. */
export function resetHistoryTextCache() {
  entries.clear();
  totalBytes = 0;
}

export const historyTextCache = { known, rememberHistory, rememberTurn };
