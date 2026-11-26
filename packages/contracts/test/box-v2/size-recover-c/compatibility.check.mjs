// SIZE-C4: exact original ABI, empty storage, fixed link and no DELEGATECALL/CALLCODE instructions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const read = (url) => JSON.parse(readFileSync(url, 'utf8'));
const artifact = (name) => read(new URL(`out/${name}.sol/${name}.json`, root));
const checks = artifact('BoxFactoryV2Checks');
assert.deepEqual(checks.abi, read(new URL('./original-abi.json', import.meta.url)), 'original ABI changed');
assert.deepEqual(Object.keys(checks.deployedBytecode.linkReferences), ['src/box-v2/libraries/FactoryChecksCurve.sol']);
assert.equal(checks.deployedBytecode.linkReferences['src/box-v2/libraries/FactoryChecksCurve.sol'].FactoryChecksCurve.length, 1);

for (const name of ['BoxFactoryV2Checks', 'FactoryChecksCurve']) {
  const layout = JSON.parse(execFileSync('forge', ['inspect', `src/box-v2/libraries/${name}.sol:${name}`, 'storageLayout', '--json'], {
    cwd: fileURLToPath(root), encoding: 'utf8',
  }));
  assert.deepEqual(layout.storage, [], `${name} gained storage`);
  const code = Buffer.from(artifact(name).deployedBytecode.object.slice(2).replace(/__\$[a-f0-9]{34}\$__/g, '0'.repeat(40)), 'hex');
  // Exclude the CBOR trailer and PUSH data; an operand byte is not an opcode.
  const executableEnd = code.length - code.readUInt16BE(code.length - 2) - 2;
  for (let pc = 0; pc < executableEnd; ++pc) {
    const op = code[pc];
    assert.notEqual(op, 0xf4, `${name} uses DELEGATECALL at ${pc}`);
    assert.notEqual(op, 0xf2, `${name} uses CALLCODE at ${pc}`);
    assert.notEqual(op, 0x55, `${name} uses SSTORE at ${pc}`);
    assert.notEqual(op, 0x5d, `${name} uses TSTORE at ${pc}`);
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
  }
}
process.stdout.write('SIZE-C4: original ABI, empty storage, fixed link and STATICCALL architecture pass\n');
