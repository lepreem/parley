import type { ReasoningEffort } from "@parley/contract";

/** Every level a turn can ask a model to think at, least thinking first. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ReasoningEffort[];
