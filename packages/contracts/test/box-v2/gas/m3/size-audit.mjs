// Fresh production artifacts only. Run after the source-scoped --sizes command in SH-V2-M3-60.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const artifacts = process.argv[2];
assert.ok(artifacts, 'pass the production-only artifact directory');
const manifest = JSON.parse(readFileSync(new URL('../../../../size-budget.v2.json', import.meta.url), 'utf8'));
const gateCount = Object.keys(manifest.gates).length;
assert.ok(gateCount > 0, 'manifest must list release gates');
assert.equal(manifest.limitBytes, 24576);
assert.equal(manifest.minReserveBytes, 2458);
assert.deepEqual(manifest.m2PlannedGates, {});
function inspect(path) {
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  const settings = metadata.settings;
  assert.match(metadata.compiler.version, /^0\.8\.26\+/);
  assert.equal(settings.evmVersion, 'cancun');
  assert.deepEqual(settings.optimizer, { enabled: true, runs: 1000 });
  assert.equal(settings.viaIR ?? false, false);
  assert.equal(settings.metadata.bytecodeHash, 'none');
  const bytes = artifact.deployedBytecode.object.replace(/^0x/, '').length / 2;
  return { bytes, target: settings.compilationTarget };
}
for (const [name, gate] of Object.entries(manifest.gates)) {
  const { bytes, target } = inspect(resolve(artifacts, basename(gate.source), `${name}.json`));
  assert.deepEqual(target, { [gate.source]: name });
  assert.equal(gate.reserveBytes, 2458);
  assert.equal(gate.m1GateBytes, 22118);
  assert.ok(bytes > 0 && bytes <= gate.m1GateBytes, `${name}: ${bytes}`);
  if (name === 'BoxReceiverV2') assert.ok(bytes <= gate.roomGateBytes, 'v2.1 receiver room');
  process.stdout.write(`${name}: ${bytes} B; room ${gate.m1GateBytes - bytes} B\n`);
}
// Also check every emitted v2 runtime, so unlisted helpers cannot silently evade the size gate.
let runtimes = 0;
for (const dir of readdirSync(artifacts, { withFileTypes: true })) {
  if (!dir.isDirectory() || !dir.name.endsWith('.sol')) continue;
  for (const file of readdirSync(resolve(artifacts, dir.name))) {
    if (!file.endsWith('.json')) continue;
    const path = resolve(artifacts, dir.name, file);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const metadata = typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : raw.metadata;
    if (!metadata || !Object.keys(metadata.settings.compilationTarget).every(p => p.startsWith('src/box-v2/'))) continue;
    const { bytes } = inspect(path);
    if (bytes === 0) continue;
    assert.ok(bytes <= 22118, `${file}: ${bytes}`);
    ++runtimes;
  }
}
assert.ok(runtimes >= gateCount, 'must inspect the complete release');
process.stdout.write(`${gateCount} manifest gates and ${runtimes} emitted v2 runtimes passed\n`);
