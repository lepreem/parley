import type { ZodType } from "zod";

/**
 * Opaque keyset-pagination cursors.
 *
 * A cursor is just the sort-key of the last row on a page (e.g.
 * `{ createdAt, id }`) serialized to a URL-safe, opaque string. It is generic
 * over the payload so any paginated endpoint can reuse it — the caller decides
 * what the keyset looks like.
 *
 * Note: the payload is encoded, not signed. Only put sort keys the client is
 * already allowed to see in here; never secrets.
 */

/** Encode any JSON-serializable keyset payload into an opaque cursor string. */
export function encodeCursor<T>(payload: T): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Decode an opaque cursor back into its payload.
 *
 * Returns `null` for anything malformed (bad base64, bad JSON, or — when a
 * schema is supplied — a shape that fails validation) so callers can treat a
 * broken/forged cursor as "start from the beginning" rather than throwing.
 *
 * Pass a Zod `schema` to validate the decoded shape; omit it for a raw,
 * unchecked decode.
 */
export function decodeCursor<T>(cursor: string, schema?: ZodType<T>): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!schema) return parsed as T;
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}
