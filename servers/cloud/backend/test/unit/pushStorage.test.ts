import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_BUCKET,
  BUCKET_SETTINGS,
  IMAGE_BUCKET,
} from "../../src/storage/schema";

const AUDIO_SETTINGS = BUCKET_SETTINGS[AUDIO_BUCKET];
const IMAGE_SETTINGS = BUCKET_SETTINGS[IMAGE_BUCKET];

const bucket = vi.hoisted(() => ({
  readSettings: vi.fn(),
  create: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("../../src/storage/bucket", () => bucket);

/** The script does its work when imported, like scripts/migrate.ts. */
async function runScript() {
  vi.resetModules();
  await import("../../scripts/pushStorage");
}

/** What readSettings reports for each bucket, by name. */
function live(byName: Record<string, object | null>) {
  bucket.readSettings.mockImplementation((name: string) =>
    Promise.resolve(byName[name]),
  );
}

describe("storage:push", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("creates every bucket when there are none", async () => {
    live({ [AUDIO_BUCKET]: null, [IMAGE_BUCKET]: null });

    await runScript();

    expect(bucket.create).toHaveBeenCalledWith(AUDIO_BUCKET, AUDIO_SETTINGS);
    expect(bucket.create).toHaveBeenCalledWith(IMAGE_BUCKET, IMAGE_SETTINGS);
    expect(bucket.updateSettings).not.toHaveBeenCalled();
  });

  it("creates only the missing bucket and updates only the one that differs", async () => {
    live({
      [AUDIO_BUCKET]: {
        public: false,
        fileSizeLimit: null,
        allowedMimeTypes: null,
      },
      [IMAGE_BUCKET]: null,
    });

    await runScript();

    expect(bucket.create).toHaveBeenCalledTimes(1);
    expect(bucket.create).toHaveBeenCalledWith(IMAGE_BUCKET, IMAGE_SETTINGS);
    expect(bucket.updateSettings).toHaveBeenCalledTimes(1);
    expect(bucket.updateSettings).toHaveBeenCalledWith(
      AUDIO_BUCKET,
      AUDIO_SETTINGS,
    );
  });

  it("leaves matching buckets alone, whatever order their types are in", async () => {
    live({
      [AUDIO_BUCKET]: {
        ...AUDIO_SETTINGS,
        allowedMimeTypes: [...AUDIO_SETTINGS.allowedMimeTypes].reverse(),
      },
      [IMAGE_BUCKET]: IMAGE_SETTINGS,
    });

    await runScript();

    expect(bucket.create).not.toHaveBeenCalled();
    expect(bucket.updateSettings).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith("  compared:", AUDIO_SETTINGS);
    expect(console.log).toHaveBeenCalledWith("  compared:", IMAGE_SETTINGS);
  });
});
