import { createContext } from "react";
import type { JobSource } from "../api/jobs";
import type { StagedSource } from "./types";

/** A completed job being attached from the library rather than uploaded again. */
export type ExistingSource = {
  audioUploadId: string;
  fileName: string;
  source: JobSource;
};

export type SourcesContextValue = {
  /** Staged sources per draft, keyed by conversation id (or "new"). */
  drafts: Record<string, StagedSource[]>;
  addFiles: (draftKey: string, files: File[]) => void;
  addYoutube: (draftKey: string, url: string) => void;
  attachExisting: (draftKey: string, job: ExistingSource) => void;
  removeSource: (draftKey: string, localId: string) => void;
  dropDeletedSource: (audioUploadId: string) => void;
  retrySource: (draftKey: string, localId: string) => void;
  /** Hands the draft over and empties it — the send path takes ownership. */
  takeDraft: (draftKey: string) => StagedSource[];
  /** Puts a taken draft back when the send it was taken for failed. */
  restoreDraft: (draftKey: string, sources: StagedSource[]) => void;
  /** Whether a YouTube video added from now on takes its captions when it has them. */
  useCaptionsIfAvailable: boolean;
  setUseCaptionsIfAvailable: (use: boolean) => void;
};

export const SourcesContext = createContext<SourcesContextValue | null>(null);
