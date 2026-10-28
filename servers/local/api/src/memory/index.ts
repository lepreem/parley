import { repliesInProgress } from "./repliesInProgress";

/**
 * What this server keeps in its own memory: `memory.<what>.<operation>()`.
 * It's gone on a restart.
 */
export const memory = { repliesInProgress };
