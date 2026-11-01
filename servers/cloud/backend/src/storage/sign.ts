import { isNotFound, objectPath, storage } from "./core";
import { KINDS, type UploadableKind, type UploadableObject } from "./schema";

/** Asks storage to sign one object for its kind's TTL. */
function requestSignedUrl(userId: string, object: UploadableObject) {
  return storage(object.kind).createSignedUrl(
    objectPath(userId, object),
    KINDS[object.kind].upload.readUrlTtlSeconds,
  );
}

/**
 * A read URL for one object, valid for its kind's TTL: a week for images
 * (client thumbnails and the chat model's vision input), an hour for audio
 * (which the transcription provider fetches for itself, and the client plays).
 */
async function createSignedUrl(userId: string, object: UploadableObject) {
  const { data, error } = await requestSignedUrl(userId, object);

  if (error) throw error;
  return data.signedUrl;
}

/**
 * A read URL as createSignedUrl signs it, or null when there's no such
 * object: a YouTube job's audio is recorded before it lands, and a video with
 * captions never sends any.
 */
async function createSignedUrlIfStored(
  userId: string,
  object: UploadableObject,
) {
  const { data, error } = await requestSignedUrl(userId, object);

  if (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return data.signedUrl;
}

/**
 * Signs many objects: one request per kind, since a request carries a single
 * TTL, all in parallel. Returns uploadId → url, omitting any the storage API
 * couldn't sign. Entries may span owners; the path carries the owner.
 */
async function createSignedUrls(
  entries: readonly (UploadableObject & { userId: string })[],
): Promise<Map<string, string>> {
  const byKind = Map.groupBy(entries, (entry) => entry.kind);
  const signed = await Promise.all(
    [...byKind].map(([kind, group]) => signGroup(kind, group)),
  );
  return new Map(signed.flatMap((urls) => [...urls]));
}

async function signGroup(
  kind: UploadableKind,
  entries: readonly (UploadableObject & { userId: string })[],
) {
  const paths = entries.map((entry) => objectPath(entry.userId, entry));
  const { data, error } = await storage(kind).createSignedUrls(
    paths,
    KINDS[kind].upload.readUrlTtlSeconds,
  );
  if (error) throw error;

  const byPath = new Map(
    data.filter((d) => d.path && d.signedUrl).map((d) => [d.path, d.signedUrl]),
  );
  return entries.flatMap((entry, i) => {
    const url = byPath.get(paths[i]);
    return url ? [[entry.uploadId, url] as const] : [];
  });
}

/**
 * The only storage calls a data module may make: signing read URLs, which
 * changes nothing in storage.
 */
export const sign = {
  url: createSignedUrl,
  urlIfStored: createSignedUrlIfStored,
  urls: createSignedUrls,
};
