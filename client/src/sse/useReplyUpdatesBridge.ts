import { useContext, useEffect } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import type { MessagesResponse } from "../api/messages";
import { queryKeys } from "../lib/queryClient";
import { useServer } from "../hooks/server/useServer";
import { EventsContext } from "./context";

/** A chat shown with a reply this page isn't streaming, so it can't see it end. */
function showsReplyElsewhere(query: Query) {
  return !!(query.state.data as MessagesResponse | undefined)?.replyInProgress;
}

/**
 * Reads a chat again once the server says its reply finished, for a page
 * that's only showing how far that reply had got: one reloaded mid-reply, or
 * another tab. A page streaming the reply itself writes the turn into the
 * cache as it ends, so it's left alone.
 */
export function useReplyUpdatesBridge(enabled: boolean) {
  const server = useServer();
  const events = useContext(EventsContext);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !events) return;

    return events.subscribe("replyFinished", ({ conversationId }) => {
      if (!conversationId) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages(server.id, conversationId),
        predicate: showsReplyElsewhere,
      });
      // A first turn names the chat.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversations(server.id),
        exact: true,
      });
    });
  }, [enabled, server, events, queryClient]);

  // A reply that finished while the stream was down reached nobody, so each
  // time it opens, any chat still showing one is read again.
  const connected = events?.connected ?? false;
  useEffect(() => {
    if (!enabled || !connected) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.conversations(server.id),
      predicate: showsReplyElsewhere,
    });
  }, [enabled, connected, server, queryClient]);
}
