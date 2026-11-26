/** SH-SNIFF-HANDLERS: repeat the SH-ACCEPT-C2PA corpus check against the supplied base, never local main. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const base = process.argv[2] ?? '86c7543dedeec209a7a500c3ca7e3a7977da061a';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64')}`;
async function loadInspector(read) {
  const limits = moduleUrl(read('packages/artwork/src/limits.ts'));
  const source = read('packages/artwork/src/sniff.ts').replace("'./limits'", JSON.stringify(limits));
  return (await import(moduleUrl(source))).inspectImage;
}
const before = await loadInspector((path) => git('show', `${base}:${path}`));
const after = await loadInspector((path) => readFileSync(path, 'utf8'));
const paths = git('ls-files', '-z').split('\0').filter((path) => /\.(png|jpe?g|webp)$/i.test(path));
const limits = { maxBytes: 10 * 1024 * 1024, minSide: 1, maxSide: 8192 };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const counts = { before: {}, after: {} };
const changes = [];
const stores = [];

// The SH-ACCEPT-C2PA tracked stores are all PNG caBX. Check chunk framing, not a substring in pixel data.
function hasPngStore(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let pos = 8; pos + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(pos);
    assert(pos + 12 + length <= bytes.length);
    if (bytes.toString('ascii', pos + 4, pos + 8) === 'caBX') return true;
    pos += 12 + length;
  }
  return false;
}
for (const path of paths) {
  const bytes = readFileSync(path);
  const snapshot = Buffer.from(bytes);
  const hash = sha256(bytes);
  const oldResult = before(bytes, limits);
  assert(bytes.equals(snapshot), `base mutated ${path}`);
  assert.equal(sha256(bytes), hash, `base hash changed: ${path}`);
  const newResult = after(bytes, limits);
  assert(bytes.equals(snapshot), `candidate mutated ${path}`);
  assert.equal(sha256(bytes), hash, `candidate hash changed: ${path}`);
  for (const [key, result] of [['before', oldResult], ['after', newResult]]) {
    const outcome = result.ok ? 'accepted' : result.code;
    counts[key][outcome] = (counts[key][outcome] ?? 0) + 1;
  }
  if (JSON.stringify(oldResult) !== JSON.stringify(newResult)) changes.push({ path, before: oldResult, after: newResult });
  if (hasPngStore(bytes)) stores.push({ path, accepted: newResult.ok, sha256: hash });
}
process.stdout.write(`${JSON.stringify({ base, pictures: paths.length, limits, counts, changes, stores, inputsUnchanged: true }, null, 2)}\n`);
assert.equal(paths.length, 1858, 'corpus size changed; review the file list');
assert.equal(stores.length, 52, 'store corpus size changed; review the file list');
assert(stores.every((store) => store.accepted), 'a tracked C2PA picture was refused');
assert.equal(changes.length, 0, 'tracked outcomes changed: stop and list under Integrator requests');
