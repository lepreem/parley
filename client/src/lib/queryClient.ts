import { QueryClient, type Query } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import type { Server } from "../api/server";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

type ServerId = Server["id"];

/**
 * Centralized query keys so the job-update bridge and mutations stay in sync. Each
 * starts with the server it was asked of, since the two servers' ids and
 * catalogs are unrelated.
 */
export const queryKeys = {
  /** A guest is offered fewer models, so their catalog is kept apart. */
  chatModels: (server: ServerId, guest: boolean) =>
    [server, "models", "chat", guest ? "guest" : "member"] as const,
  transcriptionModels: (server: ServerId) =>
    [server, "models", "transcription"] as const,
  jobLists: (server: ServerId) => [server, "jobs"] as const,
  everyJob: (server: ServerId) => [server, "job"] as const,
  job: (server: ServerId, audioUploadId: string) =>
    [server, "job", audioUploadId] as const,
  conversations: (server: ServerId) => [server, "conversations"] as const,
  messages: (server: ServerId, conversationId: string) =>
    [server, "conversations", conversationId, "messages"] as const,
  health: (server: ServerId) => [server, "health"] as const,
  guestChat: (server: ServerId) => [server, "guestChat"] as const,
};

/**
 * Only what is worth having on disk: the model catalogs, which are large and
 * change about daily, and the conversation list, which paints the sidebar.
 *
 * Messages are deliberately excluded — they are the bulk of the cache, they go
 * stale the moment anyone sends, and they are cheap to refetch for the one
 * conversation actually being read.
 */
function shouldPersist(query: Query): boolean {
  if (query.state.status !== "success") return false;
  const [, root, second] = query.queryKey as string[];
  if (root === "models") return true;
  // queryKeys.messages() also starts with "conversations", so the list is
  // matched by its exact single-segment key rather than by prefix.
  return root === "conversations" && second === undefined;
}

/**
 * Reading localStorage can throw outright when storage is blocked (private
 * browsing, cookies disabled). The persister no-ops on undefined, so failing
 * to cache costs a round trip rather than the whole app.
 */
function availableStorage(): Storage | undefined {
  try {
    const probe = "__parley_probe__";
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export const persistOptions = {
  persister: createSyncStoragePersister({
    storage: availableStorage(),
    key: "parley-query-cache",
  }),
  maxAge: 24 * 60 * 60 * 1000,
  // Bump when a cached shape changes, or what a catalog lists does, to drop
  // entries written by an older build.
  buster: "v4",
  dehydrateOptions: { shouldDehydrateQuery: shouldPersist },
};
