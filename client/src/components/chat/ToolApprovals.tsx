import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../api/http";
import {
  answerToolApproval,
  fetchToolApprovals,
  type ToolApproval,
} from "../../api/toolApprovals";
import { useServer } from "../../hooks/server/useServer";
import { useToast } from "../../hooks/toast/useToast";
import { queryKeys } from "../../lib/queryClient";
import { useEventsConnected } from "../../sse/useEventsConnected";

/** How often the prompts are read when pushes aren't arriving. */
const POLL_MS = 3_000;

function ApprovalCard({
  approval,
  answering,
  onAnswer,
}: {
  approval: ToolApproval;
  answering: boolean;
  onAnswer: (allow: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-sm font-medium text-ink">
        Claude Code wants to use {approval.toolName}
      </p>
      {/* All of it, however long: this is what's being agreed to. */}
      <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-sunk p-3 font-mono text-xs whitespace-pre-wrap break-words text-ink">
        {approval.detail}
      </pre>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={answering}
          onClick={() => onAnswer(true)}
          className="rounded-lg bg-signal px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Allow
        </button>
        <button
          type="button"
          disabled={answering}
          onClick={() => onAnswer(false)}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-sunk disabled:opacity-50"
        >
          Don't allow
        </button>
      </div>
    </div>
  );
}

/**
 * What the reply being written is waiting on the person for, on a server whose
 * replies can stop to ask. It's read from the server, so a reloaded page or
 * another tab can answer too.
 */
export function ToolApprovals({
  conversationId,
  onShown,
}: {
  conversationId: string;
  /** Called when the list changes, since it adds to the page's height. */
  onShown: () => void;
}) {
  const server = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();
  const pushed = useEventsConnected();
  const queryKey = queryKeys.toolApprovals(server.id, conversationId);
  const [answering, setAnswering] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey,
    queryFn: () => fetchToolApprovals(server, conversationId),
    enabled: server.toolApprovals,
    staleTime: 0,
    refetchInterval: pushed ? false : POLL_MS,
  });
  const approvals = server.toolApprovals ? (data ?? []) : [];

  const count = approvals.length;
  useEffect(() => {
    if (count > 0) onShown();
  }, [count, onShown]);

  const answer = async (id: string, allow: boolean) => {
    setAnswering(id);
    try {
      await answerToolApproval(server, conversationId, id, allow);
    } catch (error) {
      toast.show({
        kind: "error",
        message: errorMessage(error, "That answer didn't go through."),
      });
    } finally {
      setAnswering(null);
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  if (count === 0) return null;
  return (
    <div className="space-y-3">
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          answering={answering === approval.id}
          onAnswer={(allow) => void answer(approval.id, allow)}
        />
      ))}
    </div>
  );
}
