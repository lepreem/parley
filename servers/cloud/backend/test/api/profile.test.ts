import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockSelect, mockLimit, mockInsert, mockValues, mockOnConflict } =
  vi.hoisted(() => ({
    mockSelect: vi.fn(),
    mockLimit: vi.fn(),
    mockInsert: vi.fn(),
    mockValues: vi.fn(),
    mockOnConflict: vi.fn(),
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
  mockOnConflict.mockResolvedValue(undefined);
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

  it("returns the picture they picked", async () => {
    mockLimit.mockResolvedValueOnce([{ glyph: "moon", color: "plum" }]);
    const res = await (
      await createApp()
    ).request("http://localhost/profile", {
      headers: await authedHeaders(userId),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      avatar: { glyph: "moon", color: "plum" },
    });
  });

  it("returns their default when they haven't picked one", async () => {
    mockLimit.mockResolvedValueOnce([{ glyph: null, color: null }]);
    const res = await (
      await createApp()
    ).request("http://localhost/profile", {
      headers: await authedHeaders(userId),
    });
    expect(await res.json()).toEqual({ avatar: defaultAvatar(userId) });
  });
});

describe("PATCH /profile", () => {
  it("saves the picture they picked", async () => {
    const avatar = { glyph: "bolt", color: "sky" };
    const res = await patch({ avatar });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ avatar });
    expect(mockValues).toHaveBeenCalledWith({
      id: userId,
      avatarGlyph: "bolt",
      avatarColor: "sky",
    });
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
