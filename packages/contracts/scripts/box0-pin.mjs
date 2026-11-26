#!/usr/bin/env node
/**
 * Box 0's pin (ticket M1-02; ADR-0017 § 10; case BC-222, plan N16): box 0 (core v1) cannot change by accident.
 *
 * The manifest (packages/contracts/test/vectors/box0-pin/box0-pin.v1.json) holds, at box 0's final mainnet candidate
 * (F97, `main` 46ea4544):
 *   - `sources`: [{ file, sha256 }] of every file that makes box 0's bytecode: every file under src/box/ (BoxSpecV1.sol and the build
 *     profiles src/box/build/mainnet/ and rehearsal/ included), the other files solc reads for them (v4-core,
 *     v4-periphery, src/libraries/; from the builds' metadata), box-spec.v1.json, add-ons.v1.json and
 *     build-profiles.v1.json (the generated files' sources); `absent`: files that must not appear (remappings.txt);
 *   - `compiler`: the compiler settings of foundry.toml's default and rehearsal profiles (solc 0.8.26, cancun, 1,000
 *     runs, via_ir false, bytecode_hash none, the remappings with `sh-box-build/`), normalised; any other key in those
 *     two profiles fails unless it is one that cannot change bytecode (`INERT_KEYS`);
 *   - `code`: sha256 of the creation and runtime code of every src/box/ contract with code, per build (default,
 *     rehearsal), in scripts/bytecode-hashes.py's format (sha256 of the lower-case hex text; immutables as zeros);
 *   - `versionCodeHash`: the factory's, per build, as the Sepolia runbook's Step 2 prints it (read by the forge test
 *     test/box-v2/freeze/Box0CodePin.t.sol, which also checks `code` against the build under test).
 *
 * Usage (from the repository root; exit 1 when the pin fails):
 *   node packages/contracts/scripts/box0-pin.mjs --check              sources, absent files, compiler settings
 *   node packages/contracts/scripts/box0-pin.mjs --check --artifacts  ... and `code` against out/ and out-rehearsal/
 *   node packages/contracts/scripts/box0-pin.mjs --write              a reviewed pin update only: rewrites `sources`,
 *       `compiler` and `code` from the tree and both clean builds; `candidate` and `versionCodeHash` are kept, so
 *       `--check` fails until the reviewer sets `candidate.pinDigest` to the digest it prints
 * `--root <dir>` checks a copy of the tree instead. Read-only but for --write. Written for Square Hole (MIT).
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoDir = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const MANIFEST = 'packages/contracts/test/vectors/box0-pin/box0-pin.v1.json';
export const CONTRACTS = 'packages/contracts';
export const FOUNDRY_TOML = 'packages/contracts/foundry.toml';
/** Every file under these folders is pinned; a file added or removed there fails. */
export const SOURCE_ROOTS = ['packages/contracts/src/box'];
/** The JSON sources of the generated BoxSpecV1.sol and build profiles (packages/box-spec/scripts/generate.mjs). */
export const SPEC_SOURCES = [
  'packages/box-spec/add-ons.v1.json',
  'packages/box-spec/box-spec.v1.json',
  'packages/box-spec/build-profiles.v1.json',
];
export const ABSENT = ['packages/contracts/remappings.txt'];
/** The two profiles box 0 is built with (F78): the mainnet build and the rehearsal build. */
export const PROFILES = { default: { table: 'profile.default', out: 'out' }, rehearsal: { table: 'profile.rehearsal', out: 'out-rehearsal' } };
/** Keys of those profiles whose values are pinned (each can change what solc reads or emits). */
export const PINNED_KEYS = [
  'additional_compiler_profiles', 'auto_detect_remappings', 'auto_detect_solc', 'bytecode_hash',
  'compilation_restrictions', 'evm_version', 'libs', 'optimizer', 'optimizer_runs', 'remappings', 'solc', 'src', 'via_ir',
];
/** Keys that cannot change any bytecode: free to change. Any key in neither list fails the pin. */
export const INERT_KEYS = ['cache_path', 'dynamic_test_linking', 'ffi', 'fs_permissions', 'ignored_error_codes', 'out', 'test'];
/** Sub-tables of those profiles that configure tests and tools only. */
export const INERT_SUBTABLES = ['doc', 'fmt', 'fuzz', 'invariant', 'lint'];
/** Foundry's top-level sections that are not profiles and configure tools only. Forge reads any other top-level
 * table as a deprecated spelling of `[profile.<name>]` (`[default]` for every profile; a warning only, forge 1.8.3), so
 * every other one fails, `dependencies` and `soldeer` too (they install libraries and write remappings). */
export const STANDALONE_SECTIONS = ['bind_json', 'doc', 'etherscan', 'fmt', 'fuzz', 'invariant', 'labels', 'lint', 'rpc_endpoints', 'vyper'];

const BOX_PREFIX = 'src/box/';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// ------------------------------------------------------------------------------------------------- foundry.toml

/** `line` without its comment (a `#` outside a string). */
function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; ++i) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') ++i;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** Brackets and braces still open in `text`, and its form with whitespace, digit separators and trailing commas
 * outside strings removed (two spellings of one TOML value normalise to one text). */
function scan(text) {
  let quote = '';
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; ++i) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\' && quote === '"') out += text[++i] ?? '';
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') ++depth;
    else if (c === ']' || c === '}') --depth;
    else if (/\s/.test(c)) continue;
    else if (c === '_' && /\d/.test(out.at(-1) ?? '') && /\d/.test(text[i + 1] ?? '')) continue;
    out += c;
  }
  return { depth, value: out.replace(/,([\]}])/g, '$1') };
}

/** The tables of a TOML file as { table: { key: normalised value } } (the subset foundry.toml uses; anything else
 * throws, so the pin fails closed). */
export function parseToml(text) {
  const tables = { '': {} };
  let table = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; ++i) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    if (line.includes('"""') || line.includes("'''") || line.startsWith('[[')) {
      throw new Error(`foundry.toml:${i + 1}: multi-line strings and arrays of tables are not read by the pin`);
    }
    const header = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line);
    if (header) {
      table = header[1];
      if (tables[table]) throw new Error(`foundry.toml:${i + 1}: table [${table}] twice`);
      tables[table] = {};
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*=(.*)$/.exec(line);
    if (!m) throw new Error(`foundry.toml:${i + 1}: not a "key = value" line`);
    let raw = m[2];
    while (scan(raw).depth > 0) {
      if (++i >= lines.length) throw new Error(`foundry.toml: the value of ${m[1]} never closes`);
      raw += `\n${stripComment(lines[i])}`;
    }
    if (m[1] in tables[table]) throw new Error(`foundry.toml:${i + 1}: ${m[1]} twice in [${table}]`);
    tables[table][m[1]] = scan(raw).value;
  }
  return tables;
}

/** The pinned settings of each profile: { 'profile.default': { key: value }, ... }, and the problems found reading
 * them (keys and sub-tables that are neither pinned nor inert; keys outside a table; tables that are neither
 * `[profile.<name>...]` nor a standalone section). */
export function compilerSettings(text) {
  const tables = parseToml(text);
  const settings = {};
  const problems = Object.keys(tables['']).map((key) => `compiler: ${key} is set outside any table`);
  for (const [name, keys] of Object.entries(tables)) {
    const [head, profile] = name.split('.');
    if (name && (head === 'profile' ? !profile && Object.keys(keys).length : !STANDALONE_SECTIONS.includes(head))) {
      problems.push(`compiler: [${name}] is neither a [profile.<name>] table nor a section the pin knows to leave box 0's bytecode alone`);
    }
  }
  for (const { table } of Object.values(PROFILES)) {
    const keys = tables[table];
    if (!keys) {
      problems.push(`compiler: [${table}] is missing from foundry.toml`);
      continue;
    }
    settings[table] = {};
    for (const [key, value] of Object.entries(keys)) {
      if (PINNED_KEYS.includes(key)) settings[table][key] = value;
      else if (!INERT_KEYS.includes(key)) problems.push(`compiler: [${table}] ${key} is not a setting the pin knows to leave box 0's bytecode alone`);
    }
    for (const name of Object.keys(tables)) {
      if (name.startsWith(`${table}.`) && !INERT_SUBTABLES.includes(name.slice(table.length + 1))) {
        problems.push(`compiler: [${name}] may change box 0's bytecode`);
      }
    }
  }
  return { settings, problems };
}

// ------------------------------------------------------------------------------------------------- sources and code

/** Every file under `dir` (repository paths, sorted). */
export function listFiles(root, dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(join(root, d))) {
      const p = `${d}/${name}`;
      if (statSync(join(root, p)).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(join(root, dir))) walk(dir);
  return out.sort();
}

/** sha256 of the lower-case hex text of a bytecode object (scripts/bytecode-hashes.py), '' for none. */
const codeHash = (hex) => {
  const code = (hex ?? '').replace(/^0x/, '').toLowerCase();
  return code ? sha256(code) : '';
};

/** The artifacts of an `out` folder whose compilation target is under src/box/, contracts with code only, sorted:
 * [{ artifact, creation, runtime, runtimeBytes, sources }] (`sources`: every file solc read for it, from its metadata). */
export function boxArtifacts(outDir) {
  const rows = [];
  for (const file of listFiles(outDir, '.')) {
    if (!file.endsWith('.json') || file.includes('/build-info/')) continue;
    const art = JSON.parse(readFileSync(join(outDir, file), 'utf8'));
    const target = art.metadata?.settings?.compilationTarget ?? {};
    for (const [source, contract] of Object.entries(target)) {
      if (!source.startsWith(BOX_PREFIX)) continue;
      const runtime = codeHash(art.deployedBytecode?.object);
      if (!runtime && !codeHash(art.bytecode?.object)) continue;
      rows.push({
        artifact: `${source}:${contract}`,
        creation: codeHash(art.bytecode?.object),
        runtime,
        runtimeBytes: (art.deployedBytecode?.object ?? '').replace(/^0x/, '').length / 2,
        sources: Object.keys(art.metadata?.sources ?? {}),
      });
    }
  }
  return rows.sort((a, b) => (a.artifact < b.artifact ? -1 : 1));
}

/** `pinned` (manifest.code[build]) against the artifacts of `outDir`: one message per difference. */
export function checkCode(pinned, outDir, build) {
  if (!existsSync(outDir)) return [`code: ${build}: no build at ${outDir} (forge build first)`];
  const built = new Map(boxArtifacts(outDir).map((r) => [r.artifact, r]));
  const problems = [];
  for (const pin of pinned) {
    const now = built.get(pin.artifact);
    if (!now) problems.push(`code: ${build}: ${pin.artifact} is not in the build`);
    else {
      for (const k of ['creation', 'runtime', 'runtimeBytes']) {
        if (now[k] !== pin[k]) problems.push(`code: ${build}: ${pin.artifact} ${k} ${now[k]}, pinned ${pin[k]}`);
      }
    }
    built.delete(pin.artifact);
  }
  for (const extra of built.keys()) problems.push(`code: ${build}: ${extra} has code and no pin`);
  return problems;
}

/** sha256 of the manifest's tree half (`sources`, `absent`, `compiler`), which `candidate.pinDigest` holds: `--write`
 * keeps `candidate`, so a rewrite after an unreviewed edit fails until a reviewer sets the new digest. */
export function pinDigest(manifest) {
  const profiles = Object.entries(manifest.compiler.profiles).map(([t, keys]) => [t, Object.entries(keys).sort()]);
  return sha256(JSON.stringify([manifest.sources.map((s) => [s.file, s.sha256]), manifest.absent, manifest.compiler.file, profiles]));
}

/** Every rule of the pin but `code` (no build needed), on the tree at `root`. */
export function checkTree(manifest, root = repoDir) {
  const digest = pinDigest(manifest);
  const problems = manifest.candidate?.pinDigest === digest ? [] : [`manifest: sources, absent or compiler differ from candidate.pinDigest (${digest}; a reviewed pin update sets it)`];
  const pinned = new Set(manifest.sources.map((s) => s.file));
  for (const { file, sha256: want } of manifest.sources) {
    if (!existsSync(join(root, file))) problems.push(`source: ${file} is missing (submodules not initialised?)`);
    else if (sha256(readFileSync(join(root, file))) !== want) problems.push(`source: ${file} changed`);
  }
  for (const dir of SOURCE_ROOTS) {
    for (const file of listFiles(root, dir)) {
      if (!pinned.has(file)) problems.push(`source: ${file} is new under ${dir}`);
    }
  }
  for (const path of manifest.absent) {
    if (existsSync(join(root, path))) problems.push(`absent: ${path} exists`);
  }
  const { settings, problems: unknown } = compilerSettings(readFileSync(join(root, FOUNDRY_TOML), 'utf8'));
  problems.push(...unknown);
  for (const [table, want] of Object.entries(manifest.compiler.profiles)) {
    const now = settings[table] ?? {};
    for (const key of new Set([...Object.keys(want), ...Object.keys(now)])) {
      if (now[key] !== want[key]) problems.push(`compiler: [${table}] ${key} = ${now[key] ?? '(unset)'}, pinned ${want[key] ?? '(unset)'}`);
    }
  }
  return problems;
}

/** The manifest from the tree and both clean builds, keeping `previous`'s candidate and versionCodeHash. */
export function buildManifest(previous, root = repoDir) {
  const code = {};
  const closure = new Set([...SOURCE_ROOTS.flatMap((d) => listFiles(root, d)), ...SPEC_SOURCES]);
  for (const [build, { out }] of Object.entries(PROFILES)) {
    const rows = boxArtifacts(join(root, CONTRACTS, out));
    if (rows.length === 0) throw new Error(`no ${build} build in ${CONTRACTS}/${out}: run a clean forge build first`);
    for (const r of rows) for (const s of r.sources) closure.add(`${CONTRACTS}/${s}`);
    code[build] = rows.map(({ artifact, creation, runtime, runtimeBytes }) => ({ artifact, creation, runtime, runtimeBytes }));
  }
  const sources = [...closure].sort().map((file) => ({ file, sha256: sha256(readFileSync(join(root, file))) }));
  const { settings, problems } = compilerSettings(readFileSync(join(root, FOUNDRY_TOML), 'utf8'));
  if (problems.length) throw new Error(problems.join('\n'));
  return {
    ...previous,
    sources,
    absent: ABSENT,
    compiler: { file: FOUNDRY_TOML, profiles: settings },
    code,
  };
}

// ------------------------------------------------------------------------------------------------- the command

function main(argv) {
  const at = argv.indexOf('--root');
  const root = at >= 0 ? argv[at + 1] : repoDir;
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  if (argv.includes('--write')) {
    const next = buildManifest(manifest, root);
    writeFileSync(join(root, MANIFEST), `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`box0-pin: wrote ${MANIFEST}; after review set candidate.pinDigest to ${pinDigest(next)}\n`);
    return 0;
  }
  if (!argv.includes('--check')) {
    process.stderr.write('usage: box0-pin.mjs --check [--artifacts] | --write [--root <dir>]\n');
    return 2;
  }
  const problems = checkTree(manifest, root);
  if (argv.includes('--artifacts')) {
    for (const [build, { out }] of Object.entries(PROFILES)) {
      problems.push(...checkCode(manifest.code[build], join(root, CONTRACTS, out), build));
    }
  }
  if (problems.length) {
    console.error(`box0-pin: box 0's pin FAILS (${problems.length}):\n  ${problems.join('\n  ')}`);
    return 1;
  }
  const n = manifest.sources.length;
  const code = argv.includes('--artifacts') ? `, ${manifest.code.default.length} + ${manifest.code.rehearsal.length} contracts' code` : '';
  process.stdout.write(`box0-pin: box 0 is as pinned (${n} sources, 2 profiles' compiler settings${code}; ${MANIFEST})\n`);
  return 0;
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) process.exit(main(process.argv.slice(2)));
