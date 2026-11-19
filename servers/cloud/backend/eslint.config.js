import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import namespaceImport from "../../../eslint-rules/namespaceImport.mjs";
import helperImportOwner from "./eslint-rules/helperImportOwner.js";
import libraryOwner from "./eslint-rules/libraryOwner.js";
import publicModuleEntry from "./eslint-rules/publicModuleEntry.js";

const srcDirectory = (name) =>
  fileURLToPath(new URL(`./src/${name}`, import.meta.url));

/** Each module in a folder, named for its file: data/jobs.data.ts is `jobs`. */
const modulesIn = (folder, suffix) =>
  readdirSync(srcDirectory(folder))
    .filter((file) => file.endsWith(suffix) && file !== "index.ts")
    .map((file) => ({
      file: srcDirectory(`${folder}/${file.slice(0, -3)}`),
      name: file.slice(0, -suffix.length),
    }));

/**
 * The modules callers read through their name: `import * as bucket`, then
 * `bucket.delete()`. An index stands for its whole folder: `data.jobs.…`.
 */
const namespaceModules = [
  { file: srcDirectory("ai/chat/index"), name: "chat" },
  { file: srcDirectory("ai/transcription/index"), name: "transcription" },
  { file: srcDirectory("auth/index"), name: "auth" },
  { file: srcDirectory("data/index"), name: "data" },
  { file: srcDirectory("guest/index"), name: "guest" },
  ...modulesIn("data", ".data.ts"),
  { file: srcDirectory("memory/index"), name: "memory" },
  ...modulesIn("memory", ".ts"),
  { file: srcDirectory("message-queue/index"), name: "mq" },
  { file: srcDirectory("recurring/index"), name: "recurring" },
  { file: srcDirectory("recurring/guestSweep"), name: "guestSweep" },
  { file: srcDirectory("recurring/storageSweep"), name: "storageSweep" },
  { file: srcDirectory("storage/bucket"), name: "bucket" },
  { file: srcDirectory("storage/sign"), name: "sign" },
  { file: srcDirectory("youtubeCaptions/index"), name: "youtubeCaptions" },
  {
    file: srcDirectory("transcription/audioTranscription"),
    name: "audioTranscription",
  },
  { file: srcDirectory("uploads/uploads"), name: "uploads" },
  {
    specifier: "@parley/server-kit/transcription/jobCancellation",
    name: "jobCancellation",
  },
];

/**
 * The folders only their entry file is imported from: `import * as mq from
 * "../message-queue"`, never a file inside. A module that does I/O is one
 * namespace (`mq`, `bucket`, `memory`, `chat`…) behind one entry file.
 */
const entryModules = [
  { directory: srcDirectory("message-queue"), entry: "index" },
  { directory: srcDirectory("storage"), entry: "index" },
  { directory: srcDirectory("memory"), entry: "index" },
  { directory: srcDirectory("recurring"), entry: "index" },
  // chat and transcription don't import each other.
  {
    directory: srcDirectory("ai"),
    entry: "index",
    separateFiles: true,
  },
  { directory: srcDirectory("youtubeCaptions"), entry: "index" },
  { directory: srcDirectory("auth"), entry: "index" },
  { directory: srcDirectory("data"), entry: "index" },
  { directory: srcDirectory("db"), entry: "index" },
  // Everything only guests have; outside it a guest is just a tier.
  { directory: srcDirectory("guest"), entry: "index" },
  // Each client's catalog rules are its own: what to offer is
  // decided in one place, next to the fetch. The files beside the
  // index don't import each other: the index puts them together.
  {
    directory: srcDirectory("ai/chat"),
    entry: "index",
    separateFiles: true,
  },
  {
    directory: srcDirectory("ai/transcription"),
    entry: "index",
    separateFiles: true,
  },
];

/** The folder named for a technology is the only one that imports it. */
const libraries = [
  {
    name: "drizzle-orm",
    owners: [srcDirectory("data"), srcDirectory("db")],
    use: "data.<table>.<operation>() from src/data",
  },
  {
    name: "postgres",
    owners: [srcDirectory("db")],
    use: "data.<table>.<operation>() from src/data",
  },
  {
    name: "@supabase/supabase-js",
    owners: [srcDirectory("storage")],
    use: "bucket or sign from src/storage",
  },
  {
    name: "amqplib",
    owners: [srcDirectory("message-queue")],
    use: "mq from src/message-queue",
  },
  {
    name: "@openrouter/sdk",
    owners: [srcDirectory("ai")],
    use: "chat from src/ai",
  },
  {
    name: "@deepgram/sdk",
    owners: [srcDirectory("ai")],
    use: "transcription from src/ai",
  },
  {
    name: "@supadata/js",
    owners: [srcDirectory("youtubeCaptions")],
    use: "youtubeCaptions from src/youtubeCaptions",
  },
  {
    name: "@workos-inc/node",
    owners: [srcDirectory("auth")],
    use: "auth from src/auth",
  },
  {
    name: "hono/streaming",
    owners: [],
    use: "SSEEventQueue or the event hub from @parley/server-kit/sse",
  },
  {
    name: "hono-rate-limiter",
    owners: [srcDirectory("memory"), srcDirectory("middleware")],
    use: "the limiters in src/middleware/rateLimit.middleware",
  },
];

/**
 * Owners that aren't behind an entry: the HTTP middleware, which the routes
 * import file by file.
 */
const OWNERS_WITHOUT_ENTRY = [srcDirectory("middleware")];

// A folder that owns a library keeps it behind its entry, so swapping the
// service behind it changes that folder alone.
const ownersWithoutEntry = libraries
  .flatMap(({ owners }) => owners)
  .filter(
    (owner) =>
      !OWNERS_WITHOUT_ENTRY.includes(owner) &&
      !entryModules.some(({ directory }) => directory === owner),
  );
if (ownersWithoutEntry.length > 0) {
  throw new Error(
    `These folders own a library but have no entry in entryModules: ${[...new Set(ownersWithoutEntry)].join(", ")}`,
  );
}

/**
 * State this process holds, which a second instance wouldn't share. Only the
 * shapes that give it away: a module-level container that starts empty, and a
 * MemoryStore anywhere. A `new Set([...])` lookup table is fine anywhere.
 */
const stateOutsideMemoryMessage =
  "State held in this process goes under src/memory/, so that folder stays the full list of what a second instance wouldn't share.";
const STARTS_EMPTY = [
  "NewExpression[callee.name=/^(Map|Set|WeakMap|WeakSet)$/][arguments.length=0]",
  "ArrayExpression[elements.length=0]",
  "ObjectExpression[properties.length=0]",
];
const stateOutsideMemory = [
  ...STARTS_EMPTY.flatMap((init) => [
    `Program > VariableDeclaration > VariableDeclarator > ${init}`,
    `Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ${init}`,
  ]),
  "NewExpression[callee.name='MemoryStore']",
].map((selector) => ({ selector, message: stateOutsideMemoryMessage }));

/** Work on a timer goes under src/recurring/, so that folder lists it all. */
const timersOutsideRecurring = [
  {
    selector: "CallExpression[callee.name='setInterval']",
    message:
      "Work that runs over and over goes under src/recurring/, scheduled with its every().",
  },
];

/**
 * Deliberately narrow: this lints module boundaries only, and does not extend
 * the recommended rulesets. Adding those is a separate decision.
 */
const dbClientRestriction = {
  patterns: [
    {
      group: ["**/db", "./db"],
      importNames: ["db"],
      message:
        "Table access belongs in a *.data.ts module — import a function from one instead of the db client. Schema imports (tables, enums, pingDb) are fine.",
    },
    {
      group: ["**/data/*.data"],
      message:
        "Import * as data from src/data and call data.<table>.<operation>(), so the call reads as a database operation.",
    },
  ],
};

export default defineConfig([
  globalIgnores(["node_modules", "dist", "test"]),
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: {
      local: {
        rules: {
          "helper-import-owner": helperImportOwner,
          "library-owner": libraryOwner,
          "namespace-import": namespaceImport,
          "public-module-entry": publicModuleEntry,
        },
      },
    },
    linterOptions: {
      // Migrating a file means deleting its disable comment; this is what
      // fails the ones left behind.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-restricted-imports": ["error", dbClientRestriction],
      "local/helper-import-owner": "error",
      "local/namespace-import": ["error", { modules: namespaceModules }],
      "local/public-module-entry": [
        "error",
        {
          modules: entryModules,
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "local/library-owner": [
        "error",
        {
          libraries,
        },
      ],
    },
  },
  // One block per combination, since a later block's no-restricted-syntax
  // replaces an earlier one's rather than adding to it.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/memory/**", "src/recurring/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...stateOutsideMemory,
        ...timersOutsideRecurring,
      ],
    },
  },
  {
    files: ["src/memory/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...timersOutsideRecurring] },
  },
  {
    files: ["src/recurring/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...stateOutsideMemory] },
  },
  {
    files: ["src/data/*.data.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "no-restricted-imports": "off",
      // A data module may sign URLs, which changes nothing in storage, but
      // must not touch the bucket. Types are fine: they can't call anything.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/storage"],
              importNames: ["bucket"],
              allowTypeImports: true,
              message:
                "A *.data.ts module may only use sign from storage. Do other storage work in the caller, after the database work.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.data.ts"],
    ignores: ["src/data/*.data.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program",
          message: "Data modules must live under backend/src/data.",
        },
      ],
    },
  },
]);
