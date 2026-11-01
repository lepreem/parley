import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  deleteJob,
  fetchJob,
  fetchJobs,
  type JobsFilters,
} from "../../api/jobs";
import { errorMessage } from "../../api/http";
import { audioCopies } from "../../media/audioCopies";
import { queryKeys } from "../../lib/queryClient";
import { useServer } from "../server/useServer";
import { useToast } from "../toast/useToast";

const PAGE_SIZE = 20;

/** The sources library — every transcript job the user owns, newest first. */
export function useJobsQuery(enabled: boolean, filters: JobsFilters = {}) {
  const server = useServer();
  return useInfiniteQuery({
    queryKey: [...queryKeys.jobLists(server.id), filters],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      fetchJobs(server, { ...filters, limit: PAGE_SIZE, cursor: pageParam }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/** One job with its transcript body — what the transcript view reads. */
export function useJobQuery(audioUploadId: string | null) {
  const server = useServer();
  return useQuery({
    queryKey: queryKeys.job(server.id, audioUploadId ?? ""),
    queryFn: () => fetchJob(server, audioUploadId as string),
    enabled: !!audioUploadId,
  });
}

export function useDeleteJobMutation() {
  const server = useServer();
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: ({ audioUploadId }: { audioUploadId: string }) =>
      deleteJob(server, audioUploadId),
    onSuccess: (_result, { audioUploadId }) => {
      void audioCopies.remove(audioUploadId).catch(() => {});
      queryClient.removeQueries({
        queryKey: queryKeys.job(server.id, audioUploadId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.jobLists(server.id),
      });
      toast.show({ kind: "success", message: "Source deleted." });
    },
    onError: (error) => {
      toast.show({
        kind: "error",
        message: errorMessage(error, "Couldn't delete that source."),
      });
    },
  });
}
