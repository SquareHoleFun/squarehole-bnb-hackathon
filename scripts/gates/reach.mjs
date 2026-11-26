import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync, existsSync, globSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MAP_PATH = 'scripts/gates/test-reach-map.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFile = path => /\.[cm]?[jt]sx?$/.test(path);
const secret = path => path.split('/').some(part => /^\.env(?:\.|$)/.test(part));
export const ownerOf = path => /^(?:apps|packages)\/[^/]+/.exec(path)?.[0] ?? path.split('/')[0];
export function git(args, root = ROOT) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
}
export function inventory(root = ROOT) {
  return [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).split('\0'))]
    .filter(path => path && !secret(path) && !/^(?:square-hole-core-v2|square-hole-handoff)\/|^packages\/contracts\/lib\//.test(path)
      && existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile()).sort();
}

// Every whole-tree guard in the measured ship suites, plus the source guards named by SUMMARY's warning.
export const GUARDS = [
  'apps/web/src/alpha-pages.test.ts', 'apps/web/src/build-target.test.ts', 'apps/web/src/copy-wording.test.ts',
  'apps/web/src/no-client-secret.test.ts', 'apps/web/src/no-trade-source.test.ts', 'apps/web/src/production-check.test.ts',
  'apps/web/src/features/create/launch-skill-words.test.ts', 'apps/web/src/features/legal/privacy.test.ts',
  'packages/box-spec/src/launch-skill.test.ts', 'packages/chain/src/write/audit.test.ts',
  'packages/chain/test/source-guards.test.ts', 'packages/indexer/test/client.test.ts',
  'packages/keeper/test/final-round3/allowances.test.ts', 'infra/server/test/keeper-reverts.test.mjs',
  'packages/chain/scripts/sepolia-launch-pack.test.mjs',
];

function shipNodeTests(root, scripts) {
  const seen = new Set(), files = new Set();
  function visit(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const command = scripts[name] ?? '';
    // The ship node groups are shell globs. Vitest groups are classified separately below.
    if (/\bnode\b/.test(command)) for (const match of command.matchAll(/[\w./*-]+\.test\.[cm]?[jt]s\b/g)) {
      for (const file of globSync(match[0], { cwd: root })) files.add(file);
    }
    for (const match of command.matchAll(/\bpnpm (test:[\w-]+)/g)) visit(match[1]);
  }
  visit('test:scripts');
  return files;
}

export function buildReachMap(root = ROOT, files = inventory(root)) {
  const sources = files.filter(sourceFile), inputSet = new Set(files);
  const texts = new Map(sources.map(path => [path, readFileSync(resolve(root, path), 'utf8')]));
  const manifests = files.filter(path => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path));
  const workspace = new Map(manifests.map(path => [JSON.parse(readFileSync(resolve(root, path))).name, dirname(path)]));
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'))).scripts ?? {};
  const shippedNode = shipNodeTests(root, scripts);
  const rootProjects = ['apps/web/vite.config.ts', 'apps/landing/vitest.config.mjs', ...manifests.map(path => `${dirname(path)}/vitest.config.ts`)];
  const rootPatterns = rootProjects.filter(path => existsSync(resolve(root, path))).flatMap(path => {
    const source = readFileSync(resolve(root, path), 'utf8');
    const include = /include:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    return [...include.matchAll(/['"]([^'"]+)['"]/g)].map(match => `${dirname(path)}/${match[1]}`);
  });
  const graph = new Map();
  const externalReads = new Set();
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true, resolveJsonModule: true };
  const resolutionCache = ts.createModuleResolutionCache(root, path => path, options);
  function resolveImport(from, name) {
    // Vite query suffixes select a representation of the same underlying asset.
    name = name.replace(/[?#].*$/, '');
    if (name.startsWith('.')) {
      const path = relative(root, resolve(root, dirname(from), name));
      for (const candidate of [path, ...['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'].map(ext => path + ext), path.replace(/\.js$/, '.ts')]) {
        if (inputSet.has(candidate)) return [candidate];
      }
    }
    const found = ts.resolveModuleName(name, resolve(root, from), options, ts.sys, resolutionCache).resolvedModule?.resolvedFileName;
    if (found) {
      const path = relative(root, found);
      if (inputSet.has(path)) return [path];
    }
    // Unknown workspace exports: include the entire package rather than silently dropping its edge.
    const pkg = [...workspace].find(([key]) => name === key || name.startsWith(`${key}/`));
    if (pkg) return files.filter(path => path.startsWith(`${pkg[1]}/`));
    if (name.startsWith('.') || name.startsWith('/')) externalReads.add(from);
    return [];
  }
  for (const [path, source] of texts) {
    const imports = [];
    let dynamic = false;
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    function inspect(node) {
      if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
        || (ts.isExportDeclaration(node) && !node.isTypeOnly)) {
        if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
        else dynamic = true;
      }
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
    graph.set(path, [...new Set(imports.flatMap(name => resolveImport(path, name)))]);
    // Unknown runtime paths are deliberately wildcard reach. Follow helpers as well as the test itself.
    if (imports.some(name => /^(?:node:)?(?:fs(?:\/promises)?|child_process|worker_threads|module)$/.test(name))
      || /\b(?:readFile|readFileSync|readdir|readdirSync|globSync|execFile|execFileSync|spawn|spawnSync|createRequire)\s*\(/.test(source)
      || dynamic) externalReads.add(path);
  }
  const tests = {};
  for (const path of sources.filter(path => /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/.test(path))) {
    const source = texts.get(path);
    let runner;
    if (/\.(?:spec|e2e)\.[cm]?[jt]sx?$/.test(path) && (/playwright/.test(source) || path.includes('/e2e/'))) runner = 'playwright';
    else if (shippedNode.has(path) || /['"]node:test['"]/.test(source)) runner = shippedNode.has(path) ? 'node' : 'manual-node';
    else if (rootPatterns.some(pattern => matchesGlob(path, pattern)) || /['"]vitest['"]/.test(source)) {
      runner = path.startsWith('infra/server/monitor/') ? 'infra-monitor'
        : path.startsWith('infra/server/test/') ? 'infra'
          : path.startsWith('scripts/listing/') ? 'listing'
            : rootPatterns.some(pattern => matchesGlob(path, pattern)) ? 'vitest' : 'manual-vitest';
    } else continue;
    const visited = new Set();
    function walk(file) { if (visited.has(file)) return; visited.add(file); for (const dep of graph.get(file) ?? []) walk(dep); }
    walk(path);
    const reaches = new Set();
    for (const file of visited) {
      // Preserve exact data/asset edges even inside the test's own package.
      if (!sourceFile(file)) reaches.add(file);
      if (ownerOf(file) !== ownerOf(path)) reaches.add(ownerOf(file));
      if (externalReads.has(file)) reaches.add('*');
      for (const match of texts.get(file)?.matchAll(/(?:apps|packages)\/[a-zA-Z0-9_-]+|\b(?:examples|infra|scripts|docs|skills)\//g) ?? []) reaches.add(match[0].replace(/\/$/, ''));
    }
    tests[path] = { runner, owner: ownerOf(path), reaches: [...reaches].sort() };
  }
  const imported = new Set([...graph.values()].flat());
  const inputs = files.filter(path => sourceFile(path) || imported.has(path) || /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path));
  const inputHash = digest(inputs.map(path => `${path}\0${digest(readFileSync(resolve(root, path)))}\n`).join(''));
  return { version: 1, inputHash, guards: GUARDS, tests,
    playwright: sources.filter(path => /\.(?:spec|e2e)\.[cm]?[jt]sx?$/.test(path) && (/playwright/.test(texts.get(path)) || path.includes('/e2e/'))).sort(),
    forge: files.filter(path => path.startsWith('packages/contracts/test/') && path.endsWith('.t.sol')).sort() };
}
export const mapText = map => `${JSON.stringify(map, null, 2)}\n`;
export function assertFresh(root = ROOT, current = buildReachMap(root)) {
  if (!existsSync(resolve(root, MAP_PATH)) || readFileSync(resolve(root, MAP_PATH), 'utf8') !== mapText(current)) {
    throw new Error('Test reach map is stale. Run pnpm test:reach:write and include scripts/gates/test-reach-map.json.');
  }
  return current;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const map = buildReachMap();
  if (process.argv.includes('--check')) assertFresh(ROOT, map);
  else writeFileSync(resolve(ROOT, MAP_PATH), mapText(map));
  process.stdout.write(`${Object.keys(map.tests).length} test files; reach map ${process.argv.includes('--check') ? 'fresh' : 'written'}\n`);
}
