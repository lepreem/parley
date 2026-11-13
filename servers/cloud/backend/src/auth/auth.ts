/** Sign-in and sessions, from WorkOS AuthKit. */

import { WorkOS } from "@workos-inc/node";
import { getEnv } from "../env";

/** Exported so the auth tests can assert the URL WorkOS is handed. */
export const WORKOS_REDIRECT_URI = new URL(
  "/auth/callback",
  getEnv().API_BASE_URL,
).toString();

/**
 * Where the SDK sends its requests, signing keys included: WorkOS itself
 * unless WORKOS_API_BASE_URL points at the load test's stand-in. The SDK takes
 * the address in parts rather than as a URL.
 */
function workosHostOptions(baseUrl: string | undefined) {
  if (!baseUrl) return {};
  const url = new URL(baseUrl);
  return {
    apiHostname: url.hostname,
    https: url.protocol === "https:",
    ...(url.port ? { port: Number(url.port) } : {}),
  };
}

const client = new WorkOS(getEnv().WORKOS_API_KEY, {
  clientId: getEnv().WORKOS_CLIENT_ID,
  ...workosHostOptions(getEnv().WORKOS_API_BASE_URL),
});

/** Startup health check: fails if WorkOS is unreachable or rejects the API key. */
export async function ping(): Promise<void> {
  await client.userManagement.listUsers({ limit: 1 });
}

/** Where WorkOS publishes the keys it signs access tokens with. */
export function getJwksUrl() {
  return client.userManagement.getJwksUrl(getEnv().WORKOS_CLIENT_ID);
}

export function getRedirectUrl() {
  return client.userManagement.getAuthorizationUrl({
    // Specify that we'd like AuthKit to handle the authentication flow
    provider: "authkit",

    // The callback endpoint that WorkOS will redirect to after a user authenticates
    redirectUri: WORKOS_REDIRECT_URI,
    clientId: getEnv().WORKOS_CLIENT_ID,
  });
}

/**
 * Exchanges the code WorkOS redirected back with for the user and their
 * tokens: the access token becomes the session cookie as it is, and the
 * refresh token is what gets a new one when it expires.
 */
export async function getAuthSessionFromCode(code: string) {
  const { user, accessToken, refreshToken } =
    await client.userManagement.authenticateWithCode({
      code,
      clientId: getEnv().WORKOS_CLIENT_ID,
    });
  return { userId: user.id, accessToken, refreshToken };
}

/**
 * Trades a refresh token for the user it belongs to, a new access token and
 * a new refresh token. WorkOS rotates refresh tokens, so the one passed in
 * stops working once this succeeds.
 */
export async function refreshAuthSession(refreshToken: string) {
  const {
    user,
    accessToken,
    refreshToken: nextRefreshToken,
  } = await client.userManagement.authenticateWithRefreshToken({
    refreshToken,
    clientId: getEnv().WORKOS_CLIENT_ID,
  });
  return { userId: user.id, accessToken, refreshToken: nextRefreshToken };
}

export async function revokeAuthSession(sessionId: string): Promise<void> {
  await client.userManagement.revokeSession({
    sessionId,
  });
}
