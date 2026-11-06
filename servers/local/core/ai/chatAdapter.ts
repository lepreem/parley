import type {
  ChatModel,
  PermissionMode,
  ReasoningEffort,
  ToolApproval,
} from "@parley/contract";

/**
 * What every chat program the app can run (Claude Code, Codex) is driven
 * through. Each one's `*.adapter.ts` holds everything about talking to it, so
 * when one breaks after an update, that file is where to look; this one holds
 * only what they share.
 */

/** An image as a turn carries it: the file's bytes, base64-encoded. */
export type ChatImage = { mimeType: string; data: string };

export type ChatContentPart =
  { type: "text"; text: string } | ({ type: "image" } & ChatImage);

export type ChatTurn = {
  role: "user" | "assistant";
  content: string | ChatContentPart[];
};

/**
 * Neither program keeps a conversation's history the way the app does (edits
 * and deletes rewrite it), so every run is handed the whole conversation as
 * one message. This says how to read it.
 */
export const CHAT_INSTRUCTIONS = `This conversation reaches you through a chat app. The user's message holds the conversation so far, oldest first, with each turn wrapped in <user> or <assistant> tags. Reply to the last user turn, as the assistant, without the tags.`;

/**
 * The conversation as one message: each turn's text inside its role's tags,
 * and its images where they sit in it. Neighbouring text is joined.
 */
export function conversationAsOneMessage(
  turns: readonly ChatTurn[],
): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  const addText = (text: string) => {
    const last = parts.at(-1);
    if (last?.type === "text") last.text += text;
    else parts.push({ type: "text", text });
  };

  for (const [index, turn] of turns.entries()) {
    const content: ChatContentPart[] =
      typeof turn.content === "string"
        ? [{ type: "text", text: turn.content }]
        : turn.content;

    addText(`${index === 0 ? "" : "\n\n"}<${turn.role}>\n`);
    for (const part of content) {
      if (part.type === "text") addText(part.text);
      else parts.push({ ...part });
    }
    addText(`\n</${turn.role}>`);
  }

  return parts;
}

/**
 * Something a run wants the person's say on, as the approval card shows it.
 * Each adapter turns its program's own request into this.
 */
export type PermissionRequest = {
  /** The program asking, by the adapter's `name`. */
  program: string;
  toolName: string;
  /** Exactly what it would run or change. */
  detail: string;
  /** The program's own "don't ask again", when it offers one. */
  always: ToolApproval["always"];
  /**
   * What later runs in the conversation are handed if the person takes
   * `always`, for what lasts only as long as a terminal session would. The
   * adapter that made it is the only one that reads it.
   */
  carry: unknown[];
};

/** The person's answer, which the adapter turns back into its program's. */
export type PermissionAnswer =
  { decision: "allow" | "always" } | { decision: "deny"; message: string };

export type AskPermission = (
  request: PermissionRequest,
  /** Aborts when the program stops waiting for the answer. */
  signal: AbortSignal,
) => Promise<PermissionAnswer>;

/** One run's settings, as both adapters take them. */
export type ChatRunOptions = {
  abortSignal: AbortSignal;
  onText: (text: string) => void | Promise<void>;
  /** How hard the model thinks; left to the program when undefined. */
  effort: ReasoningEffort | undefined;
  /** Lets the model search the web, if it decides it needs to. */
  webSearch: boolean;
  /** Each page a search finds or reads, as the program describes it. */
  onSource: (url: unknown, title: unknown) => void;
  /** Asks the person about the run's prompts, which are refused without it. */
  askPermission: AskPermission | undefined;
  /** How freely the turn acts, beyond the person's own settings. */
  permissionMode: PermissionMode | undefined;
  /** What earlier runs in the conversation were allowed for the session. */
  carried: readonly unknown[];
};

/** A small job the app does for itself, like naming a conversation. */
type HelperRunOptions = {
  abortSignal: AbortSignal;
  effort: ReasoningEffort | undefined;
};

/** What a program offers, as it says when the app starts. */
export type ChatCatalog = {
  models: ChatModel[];
  /** The quick model, and its least effort, for the app's own small jobs. */
  helper: { model: string; effort: ReasoningEffort | undefined };
};

export type ChatAdapter = {
  /** The program's name, as the person knows it. */
  name: string;
  /** Whether a model id is one of this program's. */
  serves: (modelId: string) => boolean;
  /**
   * Startup check and catalog: fails when the program can't be run or isn't
   * logged in, and otherwise resolves with the models it offers.
   */
  connect: () => Promise<ChatCatalog>;
  /**
   * A chat turn, on the person's own setup of the program: their settings
   * decide what it may do. Resolves with the whole answer.
   */
  chat: (
    model: string,
    turns: readonly ChatTurn[],
    options: ChatRunOptions,
  ) => Promise<string>;
  /** The program as a plain model, which can't act on what it's given. */
  helper: (
    model: string,
    instructions: string,
    prompt: string,
    options: HelperRunOptions,
  ) => Promise<string>;
};

/**
 * This server's own settings, which a command the program runs mustn't
 * inherit: under NODE_ENV=production, `npm install` skips dev packages, and
 * PORT would move the person's own dev server. ELECTRON_RUN_AS_NODE breaks any
 * Electron app.
 */
const SERVER_ONLY_ENV = [
  "ELECTRON_RUN_AS_NODE",
  "NODE_ENV",
  "PORT",
  "DATA_DIR",
  "CLIENT_DIR",
  "CLAUDE_PATH",
  "CODEX_PATH",
  "YT_DLP_PATH",
];

/** The environment a program runs in: the person's own, less this server's. */
export function programEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of SERVER_ONLY_ENV) delete env[name];
  return env;
}

/** One line of a program's JSON output, or nothing for one that isn't JSON. */
export function parseJsonLine<T>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}
