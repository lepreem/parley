import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../../api/http";
import {
  answerToolApproval,
  fetchToolApprovals,
  type PermissionMode,
  type ToolApproval,
  type ToolApprovalChoice,
} from "../../api/toolApprovals";
import { useServer } from "../../hooks/server/useServer";
import { useToast } from "../../hooks/toast/useToast";
import { queryKeys } from "../../lib/queryClient";
import { useEventsConnected } from "../../sse/useEventsConnected";

/** How often the prompts are read when pushes aren't arriving. */
const POLL_MS = 3_000;

const SECONDARY =
  "rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-sunk disabled:opacity-50";

function ApprovalCard({
  approval,
  answering,
  onAnswer,
}: {
  approval: ToolApproval;
  answering: boolean;
  onAnswer: (choice: ToolApprovalChoice) => void;
}) {
  const { always } = approval;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-sm font-medium text-ink">
        Claude Code wants to use {approval.toolName}
      </p>
      {/* All of it, however long: this is what's being agreed to. */}
      <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-sunk p-3 font-mono text-xs whitespace-pre-wrap break-words text-ink">
        {approval.detail}
      </pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={answering}
          onClick={() => onAnswer("allow")}
          className="rounded-lg bg-signal px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Allow
        </button>
        {always && (
          <button
            type="button"
            disabled={answering}
            onClick={() => onAnswer("always")}
            className={SECONDARY}
          >
            {always.label}
          </button>
        )}
        <button
          type="button"
          disabled={answering}
          onClick={() => onAnswer("allowAll")}
          title="Runs everything without asking, for this reply and the messages after it, until you change it under the message box"
          className={SECONDARY}
        >
          Allow all
        </button>
        <button
          type="button"
          disabled={answering}
          onClick={() => onAnswer("deny")}
          className={SECONDARY}
        >
          Don't allow
        </button>
      </div>
      {always && always.rules.length > 0 && (
        <p className="mt-2 text-xs text-faint">
          {always.label} adds{" "}
          {always.rules.map((rule, index) => (
            <span key={rule}>
              {index > 0 && ", "}
              <code className="font-mono">{rule}</code>
            </span>
          ))}{" "}
          to your Claude Code settings.
        </p>
      )}
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
  onPermissionModeChange,
}: {
  conversationId: string;
  /** Called when the list changes, since it adds to the page's height. */
  onShown: () => void;
  /** For an answer that also changes how later messages may act. */
  onPermissionModeChange: (mode: PermissionMode) => void;
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

  const answer = async (approval: ToolApproval, choice: ToolApprovalChoice) => {
    setAnswering(approval.id);
    try {
      await answerToolApproval(server, conversationId, approval.id, choice);
      // The next messages carry on the way this one now does.
      if (choice === "allowAll") onPermissionModeChange("bypassPermissions");
      if (choice === "always" && approval.always?.mode) {
        onPermissionModeChange(approval.always.mode);
      }
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
          onAnswer={(choice) => void answer(approval, choice)}
        />
      ))}
    </div>
  );
}
