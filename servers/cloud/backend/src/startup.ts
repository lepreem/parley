import { verifyServices } from "@parley/server-kit/runtime/preflight";
import { mq } from "./message-queue/messageQueue";
import { pingDb } from "./db";
import { bucket } from "./storage";
import { chat, transcription } from "./ai";
import { workos } from "./auth/auth";
import { UPLOAD_CONFIRM_WINDOW_MS } from "./uploads";

/**
 * Fail-fast preflight for the API: aborts startup if any third-party
 * dependency is unavailable.
 */
export function verifyApiServices(): Promise<void> {
  return verifyServices([
    { name: "RabbitMQ", check: mq.ping },
    { name: "Postgres", check: pingDb },
    { name: "Supabase Storage", check: bucket.ping },
    // The size and type limits on what the upload URLs accept.
    {
      name: "Supabase Storage bucket settings",
      check: bucket.verifySettings,
    },
    // An upload URL has to expire inside the window its upload can be
    // confirmed in.
    {
      name: "Supabase Storage upload URLs",
      check: () => bucket.verifyUploadUrlLifetime(UPLOAD_CONFIRM_WINDOW_MS),
    },
    { name: "WorkOS", check: workos.ping },
    { name: "OpenRouter", check: chat.ping },
    { name: "Deepgram", check: transcription.ping },
  ]);
}
