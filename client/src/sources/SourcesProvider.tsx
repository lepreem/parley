import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  deleteImage,
  requestYoutubeTranscript,
  uploadAudio,
  uploadImage,
} from "../api/uploads";
import { errorMessage } from "../api/http";
import { resolveDefaultModel } from "../api/models";
import { extractAudioFromVideo } from "../media/extractAudio";
import { compressAudioForSpeech } from "../media/compressAudio";
import {
  classifyFile,
  formatBytes,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  type FileKind,
} from "../media/fileKind";
import { youtubeLabel } from "../media/youtube";
import { useServer } from "../hooks/server/useServer";
import { useToast } from "../hooks/toast/useToast";
import { useTranscriptionModelsQuery } from "../hooks/queries/useModelsQuery";
import { useServerReady } from "../hooks/server/useServerReady";
import { SourcesContext, type ExistingSource } from "./context";
import { stageSource, type StagedSource } from "./types";
import { useTranscriptWatcher } from "./useTranscriptWatcher";

type Drafts = Record<string, StagedSource[]>;

function releasePreview(source: StagedSource) {
  if (source.previewUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(source.previewUrl);
  }
}

/**
 * Holds what each draft message is carrying. Sources upload the moment they are
 * added — well before send — so the drafts outlive route changes and are keyed
 * by conversation id ("new" until the conversation exists).
 */
export function SourcesProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const server = useServer();
  const ready = useServerReady();
  const choice = server.transcribeModelChoice;
  const { models: transcriptionModels } = useTranscriptionModelsQuery(
    ready && choice !== null,
  );
  const [drafts, setDrafts] = useState<Drafts>({});
  const [transcriptModelPick, setTranscriptModelPick] = useState<string | null>(
    null,
  );

  // Null where the server picks the model, so uploads name none.
  const transcriptModelId = choice
    ? (transcriptModelPick ??
      resolveDefaultModel(
        transcriptionModels.map((model) => model.id),
        choice.defaultModelId,
      ) ??
      choice.defaultModelId)
    : null;

  // Mirrors read by the async upload runs and by callbacks that must not change
  // identity every time a draft does. Synced after commit, which is always
  // before the next event handler or resumed upload can read them.
  const draftsRef = useRef<Drafts>(drafts);
  const transcriptModelRef = useRef(transcriptModelId);
  useEffect(() => {
    draftsRef.current = drafts;
    transcriptModelRef.current = transcriptModelId;
  }, [drafts, transcriptModelId]);

  const patchSource = useCallback(
    (draftKey: string, localId: string, patch: Partial<StagedSource>) => {
      setDrafts((current) => {
        const draft = current[draftKey];
        if (!draft) return current;
        const index = draft.findIndex((source) => source.localId === localId);
        // Removed mid-upload — the run finishes into nothing, by design.
        if (index === -1) return current;
        const next = draft.slice();
        next[index] = { ...next[index], ...patch };
        return { ...current, [draftKey]: next };
      });
    },
    [],
  );

  const patchBySourceUploadId = useCallback(
    (sourceUploadId: string, patch: Partial<StagedSource>) => {
      setDrafts((current) => {
        let touched = false;
        const next: Drafts = {};
        for (const [key, draft] of Object.entries(current)) {
          next[key] = draft.map((source) => {
            if (source.sourceUploadId !== sourceUploadId) return source;
            touched = true;
            return { ...source, ...patch };
          });
        }
        return touched ? next : current;
      });
    },
    [],
  );

  /** patchSource bound to one staged source, for the length of its upload. */
  const patcherFor = useCallback(
    (draftKey: string, localId: string) => (fields: Partial<StagedSource>) =>
      patchSource(draftKey, localId, fields),
    [patchSource],
  );

  useTranscriptWatcher(drafts, patchBySourceUploadId);

  const appendSources = useCallback(
    (draftKey: string, added: StagedSource[]) => {
      setDrafts((current) => ({
        ...current,
        [draftKey]: [...(current[draftKey] ?? []), ...added],
      }));
    },
    [],
  );

  const runFileUpload = useCallback(
    async (draftKey: string, localId: string, file: File, kind: FileKind) => {
      const patch = patcherFor(draftKey, localId);

      try {
        if (kind === "image") {
          patch({ status: "uploading" });
          const uploaded = await uploadImage(server, file);
          // Swap the local object URL for the signed one and let the blob go;
          // the preview then survives being handed to the sent message.
          const withBlobPreview = draftsRef.current[draftKey]?.find(
            (source) => source.localId === localId,
          );
          patch({
            status: "ready",
            sourceUploadId: uploaded.imageUploadId,
            previewUrl: uploaded.url,
          });
          if (withBlobPreview) releasePreview(withBlobPreview);
          return;
        }

        patch({ status: "preparing" });
        const speech = await compressAudioForSpeech(
          kind === "video" ? await extractAudioFromVideo(file) : file,
        );

        if (speech.size > MAX_AUDIO_BYTES) {
          patch({
            status: "failed",
            error: `Too much audio to upload (${formatBytes(speech.size)}).`,
          });
          return;
        }

        patch({ status: "uploading" });
        const uploaded = await uploadAudio(server, {
          file: speech,
          source: kind,
          transcriptModelId: transcriptModelRef.current,
        });
        patch({
          status: "transcribing",
          sourceUploadId: uploaded.audioUploadId,
        });
      } catch (error) {
        patch({
          status: "failed",
          error: errorMessage(error, "Upload failed."),
        });
      }
    },
    [patcherFor, server],
  );

  const runYoutubeFetch = useCallback(
    async (draftKey: string, localId: string, url: string) => {
      const patch = patcherFor(draftKey, localId);
      try {
        patch({ status: "uploading" });
        const queued = await requestYoutubeTranscript(
          server,
          url,
          transcriptModelRef.current,
        );
        patch({
          status: "transcribing",
          sourceUploadId: queued.audioUploadId,
        });
      } catch (error) {
        patch({
          status: "failed",
          error: errorMessage(error, "Could not queue that video."),
        });
      }
    },
    [patcherFor, server],
  );

  const addFiles = useCallback(
    (draftKey: string, files: File[]) => {
      const accepted: { source: StagedSource; file: File; kind: FileKind }[] =
        [];
      let imageSlots =
        MAX_IMAGES_PER_MESSAGE -
        (draftsRef.current[draftKey] ?? []).filter(
          (source) => source.kind === "image",
        ).length;

      const reject = (message: string) => {
        toast.show({ kind: "error", message });
        return false;
      };
      // Toasts what it turns away, and spends an image slot on what it keeps.
      const accepts = (file: File, kind: FileKind | null): kind is FileKind => {
        if (!kind)
          return reject(`${file.name} isn't an image, audio or video file.`);
        if (kind !== "image") return true;
        if (imageSlots <= 0)
          return reject(
            `A message carries up to ${MAX_IMAGES_PER_MESSAGE} images.`,
          );
        if (file.size > MAX_IMAGE_BYTES)
          return reject(
            `${file.name} is ${formatBytes(file.size)} — images stop at ${formatBytes(MAX_IMAGE_BYTES)}.`,
          );
        imageSlots -= 1;
        return true;
      };

      for (const file of files) {
        const kind = classifyFile(file);
        if (!accepts(file, kind)) continue;

        accepted.push({
          source: stageSource({
            kind,
            name: file.name,
            status: kind === "image" ? "uploading" : "preparing",
            file,
            previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
          }),
          file,
          kind,
        });
      }

      if (accepted.length === 0) return;
      appendSources(
        draftKey,
        accepted.map((entry) => entry.source),
      );
      for (const entry of accepted) {
        void runFileUpload(
          draftKey,
          entry.source.localId,
          entry.file,
          entry.kind,
        );
      }
    },
    [appendSources, runFileUpload, toast],
  );

  const addYoutube = useCallback(
    (draftKey: string, url: string) => {
      const source = stageSource({
        kind: "youtube",
        name: youtubeLabel(url),
        status: "uploading",
        youtubeUrl: url,
      });
      appendSources(draftKey, [source]);
      void runYoutubeFetch(draftKey, source.localId, url);
    },
    [appendSources, runYoutubeFetch],
  );

  const attachExisting = useCallback(
    (draftKey: string, job: ExistingSource) => {
      const alreadyStaged = (draftsRef.current[draftKey] ?? []).some(
        (source) => source.sourceUploadId === job.audioUploadId,
      );
      if (alreadyStaged) {
        toast.show({
          kind: "info",
          message: `${job.fileName} is already on this message.`,
        });
        return;
      }
      appendSources(draftKey, [
        stageSource({
          kind: job.source === "youtube" ? "youtube" : "audio",
          name: job.fileName,
          status: "ready",
          sourceUploadId: job.audioUploadId,
        }),
      ]);
    },
    [appendSources, toast],
  );

  const removeSource = useCallback(
    (draftKey: string, localId: string) => {
      const removed = draftsRef.current[draftKey]?.find(
        (source) => source.localId === localId,
      );
      if (!removed) return;

      releasePreview(removed);
      if (
        removed.kind === "image" &&
        removed.status === "ready" &&
        removed.sourceUploadId
      ) {
        void deleteImage(server, removed.sourceUploadId).catch((error) => {
          toast.show({
            kind: "error",
            message: errorMessage(error, "Image cleanup failed."),
          });
        });
      }

      setDrafts((current) => {
        const draft = current[draftKey];
        if (!draft) return current;
        return {
          ...current,
          [draftKey]: draft.filter((source) => source.localId !== localId),
        };
      });
    },
    [server, toast],
  );

  const retrySource = useCallback(
    (draftKey: string, localId: string) => {
      const source = (draftsRef.current[draftKey] ?? []).find(
        (candidate) => candidate.localId === localId,
      );
      if (!source) return;

      patchSource(draftKey, localId, { error: null });
      if (source.youtubeUrl) {
        void runYoutubeFetch(draftKey, localId, source.youtubeUrl);
      } else if (source.file && source.kind !== "youtube") {
        void runFileUpload(draftKey, localId, source.file, source.kind);
      }
    },
    [patchSource, runFileUpload, runYoutubeFetch],
  );

  const takeDraft = useCallback((draftKey: string) => {
    const taken = draftsRef.current[draftKey] ?? [];
    if (taken.length === 0) return taken;
    setDrafts((current) => {
      if (!(draftKey in current)) return current;
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
    return taken;
  }, []);

  const restoreDraft = useCallback(
    (draftKey: string, sources: StagedSource[]) => {
      if (sources.length === 0) return;
      setDrafts((current) => ({
        ...current,
        [draftKey]: [...sources, ...(current[draftKey] ?? [])],
      }));
    },
    [],
  );

  const value = useMemo(
    () => ({
      drafts,
      addFiles,
      addYoutube,
      attachExisting,
      removeSource,
      retrySource,
      takeDraft,
      restoreDraft,
      transcriptModelId,
      setTranscriptModelId: setTranscriptModelPick,
    }),
    [
      drafts,
      addFiles,
      addYoutube,
      attachExisting,
      removeSource,
      retrySource,
      takeDraft,
      restoreDraft,
      transcriptModelId,
    ],
  );

  return (
    <SourcesContext.Provider value={value}>{children}</SourcesContext.Provider>
  );
}
