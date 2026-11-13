import * as memory from "../memory";
import * as workos from "./auth";

/**
 * Refreshes a session, making one request to WorkOS however many callers
 * bring the same refresh token at once or shortly after.
 *
 * The results live in this process, which is enough while the API runs as
 * one instance; with more, whatever sits in front of them would own refresh.
 */
export function refreshSession(refreshToken: string) {
  return memory.sessionRefreshes.once(refreshToken, () =>
    workos.refreshAuthSession(refreshToken),
  );
}
