import type {
  CreateProjectBody,
  Project,
  ProjectsResponse,
  UpdateProjectBody,
} from "@parley/contract";
import { apiFetch, apiJson, jsonRequest } from "./http";
import type { Server } from "./server";

export type { Project };

export async function fetchProjects(server: Server): Promise<Project[]> {
  const data = await apiJson<ProjectsResponse>(server, "/projects");
  if (!Array.isArray(data?.projects)) {
    throw new Error("Invalid projects response");
  }
  return data.projects;
}

export async function createProject(
  server: Server,
  body: CreateProjectBody,
): Promise<Project> {
  return apiJson<Project>(server, "/projects", jsonRequest("POST", body));
}

export async function updateProject(
  server: Server,
  projectId: string,
  body: UpdateProjectBody,
): Promise<Project> {
  return apiJson<Project>(
    server,
    `/projects/${projectId}`,
    jsonRequest("PATCH", body),
  );
}

export async function deleteProject(
  server: Server,
  projectId: string,
): Promise<void> {
  await apiFetch(server, `/projects/${projectId}`, { method: "DELETE" });
}
