import path from "node:path";

/**
 * A namespace module exports its functions one by one, and every caller reads
 * them through the module's name: `import * as bucket from "./bucket"`, then
 * `bucket.delete(...)`. The name says what a call touches without wrapping
 * the exports in an object, which would hide unused ones from knip.
 *
 * Types can be imported by name, since they can't call anything.
 */

function withoutTypeScriptExtension(filePath) {
  return filePath.replace(/\.[cm]?[jt]sx?$/, "");
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Import each namespace module as `import * as <name>`, under its own name.",
    },
    schema: [
      {
        type: "object",
        properties: {
          modules: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                // An absolute path without its extension, or a package specifier.
                file: { type: "string" },
                specifier: { type: "string" },
                name: { type: "string" },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        required: ["modules"],
        additionalProperties: false,
      },
    ],
    messages: {
      namedImport:
        "Import {{name}} as a namespace, `import * as {{name}} from …`, and call {{name}}.<export>() so the call says what it touches.",
      wrongName:
        "Name this namespace {{name}}, as every other caller does, so the calls read the same everywhere.",
      wrapped:
        "Export {{name}}'s functions one by one instead of wrapping them in an object; callers import it as `import * as {{name}}`.",
    },
  },

  create(context) {
    const [{ modules }] = context.options;
    const importerPath = withoutTypeScriptExtension(context.filename);
    const byFile = new Map(
      modules
        .filter((module) => module.file)
        .map((module) => [path.resolve(module.file), module.name]),
    );
    const bySpecifier = new Map(
      modules
        .filter((module) => module.specifier)
        .map((module) => [module.specifier, module.name]),
    );

    /** The namespace name the import source refers to, if it is one. */
    function namespaceOf(sourceNode) {
      const source = sourceNode?.value;
      if (typeof source !== "string") return undefined;
      if (bySpecifier.has(source)) return bySpecifier.get(source);
      if (!source.startsWith(".")) return undefined;
      const imported = withoutTypeScriptExtension(
        path.resolve(path.dirname(importerPath), source),
      );
      if (imported === importerPath) return undefined;
      return byFile.get(imported) ?? byFile.get(path.join(imported, "index"));
    }

    const ownName = byFile.get(importerPath);

    return {
      ImportDeclaration(node) {
        const name = namespaceOf(node.source);
        if (!name || node.importKind === "type") return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            if (specifier.local.name !== name) {
              context.report({
                node: specifier,
                messageId: "wrongName",
                data: { name },
              });
            }
          } else if (specifier.importKind !== "type") {
            context.report({
              node: specifier,
              messageId: "namedImport",
              data: { name },
            });
          }
        }
      },

      ExportAllDeclaration(node) {
        const name = namespaceOf(node.source);
        if (!name || node.exportKind === "type") return;
        if (node.exported?.name !== name) {
          context.report({
            node,
            messageId: node.exported ? "wrongName" : "namedImport",
            data: { name },
          });
        }
      },

      ExportNamedDeclaration(node) {
        if (node.source) {
          const name = namespaceOf(node.source);
          if (!name || node.exportKind === "type") return;
          for (const specifier of node.specifiers) {
            if (specifier.exportKind === "type") continue;
            context.report({
              node: specifier,
              messageId: "namedImport",
              data: { name },
            });
          }
          return;
        }
        // The old shape, `export const bucket = { ping, ... }`, in the module itself.
        if (!ownName || node.declaration?.type !== "VariableDeclaration")
          return;
        for (const declarator of node.declaration.declarations) {
          if (
            declarator.id.type === "Identifier" &&
            declarator.id.name === ownName &&
            declarator.init?.type === "ObjectExpression"
          ) {
            context.report({
              node: declarator,
              messageId: "wrapped",
              data: { name: ownName },
            });
          }
        }
      },
    };
  },
};
