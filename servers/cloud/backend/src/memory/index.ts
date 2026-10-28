import { historyText } from "./historyText";
import { modelLists } from "./modelLists";
import { repliesInProgress } from "./repliesInProgress";

/**
 * What this process keeps in its own memory: `memory.<what>.<operation>()`.
 * It's gone on a restart, and a second instance would hold its own.
 */
export const memory = { historyText, modelLists, repliesInProgress };

export { CACHE_KEYS } from "./modelLists";
export { replyKey } from "./repliesInProgress";
