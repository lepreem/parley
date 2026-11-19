import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UpdateProjectBody } from "@parley/contract";
import { moveConversation, type Conversation } from "../../api/conversations";
import { errorMessage } from "../../api/http";
import {
  createProject,
  deleteProject,
  fetchProjects,
  updateProject,
  type Project,
} from "../../api/projects";
import { queryKeys } from "../../lib/queryClient";
import { useCapabilities } from "../auth/useCapabilities";
import { useServer } from "../server/useServer";
import { useToast } from "../toast/useToast";

/**
 * Whether this section offers projects: the server has them and the user's
 * tier may use them. Guests and the local server get none.
 */
export function useProjectsOffered(): boolean {
  const server = useServer();
  const can = useCapabilities();
  return server.projects && can.projects;
}

export function useProjectsQuery(enabled: boolean) {
  const server = useServer();
  const offered = useProjectsOffered();
  return useQuery({
    queryKey: queryKeys.projects(server.id),
    queryFn: () => fetchProjects(server),
    enabled: enabled && offered,
  });
}

export function useCreateProjectMutation() {
  const server = useServer();
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: (name: string) => createProject(server, { name }),
    onSuccess: (created) => {
      queryClient.setQueryData<Project[]>(
        queryKeys.projects(server.id),
        (current) => [created, ...(current ?? [])],
      );
    },
    onError: (error) => {
      toast.show({
        kind: "error",
        message: errorMessage(error, "Couldn't make that project."),
      });
    },
  });
}

export function useUpdateProjectMutation() {
  const server = useServer();
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: ({
      projectId,
      changes,
    }: {
      projectId: string;
      changes: UpdateProjectBody;
    }) => updateProject(server, projectId, changes),
    onSuccess: (updated) => {
      queryClient.setQueryData<Project[]>(
        queryKeys.projects(server.id),
        (current) =>
          current?.map((project) =>
            project.id === updated.id ? updated : project,
          ),
      );
    },
    onError: (error) => {
      toast.show({
        kind: "error",
        message: errorMessage(error, "Couldn't save that project."),
      });
    },
  });
}

/** Deletes the project; its chats go back to the main list, as the server does. */
export function useDeleteProjectMutation() {
  const server = useServer();
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) =>
      deleteProject(server, projectId),
    onSuccess: (_result, { projectId }) => {
      queryClient.setQueryData<Project[]>(
        queryKeys.projects(server.id),
        (current) => current?.filter((project) => project.id !== projectId),
      );
      queryClient.setQueryData<Conversation[]>(
        queryKeys.conversations(server.id),
        (current) =>
          current?.map((conversation) =>
            conversation.projectId === projectId
              ? { ...conversation, projectId: null }
              : conversation,
          ),
      );
    },
    onError: (error) => {
      toast.show({
        kind: "error",
        message: errorMessage(error, "Couldn't delete that project."),
      });
    },
  });
}

export function useMoveConversationMutation() {
  const server = useServer();
  const queryClient = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: ({
      conversationId,
      projectId,
    }: {
      conversationId: string;
      projectId: string | null;
    }) => moveConversation(server, conversationId, projectId),
    onSuccess: (moved) => {
      queryClient.setQueryData<Conversation[]>(
        queryKeys.conversations(server.id),
        (current) =>
          current?.map((conversation) =>
            conversation.id === moved.id ? moved : conversation,
          ),
      );
    },
    onError: (error) => {
      toast.show({
        kind: "error",
        message: errorMessage(error, "Couldn't move that chat."),
      });
    },
  });
}
