import { useQuery } from "@tanstack/react-query";
import { fetchMessages } from "../../api/messages";
import { queryKeys } from "../../lib/queryClient";
import { useEventsConnected } from "../../sse/useEventsConnected";
import { useServer } from "../server/useServer";

/** How often a chat showing someone else's reply is read without pushes. */
const REPLY_POLL_MS = 3_000;

export function useMessagesQuery(conversationId: string | undefined) {
  const server = useServer();
  const pushed = useEventsConnected();
  return useQuery({
    queryKey: queryKeys.messages(server.id, conversationId ?? ""),
    queryFn: () => fetchMessages(server, conversationId as string),
    enabled: !!conversationId,
    // A reply this page isn't streaming ends with a replyFinished push; with
    // the event stream down, nothing else would say so.
    refetchInterval: (query) =>
      query.state.data?.replyInProgress && !pushed ? REPLY_POLL_MS : false,
  });
}
