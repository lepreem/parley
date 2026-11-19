import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Avatar, ProfileResponse } from "@parley/contract/avatars";
import { fetchProfile, updateAvatar } from "../../api/profile";
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
 * Picks their picture. The new one shows at once and goes back to the old
 * one if the server turns it down.
 */
export function useUpdateAvatarMutation(userId: string) {
  const server = useServer();
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = queryKeys.profile(server.id, userId);

  return useMutation({
    mutationFn: (avatar: Avatar) => updateAvatar(server, avatar),
    onMutate: async (avatar) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProfileResponse>(key);
      queryClient.setQueryData<ProfileResponse>(key, { avatar });
      return { previous };
    },
    onSuccess: (profile) => {
      queryClient.setQueryData<ProfileResponse>(key, profile);
    },
    onError: (error, _avatar, context) => {
      if (context?.previous)
        queryClient.setQueryData<ProfileResponse>(key, context.previous);
      toast.show({
        kind: "error",
        message: errorMessage(error, "Couldn't change your picture."),
      });
    },
  });
}
