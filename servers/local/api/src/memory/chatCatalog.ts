import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { ChatModel } from "@parley/contract";
import { logger } from "@parley/server-kit/runtime/logger";
import {
  chatSettingsFiles,
  connectChat,
  type ConnectedChat,
} from "../../../core/ai/ai_chat_client";
import { EVERYONE, eventHub } from "../sse/hub";

const log = logger.child({ component: "chat" });

/** Editors save a file in several writes; one reload covers them all. */
const SETTLE_MS = 1000;

/**
 * The chat models this server offers: whatever Claude Code and Codex said
 * when they were first asked, at startup, and again whenever the person
 * changes one's settings, since those decide things like the effort a model
 * runs at. A program installed or logged in later shows up after a restart.
 */
function createChatCatalog() {
  let connected: Promise<ConnectedChat> | undefined;
  let watchers: FSWatcher[] | undefined;

  /** Connects once; a failure isn't kept, so the next call tries again. */
  function load(): Promise<ConnectedChat> {
    connected ??= connectChat().then(
      (chat) => {
        for (const { name, reason } of chat.unavailable) {
          log.warn("Chat program unavailable", { program: name, reason });
        }
        watchSettings();
        return chat;
      },
      (error: unknown) => {
        connected = undefined;
        throw error;
      },
    );
    return connected;
  }

  /**
   * Asks the programs again. What they offer replaces what they offered
   * only if they could say, and the pages hear about it only if it changed.
   */
  async function reload() {
    const before = await connected?.catch(() => undefined);
    let chat: ConnectedChat;
    try {
      chat = await connectChat();
    } catch (error) {
      log.warn("Chat settings changed, but asking again failed", { error });
      return;
    }
    connected = Promise.resolve(chat);
    if (
      JSON.stringify([before?.models, before?.defaultModel]) !==
      JSON.stringify([chat.models, chat.defaultModel])
    ) {
      eventHub.send(EVERYONE, "chatModelsChanged", {});
    }
  }

  /**
   * Watches the folders the settings files are in rather than the files: an
   * editor that saves by replacing a file would leave a watch on the old one.
   */
  function watchSettings() {
    if (watchers) return;
    const files = chatSettingsFiles();
    const names = new Set(files.map((file) => basename(file)));
    let timer: NodeJS.Timeout | undefined;
    const changed = (name: string | Buffer | null) => {
      if (name !== null && !names.has(name.toString())) return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), SETTLE_MS);
    };
    watchers = [...new Set(files.map((file) => dirname(file)))].flatMap(
      (folder) => {
        try {
          // A program that's never been set up has no folder to watch.
          return [
            watch(folder, { persistent: false }, (_, name) => changed(name)),
          ];
        } catch {
          return [];
        }
      },
    );
  }

  return {
    load,

    list: async (): Promise<ChatModel[]> => [...(await load()).models],

    /** The model a new chat starts on. */
    defaultModel: async (): Promise<string> => (await load()).defaultModel,

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
