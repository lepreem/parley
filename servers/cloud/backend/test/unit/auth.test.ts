import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthenticateWithCode,
  mockAuthenticateWithRefreshToken,
  mockRevokeSession,
} = vi.hoisted(() => ({
  mockAuthenticateWithCode: vi.fn(),
  mockAuthenticateWithRefreshToken: vi.fn(),
  mockRevokeSession: vi.fn(),
}));

vi.mock("@workos-inc/node", () => ({
  WorkOS: class {
    userManagement = {
      authenticateWithCode: mockAuthenticateWithCode,
      authenticateWithRefreshToken: mockAuthenticateWithRefreshToken,
      getAuthorizationUrl: vi.fn(),
      listUsers: vi.fn(),
      revokeSession: mockRevokeSession,
    };
  },
}));

import * as workos from "../../src/auth/auth";

const userId = "user_01AUTH";
const sessionId = "session_01AUTH";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkOS auth sessions", () => {
  it("returns the user and the tokens WorkOS issued", async () => {
    mockAuthenticateWithCode.mockResolvedValueOnce({
      user: { id: userId },
      accessToken: "workos-access-token",
      refreshToken: "workos-refresh-token",
    });

    await expect(workos.getAuthSessionFromCode("oauth-code")).resolves.toEqual({
      userId,
      accessToken: "workos-access-token",
      refreshToken: "workos-refresh-token",
    });
  });

  it("trades a refresh token for its user and the new tokens WorkOS issues", async () => {
    mockAuthenticateWithRefreshToken.mockResolvedValueOnce({
      user: { id: userId },
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });

    await expect(workos.refreshAuthSession("refresh-1")).resolves.toEqual({
      userId,
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    expect(mockAuthenticateWithRefreshToken).toHaveBeenCalledWith({
      refreshToken: "refresh-1",
      clientId: process.env.WORKOS_CLIENT_ID,
    });
  });

  it("revokes the selected WorkOS session", async () => {
    mockRevokeSession.mockResolvedValueOnce(undefined);

    await workos.revokeAuthSession(sessionId);

    expect(mockRevokeSession).toHaveBeenCalledWith({ sessionId });
  });
});
