import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { defaultAvatar } from "@parley/contract/avatars";
import type {
  ProfileResponse,
  UpdateProfileBody,
} from "@parley/contract/profile";
import { fetchProfile, updateProfile } from "../../api/profile";
import { errorMessage } from "../../api/http";
import { queryKeys } from "../../lib/queryClient";
import { useServer } from "../server/useServer";
import { useToast } from "../toast/useToast";

/**
 * How the signed-in user appears. Only a server with accounts has one, so
 * there's nothing to ask for without a `userId`.
 */
export function useProfileQuery(userId: string | undefined) {
  const server = useServer();
  return useQuery({
    queryKey: queryKeys.profile(server.id, userId ?? ""),
    queryFn: () => fetchProfile(server),
    enabled: userId !== undefined,
  });
}

/**
 * Picks their picture or username. The change shows at once and goes back if
 * the server turns it down.
 */
export function useUpdateProfileMutation(userId: string) {
  const server = useServer();
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = queryKeys.profile(server.id, userId);

  return useMutation({
    mutationFn: (changes: UpdateProfileBody) => updateProfile(server, changes),
    onMutate: async (changes) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProfileResponse>(key);
      queryClient.setQueryData<ProfileResponse>(key, {
        avatar: changes.avatar ?? previous?.avatar ?? defaultAvatar(userId),
        username:
          changes.username !== undefined
            ? changes.username
            : (previous?.username ?? null),
      });
      return { previous };
    },
    onSuccess: (profile) => {
      queryClient.setQueryData<ProfileResponse>(key, profile);
    },
    onError: (error, changes, context) => {
      if (context?.previous)
        queryClient.setQueryData<ProfileResponse>(key, context.previous);
      toast.show({
        kind: "error",
        message: errorMessage(
          error,
          changes.avatar
            ? "Couldn't change your picture."
            : "Couldn't change your username.",
        ),
      });
    },
  });
}
