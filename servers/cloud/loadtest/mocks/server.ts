/**
 * Stand-ins for the paid services the backend calls, so a load test costs
 * nothing: OpenRouter (chat and titles), Deepgram (transcription) and WorkOS
 * (the keys session tokens are checked against). Each answers just the calls
 * the backend makes, in the shape its SDK checks for, after a delay that
 * stands in for the real service's.
 *
 * It also signs the session tokens k6 sends, for made-up users, with the key
 * it publishes as WorkOS's, which is how the API comes to trust them.
 *
 * No dependencies: Node runs this file as it is (type stripping, Node 23.6+).
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 4000);

/** Every delay, so a run can model a slower or faster provider. */
const DELAYS = {
  /** Before the first streamed token, as a model "thinks". */
  chatFirstTokenMs: numberEnv("CHAT_FIRST_TOKEN_MS", 800),
  /** Between streamed tokens. */
  chatTokenIntervalMs: numberEnv("CHAT_TOKEN_INTERVAL_MS", 30),
  /** Tokens in each streamed reply. */
  chatTokens: numberEnv("CHAT_TOKENS", 150),
  /** A whole non-streamed reply, which is what titles are. */
  titleMs: numberEnv("TITLE_MS", 600),
  /** A transcription, on top of downloading the audio. */
  transcribeMs: numberEnv("TRANSCRIBE_MS", 5000),
};

/** How long the tokens it signs stay valid: a whole run, with no refresh. */
const TOKEN_TTL_SECONDS = numberEnv("TOKEN_TTL_SECONDS", 24 * 60 * 60);

function numberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// ---------------------------------------------------------------------------
// WorkOS: the signing key

// A fresh key and key id each start. The API looks the keys up again when a
// token names one it hasn't seen, so a restart doesn't strand it.
const KEY_ID = `loadtest-${randomUUID()}`;
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const JWKS = {
  keys: [
    {
      ...publicKey.export({ format: "jwk" }),
      kid: KEY_ID,
      alg: "RS256",
      use: "sig",
    },
  ],
};

/** An access token shaped like WorkOS's: sub, sid and exp, signed RS256. */
function signAccessToken(userId: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (part: object) =>
    Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT", kid: KEY_ID })}.${encode(
    {
      sub: userId,
      sid: `session-${userId}`,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    },
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(privateKey)
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

/** The user ids k6 runs as; seed-users.sql inserts the same ones. */
function loadtestUserId(n: number) {
  return `loadtest-user-${n}`;
}

// ---------------------------------------------------------------------------
// OpenRouter: the catalog and chat

function catalogModel(id: string, name: string, inputModalities: string[]) {
  return {
    id,
    canonical_slug: id,
    name,
    // Today: the backend leaves out models past an age.
    created: Math.floor(Date.now() / 1000),
    context_length: 128_000,
    architecture: {
      input_modalities: inputModalities,
      output_modalities: ["text"],
      modality: `${inputModalities.join("+")}->text`,
    },
    pricing: { prompt: "0", completion: "0" },
    top_provider: { context_length: 128_000, is_moderated: false },
    per_request_limits: null,
    supported_parameters: [],
    supported_voices: null,
    default_parameters: null,
    links: { details: `https://openrouter.ai/${id}` },
  };
}

/**
 * Includes the model titles are generated with, and the alias they name it by
 * (ai_chat_client/ai_chat_client.ts).
 */
const CHAT_MODELS = [
  catalogModel("openai/gpt-6-luna", "GPT-6 Luna", ["text", "image"]),
  {
    ...catalogModel("~openai/gpt-luna-latest", "GPT Luna Latest", [
      "text",
      "image",
    ]),
    alias_target: { slug: "openai/gpt-6-luna", name: "OpenAI: GPT-6 Luna" },
  },
  catalogModel("loadtest/text-model", "Load test text model", ["text"]),
];

const REPLY_WORDS =
  "This is a canned reply from the load test's stand-in for OpenRouter, so no real model is called and nothing is billed.".split(
    " ",
  );

function chatChunk(
  id: string,
  model: string,
  delta: object,
  finishReason: string | null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function streamChat(
  res: ServerResponse,
  model: string,
  signal: AbortSignal,
) {
  const id = `gen-${randomUUID()}`;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const send = (data: unknown) =>
    res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Each token waits for its own deadline rather than a fixed gap after the
  // last, so timer lag doesn't add up over a reply and k6's chat_overhead
  // measures the backend, not this.
  const started = performance.now();
  const until = (deadline: number) =>
    sleep(Math.max(0, started + deadline - performance.now()), undefined, {
      signal,
    });

  await until(DELAYS.chatFirstTokenMs);
  send(chatChunk(id, model, { role: "assistant", content: "" }, null));
  for (let i = 0; i < DELAYS.chatTokens; i++) {
    const word = REPLY_WORDS[i % REPLY_WORDS.length];
    send(
      chatChunk(id, model, { content: `${i === 0 ? "" : " "}${word}` }, null),
    );
    await until(DELAYS.chatFirstTokenMs + (i + 1) * DELAYS.chatTokenIntervalMs);
  }
  send(chatChunk(id, model, {}, "stop"));
  res.end("data: [DONE]\n\n");
}

async function completeChat(
  res: ServerResponse,
  model: string,
  signal: AbortSignal,
) {
  await sleep(DELAYS.titleMs, undefined, { signal });
  json(res, 200, {
    id: `gen-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "Load test conversation" },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Deepgram: the catalog and transcription

const TRANSCRIBE_MODELS = [
  {
    name: "nova-3",
    canonical_name: "nova-3-general",
    architecture: "nova-3",
    languages: ["en"],
    version: "loadtest",
    uuid: randomUUID(),
    batch: true,
    streaming: true,
    formatted_output: true,
  },
];

const TRANSCRIPT =
  "This is a canned transcript from the load test's stand-in for Deepgram. No audio was sent to a real transcription service.";

/**
 * Transcriptions running now, and the most there have been at once: Deepgram
 * refuses more than 50 at once, and the API holds itself to fewer.
 */
const transcriptions = { running: 0, peak: 0 };

async function transcribe(
  res: ServerResponse,
  body: { url?: string },
  signal: AbortSignal,
) {
  transcriptions.running++;
  transcriptions.peak = Math.max(transcriptions.peak, transcriptions.running);
  try {
    await transcribeCounted(res, body, signal);
  } finally {
    transcriptions.running--;
  }
}

async function transcribeCounted(
  res: ServerResponse,
  body: { url?: string },
  signal: AbortSignal,
) {
  // Downloads the audio as Deepgram would, so storage serves the read it
  // would serve in production.
  if (body.url) {
    const audio = await fetch(body.url, { signal });
    if (!audio.ok) {
      json(res, 400, {
        err_code: "REMOTE_CONTENT_ERROR",
        err_msg: `Audio fetch failed: ${audio.status}`,
      });
      return;
    }
    await audio.arrayBuffer();
  }
  await sleep(DELAYS.transcribeMs, undefined, { signal });
  json(res, 200, {
    metadata: {
      request_id: randomUUID(),
      created: new Date().toISOString(),
      duration: 60,
      channels: 1,
      models: [],
    },
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: TRANSCRIPT,
              confidence: 0.99,
              words: [],
            },
          ],
        },
      ],
      utterances: [{ start: 0, end: 60, transcript: TRANSCRIPT }],
    },
  });
}

// ---------------------------------------------------------------------------
// The server

/** Requests per service, so a smoke run can show every call landed here. */
const counts: Record<string, number> = {};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

type Route = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  signal: AbortSignal,
) => Promise<void> | void;

const routes: Record<string, Route> = {
  "GET /openrouter/models": (_req, res) =>
    json(res, 200, {
      data: CHAT_MODELS,
      links: { next: null },
      total_count: CHAT_MODELS.length,
    }),
  "POST /openrouter/chat/completions": async (req, res, _url, signal) => {
    const body = await readJson(req);
    const model =
      typeof body.model === "string" ? body.model : "loadtest/text-model";
    await (body.stream
      ? streamChat(res, model, signal)
      : completeChat(res, model, signal));
  },

  "POST /deepgram/v1/auth/grant": (_req, res) =>
    json(res, 200, { access_token: "loadtest", expires_in: 30 }),
  "GET /deepgram/v1/models": (_req, res) =>
    json(res, 200, { stt: TRANSCRIBE_MODELS, tts: [] }),
  "POST /deepgram/v1/listen": async (req, res, _url, signal) =>
    transcribe(res, await readJson(req), signal),

  // WorkOS's SDK takes a host but no path, so its routes sit at the root.
  "GET /user_management/users": (_req, res) =>
    json(res, 200, {
      object: "list",
      data: [],
      list_metadata: { before: null, after: null },
    }),
  "GET /sso/jwks": (_req, res) => json(res, 200, JWKS),

  /** k6's setup: a session token for each of users 1..count. */
  "GET /loadtest/tokens": (_req, res, url) => {
    const count = Math.min(Number(url.searchParams.get("count") ?? 1), 10_000);
    const tokens = Array.from({ length: count }, (_, i) =>
      signAccessToken(loadtestUserId(i + 1)),
    );
    json(res, 200, { tokens });
  },
  "GET /loadtest/stats": (_req, res) =>
    json(res, 200, { counts, transcriptions, delays: DELAYS }),
  "GET /health": (_req, res) => json(res, 200, { ok: true }),
};

function routeKey(method: string, pathname: string) {
  // The JWKS path ends in the client id, which this doesn't care about.
  if (pathname.startsWith("/sso/jwks/")) return `${method} /sso/jwks`;
  return `${method} ${pathname}`;
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://mocks");
  const key = routeKey(req.method ?? "GET", url.pathname);
  const route = routes[key];

  const service = url.pathname.split("/")[1] || "root";
  counts[service] = (counts[service] ?? 0) + 1;

  if (!route) {
    console.warn(`No stand-in for ${key}`);
    json(res, 404, { message: `No stand-in for ${key}` });
    return;
  }

  // Stops a stream or a delay when the backend hangs up, as a real provider would.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  Promise.resolve(route(req, res, url, abort.signal)).catch(
    (error: unknown) => {
      if (abort.signal.aborted) return;
      console.error(`${key} failed`, error);
      if (!res.headersSent) json(res, 500, { message: "Stand-in failed" });
      else res.end();
    },
  );
}).listen(PORT, () => {
  console.log(`Paid-service stand-ins listening on :${PORT}`, DELAYS);
});
