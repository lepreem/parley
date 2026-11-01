import type { TranscribeModel } from "@parley/contract";

/**
 * Which of Deepgram's speech-to-text models the app offers. Everything that
 * decides what reaches the transcription picker is here, private to
 * ai_transcribe_client.ts.
 */

/** One of Deepgram's speech-to-text models, as of its newest version. */
export type DeepgramModel = {
  name: string;
  canonicalName: string;
  architecture: string | undefined;
  languages: string[] | undefined;
  /** "2026-10-21.34513": the day it was built, so newer sorts later. */
  version: string | undefined;
  uuid: string | undefined;
  batch: boolean | undefined;
  streaming: boolean | undefined;
  formattedOutput: boolean | undefined;
};

export type TranscribeModelData = {
  [modelId: string]: DeepgramModel;
};

/**
 * Deepgram's batch models keyed by canonical name ("nova-3-general"), each at
 * its newest version. The catalog lists a model once per version, language
 * set and mode, a hundred and more times for the general ones, and the
 * newest is the one a request without a version gets. Only batch builds
 * count, since a job sends a whole file: a model's newest build can be one
 * that only streams.
 */
export function newestVersions(
  models: readonly DeepgramModel[],
): TranscribeModelData {
  const newest: TranscribeModelData = {};
  for (const model of models) {
    if (model.batch !== true) continue;
    const held = newest[model.canonicalName];
    if (!held || (model.version ?? "") > (held.version ?? ""))
      newest[model.canonicalName] = model;
  }
  return newest;
}

/** "nova-3-medical" as "Nova 3 Medical"; "general" goes unsaid. */
function displayName(id: string): string {
  return id
    .split("-")
    .filter((word) => word !== "general")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isGeneral(model: DeepgramModel): boolean {
  return model.canonicalName === `${model.architecture}-general`;
}

/**
 * The models of Deepgram's current generation: the architecture whose
 * general model was built most recently (nova-3, until a nova-4 comes),
 * from newestVersions' batch builds. The general model comes
 * first, as the default, then the domain ones (medical, pharma). Older
 * generations, Whisper and Deepgram's older industry models are left out:
 * the current generation transcribes better and in more languages.
 */
export function offeredModels(data: TranscribeModelData): TranscribeModel[] {
  const models = Object.values(data);
  const current = models
    .filter(isGeneral)
    .reduce<DeepgramModel | undefined>(
      (newest, model) =>
        !newest || (model.version ?? "") > (newest.version ?? "")
          ? model
          : newest,
      undefined,
    )?.architecture;
  if (!current) return [];

  return models
    .filter((model) => model.architecture === current)
    .sort(
      (a, b) =>
        Number(isGeneral(b)) - Number(isGeneral(a)) ||
        a.canonicalName.localeCompare(b.canonicalName),
    )
    .map((model) => ({
      id: model.canonicalName,
      name: displayName(model.canonicalName),
    }));
}
