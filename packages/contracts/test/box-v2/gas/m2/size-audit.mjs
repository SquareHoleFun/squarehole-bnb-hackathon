// Run after the production-only forge build shown in SH-V2-M2-60. No alternate test-profile artifacts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const artifacts = process.argv[2];
assert.ok(artifacts, 'pass the production-only artifact directory');
const manifest = JSON.parse(readFileSync(new URL('../../../../size-budget.v2.json', import.meta.url), 'utf8'));
const gateCount = Object.keys(manifest.gates).length;
assert.ok(gateCount > 0, 'manifest must list release gates');
assert.deepEqual(manifest.m2PlannedGates, {});
for (const [name, gate] of Object.entries(manifest.gates)) {
  const artifact = JSON.parse(readFileSync(resolve(artifacts, basename(gate.source), `${name}.json`), 'utf8'));
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  const settings = metadata.settings;
  assert.match(metadata.compiler.version, /^0\.8\.26\+/);
  assert.equal(settings.evmVersion, 'cancun');
  assert.deepEqual(settings.optimizer, { enabled: true, runs: 1000 });
  assert.equal(settings.viaIR ?? false, false);
  assert.equal(settings.metadata.bytecodeHash, 'none');
  assert.deepEqual(settings.compilationTarget, { [gate.source]: name });
  const bytes = artifact.deployedBytecode.object.replace(/^0x/, '').length / 2;
  assert.equal(gate.reserveBytes, 2458);
  assert.equal(gate.m1GateBytes, 22118);
  assert.ok(bytes > 0 && bytes <= gate.m1GateBytes, `${name}: ${bytes}`);
  if (name === 'BoxReceiverV2') assert.ok(bytes <= gate.roomGateBytes, 'v2.1 receiver room');
  process.stdout.write(`${name}: ${bytes} B; room ${gate.m1GateBytes - bytes} B\n`);
}
process.stdout.write(`${gateCount} manifest gates passed\n`);
