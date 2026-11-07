import { useQuery } from "@tanstack/react-query";
import { fetchChatModels, type ChatModel } from "../../api/models";
import { queryKeys } from "../../lib/queryClient";
import { useServer } from "../server/useServer";
import { useIsGuest } from "../auth/useIsGuest";

/**
 * The catalog only changes when the app does, or when the server says it
 * did: the programs on this computer offer what their settings say.
 */
const MODEL_CATALOG_STALE_MS = 60 * 60_000;

/** The chat models, in the order the API lists them, and how to offer them. */
export function useChatModelsQuery(enabled: boolean) {
  const server = useServer();
  const guest = useIsGuest();
  const query = useQuery({
    queryKey: queryKeys.chatModels(server.id, guest),
    queryFn: () => fetchChatModels(server),
    enabled,
    staleTime: MODEL_CATALOG_STALE_MS,
  });

  return {
    models: query.data?.models ?? NO_CHAT_MODELS,
    defaultModelId: query.data?.defaultModelId ?? null,
    recommendedModelIds: query.data?.recommendedModelIds ?? NO_IDS,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
  };
}

// Stable empty lists, so callers' memos don't rerun while loading.
const NO_CHAT_MODELS: ChatModel[] = [];
const NO_IDS: string[] = [];
