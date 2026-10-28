import { existsSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { logger } from "@parley/server-kit/runtime/logger";
import { getEnv } from "./env";
import { jobsRouter } from "./routes/jobs.router";
import { uploadRouter } from "./routes/upload.router";
import { authRouter } from "./routes/auth.router";
import { modelsRouter } from "./routes/models.router";
import { conversationsRouter } from "./routes/conversations.router";
import { handleEvents } from "./sse/events.controller";
import { requireAuth } from "./middleware/auth.middleware";

import { AUDIO_BUCKET, MAX_AUDIO_BYTES } from "./storage";
import { verifyApiServices } from "./startup";
import { mq } from "./message-queue/messageQueue";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export async function createApp() {
  const env = getEnv();
  const app = new Hono();
  app.use("*", cors({ origin: env.CLIENT_URL, credentials: true }));
  // CORS only matters in development, where Vite serves the client from its
  // own port; in production the API serves it. A form post skips CORS
  // entirely (multipart/form-data is a safelisted content type), and the
  // SameSite=Lax session cookie already stays off another site's POST. This
  // rejects the form-style content types unless the Origin is the client, in
  // case a browser sends it anyway.
  app.use("*", csrf({ origin: env.CLIENT_URL }));
  // The chat model catalog is ~50KB of JSON and every client downloads it;
  // gzip takes that to ~7KB. Streamed chat replies are left alone: hono skips
  // text/event-stream by content type, and streamSSE sets Transfer-Encoding,
  // which this middleware also treats as already-encoded. Both guarantees are
  // covered by tests, because buffering the reply stream would be invisible
  // here and obvious to every user.
  app.use("*", compress());
  // Nothing has a reason to send more: a message is at most 50k characters,
  // and files go straight to storage, never through here. Without a limit a
  // request body is read whole into memory, however large.
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ message: "Request body is too large" }, 413),
    }),
  );

  // Every other answer the client gets is JSON with a `message`; an error no
  // handler caught is one too, and goes through the logger rather than
  // Hono's console.error. An HTTPException carries its own response.
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    logger.error("Unhandled request error", error, {
      method: c.req.method,
      path: c.req.path,
    });
    return c.json({ message: "Internal server error" }, 500);
  });

  await verifyApiServices();

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/events", requireAuth, ...handleEvents);
  // Cross-service contract: non-sensitive shared facts (queue names + bucket
  // name) the Python youtube-fetcher reads at boot so it never hand-mirrors
  // them. Public + unauthenticated on purpose — none of this is sensitive and
  // service callers have no session. Secrets (Supabase key, MQ_URL) are NOT
  // served here — those belong in a secrets manager / platform env.

  // TODO: rename bucket key to audioBucket.
  app.get("/contract", (c) =>
    c.json({
      queues: mq.queues,
      bucket: AUDIO_BUCKET,
      maxAudioBytes: MAX_AUDIO_BYTES,
    }),
  );
  app.route("/upload", uploadRouter);
  app.route("/auth", authRouter);
  app.route("/jobs", jobsRouter);
  app.route("/models", modelsRouter);
  app.route("/conversations", conversationsRouter);

  // The built client, on the API's own origin, so the session cookie is
  // first-party. Under `npm run dev` it isn't built and Vite serves it.
  const clientDir = path.resolve(env.CLIENT_DIR);
  if (existsSync(path.join(clientDir, "index.html"))) {
    // Vite names each file under /assets after a hash of its contents, so a
    // changed file arrives under a new name and a browser can keep these for
    // good. The page has no hash in its name, so a browser checks it every
    // time, or it would stay on the old page, and old assets, after a deploy.
    app.use("*", async (c, next) => {
      await next();
      if (!c.res.ok) return;
      if (c.req.path.startsWith("/assets/")) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (c.res.headers.get("Content-Type")?.startsWith("text/html")) {
        c.header("Cache-Control", "no-cache");
      }
    });
    app.use("*", serveStatic({ root: clientDir }));
    // The client's own routes are pages rather than files. Only those: any
    // other path is the API's, and one it doesn't have is a 404.
    const page = serveStatic({ root: clientDir, path: "index.html" });
    app.get("/", page);
    app.get("/chat", page);
    app.get("/chat/*", page);
  }
  return app;
}
