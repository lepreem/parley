import type { ChatModel } from "@parley/contract";
import { logger } from "@parley/server-kit/runtime/logger";
import {
  connectChat,
  type ConnectedChat,
} from "../../../core/ai/ai_chat_client";

const log = logger.child({ component: "chat" });

/**
 * The chat models this server offers: whatever Claude Code and Codex said
 * when they were first asked, at startup. A program installed or logged in
 * later shows up after a restart.
 */
function createChatCatalog() {
  let connected: Promise<ConnectedChat> | undefined;

  /** Connects once; a failure isn't kept, so the next call tries again. */
  function load(): Promise<ConnectedChat> {
    connected ??= connectChat().then(
      (chat) => {
        for (const { name, reason } of chat.unavailable) {
          log.warn("Chat program unavailable", { program: name, reason });
        }
        return chat;
      },
      (error: unknown) => {
        connected = undefined;
        throw error;
      },
    );
    return connected;
  }

  return {
    load,

    list: async (): Promise<ChatModel[]> => [...(await load()).models],

    /**
     * The model with this id, or undefined when it isn't one the app can chat
     * with. Checked up front, so an unknown model or images for a text-only
     * one is a 400 on the request rather than a failure mid-stream, where the
     * only channel left is an SSE error event.
     */
    find: async (id: string): Promise<ChatModel | undefined> =>
      (await load()).models.find((model) => model.id === id),

    /** The model the app's own small jobs, like titles, run on. */
    helper: async () => (await load()).helper,
  };
}

export const chatCatalog = createChatCatalog();
