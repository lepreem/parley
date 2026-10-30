import { useQuery } from "@tanstack/react-query";
import {
  fetchChatModels,
  fetchTranscriptionModels,
  type ChatModel,
  type TranscribeModel,
} from "../../api/models";
import { queryKeys } from "../../lib/queryClient";
import { useServer } from "../server/useServer";
import { useIsGuest } from "../auth/useIsGuest";

/** The catalogs only change when the app does. */
const MODEL_CATALOG_STALE_MS = 60 * 60_000;

/** The chat models, in the order the API lists them. */
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
    models: query.data ?? NO_CHAT_MODELS,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
  };
}

/** The transcription models, in the order the API lists them. */
export function useTranscriptionModelsQuery(enabled: boolean) {
  const server = useServer();
  const query = useQuery({
    queryKey: queryKeys.transcriptionModels(server.id),
    queryFn: () => fetchTranscriptionModels(server),
    enabled,
    staleTime: MODEL_CATALOG_STALE_MS,
  });

  return {
    models: query.data ?? NO_TRANSCRIPTION_MODELS,
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
  };
}

// Stable empty lists, so callers' memos don't rerun while loading.
const NO_CHAT_MODELS: ChatModel[] = [];
const NO_TRANSCRIPTION_MODELS: TranscribeModel[] = [];
