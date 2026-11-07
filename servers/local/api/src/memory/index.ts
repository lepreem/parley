import { chatCatalog } from "./chatCatalog";
import { repliesInProgress } from "./repliesInProgress";
import { toolApprovals } from "./toolApprovals";

/**
 * What this server keeps in its own memory: `memory.<what>.<operation>()`.
 * It's gone on a restart.
 */
export const memory = { chatCatalog, repliesInProgress, toolApprovals };
