import { createRemoteJWKSet } from "jose";
import * as workos from "./auth";

/**
 * How long the fetched keys are trusted before they're fetched again. A token
 * signed with a key that isn't among them triggers a fetch straight away, which
 * is how a key WorkOS rotates in gets picked up; this only bounds how long a key
 * WorkOS has withdrawn is still accepted.
 */
const KEYS_MAX_AGE_MS = 60 * 60 * 1000;

let keys: ReturnType<typeof createRemoteJWKSet> | undefined;

/**
 * The keys WorkOS signs access tokens with, fetched on first use and cached
 * in the process, so verifying a token makes no request of its own.
 */
export function workosKeys() {
  keys ??= createRemoteJWKSet(new URL(workos.getJwksUrl()), {
    cacheMaxAge: KEYS_MAX_AGE_MS,
  });
  return keys;
}
