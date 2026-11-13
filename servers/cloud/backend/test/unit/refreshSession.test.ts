import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRefreshAuthSession } = vi.hoisted(() => ({
  mockRefreshAuthSession: vi.fn(),
}));

vi.mock("../../src/auth/auth", () => ({
  refreshAuthSession: mockRefreshAuthSession,
}));

import { refreshSession } from "../../src/auth/refreshSession";

const tokens = { accessToken: "access-2", refreshToken: "refresh-2" };
let refreshToken = 0;
/** A token no earlier test has spent, since results outlive a test. */
const freshToken = () => `refresh-${++refreshToken}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshSession", () => {
  it("asks WorkOS once for callers that arrive together", async () => {
    mockRefreshAuthSession.mockResolvedValue(tokens);
    const token = freshToken();

    const results = await Promise.all([
      refreshSession(token),
      refreshSession(token),
      refreshSession(token),
    ]);

    expect(results).toEqual([tokens, tokens, tokens]);
    expect(mockRefreshAuthSession).toHaveBeenCalledTimes(1);
    expect(mockRefreshAuthSession).toHaveBeenCalledWith(token);
  });

  it("hands a late caller the same result within the replay window", async () => {
    mockRefreshAuthSession.mockResolvedValue(tokens);
    const token = freshToken();
    await refreshSession(token);

    await vi.advanceTimersByTimeAsync(9_000);

    await expect(refreshSession(token)).resolves.toEqual(tokens);
    expect(mockRefreshAuthSession).toHaveBeenCalledTimes(1);
  });

  it("asks WorkOS again once the replay window has passed", async () => {
    mockRefreshAuthSession.mockResolvedValue(tokens);
    const token = freshToken();
    await refreshSession(token);

    await vi.advanceTimersByTimeAsync(10_000);
    await refreshSession(token);

    expect(mockRefreshAuthSession).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a failure, so the next caller asks WorkOS again", async () => {
    mockRefreshAuthSession
      .mockRejectedValueOnce(new Error("WorkOS unavailable"))
      .mockResolvedValueOnce(tokens);
    const token = freshToken();

    await expect(refreshSession(token)).rejects.toThrow("WorkOS unavailable");
    await expect(refreshSession(token)).resolves.toEqual(tokens);
    expect(mockRefreshAuthSession).toHaveBeenCalledTimes(2);
  });

  it("keeps different refresh tokens apart", async () => {
    mockRefreshAuthSession.mockResolvedValue(tokens);

    await Promise.all([
      refreshSession(freshToken()),
      refreshSession(freshToken()),
    ]);

    expect(mockRefreshAuthSession).toHaveBeenCalledTimes(2);
  });
});
