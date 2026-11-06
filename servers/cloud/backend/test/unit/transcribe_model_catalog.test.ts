import { describe, expect, it } from "vitest";
import {
  currentModel,
  newestVersions,
  type DeepgramModel,
} from "../../src/ai/ai_transcribe_client/model_catalog";

/** A model as Deepgram lists it: only what the catalog reads. */
function listed(
  canonicalName: string,
  architecture: string,
  version: string,
  overrides: Partial<DeepgramModel> = {},
): DeepgramModel {
  return {
    name: canonicalName,
    canonicalName,
    architecture,
    languages: ["en"],
    version,
    uuid: `${canonicalName}@${version}`,
    batch: true,
    streaming: true,
    formattedOutput: true,
    ...overrides,
  };
}

function current(...models: DeepgramModel[]) {
  return currentModel(newestVersions(models));
}

describe("newestVersions", () => {
  it("keeps each model's newest version", () => {
    const data = newestVersions([
      listed("nova-3-general", "nova-3", "2026-10-21.1"),
      listed("nova-3-general", "nova-3", "2025-01-01.1"),
      listed("nova-2-general", "nova-2", "2025-03-31.1"),
    ]);
    expect(Object.keys(data)).toEqual(["nova-3-general", "nova-2-general"]);
    expect(data["nova-3-general"]?.version).toBe("2026-10-21.1");
  });

  it("goes by batch builds, though a newer one only streams", () => {
    const data = newestVersions([
      listed("nova-3-medical", "nova-3", "2026-10-06.1"),
      listed("nova-3-medical", "nova-3", "2026-10-06.2", { batch: false }),
    ]);
    expect(data["nova-3-medical"]?.version).toBe("2026-10-06.1");
  });
});

describe("currentModel", () => {
  it("is the newest generation's general model, not a domain one", () => {
    expect(
      current(
        listed("nova-3-pharma", "nova-3", "2026-06-05.1"),
        listed("nova-3-medical", "nova-3", "2026-10-30.1"),
        listed("nova-3-general", "nova-3", "2026-10-21.1"),
        listed("nova-2-general", "nova-2", "2025-03-31.1"),
        listed("whisper-large", "whisper", "2022-12-08.0"),
      ),
    ).toBe("nova-3-general");
  });

  it("moves to a new generation once its general model is out", () => {
    expect(
      current(
        listed("nova-3-general", "nova-3", "2026-10-21.1"),
        listed("nova-4-general", "nova-4", "2027-03-01.1"),
      ),
    ).toBe("nova-4-general");
  });

  it("goes by general models, not a newer build of something else", () => {
    expect(
      current(
        listed("nova-3-general", "nova-3", "2026-10-21.1"),
        listed("whisper-large", "whisper", "2027-01-01.1"),
      ),
    ).toBe("nova-3-general");
  });

  it("isn't one that only streams", () => {
    expect(
      current(
        listed("nova-3-general", "nova-3", "2026-10-21.1"),
        listed("nova-4-general", "nova-4", "2027-03-01.1", { batch: false }),
      ),
    ).toBe("nova-3-general");
  });

  it("is none while the catalog has no general model", () => {
    expect(
      current(listed("nova-3-medical", "nova-3", "2026-10-06.1")),
    ).toBeUndefined();
  });
});
