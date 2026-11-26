import { posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// A deliberately local rule: a recursive mkdir must precede the allocation in the same
// block (or an enclosing block). A mkdir in another test/branch/helper cannot satisfy it.
export function unguardedTempCalls(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const bindings = new Map(), aliases = new Map(), calls = [];
  const scopeOf = node => {
    while (node && !ts.isBlock(node) && !ts.isSourceFile(node)) node = node.parent;
    return node;
  };
  function collect(node) {
    if (ts.isImportSpecifier(node)) aliases.set(node.name.text, node.propertyName?.text ?? node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const scope = scopeOf(node);
      if (!bindings.has(scope)) bindings.set(scope, new Map());
      bindings.get(scope).set(node.name.text, node.initializer);
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  }
  collect(ast);
  const nameOf = node => ts.isIdentifier(node) ? aliases.get(node.text) ?? node.text
    : ts.isPropertyAccessExpression(node) ? node.name.text : '';
  function value(node, seen = new Set()) {
    if (!node || seen.has(node)) return undefined;
    const next = new Set([...seen, node]);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (node.getText(ast) === 'import.meta.url' || node.getText(ast) === 'import.meta.dirname') {
      return node.getText(ast).endsWith('dirname') ? posix.dirname(resolve(filename)) : resolve(filename);
    }
    if (ts.isIdentifier(node)) {
      for (let scope = scopeOf(node); scope; scope = scopeOf(scope.parent)) {
        const binding = bindings.get(scope)?.get(node.text);
        if (binding) return value(binding, next);
      }
      return `@${node.text}@`;
    }
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span =>
      `${value(span.expression, next) ?? '@expression@'}${span.literal.text}`).join('');
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return `${value(node.left, next) ?? ''}${value(node.right, next) ?? ''}`;
    }
    if (ts.isParenthesizedExpression(node)) return value(node.expression, next);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'pathname') return value(node.expression, next);
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'URL') {
      const [path, base] = (node.arguments ?? []).map(arg => value(arg, next));
      if (path !== undefined && base !== undefined) return fileURLToPath(new URL(path, pathToFileURL(base)));
    }
    if (ts.isCallExpression(node)) {
      const args = node.arguments.map(arg => value(arg, next));
      if (args.some(arg => arg === undefined)) return undefined;
      switch (nameOf(node.expression)) {
        case 'join': return posix.join(...args);
        case 'resolve': return resolve(...args);
        case 'dirname': return posix.dirname(args[0]);
        case 'fileURLToPath': return args[0];
      }
    }
    return undefined;
  }
  const recursive = call => call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1])
    && call.arguments[1].properties.some(prop => ts.isPropertyAssignment(prop)
      && prop.name.getText(ast).replace(/['"]/g, '') === 'recursive' && prop.initializer.kind === ts.SyntaxKind.TrueKeyword);
  const mkdirs = calls.filter(call => nameOf(call.expression) === 'mkdirSync' && recursive(call)
    && ts.isExpressionStatement(call.parent) && (ts.isBlock(call.parent.parent) || ts.isSourceFile(call.parent.parent)));
  const failures = [];
  for (const call of calls.filter(call => nameOf(call.expression) === 'mkdtempSync')) {
    const prefix = value(call.arguments[0]);
    if (!prefix?.includes('.cache/tmp')) continue;
    const parent = posix.dirname(resolve(prefix));
    const guarded = mkdirs.some(mkdir => {
      const directory = value(mkdir.arguments[0]);
      if (directory === undefined || resolve(directory) !== parent) return false;
      // Walk only blocks containing the allocation; sibling callbacks and conditional bodies do not count.
      for (let child = call; child.parent; child = child.parent) {
        if (child.parent === mkdir.parent.parent && mkdir.end <= child.getStart(ast)) return true;
      }
      return false;
    });
    if (!guarded) failures.push(`${filename}:${ast.getLineAndCharacterOfPosition(call.getStart(ast)).line + 1}: mkdirSync(${JSON.stringify(parent)}, { recursive: true }) required before mkdtempSync`);
  }
  return failures;
}
