import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateKeyPair, SignJWT } from "jose";

const MOCK_WORKOS_URL = "https://workos.example/authorize";
const userId = "user_01CALLBACK";
const sessionId = "session_01CALLBACK";

const {
  mockGetRedirectUrl,
  mockGetAuthSessionFromCode,
  mockRevokeAuthSession,
  mockRefreshAuthSession,
  mockInsert,
} = vi.hoisted(() => ({
  mockGetRedirectUrl: vi.fn(),
  mockGetAuthSessionFromCode: vi.fn(),
  mockRevokeAuthSession: vi.fn(),
  mockRefreshAuthSession: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock("../../src/auth/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/auth")>();
  return {
    ...actual,
    workos: {
      ...actual.workos,
      getRedirectUrl: mockGetRedirectUrl,
      getAuthSessionFromCode: mockGetAuthSessionFromCode,
      revokeAuthSession: mockRevokeAuthSession,
      refreshAuthSession: mockRefreshAuthSession,
    },
  };
});

vi.mock("../../src/db", async () => ({
  db: { insert: mockInsert },
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

import { createApp } from "../../src/app";
import { authedHeaders } from "../helpers/session";
import { signAccessToken } from "../helpers/accessTokens";
import { WORKOS_REDIRECT_URI } from "../../src/auth/auth";
import { COOKIE_KEYS } from "../../src/cookies/session";

describe("GET /auth/me", () => {
  it("returns 401 without a session cookie", async () => {
    const res = await (await createApp()).request("http://localhost/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid session cookie", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/me", {
      headers: { Cookie: `${COOKIE_KEYS.session}=not.a.valid.jwt` },
    });
    expect(res.status).toBe(401);
  });

  it("returns the user and when their access token expires", async () => {
    const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + 300;
    const token = await signAccessToken({
      userId: "user_01TEST",
      sessionId,
      expiresAtEpochSeconds,
    });

    const res = await (
      await createApp()
    ).request("http://localhost/auth/me", {
      headers: { Cookie: `${COOKIE_KEYS.session}=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user_01TEST",
      expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
      isGuest: false,
    });
  });
});

const EXPECTED_CALLBACK_PATH = "/auth/callback";

describe("OAuth callback URL", () => {
  it("WorkOS redirectUri path matches auth router callback", () => {
    const { pathname } = new URL(WORKOS_REDIRECT_URI);
    expect(pathname).toBe(EXPECTED_CALLBACK_PATH);
  });
});

describe("GET /auth/login", () => {
  beforeEach(() => {
    mockGetRedirectUrl.mockReturnValue(MOCK_WORKOS_URL);
  });

  it("redirects to the WorkOS authorization URL", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/login", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(MOCK_WORKOS_URL);
    expect(mockGetRedirectUrl).toHaveBeenCalledTimes(1);
  });
});

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthSessionFromCode.mockResolvedValue({
      userId,
      accessToken: "workos-access-token",
      refreshToken: "workos-refresh-token",
    });
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    });
  });

  it("returns 400 when code is missing (route exists)", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/callback");
    expect(res.status).toBe(400);
  });

  it("exchanges code, sets session cookie, and redirects to client", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/callback?code=oauth_code_123", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:5173");
    expect(mockGetAuthSessionFromCode).toHaveBeenCalledWith("oauth_code_123");
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContainEqual(
      expect.stringMatching(
        new RegExp(`^${COOKIE_KEYS.session}=workos-access-token;.*Path=/;`),
      ),
    );
    // Sent only to the endpoint that spends it.
    expect(cookies).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${COOKIE_KEYS.refresh}=workos-refresh-token;.*Path=/auth/refresh;`,
        ),
      ),
    );
  });
});

describe("POST /auth/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Refresh results are kept per refresh token, so each test spends its own. */
  const refresh = async (refreshToken?: string) =>
    (await createApp()).request("http://localhost/auth/refresh", {
      method: "POST",
      headers: {
        Origin: process.env.CLIENT_URL!,
        ...(refreshToken && {
          Cookie: `${COOKIE_KEYS.refresh}=${refreshToken}`,
        }),
      },
    });

  // SameSite=Lax already keeps the cookie off another site's POST; this is
  // the check that holds even if a browser sends it anyway.
  it("refuses a refresh from another site", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/refresh", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Cookie: `${COOKIE_KEYS.refresh}=refresh-cross-site`,
      },
    });

    expect(res.status).toBe(403);
    expect(mockRefreshAuthSession).not.toHaveBeenCalled();
  });

  it("returns 401 without a refresh cookie", async () => {
    const res = await refresh();

    expect(res.status).toBe(401);
    expect(mockRefreshAuthSession).not.toHaveBeenCalled();
  });

  it("sets both new tokens and says when the access token expires", async () => {
    const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + 300;
    const accessToken = await signAccessToken({
      userId,
      sessionId,
      expiresAtEpochSeconds,
    });
    mockRefreshAuthSession.mockResolvedValue({
      userId,
      accessToken,
      refreshToken: "refresh-after-success",
    });

    const res = await refresh("refresh-before-success");

    expect(res.status).toBe(200);
    expect(mockRefreshAuthSession).toHaveBeenCalledWith(
      "refresh-before-success",
    );
    expect(await res.json()).toEqual({
      userId,
      expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
    });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContainEqual(
      expect.stringMatching(
        new RegExp(`^${COOKIE_KEYS.session}=${accessToken};`),
      ),
    );
    expect(cookies).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${COOKIE_KEYS.refresh}=refresh-after-success;.*Path=/auth/refresh;`,
        ),
      ),
    );
  });

  it("sets the new tokens without fetching WorkOS's signing keys", async () => {
    // Signed with a key the API doesn't know, so verifying it would fail as
    // it would while WorkOS's keys can't be fetched.
    const { privateKey } = await generateKeyPair("RS256");
    const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + 300;
    const accessToken = await new SignJWT({ sub: userId, sid: sessionId })
      .setProtectedHeader({ alg: "RS256", kid: "unknown-key" })
      .setExpirationTime(expiresAtEpochSeconds)
      .sign(privateKey);
    mockRefreshAuthSession.mockResolvedValue({
      userId,
      accessToken,
      refreshToken: "refresh-after-unverified",
    });

    const res = await refresh("refresh-before-unverified");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId,
      expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
    });
    expect(res.headers.getSetCookie()).toContainEqual(
      expect.stringMatching(
        new RegExp(`^${COOKIE_KEYS.refresh}=refresh-after-unverified;`),
      ),
    );
  });

  it("signs the user out when WorkOS turns the refresh token down", async () => {
    mockRefreshAuthSession.mockRejectedValue(
      Object.assign(new Error("invalid_grant"), { status: 400 }),
    );

    const res = await refresh("refresh-rejected");

    expect(res.status).toBe(401);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContainEqual(
      expect.stringMatching(new RegExp(`^${COOKIE_KEYS.session}=;.*Max-Age=0`)),
    );
    expect(cookies).toContainEqual(
      expect.stringMatching(new RegExp(`^${COOKIE_KEYS.refresh}=;.*Max-Age=0`)),
    );
  });

  it("keeps the cookies when WorkOS fails to answer", async () => {
    mockRefreshAuthSession.mockRejectedValue(
      Object.assign(new Error("WorkOS unavailable"), { status: 503 }),
    );

    const res = await refresh("refresh-during-outage");

    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("POST /auth/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevokeAuthSession.mockResolvedValue(undefined);
  });

  it("revokes the WorkOS session and clears both cookies", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/logout", {
      method: "POST",
      headers: await authedHeaders("user_01TEST", sessionId),
    });
    expect(res.status).toBe(200);
    expect(mockRevokeAuthSession).toHaveBeenCalledWith(sessionId);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toContainEqual(
      expect.stringMatching(
        new RegExp(`^${COOKIE_KEYS.session}=;.*Max-Age=0;.*Path=/;`),
      ),
    );
    expect(cookies).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${COOKIE_KEYS.refresh}=;.*Max-Age=0;.*Path=/auth/refresh;`,
        ),
      ),
    );
  });

  it("ends the session of an access token that has already expired", async () => {
    const token = await signAccessToken({
      userId: "user_01TEST",
      sessionId,
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) - 600,
    });

    const res = await (
      await createApp()
    ).request("http://localhost/auth/logout", {
      method: "POST",
      headers: {
        Origin: process.env.CLIENT_URL!,
        Cookie: `${COOKIE_KEYS.session}=${token}`,
      },
    });

    expect(res.status).toBe(200);
    expect(mockRevokeAuthSession).toHaveBeenCalledWith(sessionId);
  });

  it("remains successful without a session cookie", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/logout", {
      method: "POST",
      headers: { Origin: process.env.CLIENT_URL! },
    });

    expect(res.status).toBe(200);
    expect(mockRevokeAuthSession).not.toHaveBeenCalled();
    expect(res.headers.get("Set-Cookie")?.toLowerCase()).toMatch(
      /max-age=0|expires=/,
    );
  });

  it("still clears the local session when WorkOS revocation fails", async () => {
    mockRevokeAuthSession.mockRejectedValueOnce(
      new Error("WorkOS unavailable"),
    );

    const res = await (
      await createApp()
    ).request("http://localhost/auth/logout", {
      method: "POST",
      headers: await authedHeaders("user_01TEST", sessionId),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")?.toLowerCase()).toMatch(
      /max-age=0|expires=/,
    );
  });
});
