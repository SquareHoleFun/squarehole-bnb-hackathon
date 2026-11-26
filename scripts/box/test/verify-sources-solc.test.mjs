import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolvedSolcFixture } from './verify-sources-fixtures.mjs';
import { makePlan } from '../lib/verify-sources.mjs';

// Explicitly supplied cached compiler only: this test never downloads or resolves a compiler over the network.
for (const metadataField of ['metadata', 'rawMetadata']) {
  test(`solc recompiles reconstructed ${metadataField} to identical linked creation/runtime bytes`, async () => {
    assert.ok(process.env.VERIFY_SOURCES_SOLC, 'set VERIFY_SOURCES_SOLC to a cached solc 0.8.26 executable');
    const f = await resolvedSolcFixture(metadataField);
    const plan = await makePlan(f.manifest, f.options);
    for (const entry of plan.contracts) {
      const input = JSON.parse(entry.request.fields.sourceCode);
      input.settings.outputSelection = f.build.input.settings.outputSelection;
      const result = spawnSync(process.env.VERIFY_SOURCES_SOLC, ['--standard-json'], {
        input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      assert.equal(result.status, 0, 'cached solc must complete successfully');
      const output = JSON.parse(result.stdout);
      assert.deepEqual((output.errors ?? []).filter((error) => error.severity === 'error'), []);
      const [path, name] = entry.contract.split(':');
      const actual = output.contracts[path][name];
      const expected = f.build.output.contracts[path][name];
      assert.equal(actual.metadata, expected.metadata, 'compiler version, links and metadata are unchanged');
      assert.equal(actual.evm.bytecode.object, expected.evm.bytecode.object, 'exact creation bytecode');
      assert.equal(actual.evm.deployedBytecode.object, expected.evm.deployedBytecode.object, 'exact runtime including metadata');
      assert.equal(`0x${actual.evm.deployedBytecode.object}`, entry.runtime);
    }
  });
}
