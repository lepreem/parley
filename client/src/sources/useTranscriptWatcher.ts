import { useEffect, useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { fetchJob, type Job } from "../api/jobs";
import { useServer } from "../hooks/server/useServer";
import { useEventsConnected } from "../sse/useEventsConnected";
import { queryKeys } from "../lib/queryClient";
import type { StagedSource } from "./types";

/**
 * Only used while the event stream is down. /jobs allows 100 requests per 15 minutes
 * per user, shared with the sources drawer, so this stays slow on purpose —
 * push is the real mechanism and a reconnect refetches everything anyway.
 */
const OFFLINE_POLL_MS = 20_000;

/**
 * Watches every staged source waiting on a transcript and moves it to ready or
 * failed. Nothing else advances a source past `transcribing`: the upload
 * response only tells us the job was queued.
 */
export function useTranscriptWatcher(
  drafts: Record<string, StagedSource[]>,
  patchBySourceUploadId: (
    sourceUploadId: string,
    patch: Partial<StagedSource>,
  ) => void,
) {
  const server = useServer();
  const eventsConnected = useEventsConnected();

  const pendingAudioUploadIds = useMemo(() => {
    const audioUploadIds = new Set<string>();
    for (const draft of Object.values(drafts)) {
      for (const source of draft) {
        if (source.status === "transcribing" && source.sourceUploadId) {
          audioUploadIds.add(source.sourceUploadId);
        }
      }
    }
    return [...audioUploadIds].sort();
  }, [drafts]);

  const results = useQueries({
    queries: pendingAudioUploadIds.map((audioUploadId) => ({
      queryKey: queryKeys.job(server.id, audioUploadId),
      queryFn: () => fetchJob(server, audioUploadId),
      refetchInterval: eventsConnected ? (false as const) : OFFLINE_POLL_MS,
      staleTime: 0,
    })),
  });

  const settled = results.flatMap((result) =>
    result.data?.status === "completed" || result.data?.status === "failed"
      ? [result.data]
      : [],
  );
  // The patch effect keys off what actually changed, not the array identity
  // useQueries hands back on every render.
  const signature = settled
    .map((job) => `${job.audioUploadId}:${job.status}`)
    .join("|");
  const settledRef = useRef<Job[]>(settled);
  useEffect(() => {
    settledRef.current = settled;
  });

  useEffect(() => {
    for (const job of settledRef.current) {
      if (job.status === "completed") {
        patchBySourceUploadId(job.audioUploadId, {
          status: "ready",
          name: job.fileName,
          charCount: job.transcript?.length ?? null,
        });
      } else {
        patchBySourceUploadId(job.audioUploadId, {
          status: "failed",
          error: job.error ?? "Transcription failed.",
        });
      }
    }
  }, [signature, patchBySourceUploadId]);
}
