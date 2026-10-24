import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { TurnStep } from "@parley/shared/contract";
import type { logger } from "@parley/shared/logger";

export type RecordedStep = TurnStep & {
  operationId: string;
  parentOperationId: string | undefined;
};

type PreparationContext = {
  log: Pick<typeof logger, "info">;
  startedAt: number;
  parentOperationId?: string;
  depth?: number;
  /** Each step as it completes, for a turn that reports its stats. */
  steps?: RecordedStep[];
};

const preparationContext = new AsyncLocalStorage<PreparationContext>();

/**
 * Durations are reported to two decimals throughout: finer than that is noise
 * from the timer itself, and coarser loses the sub-millisecond steps.
 */
const roundMs = (ms: number) => Math.round(ms * 100) / 100;

/** Milliseconds since a `performance.now()` mark, rounded the same way. */
export const msSince = (mark: number) => roundMs(performance.now() - mark);

export function withPreparationMetrics<T>(
  context: PreparationContext,
  run: () => T,
): T {
  return preparationContext.run(context, run);
}

export async function measurePreparation<T>(
  operation: string,
  promiseAllId: string | undefined,
  run: () => PromiseLike<T>,
  details?: Record<string, number | boolean>,
): Promise<T> {
  const context = preparationContext.getStore();
  if (!context) return await run();

  const operationId = randomUUID();
  const startedAt = performance.now();
  let outcome = "fulfilled";
  try {
    return await preparationContext.run(
      {
        ...context,
        parentOperationId: operationId,
        depth: (context.depth ?? 0) + 1,
      },
      run,
    );
  } catch (error) {
    outcome = "rejected";
    throw error;
  } finally {
    const finishedAt = performance.now();
    const step = {
      operation,
      operationId,
      parentOperationId: context.parentOperationId,
      depth: context.depth ?? 0,
      startOffsetMs: roundMs(startedAt - context.startedAt),
      durationMs: roundMs(finishedAt - startedAt),
    };
    context.steps?.push(step);
    context.log.info("Message preparation operation completed", {
      operation,
      operationId,
      parentOperationId: step.parentOperationId,
      promiseAllId,
      outcome,
      durationMs: step.durationMs,
      startOffsetMs: step.startOffsetMs,
      completedAfterMs: roundMs(finishedAt - context.startedAt),
      ...details,
    });
  }
}

/**
 * Recorded steps as a tree read top to bottom: by when they started, each
 * followed by the steps it ran. Sorting by start alone would put a step's
 * own steps under whichever step started beside it.
 */
export function stepsInOrder(steps: readonly RecordedStep[]): TurnStep[] {
  const byStart = steps.toSorted((a, b) => a.startOffsetMs - b.startOffsetMs);
  const ordered: TurnStep[] = [];
  const visit = (parentOperationId: string | undefined) => {
    for (const step of byStart) {
      if (step.parentOperationId !== parentOperationId) continue;
      const { operation, depth, startOffsetMs, durationMs } = step;
      ordered.push({ operation, depth, startOffsetMs, durationMs });
      visit(step.operationId);
    }
  };
  visit(undefined);
  return ordered;
}
