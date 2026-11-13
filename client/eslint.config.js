import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";
import { fileURLToPath } from "node:url";
import namespaceImport from "../eslint-rules/namespaceImport.mjs";

/** The modules callers read through their name: `import * as audioCopies`. */
const namespaceModules = [
  {
    file: fileURLToPath(new URL("./src/media/audioCopies", import.meta.url)),
    name: "audioCopies",
  },
];

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: { local: { rules: { "namespace-import": namespaceImport } } },
    rules: {
      "local/namespace-import": ["error", { modules: namespaceModules }],
    },
  },
]);
