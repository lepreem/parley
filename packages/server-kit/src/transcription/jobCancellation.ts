const running = new Map<string, AbortController>();

/**
 * Cancelling a job while this process works on it.
 *
 * A worker calls `start` before it claims the job, so a delete either finds
 * the job gone from the worker's view of the database (the claim comes back
 * empty) or finds the job here and aborts the signal. There's no moment
 * between the two when a delete goes unnoticed.
 *
 * It only reaches work in this process. A second instance would need the
 * cancel sent to it over the broker.
 */
export const jobCancellation = {
  /** The job's signal, and what to call once the work on it has ended. */
  start(jobId: string) {
    const controller = new AbortController();
    running.set(jobId, controller);
    return {
      signal: controller.signal,
      finish() {
        if (running.get(jobId) === controller) running.delete(jobId);
      },
    };
  },

  /** Aborts the job's signal, if this process is working on it. */
  cancel(jobId: string) {
    running.get(jobId)?.abort(new Error("The job was cancelled"));
  },
};
