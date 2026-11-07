import { useContext, useMemo } from "react";
import { SourcesContext, type ExistingSource } from "./context";
import type { StagedSource } from "./types";

const NO_SOURCES: StagedSource[] = [];

/**
 * The staged sources for one draft, with every action already bound to it.
 * `draftKey` is the conversation id, or "new" before the conversation exists.
 */
export function useSources(draftKey: string) {
  const context = useContext(SourcesContext);
  if (context === null) {
    throw new Error("useSources must be used within SourcesProvider");
  }

  const {
    drafts,
    addFiles,
    addYoutube,
    attachExisting,
    removeSource,
    dropDeletedSource,
    retrySource,
    takeDraft,
    restoreDraft,
    useCaptionsIfAvailable,
    captionsRequired,
    setUseCaptionsIfAvailable,
  } = context;
  const sources = drafts[draftKey] ?? NO_SOURCES;

  return useMemo(
    () => ({
      sources,
      useCaptionsIfAvailable,
      captionsRequired,
      setUseCaptionsIfAvailable,
      addFiles: (files: File[]) => addFiles(draftKey, files),
      addYoutube: (url: string) => addYoutube(draftKey, url),
      attachExisting: (job: ExistingSource) => attachExisting(draftKey, job),
      removeSource: (localId: string) => removeSource(draftKey, localId),
      dropDeletedSource,
      retrySource: (localId: string) => retrySource(draftKey, localId),
      takeSources: () => takeDraft(draftKey),
      /**
       * Takes the key explicitly: a failed send may have created the
       * conversation first, so the sources belong to a draft that didn't exist
       * when this was called.
       */
      restoreSourcesFor: (key: string, taken: StagedSource[]) =>
        restoreDraft(key, taken),
    }),
    [
      draftKey,
      sources,
      useCaptionsIfAvailable,
      captionsRequired,
      setUseCaptionsIfAvailable,
      addFiles,
      addYoutube,
      attachExisting,
      removeSource,
      dropDeletedSource,
      retrySource,
      takeDraft,
      restoreDraft,
    ],
  );
}
