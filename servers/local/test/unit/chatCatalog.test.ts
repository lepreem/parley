import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockConnectChat, mockSettingsFiles, mockSend } = vi.hoisted(() => ({
  mockConnectChat: vi.fn(),
  mockSettingsFiles: vi.fn(),
  mockSend: vi.fn(),
}));

vi.mock("../../core/ai/ai_chat_client", () => ({
  connectChat: mockConnectChat,
  chatSettingsFiles: mockSettingsFiles,
}));
vi.mock("../../api/src/sse/hub", () => ({
  EVERYONE: "everyone",
  eventHub: { send: mockSend },
}));

/** What connectChat finds, with Sonnet at `effort` when none is chosen. */
const connected = (effort: string) => ({
  models: [{ id: "sonnet", reasoning: { defaultEffort: effort } }],
  defaultModel: "sonnet",
  helper: { model: "haiku", effort: "none" },
  unavailable: [],
});

let folder: string;
const folders: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  folder = await mkdtemp(join(tmpdir(), "chat-settings-"));
  folders.push(folder);
  mockSettingsFiles.mockReturnValue([join(folder, "settings.json")]);
});

// Not after each: an earlier test's catalog still watches its folder, and
// would see the settings file go.
afterAll(async () => {
  await Promise.all(
    folders.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function freshCatalog() {
  const { chatCatalog } = await import("../../api/src/memory/chatCatalog");
  return chatCatalog;
}

describe("chatCatalog", () => {
  it("asks again when the person changes a program's settings, and tells the pages", async () => {
    mockConnectChat
      .mockResolvedValueOnce(connected("medium"))
      .mockResolvedValue(connected("high"));
    const catalog = await freshCatalog();
    expect((await catalog.list())[0]).toMatchObject({
      reasoning: { defaultEffort: "medium" },
    });

    await writeFile(join(folder, "settings.json"), '{"effortLevel":"high"}');

    await vi.waitFor(
      () =>
        expect(mockSend).toHaveBeenCalledWith(
          "everyone",
          "chatModelsChanged",
          {},
        ),
      { timeout: 5000 },
    );
    expect((await catalog.list())[0]).toMatchObject({
      reasoning: { defaultEffort: "high" },
    });
  });

  it("leaves the pages alone when asking again finds the same", async () => {
    mockConnectChat.mockResolvedValue(connected("medium"));
    const catalog = await freshCatalog();
    await catalog.load();

    await writeFile(join(folder, "settings.json"), "{}");

    await vi.waitFor(() => expect(mockConnectChat).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });
    // The reload has finished once its answer is the catalog's.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("ignores other files in the folder", async () => {
    mockConnectChat.mockResolvedValue(connected("medium"));
    const catalog = await freshCatalog();
    await catalog.load();

    await writeFile(join(folder, "history.jsonl"), "{}\n");

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(mockConnectChat).toHaveBeenCalledTimes(1);
  });

  it("keeps what it had when asking again fails", async () => {
    mockConnectChat
      .mockResolvedValueOnce(connected("medium"))
      .mockRejectedValue(new Error("claude broke"));
    const catalog = await freshCatalog();
    await catalog.load();

    await writeFile(join(folder, "settings.json"), "{");

    await vi.waitFor(() => expect(mockConnectChat).toHaveBeenCalledTimes(2), {
      timeout: 5000,
    });
    expect((await catalog.list())[0]).toMatchObject({
      reasoning: { defaultEffort: "medium" },
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
