/** Local content-addressed build results. No timestamps or git revisions stand in for input bytes. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire, isBuiltin } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize, deserialize } from 'node:v8';
import { setTimeout } from 'node:timers/promises';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const secret = path => path.split('/').some(part => part === '.env' || part.startsWith('.env.'));

/** A reader in another test process must see either the old complete asset or the new complete asset. */
export function writeCacheAsset(path, bytes) {
  if (existsSync(path) && readFileSync(path).equals(Buffer.from(bytes))) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: 'wx' });
  renameSync(temporary, path);
}

// Metadata invalidates the digest memo and detects in-process edits. Persistent identities use content hashes.
// ctime catches same-size edits even when a test restores mtime. Inventory is walked again on every call.
const fileDigests = new Map();
let observedFiles;
function fileDigest(path) {
  const stat = statSync(path, { bigint: true });
  const signature = [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(':');
  observedFiles?.set(path, signature);
  const old = fileDigests.get(path);
  if (old?.signature === signature) return old.digest;
  const value = digest(readFileSync(path));
  fileDigests.set(path, { signature, digest: value });
  return value;
}

export function hashFiles(root, paths, extra = '') {
  const hash = createHash('sha256').update(extra);
  for (const path of [...new Set(paths)].sort()) {
    if (secret(path)) continue;
    hash.update(JSON.stringify(path));
    const full = resolve(root, path);
    hash.update(existsSync(full) ? (statSync(full).isDirectory() ? hashFiles(full, packageFiles(full)) : fileDigest(full)) : 'missing');
  }
  return hash.digest('hex');
}

export const BUILDER_WORKSPACES = ['apps/web', 'packages/artwork', 'packages/box-spec', 'packages/domain', 'packages/chain', 'packages/cards'];
export const BUILDER_SOURCE_ROOTS = ['scripts/kits', 'packages/artwork/src', 'packages/box-spec/src',
  'packages/box-spec/examples/v2', 'packages/domain/src', 'packages/chain/src', 'packages/chain/scripts',
  'packages/cards/src', 'apps/web/src', 'examples/boxes'];

// These modules are never imported by settings/app or the four producers. Their file reads use
// explicit asset paths, not test discovery. Keep fixture-named runtime modules, registry JSON,
// example documents and junkyard/test-collections: names alone do not make those test-only.
// The cache regressions check each exclusion and the actual builder import graph.
export function isBuilderNonInput(path) {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) return true;
  if (BUILDER_SOURCE_ROOTS.some(root => root.endsWith('/src') && path.startsWith(`${root}/`))
    && /\/test-support(?:\/|\.[cm]?[jt]sx?$)/.test(path)) return true;
  return path === 'scripts/kits/README.md' || path.startsWith('packages/box-spec/src/m1-11/fixtures/');
}

// Inventory actual inputs, including untracked/ignored source additions. No git executable is required.
// Builders read their generated assets inside the uncached build.
export function sourceKey(root = ROOT) {
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', '.mise.toml', 'mise.toml'];
  const outputs = new Set(['node_modules', '.git', '.cache', 'build', 'dist', 'out', 'cache', 'coverage', 'test-results', '__pycache__']);
  function walk(path) {
    if (!existsSync(resolve(root, path))) { files.push(path); return; }
    for (const entry of readdirSync(resolve(root, path), { withFileTypes: true })) {
      if (secret(entry.name) || outputs.has(entry.name)) continue;
      const name = join(path, entry.name);
      if (isBuilderNonInput(name) || entry.isDirectory() && isBuilderNonInput(`${name}/`)) continue;
      if (entry.isDirectory()) walk(name);
      else if (!/\.(?:tsbuildinfo|pyc)$/.test(name)) files.push(name);
    }
  }
  for (const path of BUILDER_SOURCE_ROOTS) walk(path);
  for (const path of BUILDER_WORKSPACES) files.push(`${path}/package.json`);
  return hashFiles(root, files);
}

function packageFiles(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules' || secret(entry.name)) return [];
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? packageFiles(directory, path) : [path];
  });
}

// Fixed dependency roots, independent of which consumer imports settings first.
// These are the external imports of app.mjs, its workspace graph and the four producers.
// Include their complete optional/native closures; unrelated test imports never change the key.
export function builderDependencies(root = ROOT) {
  const roots = [
    ['packages/cards', '@resvg/resvg-js'], ['packages/chain', 'viem'], ['packages/box-spec', 'zod'],
    ['packages/artwork', '@noble/hashes'], ['packages/artwork', 'shamir-secret-sharing'],
  ].map(([workspace, name]) => {
    const require = createRequire(resolve(root, workspace, 'package.json'));
    const manifest = require.resolve.paths(name)?.map(path => join(path, name, 'package.json')).find(existsSync);
    if (!manifest) throw new Error(`Missing builder dependency ${name}`);
    return manifest;
  });
  // The unique producers try their own src/render.mjs resolution before cards. Hash both
  // closures: a present local package can fail to load and trigger the cards fallback.
  for (const kit of ['rent-free', 'bag-holders', 'link-marines-v2', 'exit-liquidity']) {
    const require = createRequire(resolve(root, 'examples/boxes', kit, 'src/render.mjs'));
    const directory = require.resolve.paths('@resvg/resvg-js')?.map(path => join(path, '@resvg/resvg-js')).find(path => existsSync(path) && statSync(path).isDirectory());
    if (directory) {
      const manifest = join(directory, 'package.json');
      if (!existsSync(manifest)) return null; // A legacy index.js has no identifiable dependency closure.
      roots.push(manifest);
    }
  }
  return [...new Set(roots)];
}

export function dependencyKey(manifests = builderDependencies()) {
  if (manifests === null) return null;
  // Include lazily loaded and platform-specific optional dependencies.
  const seen = new Map();
  function visit(manifest) {
    manifest = realpathSync(manifest);
    if (seen.has(manifest)) return;
    const directory = dirname(manifest), pkg = JSON.parse(readFileSync(manifest));
    seen.set(manifest, hashFiles(directory, packageFiles(directory)));
    const require = createRequire(manifest);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      if (name.startsWith('@squarehole/') || isBuiltin(name)) continue;
      const child = require.resolve.paths(name)?.map(path => join(path, name, 'package.json')).find(existsSync);
      if (child) visit(child);
      else if (!pkg.optionalDependencies?.[name]) throw new Error(`Missing dependency ${name} of ${manifest}`);
    }
  }
  for (const manifest of [...manifests].sort()) visit(manifest);
  return digest(JSON.stringify([...seen].sort()));
}

/** Separate pure composition so every machine/tool field has an explicit regression. */
export function inputKey({ root = ROOT, source, dependencies, versions = process.versions,
  platform = process.platform, arch = process.arch,
  libc = process.report.getReport().header.glibcVersionRuntime ?? null,
  cwebp, encoderTimeout = process.env.SH_KITS_CWEBP_TIMEOUT_MS ?? null }) {
  return digest(JSON.stringify({ schema: 3, root, source, dependencies, versions, platform, arch, libc, cwebp, encoderTimeout }));
}

// Node retains imported modules. After a source/dependency edit, run normally without reading or
// writing cache entries for the rest of this process; old loaded code must not populate a new key.
export function createLoadedSourceGuard(source, dependencies) {
  let first = source === undefined ? undefined : `${source}:${dependencies}`, changed = false;
  return (source, dependencies) => {
    const current = `${source}:${dependencies}`;
    first ??= current;
    changed ||= current !== first;
    return !changed;
  };
}

// Inspect exactly the manifests whose bytes participate in source/dependency identity, including
// transitive dependencies and nested workspace/kit manifests. Values are paths, not condition names.
function manifestConditions(paths) {
  const conditions = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) { conditions.add(name); visit(child); }
  }
  for (const path of paths) if (path.endsWith('/package.json')) {
    const pkg = JSON.parse(readFileSync(path));
    visit(pkg.exports); visit(pkg.imports);
  }
  return conditions;
}

function snapshotInputs(root, dependencies) {
  const previous = observedFiles;
  observedFiles = new Map();
  try {
    const source = sourceKey(root), deps = dependencies();
    return { source, dependencies: deps, revision: digest(JSON.stringify([...observedFiles].sort())),
      conditions: manifestConditions(observedFiles.keys()) };
  } finally { observedFiles = previous; }
}

function vitestDirectory(root) {
  const require = createRequire(resolve(root, 'package.json'));
  return dirname(realpathSync(require.resolve('vitest/package.json')));
}

// pnpm's pinned Vitest bin shim adds precisely these fallback search paths, even when
// the caller supplied no NODE_PATH. Added caller paths or other launchers remain overrides.
function vitestNodePath(root) {
  const directory = vitestDirectory(root);
  return [join(directory, 'node_modules'), dirname(directory), resolve(root, 'node_modules/.pnpm/node_modules')].join(delimiter);
}

/** Startup hooks can rewrite arbitrary imports and subprocesses. Only the pinned Vitest launcher is known. */
export function hasToolOverrides(env = process.env, execArgv = process.execArgv, { root = ROOT, conditions } = {}) {
  if (env.NODE_OPTIONS?.trim()
    || Object.entries(env).some(([key, value]) => /^(?:LD_|DYLD_)/.test(key) && value)) return true;
  try {
    if (env.NODE_PATH && env.NODE_PATH !== vitestNodePath(root)) return true;
    for (let i = 0; i < execArgv.length; i++) {
      const arg = execArgv[i];
      // This flag enables the resolver API; it does not select different module bytes.
      if (arg === '--experimental-import-meta-resolve') continue;
      if (/^(?:--require(?:=|$)|-r)/.test(arg)) {
        const target = arg === '--require' || arg === '-r' ? execArgv[++i]
          : arg.startsWith('--require=') ? arg.slice('--require='.length) : arg.slice(2);
        const hook = join(vitestDirectory(root), 'suppress-warnings.cjs');
        // The lockfile pins Vitest. An identical copy elsewhere is still an unknown startup hook.
        if (!target || realpathSync(target) !== realpathSync(hook)) return true;
        continue;
      }
      if (/^(?:--conditions(?:=|$)|-C)/.test(arg)) {
        const condition = arg === '--conditions' || arg === '-C' ? execArgv[++i]
          : arg.startsWith('--conditions=') ? arg.slice('--conditions='.length) : arg.slice(2);
        if (condition === 'node') continue; // Already active in plain Node.
        if (condition !== 'development' && condition !== 'production') return true;
        if (conditions === undefined) {
          const snapshot = snapshotInputs(root, () => dependencyKey(builderDependencies(root)));
          if (snapshot.dependencies === null) return true;
          conditions = snapshot.conditions;
        }
        if (conditions.has(condition)) return true;
        continue;
      }
      if (/^--(?:import|loader|experimental-loader|experimental-policy|policy-integrity|preserve-symlinks(?:-main)?|experimental-(?:config-file|default-config-file)|env-file(?:-if-exists)?)(?:=|$)/.test(arg)) return true;
    }
    return false;
  } catch { return true; } // An unresolvable hook or dependency closure is unidentified.
}

/** Linux ldd enumerates the resolved transitive closure, including the dynamic loader. */
export function nativeLibraryKey(executable, { platform = process.platform,
  inspect = path => spawnSync('/usr/bin/ldd', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000 }) } = {}) {
  try {
    // Script wrappers, unsupported platforms and ambiguous output must build without cache reuse.
    if (platform !== 'linux' || !readFileSync(executable).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return null;
    if (existsSync('/etc/ld.so.preload') && readFileSync('/etc/ld.so.preload', 'utf8').trim()) return null;
    const result = inspect(executable);
    if (result.error || result.status !== 0) return null;
    const paths = [];
    for (const line of result.stdout.trim().split('\n')) {
      if (/^\s*linux-vdso\.so\.\d+ \(0x[\da-f]+\)\s*$/.test(line)) continue;
      const path = /^\s*(?:\S+\s+=>\s+)?(\/[^\n]+?)\s+\(0x[\da-f]+\)\s*$/.exec(line)?.[1];
      if (!path || !existsSync(path) || !statSync(path).isFile()) return null;
      paths.push(realpathSync(path));
    }
    return paths.length ? hashFiles('/', paths) : null;
  } catch { return null; }
}

function encoderIdentity() {
  const executable = process.env.PATH?.split(':').map(path => join(path, 'cwebp')).find(path => {
    try { return statSync(path).isFile() && (statSync(path).mode & 0o111); } catch { return false; }
  });
  if (!executable) return null;
  const libraries = nativeLibraryKey(executable);
  if (libraries === null) return null;
  const encoder = spawnSync(executable, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000 });
  // Let the real builder report its normal encoder error. Never cache an unavailable/broken tool.
  if (encoder.error || encoder.status !== 0) return null;
  return [encoder.stdout, encoder.stderr, fileDigest(executable), libraries];
}

/** Capture before importing builders, not at their first build call. Metadata detects edit-and-restore too. */
export function createKitInputKey({ root = ROOT, dependencies = () => dependencyKey(builderDependencies(root)),
  encoder = encoderIdentity, env = process.env, execArgv = process.execArgv } = {}) {
  const snapshot = () => snapshotInputs(root, dependencies);
  const baseline = snapshot();
  if (baseline.dependencies === null) return () => null;
  const loadedSources = createLoadedSourceGuard(`${baseline.source}:${baseline.revision}`, baseline.dependencies);
  // Once a hook/override has been observed, clearing the environment cannot unload its code.
  // Any subsequent manifest edit makes the loaded-source guard permanently ineligible, so
  // condition eligibility can use this baseline without another inventory walk.
  const overrides = () => hasToolOverrides(env, execArgv, { root, conditions: baseline.conditions });
  let overridden = overrides();
  return () => {
    overridden ||= overrides();
    if (overridden) return null;
    const current = snapshot();
    if (!loadedSources(`${current.source}:${current.revision}`, current.dependencies)) return null;
    const cwebp = encoder();
    return cwebp === null ? null : inputKey({ root, source: current.source, dependencies: current.dependencies, cwebp });
  };
}
// settings loads its builder modules dynamically after this module has established the baseline.
export const kitInputKey = createKitInputKey();

export function createBuildCache(directory) {
  const pending = new Map();
  return async (key, build, { fresh = false, disabled = process.env.SH_KIT_CACHE === '0', isCurrent = () => true } = {}) => {
    const run = async () => {
      if (fresh || disabled) return build();
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${key}.bin`), lock = `${path}.lock`;
      const read = () => {
        if (!existsSync(path)) return undefined;
        try {
          const bytes = readFileSync(path), body = bytes.subarray(64);
          if (bytes.subarray(0, 64).toString() !== digest(body)) return undefined;
          return deserialize(body);
        } catch { return undefined; }
      };
      for (;;) {
        const hit = read();
        if (hit !== undefined) return isCurrent() ? hit : build();
        try { writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          try {
            if (Date.now() - statSync(lock).mtimeMs > 5000) {
              const pid = Number(readFileSync(lock, 'utf8'));
              try { if (!Number.isSafeInteger(pid) || pid <= 0) unlinkSync(lock); else process.kill(pid, 0); }
              catch (error) { if (error.code === 'ESRCH') unlinkSync(lock); }
            }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await setTimeout(100);
        }
      }
      try {
        const hit = read();
        if (hit !== undefined) return isCurrent() ? hit : await build();
        const result = await build(), bytes = serialize(result);
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, Buffer.concat([Buffer.from(digest(bytes)), bytes]));
        // Validate after serialization and the temporary write, immediately before publication.
        // Hits validate once after reading; waiting and lock acquisition need no extra inventory.
        if (!isCurrent()) { unlinkSync(temp); return result; }
        renameSync(temp, path);
        return result;
      } finally { unlinkSync(lock); }
    };
    if (!fresh && !disabled && pending.has(key)) {
      const result = deserialize(await pending.get(key));
      return isCurrent() ? result : build();
    }
    // Never retain failures. Fresh/disabled calls also bypass in-flight work. Clone every successful result.
    const next = run().then(serialize);
    if (!fresh && !disabled) pending.set(key, next);
    try { return deserialize(await next); }
    finally { if (pending.get(key) === next) pending.delete(key); }
  };
}
