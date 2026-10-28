import { DeepgramClient } from "@deepgram/sdk";
import type { TranscribeModel } from "@parley/contract";
import type { TranscriptSegment } from "@parley/server-kit/transcription/transcript";
import { getEnv } from "../env";
import { CACHE_KEYS, memory } from "../memory";

const deepgram = new DeepgramClient({
  apiKey: getEnv().DEEPGRAM_API_KEY,
  // The load test's stand-in; unset, the SDK uses Deepgram itself.
  baseUrl: getEnv().DEEPGRAM_BASE_URL,
});

/**
 * Deepgram transcribes a multi-hour file in one job, but a long one can take
 * minutes to come back — far past the SDK's default timeout. Retries are held
 * to one because every attempt is billed for the full audio duration.
 */
const TRANSCRIBE_TIMEOUT_SECONDS = 20 * 60;
const TRANSCRIBE_MAX_RETRIES = 1;

/** Startup health check: fails if Deepgram is unreachable or rejects the API key. */
async function ping(): Promise<void> {
  await deepgram.auth.v1.tokens.grant();
}

/**
 * The audio at `audioUrl`, transcribed: Deepgram's utterances, each a stretch
 * of speech between pauses, with when it was said.
 */
async function transcribe(
  model: string,
  audioUrl: string,
): Promise<TranscriptSegment[]> {
  const response = await deepgram.listen.v1.media.transcribeUrl(
    {
      url: audioUrl,
      model,
      smart_format: true,
      utterances: true,
    },
    {
      timeoutInSeconds: TRANSCRIBE_TIMEOUT_SECONDS,
      maxRetries: TRANSCRIBE_MAX_RETRIES,
    },
  );

  // The response type also covers the callback mode, which answers with just a
  // request id. We never pass `callback`, so a body without results is a bug
  // rather than something to poll for.
  if (!("results" in response)) {
    throw new Error("Deepgram returned no transcription results");
  }

  return (response.results.utterances ?? []).map((utterance) => ({
    start: utterance.start ?? 0,
    end: utterance.end ?? utterance.start ?? 0,
    text: utterance.transcript ?? "",
  }));
}

type DeepgramModel = {
  name: string;
  canonicalName: string;
  architecture: string | undefined;
  languages: string[] | undefined;
  version: string | undefined;
  uuid: string | undefined;
  batch: boolean | undefined;
  streaming: boolean | undefined;
  formattedOutput: boolean | undefined;
};

type TranscribeModelData = {
  [modelId: string]: DeepgramModel;
};

async function fetchTranscribeModelData(): Promise<TranscribeModelData> {
  const response = await deepgram.manage.v1.models.list();

  return Object.fromEntries(
    (response.stt ?? []).flatMap((model) => {
      const id = model.canonical_name ?? model.name;
      if (!id) return [];
      return [
        [
          id,
          {
            name: model.name ?? id,
            canonicalName: model.canonical_name ?? id,
            architecture: model.architecture,
            languages: model.languages,
            version: model.version,
            uuid: model.uuid,
            batch: model.batch,
            streaming: model.streaming,
            formattedOutput: model.formatted_output,
          },
        ],
      ];
    }),
  );
}

/** Exported for tests that seed the catalog; callers use the namespace. */
export function getTranscribeModelData(): Promise<TranscribeModelData> {
  // Served stale while it refreshes, like the chat catalog, so no request
  // waits on Deepgram once a process has loaded it.
  return memory.modelLists.getOrSet(
    CACHE_KEYS.deepgramTranscribeModels,
    fetchTranscribeModelData,
    { serveStale: true },
  );
}

/**
 * The models offered, in the order shown, with the names they're shown by.
 * Deepgram's catalog lists about forty: older generations, industry variants
 * (drive-thru, voicemail, ATC) and models private to an account, which only
 * made the list harder to choose from. Ids are canonical names, since
 * Deepgram's own names repeat across generations ("general" is both nova-2
 * and nova-3).
 */
const OFFERED_MODELS: readonly TranscribeModel[] = [
  { id: "nova-3-general", name: "Nova 3" },
  { id: "nova-3-medical", name: "Nova 3 Medical" },
  { id: "nova-2-general", name: "Nova 2" },
  { id: "whisper-large", name: "Whisper Large" },
];

/** The offered models Deepgram's catalog currently has. */
async function listModels(): Promise<TranscribeModel[]> {
  const modelData = await getTranscribeModelData();
  return OFFERED_MODELS.filter((model) => Object.hasOwn(modelData, model.id));
}

/**
 * Whether a model id can be used for transcription: one listModels lists.
 * Deepgram STT models are single-modality, so being offered and in the
 * catalog is the whole check, as presence is for chat.findModel.
 */
async function isValidModel(modelId: string): Promise<boolean> {
  return (await listModels()).some((model) => model.id === modelId);
}

export const DEFAULT_TRANSCRIBE_MODEL = "nova-3-general";

/** Speech-to-text and its model catalog, from Deepgram. */
export const transcription = {
  transcribe,
  listModels,
  isValidModel,
  ping,
};
