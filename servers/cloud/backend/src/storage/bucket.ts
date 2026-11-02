import { randomUUID } from "node:crypto";
import { isNotFound, objectPath, storage, supabase } from "./core";
import {
  BUCKET_SETTINGS,
  KINDS,
  matchesBucketSettings,
  type BucketSettings,
  type LiveBucketSettings,
  type UploadableObject,
  type StoredObject,
} from "./schema";

/** Startup health check: fails if Supabase is unreachable or a bucket is missing. */
async function ping(): Promise<void> {
  await Promise.all(
    Object.keys(BUCKET_SETTINGS).map(async (name) => {
      const { error } = await supabase.storage.getBucket(name);
      if (error) throw error;
    }),
  );
}

/**
 * A bucket's settings as Supabase has them, or null when there's no such
 * bucket. A limit Supabase doesn't enforce reads as null.
 */
async function readSettings(name: string): Promise<LiveBucketSettings | null> {
  const { data, error } = await supabase.storage.getBucket(name);
  if (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return {
    public: data.public,
    fileSizeLimit: data.file_size_limit ?? null,
    allowedMimeTypes: data.allowed_mime_types ?? null,
  };
}

/**
 * Startup check: fails when a live bucket isn't what the storage schema
 * declares, for instance because a limit was loosened in the dashboard. The
 * confirm step would still reject what the bucket lets through, but only
 * after the bytes had landed. `npm run storage:push` puts the settings back.
 */
async function verifySettings(): Promise<void> {
  await Promise.all(
    Object.entries(BUCKET_SETTINGS).map(([name, declared]) =>
      verifyBucketSettings(name, declared),
    ),
  );
}

async function verifyBucketSettings(name: string, declared: BucketSettings) {
  const live = await readSettings(name);
  if (!live) {
    throw new Error(
      `Bucket "${name}" does not exist; run npm run storage:push`,
    );
  }
  if (!matchesBucketSettings(live, declared)) {
    throw new Error(
      `Bucket "${name}" is ${JSON.stringify(live)}, not the storage schema's ` +
        `${JSON.stringify(declared)}; run npm run storage:push`,
    );
  }
}

/** Creates the named bucket with these settings. */
async function create(name: string, settings: BucketSettings): Promise<void> {
  const { error } = await supabase.storage.createBucket(name, settings);
  if (error) throw error;
}

/** Changes the named bucket's settings to these. */
async function updateSettings(
  name: string,
  settings: BucketSettings,
): Promise<void> {
  const { error } = await supabase.storage.updateBucket(name, settings);
  if (error) throw error;
}

/**
 * A one-shot URL the browser can PUT a file to, so the bytes go straight from
 * the device to storage instead of through this process. The token is bound
 * to this exact key, so the client can neither choose its own path nor reuse
 * the URL for a second object.
 *
 * The URL itself can't limit what lands: size and content type are the
 * client's to set. The kind's bucket caps both at the kind's own limits
 * (BUCKET_SETTINGS), and inspectUploadedObject checks them again at confirm.
 */
async function createUploadUrl(userId: string, object: UploadableObject) {
  const { data, error } = await storage(object.kind).createSignedUploadUrl(
    objectPath(userId, object),
  );

  if (error) throw error;
  return data.signedUrl;
}

/**
 * Startup check: fails when Supabase hands out upload URLs that stay valid
 * for longer than `maxLifetimeMs`.
 *
 * Supabase decides that lifetime (two hours today) and offers no way to set
 * it or read it back, so the only place it exists is inside the URL's own
 * token. If it ever outgrew the window an upload can be confirmed in, an
 * upload could land after its record had been swept and sit in the bucket
 * for good — so this stops a deploy rather than leaking storage quietly.
 *
 * Minting a URL creates no object, so the probe leaves nothing behind.
 */
async function verifyUploadUrlLifetime(maxLifetimeMs: number): Promise<void> {
  const probe = { kind: "image", uploadId: randomUUID() } as const;
  const { data, error } = await storage(probe.kind).createSignedUploadUrl(
    objectPath("preflight", probe),
  );
  if (error) throw error;

  const lifetimeMs = tokenLifetimeMs(data.token);
  if (lifetimeMs > maxLifetimeMs) {
    throw new Error(
      `Upload URLs are valid for ${lifetimeMs} ms, longer than the ` +
        `${maxLifetimeMs} ms an upload can be confirmed in: an upload could ` +
        "land after its record has been swept",
    );
  }
}

/** How long a Supabase-signed token is valid for, from its own claims. */
function tokenLifetimeMs(token: string) {
  const [, payload] = token.split(".");
  const { iat, exp } = JSON.parse(
    Buffer.from(payload ?? "", "base64url").toString(),
  ) as { iat?: unknown; exp?: unknown };
  if (typeof iat !== "number" || typeof exp !== "number") {
    throw new Error("Upload token carries no lifetime");
  }
  return (exp - iat) * 1000;
}

/**
 * What storage says landed under an upload, checked against what its kind
 * accepts. Neither size nor content type passed through this process, so both
 * are read back rather than taken from the client. Only reads: an object this
 * rejects is left for the sweep.
 */
async function inspectUploadedObject(userId: string, object: UploadableObject) {
  const { contentTypePrefix, maxBytes } = KINDS[object.kind].upload;
  const { data, error } = await storage(object.kind).info(
    objectPath(userId, object),
  );

  if (error) {
    if (isNotFound(error)) return { ok: false, reason: "missing" } as const;
    throw error;
  }

  const sizeBytes = data.size ?? 0;
  const contentType = data.contentType ?? "";

  const reason = !contentType.startsWith(contentTypePrefix)
    ? "wrong-type"
    : sizeBytes > maxBytes
      ? "too-large"
      : null;

  if (reason) return { ok: false, reason, contentType, maxBytes } as const;

  return { ok: true, sizeBytes, contentType } as const;
}

/**
 * Removes one owner's objects, of any mix of kinds: one request per bucket
 * they're stored in, all in parallel. No-ops on an empty list.
 */
async function deleteObjects(userId: string, objects: readonly StoredObject[]) {
  const byBucket = Map.groupBy(objects, (object) => KINDS[object.kind].bucket);
  const removed = await Promise.all(
    [...byBucket.values()].map((group) => removeGroup(userId, group)),
  );
  return removed.flat();
}

/** Removes objects that are all stored in the same bucket, in one request. */
async function removeGroup(userId: string, objects: readonly StoredObject[]) {
  const { data, error } = await storage(objects[0].kind).remove(
    objects.map((object) => objectPath(userId, object)),
  );

  if (error) throw error;
  return data;
}

export const bucket = {
  ping,
  readSettings,
  verifySettings,
  create,
  updateSettings,
  createUploadUrl,
  verifyUploadUrlLifetime,
  inspectUploadedObject,
  delete: deleteObjects,
};
