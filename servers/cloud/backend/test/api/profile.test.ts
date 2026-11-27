import { describe, it, expect, vi, beforeEach } from "vitest";
const {
  mockSelect,
  mockLimit,
  mockInsert,
  mockValues,
  mockOnConflict,
  mockReturning,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockLimit: vi.fn(),
  mockInsert: vi.fn(),
  mockValues: vi.fn(),
  mockOnConflict: vi.fn(),
  mockReturning: vi.fn(),
}));

vi.mock("../../src/db", async () => ({
  db: { select: mockSelect, insert: mockInsert },
  ...(await import("../helpers/dbTableStubs")).tableStubs,
}));

import { defaultAvatar } from "@parley/contract/avatars";
import { createApp } from "../../src/app";
import { authedHeaders } from "../helpers/session";

const userId = "user_01OWNER";

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: mockLimit }) }),
  }));
  mockInsert.mockImplementation(() => ({ values: mockValues }));
  mockValues.mockImplementation(() => ({
    onConflictDoUpdate: mockOnConflict,
  }));
  mockOnConflict.mockImplementation(() => ({ returning: mockReturning }));
  mockReturning.mockResolvedValue([
    { glyph: null, color: null, username: null },
  ]);
});

async function patch(body: unknown) {
  return (await createApp()).request("http://localhost/profile", {
    method: "PATCH",
    headers: {
      ...(await authedHeaders(userId)),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("GET /profile", () => {
  it("returns 401 without a session cookie", async () => {
    const res = await (await createApp()).request("http://localhost/profile");
    expect(res.status).toBe(401);
  });

  it("returns the picture and username they picked", async () => {
    mockLimit.mockResolvedValueOnce([
      { glyph: "moon", color: "plum", username: "river" },
    ]);
    const res = await (
      await createApp()
    ).request("http://localhost/profile", {
      headers: await authedHeaders(userId),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      avatar: { glyph: "moon", color: "plum" },
      username: "river",
    });
  });

  it("returns their default picture and no username before they pick", async () => {
    mockLimit.mockResolvedValueOnce([
      { glyph: null, color: null, username: null },
    ]);
    const res = await (
      await createApp()
    ).request("http://localhost/profile", {
      headers: await authedHeaders(userId),
    });
    expect(await res.json()).toEqual({
      avatar: defaultAvatar(userId),
      username: null,
    });
  });
});

describe("PATCH /profile", () => {
  it("saves the picture they picked", async () => {
    mockReturning.mockResolvedValueOnce([
      { glyph: "bolt", color: "sky", username: "river" },
    ]);
    const res = await patch({ avatar: { glyph: "bolt", color: "sky" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      avatar: { glyph: "bolt", color: "sky" },
      username: "river",
    });
    expect(mockValues).toHaveBeenCalledWith({
      id: userId,
      avatarGlyph: "bolt",
      avatarColor: "sky",
    });
  });

  it("saves a username tidied, leaving the picture alone", async () => {
    const res = await patch({ username: "  River   Stone " });
    expect(res.status).toBe(200);
    expect(mockValues).toHaveBeenCalledWith({
      id: userId,
      username: "River Stone",
    });
    expect(mockOnConflict).toHaveBeenCalledWith(
      expect.objectContaining({ set: { username: "River Stone" } }),
    );
  });

  it("clears the username for null or only spaces", async () => {
    for (const username of [null, "   "]) {
      mockValues.mockClear();
      expect((await patch({ username })).status).toBe(200);
      expect(mockValues).toHaveBeenCalledWith({ id: userId, username: null });
    }
  });

  it("refuses a username that's too long or has control characters", async () => {
    for (const username of [
      "x".repeat(33),
      "a\u0000b",
      "line\u200bbreak",
      "abc\u202edef",
    ]) {
      expect((await patch({ username })).status, username).toBe(400);
    }
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("keeps emoji made with joiners", async () => {
    const res = await patch({ username: "🧑‍💻 dev" });
    expect(res.status).toBe(200);
    expect(mockValues).toHaveBeenCalledWith({ id: userId, username: "🧑‍💻 dev" });
  });

  it("refuses a body with nothing to change", async () => {
    expect((await patch({})).status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("refuses an id it doesn't offer", async () => {
    const res = await patch({ avatar: { glyph: "skull", color: "sky" } });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("defaultAvatar", () => {
  it("gives the same id the same picture", () => {
    expect(defaultAvatar(userId)).toEqual(defaultAvatar(userId));
  });

  it("spreads ids across the pictures", () => {
    const pictures = new Set(
      Array.from({ length: 200 }, (_, index) => {
        const { glyph, color } = defaultAvatar(`user_01${index}`);
        return `${glyph}/${color}`;
      }),
    );
    expect(pictures.size).toBeGreaterThan(80);
  });
});
