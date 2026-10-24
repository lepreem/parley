import { useState } from "react";
import { describeModel } from "../../api/models";
import { useChatModelsQuery } from "../../hooks/queries/useModelsQuery";
import { useServerReady } from "../../hooks/server/useServerReady";
import { Icon } from "../ui/Icon";
import type { TurnStats } from "../../api/messages";
import { Markdown } from "./Markdown";
import { TurnStatsPanel } from "./TurnStatsPanel";

export function AssistantTurn({
  content,
  modelId,
  streaming,
  elsewhere,
  stopped,
  stats,
}: {
  content: string;
  modelId?: string | null;
  streaming?: boolean;
  /** Streaming, but not to this page: `content` is how far it had got. */
  elsewhere?: boolean;
  /** Someone stopped it before it finished. */
  stopped?: boolean;
  /** How the turn went, when it was streamed to this page. */
  stats?: TurnStats;
}) {
  const [copied, setCopied] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const { models } = useChatModelsQuery(useServerReady());
  const model = models.find((entry) => entry.id === modelId);
  const modelName = model ? describeModel(model).name : modelId;

  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="group/turn">
      {streaming && content.length === 0 ? (
        // Not "Thinking": most models don't, they're just slow to start.
        <span
          className="typing"
          role="status"
          aria-label="Waiting for the reply"
        >
          <span />
          <span />
          <span />
        </span>
      ) : (
        <div className="md">
          <Markdown content={content} />
        </div>
      )}

      {elsewhere && content.length > 0 && (
        <p className="mt-2 text-sm text-faint">
          Still writing
          <span className="caret" />
        </p>
      )}

      {!streaming && content.length > 0 && (
        <div className="mt-2 flex h-7 items-center gap-3">
          {stopped && (
            <span className="px-1.5 text-xs text-faint">Stopped</span>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted opacity-0 pointer-coarse:opacity-100 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/turn:opacity-100"
          >
            <Icon name={copied ? "check" : "copy"} className="h-3.5 w-3.5" />
            <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
          </button>
          {stats && (
            <button
              type="button"
              onClick={() => setStatsOpen((open) => !open)}
              aria-expanded={statsOpen}
              className={`flex items-center gap-1 rounded-md px-1.5 py-1 text-muted transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/turn:opacity-100 pointer-coarse:opacity-100 ${statsOpen ? "opacity-100" : "opacity-0"}`}
            >
              <span className="text-xs">Stats for nerds</span>
              <Icon
                name="chevronDown"
                className={`h-3 w-3 transition-transform ${statsOpen ? "rotate-180" : ""}`}
              />
            </button>
          )}
          {modelName && (
            <span className="font-mono text-[11px] text-faint opacity-0 pointer-coarse:opacity-100 transition-opacity group-hover/turn:opacity-100">
              {modelName}
            </span>
          )}
        </div>
      )}

      {stats && statsOpen && <TurnStatsPanel stats={stats} />}
    </div>
  );
}
