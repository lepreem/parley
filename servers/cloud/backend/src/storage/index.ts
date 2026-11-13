/**
 * Object storage. `bucket` changes what's stored; `sign` only mints read URLs,
 * which is why it's the one a data module may use.
 */
export * as bucket from "./bucket";
export * as sign from "./sign";
export {
  BUCKET_SETTINGS,
  IMAGE_URL_TTL_SECONDS,
  matchesBucketSettings,
} from "./schema";
export type { StoredObject, UploadableObject } from "./schema";
