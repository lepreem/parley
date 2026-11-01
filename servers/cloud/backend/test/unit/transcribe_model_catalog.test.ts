import { describe, expect, it } from "vitest";
import {
  newestVersions,
  offeredModels,
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

function offered(...models: DeepgramModel[]) {
  return offeredModels(newestVersions(models));
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

describe("offeredModels", () => {
  it("offers the current generation, general first, named from its id", () => {
    expect(
      offered(
        listed("nova-3-pharma", "nova-3", "2026-06-05.1"),
        listed("nova-3-medical", "nova-3", "2026-10-06.1"),
        listed("nova-3-general", "nova-3", "2026-10-21.1"),
        listed("nova-2-general", "nova-2", "2025-03-31.1"),
        listed("nova-2-drivethru", "nova-2", "2024-02-07.1"),
        listed("whisper-large", "whisper", "2022-12-08.0"),
      ),
    ).toEqual([
      { id: "nova-3-general", name: "Nova 3" },
      { id: "nova-3-medical", name: "Nova 3 Medical" },
      { id: "nova-3-pharma", name: "Nova 3 Pharma" },
    ]);
  });

  it("moves to a new generation once its general model is out", () => {
    expect(
      offered(
        listed("nova-3-general", "nova-3", "2026-10-21.1"),
        listed("nova-4-general", "nova-4", "2027-03-01.1"),
      ).map((model) => model.id),
    ).toEqual(["nova-4-general"]);
  });

  it("goes by general models, not a newer build of something else", () => {
    expect(
      offered(
        listed("nova-3-general", "nova-3", "2026-10-21.1"),
        listed("whisper-large", "whisper", "2027-01-01.1"),
      ).map((model) => model.id),
    ).toEqual(["nova-3-general"]);
  });

  it("leaves out models that only stream", () => {
    expect(
      offered(
        listed("nova-3-general", "nova-3", "2026-10-21.1"),
        listed("nova-3-live", "nova-3", "2026-10-21.1", { batch: false }),
      ).map((model) => model.id),
    ).toEqual(["nova-3-general"]);
  });

  it("offers nothing while the catalog has no general model", () => {
    expect(offered(listed("nova-3-medical", "nova-3", "2026-10-06.1"))).toEqual(
      [],
    );
  });
});
