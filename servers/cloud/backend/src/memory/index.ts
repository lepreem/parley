import { historyText } from "./historyText";
import { modelLists } from "./modelLists";
import { rateLimitCounts } from "./rateLimitCounts";
import { repliesInProgress } from "./repliesInProgress";
import { sessionRefreshes } from "./sessionRefreshes";

/**
 * What this process keeps in its own memory: `memory.<what>.<operation>()`.
 * It's gone on a restart, and a second instance would hold its own.
 */
export const memory = {
  historyText,
  modelLists,
  rateLimitCounts,
  repliesInProgress,
  sessionRefreshes,
};

export { CACHE_KEYS } from "./modelLists";
