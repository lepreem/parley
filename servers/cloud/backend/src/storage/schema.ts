/**
 * What the buckets hold, declared in one place the way src/db/schema.ts
 * declares the tables: the buckets' names, and for each kind of object its
 * bucket, its folder there and, for the kinds clients upload, their limits.
 */

import { isDeepStrictEqual } from "node:util";

export const AUDIO_BUCKET = "Audio";

// Images have a bucket to themselves, so the bucket can hold them to the
// image limit rather than the audio one.
export const IMAGE_BUCKET = "Images";

// Cap on audio files entering the bucket.
// Supabase's Free plan caps every upload in the project at 50 MB, and a
// bucket's limit can't exceed the project's, so this can only go higher with
// the plan.
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50MB

// Cap on images entering the bucket (chat attachments / standalone uploads).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * How long an image URL is signed for. Long-lived because it's minted once at
 * upload and cached on the row — the model provider only needs seconds, but a
 * conversation reopened next week should not have to re-sign to render.
 */
export const IMAGE_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long an audio URL handed to the transcription provider stays valid. Long
 * enough to outlive a multi-hour file's transcription job and short enough that
 * the link is useless by the time the job row is history.
 */
const AUDIO_URL_TTL_SECONDS = 60 * 60;

/**
 * Everything that differs between kinds of stored object: the bucket it's
 * stored in, its folder there, and the rules for uploading it and signing it
 * for reading.
 */
export const KINDS = {
  image: {
    bucket: IMAGE_BUCKET,
    folder: "images",
    upload: {
      contentTypePrefix: "image/",
      maxBytes: MAX_IMAGE_BYTES,
      readUrlTtlSeconds: IMAGE_URL_TTL_SECONDS,
    },
  },
  audio: {
    bucket: AUDIO_BUCKET,
    folder: "audios",
    upload: {
      contentTypePrefix: "audio/",
      maxBytes: MAX_AUDIO_BYTES,
      readUrlTtlSeconds: AUDIO_URL_TTL_SECONDS,
    },
  },
} as const;

export type StoredObjectKind = keyof typeof KINDS;

/** The kinds a client uploads directly and that can be signed for reading. */
export type UploadableKind = {
  [K in StoredObjectKind]: (typeof KINDS)[K] extends { upload: object }
    ? K
    : never;
}[StoredObjectKind];

export type StoredObject = { kind: StoredObjectKind; uploadId: string };
export type UploadableObject = { kind: UploadableKind; uploadId: string };

/** A bucket's settings as the storage schema declares them. */
export type BucketSettings = {
  public: boolean;
  fileSizeLimit: number;
  allowedMimeTypes: string[];
};

/**
 * What a bucket itself enforces on every upload, before anything reaches the
 * confirm step, including uploads through a signed URL, which can't carry
 * limits of their own. Derived from the kinds KINDS stores in it, so the two
 * can't disagree: the largest of their size limits, and their content types.
 * Each kind clients upload has a bucket of its own, so its bucket holds it to
 * exactly its own limits; the confirm step checks them again.
 */
function settingsFor(bucket: string): BucketSettings {
  const rules = Object.values(KINDS).flatMap((kind) =>
    kind.bucket === bucket && "upload" in kind ? [kind.upload] : [],
  );
  return {
    public: false,
    fileSizeLimit: Math.max(...rules.map((rule) => rule.maxBytes)),
    allowedMimeTypes: rules.map((rule) => `${rule.contentTypePrefix}*`),
  };
}

/**
 * Every bucket KINDS stores objects in, by name, with its settings.
 * `npm run storage:push` makes the live buckets match these.
 */
export const BUCKET_SETTINGS: Record<string, BucketSettings> =
  Object.fromEntries(
    Object.values(KINDS).map((kind) => [kind.bucket, settingsFor(kind.bucket)]),
  );

/** A bucket's settings as Supabase reports them; an unenforced limit is null. */
export type LiveBucketSettings = {
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
};

/**
 * Whether a bucket's live settings are the declared ones. The order its
 * content types are listed in doesn't matter.
 */
export function matchesBucketSettings(
  live: LiveBucketSettings,
  declared: BucketSettings,
) {
  const sorted = (types: readonly string[] | null) =>
    types ? [...types].sort() : null;
  return (
    live.public === declared.public &&
    live.fileSizeLimit === declared.fileSizeLimit &&
    isDeepStrictEqual(
      sorted(live.allowedMimeTypes),
      sorted(declared.allowedMimeTypes),
    )
  );
}
