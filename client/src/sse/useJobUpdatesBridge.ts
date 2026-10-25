import { useContext, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EventsContext } from "./context";
import { queryKeys } from "../lib/queryClient";
import { useToast } from "../hooks/toast/useToast";
import type { Job } from "../api/jobs";
import { useServer } from "../hooks/server/useServer";

/**
 * The fast path for transcript progress: a job update refreshes that job, which
 * is what the staged-source watcher and the sources drawer both read. Only
 * failures are announced — a finished transcript is already visible on its chip.
 */
export function useJobUpdatesBridge(enabled: boolean) {
  const server = useServer();
  const events = useContext(EventsContext);
  const queryClient = useQueryClient();
  const toast = useToast();

  useEffect(() => {
    if (!enabled || !events) return;

    return events.subscribe("jobUpdated", async ({ audioUploadId }) => {
      if (!audioUploadId) return;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.job(server.id, audioUploadId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.jobLists(server.id),
      });

      const job = queryClient.getQueryData<Job>(
        queryKeys.job(server.id, audioUploadId),
      );
      if (job?.status === "failed") {
        toast.show({
          kind: "error",
          message: `${job.fileName} failed${job.error ? `: ${job.error}` : "."}`,
        });
      }
    });
  }, [enabled, server, events, queryClient, toast]);

  // Updates pushed while the stream was down reached nobody, so each time it
  // opens, what it may have missed is read again rather than waited for.
  const connected = events?.connected ?? false;
  useEffect(() => {
    if (!enabled || !connected) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.everyJob(server.id),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.jobLists(server.id),
    });
  }, [enabled, connected, server, queryClient]);
}
