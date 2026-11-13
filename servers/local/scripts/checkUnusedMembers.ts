/**
 * Lists members of exported object literals that nothing reads, then exits 1
 * if there are any. knip covers unused files and exports, including those of
 * namespace modules like `data.messages`, but not the members of a constant
 * object like `FORM_KEYS.<field>`. A member read only by tests counts as used. An object
 * used as a whole, like `POLICIES[name]` or `Object.values(KINDS)`, may read
 * any member, so it is skipped.
 */
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const config = ts.getParsedCommandLineOfConfigFile(
  "tsconfig.json",
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
);
if (!config) throw new Error("Could not read tsconfig.json");

const files = new Set(config.fileNames);
const service = ts.createLanguageService({
  getScriptFileNames: () => config.fileNames,
  getScriptVersion: () => "1",
  getScriptSnapshot: (file) => {
    const text = ts.sys.readFile(file);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => root,
  getCompilationSettings: () => config.options,
  getDefaultLibFileName: ts.getDefaultLibFilePath,
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
});
const program = service.getProgram();
if (!program) throw new Error("Could not build the program");
const checker = program.getTypeChecker();

const relative = (file: string) => path.relative(root, file);
const isTest = (file: string) => relative(file).startsWith("test/");

/** `x as const`, `x satisfies T` and `(x)` down to `x`. */
function unwrap(node: ts.Expression | undefined) {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

/** Whether anything reads the member through its object. */
function isRead(file: string, name: ts.PropertyName) {
  const groups =
    service.findReferences(file, name.getStart(name.getSourceFile())) ?? [];
  // A shorthand property refers to both the local and the property; only
  // accesses through the object count.
  return groups.some(
    (group) =>
      (group.definition.kind === ts.ScriptElementKind.memberVariableElement ||
        group.definition.kind === ts.ScriptElementKind.memberFunctionElement) &&
      group.references.some((reference) => !reference.isDefinition),
  );
}

/** Whether every use of the object names its members, as `x.member` does. */
function isReadByName(file: string, name: ts.Node) {
  const groups =
    service.findReferences(file, name.getStart(name.getSourceFile())) ?? [];
  return groups.every((group) =>
    group.references.every((reference) => {
      if (reference.isDefinition) return true;
      const sourceFile = program!.getSourceFile(reference.fileName);
      if (!sourceFile) return false;
      const token = getTokenAt(sourceFile, reference.textSpan.start);
      const parent = token?.parent;
      if (!parent) return false;
      if (ts.isPropertyAccessExpression(parent))
        return parent.expression === token;
      // `typeof data.jobs` in a type.
      if (ts.isQualifiedName(parent)) return parent.left === token;
      if (ts.isElementAccessExpression(parent)) {
        return ts.isStringLiteralLike(parent.argumentExpression);
      }
      // Imports, re-exports, `typeof x` and grouping into another object
      // (`data = { messages }`) all keep member reads traceable.
      return (
        ts.isImportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isTypeQueryNode(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isPropertyAssignment(parent)
      );
    }),
  );
}

/** The innermost node covering `position`. */
function getTokenAt(node: ts.Node, position: number): ts.Node | undefined {
  for (const child of node.getChildren()) {
    if (child.getStart() <= position && position < child.getEnd()) {
      return getTokenAt(child, position) ?? child;
    }
  }
  return undefined;
}

const unused: string[] = [];
for (const sourceFile of program.getSourceFiles()) {
  const file = sourceFile.fileName;
  if (!files.has(file) || isTest(file)) continue;
  const module = checker.getSymbolAtLocation(sourceFile);
  if (!module) continue;
  for (const exported of checker.getExportsOfModule(module)) {
    const declaration = exported.declarations?.[0];
    if (!declaration || declaration.getSourceFile() !== sourceFile) continue;
    if (!ts.isVariableDeclaration(declaration)) continue;
    const object = unwrap(declaration.initializer);
    if (!object || !ts.isObjectLiteralExpression(object)) continue;
    if (!isReadByName(file, declaration.name)) continue;
    for (const property of object.properties) {
      if (!property.name || isRead(file, property.name)) continue;
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        property.name.getStart(sourceFile),
      );
      unused.push(
        `${relative(file)}:${line + 1} ${exported.name}.${property.name.getText(sourceFile)}`,
      );
    }
  }
}

if (unused.length > 0) {
  console.error(`Unused members (${unused.length})`);
  console.error(unused.sort().join("\n"));
  process.exitCode = 1;
}
