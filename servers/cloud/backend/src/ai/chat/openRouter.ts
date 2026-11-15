/** The OpenRouter connections: which key a call is billed to. */

import { getEnv } from "../../env";
import { OpenRouter } from "@openrouter/sdk";
import type { Model } from "@openrouter/sdk/models";
import type { Tier } from "@parley/contract/tiers";

const client = new OpenRouter({
  apiKey: getEnv().OPENROUTER_API_KEY,
  // The load test's stand-in; unset, the SDK uses OpenRouter itself.
  serverURL: getEnv().OPENROUTER_BASE_URL,
});

/**
 * Guests' turns go through a key of their own, whose credit limit is the cap
 * on what guests can spend. There is no guest client without that key, so a
 * guest turn can never fall back to the main one.
 */
const guestApiKey = getEnv().OPENROUTER_GUEST_API_KEY;
const guestClient =
  guestApiKey === undefined
    ? undefined
    : new OpenRouter({
        apiKey: guestApiKey,
        serverURL: getEnv().OPENROUTER_BASE_URL,
      });

/** The OpenRouter key each tier's turns are billed to. */
const KEY_OF_TIER: Record<Tier, "main" | "guest"> = {
  guest: "guest",
  free: "main",
};

/** The connection a tier's call goes through. */
export function clientFor(tier: Tier): OpenRouter {
  if (KEY_OF_TIER[tier] === "main") return client;
  if (!guestClient) throw new Error("Guest chat isn't enabled");
  return guestClient;
}

/** Startup health check: fails if OpenRouter is unreachable or rejects the API key. */
export async function ping(): Promise<void> {
  await client.models.list();
}

/**
 * Every model OpenRouter lists that answers in text: every one of them is a
 * chat model. Transcription is served by Deepgram.
 */
export async function listTextModels(): Promise<Model[]> {
  const { data } = (await client.models.list({ outputModalities: "text" }))
    .result;
  return data;
}
