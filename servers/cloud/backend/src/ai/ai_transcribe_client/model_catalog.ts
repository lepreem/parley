/**
 * Which of Deepgram's speech-to-text models the app transcribes with.
 * Everything that decides it is here, private to ai_transcribe_client.ts.
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

function isGeneral(model: DeepgramModel): boolean {
  return model.canonicalName === `${model.architecture}-general`;
}

/**
 * The model every file is transcribed with: the general model built most
 * recently (nova-3-general, until a nova-4-general comes), from
 * newestVersions' batch builds. Its domain siblings (medical, pharma) only add
 * specialist vocabulary, which nobody uploading a file knows to ask for, and
 * Deepgram detects the language whichever it is. Undefined while the catalog
 * has no general model.
 */
export function currentModel(data: TranscribeModelData): string | undefined {
  return Object.values(data)
    .filter(isGeneral)
    .reduce<DeepgramModel | undefined>(
      (newest, model) =>
        !newest || (model.version ?? "") > (newest.version ?? "")
          ? model
          : newest,
      undefined,
    )?.canonicalName;
}
