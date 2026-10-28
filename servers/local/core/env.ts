import "dotenv/config";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseEnv } from "@parley/server-kit/runtime/parseEnv";

const nodeEnvSchema = z
  .enum(["development", "production", "test"])
  .default("development");

/** Shared by everything that reads env. Exported for its own unit test. */
export const baseEnvSchema = z.object({
  /**
   * Where the app keeps its files: the database, uploads and Whisper models.
   * ~/.parley unless set.
   */
  DATA_DIR: z.string().min(1).default(path.join(homedir(), ".parley")),
  /** The Claude Code program chat runs on; found on PATH by default. */
  CLAUDE_PATH: z.string().min(1).default("claude"),
  /** The uv program that runs transcription; found on PATH by default. */
  UV_PATH: z.string().min(1).default("uv"),
  NODE_ENV: nodeEnvSchema,
});

/** Exported for its own unit test; the API reads env through getApiEnv. */
export const apiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(3002),
  /**
   * The built client, which the API serves when it's there. Relative to the
   * working directory, like the migrations.
   */
  CLIENT_DIR: z.string().min(1).default("../../client/dist"),
  /**
   * Names the app answers to besides this machine's, comma-separated: the
   * Tailscale name `tailscale serve` puts it behind, so a phone on the same
   * tailnet can reach it. Each is trusted like localhost, so list only names
   * that lead to this app.
   */
  ALLOWED_HOSTS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    ),
  /**
   * Origins besides this machine's whose pages may call the API,
   * comma-separated: the hosted client, e.g. https://parley.example.com,
   * which reaches "This computer" from the browser. Each may read and change
   * everything here, so list only the app's own.
   */
  ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim().replace(/\/$/, "").toLowerCase())
        .filter(Boolean),
    ),
  /** The yt-dlp program that fetches YouTube videos; found on PATH by default. */
  YT_DLP_PATH: z.string().min(1).default("yt-dlp"),
});

type BaseEnv = z.infer<typeof baseEnvSchema>;
type ApiEnv = z.infer<typeof apiEnvSchema>;

let cachedBaseEnv: BaseEnv | undefined;
export function getBaseEnv(): BaseEnv {
  cachedBaseEnv ??= parseEnv(baseEnvSchema, "base");
  return cachedBaseEnv;
}

let cachedApiEnv: ApiEnv | undefined;
export function getApiEnv(): ApiEnv {
  cachedApiEnv ??= parseEnv(apiEnvSchema, "api");
  return cachedApiEnv;
}
