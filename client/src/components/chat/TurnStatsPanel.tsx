import type { TurnStats } from "../../api/messages";

type Row = {
  label: string;
  depth: number;
  startMs: number;
  durationMs: number;
  tone: "step" | "waiting" | "writing";
};

const barTone: Record<Row["tone"], string> = {
  step: "bg-line-strong",
  waiting: "bg-signal-tint",
  writing: "bg-signal",
};

/** Two decimals for the sub-millisecond steps, whole numbers once it's long. */
function formatMs(ms: number) {
  if (ms >= 100) return `${Math.round(ms).toLocaleString()} ms`;
  return `${ms.toFixed(ms >= 10 ? 1 : 2)} ms`;
}

const count = (n: number) => n.toLocaleString();

/**
 * The server's steps with the model's two spans (waiting for the first
 * token, then writing) placed among them by when they started.
 */
function rowsOf(stats: TurnStats): Row[] {
  const firstTokenMs = stats.firstTokenAfterMs ?? stats.modelFinishedAfterMs;
  const modelRows: Row[] = [
    {
      label: "model: first token",
      depth: 0,
      startMs: stats.modelStartedAfterMs,
      durationMs: firstTokenMs - stats.modelStartedAfterMs,
      tone: "waiting",
    },
    {
      label: "model: writing",
      depth: 0,
      startMs: firstTokenMs,
      durationMs: stats.modelFinishedAfterMs - firstTokenMs,
      tone: "writing",
    },
  ];

  const rows: Row[] = [];
  let modelPlaced = false;
  for (const step of stats.steps) {
    // Only between top-level steps, so a step's own steps stay under it.
    if (
      !modelPlaced &&
      step.depth === 0 &&
      step.startOffsetMs >= stats.modelStartedAfterMs
    ) {
      rows.push(...modelRows);
      modelPlaced = true;
    }
    rows.push({
      label: step.operation,
      depth: step.depth,
      startMs: step.startOffsetMs,
      durationMs: step.durationMs,
      tone: "step",
    });
  }
  if (!modelPlaced) rows.push(...modelRows);
  return rows;
}

/**
 * How one turn went, as the server timed it: a waterfall of every step from
 * the request's start to the save, then what went into the prompt.
 */
export function TurnStatsPanel({ stats }: { stats: TurnStats }) {
  const scale = Math.max(stats.totalMs, 1);
  const { context } = stats;
  const promptChars = context.historyChars + context.newTurnChars;

  return (
    <div className="mt-2 rounded-lg border border-line bg-sunk p-3 font-mono text-[11px] text-muted">
      <p className="text-faint">
        total <span className="text-ink">{formatMs(stats.totalMs)}</span>
        {stats.firstTokenAfterMs !== null && (
          <>
            {" · "}first token{" "}
            <span className="text-ink">
              {formatMs(stats.firstTokenAfterMs)}
            </span>
            {" ("}model{" "}
            {formatMs(stats.firstTokenAfterMs - stats.modelStartedAfterMs)})
          </>
        )}
      </p>

      <table className="mt-2 w-full table-fixed border-collapse">
        <tbody>
          {rowsOf(stats).map((row, index) => (
            <tr key={index}>
              <td
                className="w-44 truncate py-0.5 pr-2"
                style={{ paddingLeft: `${row.depth * 0.75}rem` }}
                title={row.label}
              >
                {row.label}
              </td>
              <td className="py-0.5">
                <div className="relative h-2">
                  <div
                    className={`absolute inset-y-0 rounded-sm ${barTone[row.tone]}`}
                    style={{
                      left: `${(row.startMs / scale) * 100}%`,
                      width: `max(${(row.durationMs / scale) * 100}%, 2px)`,
                    }}
                  />
                </div>
              </td>
              <td className="w-20 py-0.5 text-right text-ink tabular-nums">
                {formatMs(row.durationMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
        <dt className="text-faint">history read</dt>
        <dd>
          {count(context.historyReadMessages)} messages,{" "}
          {count(context.historyCachedMessages)} with their text cached
        </dd>
        <dt className="text-faint">history sent</dt>
        <dd>
          {count(context.historyMessages)} of up to{" "}
          {count(context.maxHistoryMessages)} messages,{" "}
          {count(context.historyChars)} chars
        </dd>
        <dt className="text-faint">this message</dt>
        <dd>{count(context.newTurnChars)} chars</dd>
        <dt className="text-faint">context used</dt>
        <dd>
          {count(promptChars)} of {count(context.maxChars)} chars (
          {((promptChars / context.maxChars) * 100).toFixed(1)}%)
        </dd>
      </dl>
    </div>
  );
}
