import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import namespaceImport from "../../eslint-rules/namespaceImport.mjs";
import helperImportOwner from "./eslint-rules/helperImportOwner.js";
import publicModuleEntry from "./eslint-rules/publicModuleEntry.js";

const messageQueueDirectory = fileURLToPath(
  new URL("./core/message-queue", import.meta.url),
);

const local = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/**
 * The modules callers read through their name: `import * as files`, then
 * `files.delete()`. An index stands for its whole folder: `data.jobs.…`.
 */
const namespaceModules = [
  { file: local("core/data/index"), name: "data" },
  ...readdirSync(local("core/data"))
    .filter((file) => file.endsWith(".data.ts"))
    .map((file) => ({
      file: local(`core/data/${file.slice(0, -3)}`),
      name: file.slice(0, -".data.ts".length),
    })),
  { file: local("core/files"), name: "files" },
  { file: local("core/message-queue/messageQueue"), name: "mq" },
  { file: local("api/src/memory/index"), name: "memory" },
  { file: local("api/src/ytDlp"), name: "ytDlp" },
  {
    specifier: "@parley/server-kit/transcription/jobCancellation",
    name: "jobCancellation",
  },
];

/**
 * Deliberately narrow: this lints module boundaries only, and does not extend
 * the recommended rulesets. Adding those is a separate decision.
 */
const dbClientRestriction = {
  patterns: [
    {
      group: ["**/core/db"],
      importNames: ["db"],
      message:
        "Table access belongs in a *.data.ts module — import a function from one instead of the db client. Schema imports (tables, enums) and migrateDb/closeDb are fine.",
    },
    {
      group: ["**/data/*.data"],
      message:
        "Import * as data from core/data and call data.<table>.<operation>(), so the call reads as a database operation.",
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
          directory: messageQueueDirectory,
          entry: "messageQueue",
        },
      ],
    },
  },
  {
    // Data modules are where table access lives.
    files: ["core/**/*.data.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["**/*.data.ts"],
    ignores: ["core/**/*.data.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program",
          message: "Data modules must live under core/.",
        },
      ],
    },
  },
]);
