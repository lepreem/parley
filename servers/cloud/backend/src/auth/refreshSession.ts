import * as memory from "../memory";
import * as workos from "./workos";

/**
 * The refresh token was turned down: spent, revoked or expired. The session
 * is over, as opposed to WorkOS failing to answer.
 */
export class RefreshRefused extends Error {
  constructor(options: { cause: unknown }) {
    super("The refresh token was refused", options);
    this.name = "RefreshRefused";
  }
}

/**
 * Refreshes a session, making one request to WorkOS however many callers
 * bring the same refresh token at once or shortly after. Throws
 * RefreshRefused when the session is over.
 *
 * The results live in this process, which is enough while the API runs as
 * one instance; with more, whatever sits in front of them would own refresh.
 */
export function refresh(refreshToken: string) {
  return memory.sessionRefreshes.once(refreshToken, async () => {
    try {
      return await workos.refreshTokens(refreshToken);
    } catch (error) {
      throw workos.isRefusal(error)
        ? new RefreshRefused({ cause: error })
        : error;
    }
  });
}
