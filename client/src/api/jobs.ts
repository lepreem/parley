import type {
  Job,
  JobAudio,
  JobSource,
  JobStatus,
  JobsPage,
  JobSummary,
} from "@parley/contract";
import { apiFetch, apiJson } from "./http";
import type { Server } from "./server";

export type { Job, JobSource, JobStatus, JobsPage, JobSummary };

export type JobsFilters = {
  status?: JobStatus | null;
  q?: string | null;
};

export async function fetchJob(
  server: Server,
  audioUploadId: string,
): Promise<Job> {
  const data = await apiJson<Job>(server, `/jobs/transcribe/${audioUploadId}`);
  if (!data?.audioUploadId) throw new Error("Invalid job response");
  return data;
}

/** Where the server has the job's audio, if it still does. */
export async function fetchJobAudio(
  server: Server,
  audioUploadId: string,
): Promise<JobAudio> {
  const data = await apiJson<JobAudio>(
    server,
    `/jobs/transcribe/${audioUploadId}/audio`,
  );
  if (!data || !("url" in data)) throw new Error("Invalid job audio response");
  return { url: data.url };
}

export async function fetchJobs(
  server: Server,
  params: JobsFilters & { limit?: number; cursor?: string | null } = {},
): Promise<JobsPage> {
  const query = new URLSearchParams();
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.status) query.set("status", params.status);
  if (params.q) query.set("q", params.q);

  const path = query.size > 0 ? `/jobs?${query}` : "/jobs";
  const data = await apiJson<JobsPage>(server, path);
  if (!Array.isArray(data?.jobs)) throw new Error("Invalid jobs response");
  return { jobs: data.jobs, nextCursor: data.nextCursor ?? null };
}

export async function deleteJob(
  server: Server,
  audioUploadId: string,
): Promise<void> {
  await apiFetch(server, `/jobs/transcribe/${audioUploadId}`, {
    method: "DELETE",
  });
}
