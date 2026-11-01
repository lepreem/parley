import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { fileURLToPath } from "node:url";
import helperImportOwner from "./eslint-rules/helperImportOwner.js";
import publicModuleEntry from "./eslint-rules/publicModuleEntry.js";

const srcDirectory = (name) =>
  fileURLToPath(new URL(`./src/${name}`, import.meta.url));

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
        "Import { data } from src/data and call data.<table>.<operation>(), so the call reads as a database operation.",
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
      // A module that does I/O is one namespace object (`mq`, `bucket`,
      // `cache`, `chat`…) behind one entry file; nothing outside reaches past it.
      "local/public-module-entry": [
        "error",
        {
          modules: [
            {
              directory: srcDirectory("message-queue"),
              entry: "messageQueue",
            },
            { directory: srcDirectory("storage"), entry: "index" },
            { directory: srcDirectory("cache"), entry: "index" },
            { directory: srcDirectory("ai"), entry: "index" },
            // Each client's catalog rules are its own: what to offer is
            // decided in one place, next to the fetch.
            {
              directory: srcDirectory("ai/ai_chat_client"),
              entry: "ai_chat_client",
            },
            {
              directory: srcDirectory("ai/ai_transcribe_client"),
              entry: "ai_transcribe_client",
            },
          ],
        },
      ],
    },
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
