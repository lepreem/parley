import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignJWT } from "jose";

const { mockEnsureUser, mockAdoptGuest, mockGetAuthSessionFromCode } =
  vi.hoisted(() => ({
    mockEnsureUser: vi.fn(),
    mockAdoptGuest: vi.fn(),
    mockGetAuthSessionFromCode: vi.fn(),
  }));

vi.mock("../../src/data/users.data", () => ({
  users: { ensureUser: mockEnsureUser, adoptGuest: mockAdoptGuest },
}));

vi.mock("../../src/auth/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/auth")>();
  return {
    ...actual,
    workos: {
      ...actual.workos,
      getAuthSessionFromCode: mockGetAuthSessionFromCode,
    },
  };
});

vi.mock("../../src/db", async () => ({
  db: {},
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

import { createApp } from "../../src/app";
import { COOKIE_KEYS } from "../../src/cookies/session";
import { resetRateLimits } from "../../src/middleware/rateLimit.middleware";
import { guestCookieHeader, sessionCookieHeader } from "../helpers/session";

const guestId = "guest_00000000-0000-4000-8000-000000000002";
const origin = process.env.CLIENT_URL!;

/** The session cookie a response sets, as `name=value`, and its attributes. */
function sessionCookieOf(res: Response) {
  const header = res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${COOKIE_KEYS.session}=`));
  return header === undefined
    ? undefined
    : { pair: header.split(";")[0]!, header };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  mockEnsureUser.mockResolvedValue(undefined);
  mockAdoptGuest.mockResolvedValue(undefined);
  mockGetAuthSessionFromCode.mockResolvedValue({
    userId: "user_01SIGNEDIN",
    accessToken: "access-token",
    refreshToken: "refresh-token",
  });
});

describe("GET /auth/guest", () => {
  it("says guest chat is on", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/guest");
    expect(await res.json()).toEqual({ enabled: true });
  });
});

describe("POST /auth/guest", () => {
  it("makes a guest and signs them in for thirty days", async () => {
    const app = await createApp();
    const res = await app.request("http://localhost/auth/guest", {
      method: "POST",
      headers: { Origin: origin },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; isGuest: boolean };
    expect(body).toMatchObject({ isGuest: true });
    expect(body.userId).toMatch(/^guest_[0-9a-f-]{36}$/);
    expect(mockEnsureUser).toHaveBeenCalledWith(body.userId);

    const cookie = sessionCookieOf(res)!;
    expect(cookie.header).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(cookie.header).toContain("HttpOnly");

    const me = await app.request("http://localhost/auth/me", {
      headers: { Cookie: cookie.pair },
    });
    expect(await me.json()).toMatchObject({
      userId: body.userId,
      isGuest: true,
    });
  });

  it("gives a guest who has a session that one, not another", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/guest", {
      method: "POST",
      headers: { Origin: origin, Cookie: await guestCookieHeader(guestId) },
    });

    expect(await res.json()).toMatchObject({ userId: guestId, isGuest: true });
    expect(mockEnsureUser).not.toHaveBeenCalled();
    expect(sessionCookieOf(res)).toBeUndefined();
  });

  it("gives a signed-in user their own session back", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/guest", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: await sessionCookieHeader("user_01SIGNEDIN"),
      },
    });

    expect(await res.json()).toMatchObject({
      userId: "user_01SIGNEDIN",
      isGuest: false,
    });
    expect(mockEnsureUser).not.toHaveBeenCalled();
  });

  it("starts ten guests per address every fifteen minutes", async () => {
    const app = await createApp();
    const start = () =>
      app.request("http://localhost/auth/guest", {
        method: "POST",
        headers: { Origin: origin, "X-Real-IP": "203.0.113.20" },
      });
    for (let i = 0; i < 10; i++) expect((await start()).status).toBe(200);

    expect((await start()).status).toBe(429);
  });
});

describe("a guest session", () => {
  it("isn't one when another key signed it", async () => {
    const forged = await new SignJWT()
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("parley-guest")
      .setSubject(guestId)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("not-the-guest-session-secret-at-all"));

    const res = await (
      await createApp()
    ).request("http://localhost/auth/me", {
      headers: { Cookie: `${COOKIE_KEYS.session}=${forged}` },
    });
    expect(res.status).toBe(401);
  });

  it("can't name a WorkOS user", async () => {
    const forged = await new SignJWT()
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("parley-guest")
      .setSubject("user_01SIGNEDIN")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.GUEST_SESSION_SECRET!));

    const res = await (
      await createApp()
    ).request("http://localhost/auth/me", {
      headers: { Cookie: `${COOKIE_KEYS.session}=${forged}` },
    });
    expect(res.status).toBe(401);
  });

  it.each([
    ["/upload/audio", { fileName: "a.mp3", sizeBytes: 1 }],
    ["/upload/youtube", { url: "https://youtu.be/dQw4w9WgXcQ" }],
    ["/upload/image", { fileName: "a.png", sizeBytes: 1 }],
  ])("is refused %s: guests chat in text only", async (path, body) => {
    const res = await (
      await createApp()
    ).request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: await guestCookieHeader(guestId),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "Sign in to add files" });
  });
});

describe("GET /auth/callback", () => {
  it("moves a guest's chats to the account they sign in to", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/callback?code=test", {
      headers: { Cookie: await guestCookieHeader(guestId) },
    });

    expect(res.status).toBe(302);
    expect(mockEnsureUser).toHaveBeenCalledWith("user_01SIGNEDIN");
    expect(mockAdoptGuest).toHaveBeenCalledWith(guestId, "user_01SIGNEDIN");
    expect(mockEnsureUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockAdoptGuest.mock.invocationCallOrder[0]!,
    );
    expect(sessionCookieOf(res)?.pair).toBe(
      `${COOKIE_KEYS.session}=access-token`,
    );
  });

  it("moves nothing for someone who wasn't a guest", async () => {
    const res = await (
      await createApp()
    ).request("http://localhost/auth/callback?code=test", {
      headers: { Cookie: await sessionCookieHeader("user_01OTHER") },
    });

    expect(res.status).toBe(302);
    expect(mockAdoptGuest).not.toHaveBeenCalled();
  });

  it("still signs in when the move fails", async () => {
    mockAdoptGuest.mockRejectedValue(new Error("database down"));

    const res = await (
      await createApp()
    ).request("http://localhost/auth/callback?code=test", {
      headers: { Cookie: await guestCookieHeader(guestId) },
    });

    expect(res.status).toBe(302);
    expect(sessionCookieOf(res)?.pair).toBe(
      `${COOKIE_KEYS.session}=access-token`,
    );
  });
});
