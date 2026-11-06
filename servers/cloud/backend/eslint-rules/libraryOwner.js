import path from "node:path";

function isInsideDirectory(filePath, directory) {
  const relativePath = path.relative(directory, filePath);

  return (
    relativePath !== "" &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".." &&
    !path.isAbsolute(relativePath)
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "A library that talks to one technology may only be imported by the folder that owns that technology.",
    },
    schema: [
      {
        type: "object",
        properties: {
          libraries: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                owners: { type: "array", items: { type: "string" } },
                use: { type: "string" },
              },
              required: ["name", "owners", "use"],
              additionalProperties: false,
            },
          },
        },
        required: ["libraries"],
        additionalProperties: false,
      },
    ],
    messages: {
      notOwner: "{{library}} stays behind one interface: use {{use}} instead.",
    },
  },

  create(context) {
    const [options] = context.options;
    const libraries = options.libraries.filter(
      ({ owners }) =>
        !owners.some((owner) => isInsideDirectory(context.filename, owner)),
    );

    if (libraries.length === 0) return {};

    function checkImportSource(sourceNode) {
      if (!sourceNode || typeof sourceNode.value !== "string") return;

      const library = libraries.find(
        ({ name }) =>
          sourceNode.value === name || sourceNode.value.startsWith(`${name}/`),
      );
      if (!library) return;

      context.report({
        node: sourceNode,
        messageId: "notOwner",
        data: { library: library.name, use: library.use },
      });
    }

    return {
      ImportDeclaration: (node) => checkImportSource(node.source),
      ImportExpression: (node) => checkImportSource(node.source),
      ExportNamedDeclaration: (node) => checkImportSource(node.source),
      ExportAllDeclaration: (node) => checkImportSource(node.source),
    };
  },
};
