/**
 * What goes over the wire between the client and either server: the cloud
 * one (servers/cloud) and the local one (servers/local). Both servers answer
 * in these shapes and the client reads them, so a change here fails the type
 * check of whichever side no longer matches.
 *
 * Types only, imported with `import type`: nothing here exists at runtime.
 * Timestamps are ISO 8601 strings.
 *
 * Request bodies are here too, and each server's validator is checked to take
 * every body the contract allows. Sign-in and the way a file gets uploaded
 * differ between the servers on purpose, so neither is here; what an upload
 * answers with is.
 */

/* ------------------------------------------------------------------ errors */

/** Every 4xx and 5xx answer with a body. */
export type ErrorBody = { message: string };

/* ----------------------------------------------------------- conversations */

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

/** GET /conversations, most recently active first. */
export type ConversationsResponse = { conversations: Conversation[] };

/** POST /conversations. Without a title, the server picks one. */
export type CreateConversationBody = { conversationTitle?: string };

/** PATCH /conversations/:conversationId */
export type RenameConversationBody = { conversationTitle: string };

/* ---------------------------------------------------------------- messages */

/** An image a user turn carried. */
export type MessageImage = {
  imageUploadId: string;
  fileName: string;
  mimeType: string;
  size: number;
  /**
   * Where the image is: a signed link from the cloud server, or a path
   * relative to the local server, which may be reached by more than one name.
   */
  url: string;
};

/** A transcript a user turn was sent with, in the order it was attached. */
export type MessageTranscript = {
  audioUploadId: string;
  fileName: string;
  source: JobSource;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  chosenModelId: string | null;
  conversationId: string;
  createdAt: string;
  attachments: MessageImage[]; // rename to imageAttachments
  transcriptAttachments: MessageTranscript[];
  /** An assistant reply someone stopped before it finished. */
  stopped: boolean;
};

/**
 * A turn the server is answering right now. Neither message is stored until
 * the reply finishes, so this is the only place either shows up meanwhile.
 */
export type ReplyInProgress = {
  /** The message being answered, as the user wrote it. */
  content: string;
  /** The reply so far. */
  assistantContent: string;
};

/** GET /conversations/:conversationId/messages, oldest first. */
export type MessagesResponse = {
  lastMessageId: string | null;
  messages: ChatMessage[];
  /**
   * Set while a turn is being answered. Its messages join `messages` once
   * it's saved, and the server sends `replyFinished` then.
   */
  replyInProgress: ReplyInProgress | null;
};

export type MessageAttachmentInput =
  | { type: "image"; imageUploadId: string }
  | { type: "transcript"; audioUploadId: string };

/**
 * POST /conversations/:conversationId/messages, and PATCH on a message to
 * edit it and answer again.
 */
export type SendMessageBody = {
  messageContent: string;
  chosenModelId: string;
  attachments: MessageAttachmentInput[];
  /** The conversation's head as the client last saw it. */
  lastMessageId: string | null;
};

/** One timed step of a turn, in milliseconds from the turn's start. */
export type TurnStep = {
  operation: string;
  /** How many steps it ran inside: 0 for one the turn itself ran. */
  depth: number;
  startOffsetMs: number;
  durationMs: number;
};

/**
 * How one turn went. Times are milliseconds from the turn's start, which is
 * after sign-in and the request's checks.
 */
export type TurnStats = {
  /** Every timed step, by when it started, each followed by its own steps. */
  steps: TurnStep[];
  modelStartedAfterMs: number;
  /** Null when the model finished without writing anything. */
  firstTokenAfterMs: number | null;
  modelFinishedAfterMs: number;
  /** Until the turn was saved. */
  totalMs: number;
  context: {
    /** Past messages the history read returned. */
    historyReadMessages: number;
    /** Of those, how many the server already held the text of. */
    historyCachedMessages: number;
    /** Past messages that fit, and went into the prompt. */
    historyMessages: number;
    /** Characters those carried, transcripts included. */
    historyChars: number;
    newTurnChars: number;
    maxChars: number;
    maxHistoryMessages: number;
  };
};

/**
 * The server-sent events a reply streams back, by event name: pieces of the
 * answer, then either done or error.
 */
export type ReplyStreamEvents = {
  delta: { delta: string };
  /**
   * The turn is saved. `stopped` when it was stopped partway. `stats` is how
   * the turn went, for anyone curious; a server that doesn't time its turns
   * leaves it out.
   */
  done: { lastMessageId: string; stopped: boolean; stats?: TurnStats };
  /** Stopped before any of the reply came, so nothing was saved. */
  cancelled: Record<string, never>;
  error: ErrorBody;
};

/* ------------------------------------------------------------------ models */

/** A chat model, whichever provider serves it. */
export type ChatModel = {
  id: string;
  name: string;
  /** The longest prompt it takes, in tokens, when known. */
  contextTokens: number | null;
  /** Whether a turn may carry images. */
  acceptsImages: boolean;
  /**
   * What it charges, or null when that isn't a price per token: a router
   * whose price depends on the model it picks, or a subscription.
   */
  pricing: ModelPricing | null;
};

/** A chat model's price, in US dollars per million tokens. */
export type ModelPricing = {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
};

/** A transcription model, whichever provider serves it. */
export type TranscribeModel = { id: string; name: string };

/** GET /models/chat and GET /models/transcription */
export type ModelsResponse<Model> = { models: Model[] };

/* -------------------------------------------------------------------- jobs */

export type JobStatus = "queued" | "processing" | "completed" | "failed";
export type JobSource = "audio" | "video" | "youtube";

/** GET /jobs/:audioUploadId */
export type Job = {
  audioUploadId: string;
  fileName: string;
  source: JobSource;
  status: JobStatus;
  /** Only once the job has completed. */
  transcript: string | null;
  error: string | null;
};

/** A job as the history list shows it, without its transcript. */
export type JobSummary = {
  audioUploadId: string;
  fileName: string;
  source: JobSource;
  status: JobStatus;
  createdAt: string;
  error: string | null;
};

/** GET /jobs, newest first. */
export type JobsPage = {
  jobs: JobSummary[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
};

/* ----------------------------------------------------------------- uploads */

/** What an image upload answers with, once the image is stored. */
export type UploadedImage = MessageImage;

/** What an audio upload answers with, once its transcription is queued. */
export type UploadedAudio = {
  audioUploadId: string;
  fileName: string;
  size: number;
  mimeType: string;
  source: "audio" | "video";
};

/** POST /upload/youtube */
export type QueueYoutubeBody = {
  youtubeUrl: string;
  /** The server's default when absent. */
  transcriptModelId?: string;
  /** Use the video's own captions instead of transcribing, when it has them. */
  useCaptionsIfAvailable?: boolean;
};

/** What POST /upload/youtube answers with, once the fetch is queued. */
export type QueuedYoutube = {
  audioUploadId: string;
  source: "youtube";
  url: string;
};

/* ------------------------------------------------------------------ events */

/**
 * GET /events: what the servers push on the stream the browser holds open,
 * by event name. The cloud sends a user their own jobs' events; the local
 * server sends everyone everything.
 */
export type ServerEvents = {
  /** A job changed; refetch it. */
  jobUpdated: { audioUploadId: string };
  /** A reply finished, was stopped or failed; refetch the conversation. */
  replyFinished: { conversationId: string };
};
