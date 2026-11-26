import test from 'node:test';
import assert from 'node:assert/strict';
import { read, v } from './model.mjs';
import * as pins from '../quicknet.mjs';

test('backed addresses, runtime and backup windows equal the Solidity pins', () => {
  const text = read('packages/contracts/src/box/randomness/BackedSourcePins.sol');
  for (const [chain, suffix] of [['1', 'MAINNET'], ['11155111', 'SEPOLIA']]) {
    assert.equal(pins.PINS[chain].backedAddress?.toLowerCase(), text.match(new RegExp(`ADDRESS_${suffix} = (0x[\\da-fA-F]+)`))[1].toLowerCase());
    assert.equal(pins.PINS[chain].backedCodeHash, text.match(new RegExp(`CODE_HASH_${suffix} = (0x[\\da-f]+)`))[1]);
    const runtime = JSON.parse(read('scripts/box/drand-rescue/test/backed-runtime.json')).runtime;
    assert.equal(v.keccak256(runtime), pins.PINS[chain].backedCodeHash);
  }
  const source = read('packages/contracts/src/box/randomness/BoxBackedSource.sol');
  for (const [name, expression, value] of [
    ['BACKUP_AFTER', '5 days', 432000n], ['LATEST_START', '5 days + 18 hours', 496800n],
    ['RECENT_BLOCKS', '8', 8n], ['TARGET_BLOCKS', '256', 256n], ['HISTORY_WINDOW', '8191', 8191n],
  ]) {
    assert.ok(source.includes(`uint256 public constant ${name} = ${expression};`));
    assert.equal(pins[name], value, name);
  }
});

test('backed ABI functions, events and errors equal the source declarations', async () => {
  const { ABIS } = await import('../abi.mjs');
  const source = read('packages/contracts/src/box/randomness/BoxBackedSource.sol');
  const declarations = [...source.matchAll(/(?:event|error) \w+\([^;]*\);/g)].map(m => m[0].slice(0, -1));
  for (const name of ['requestOf', 'wordOf', 'backupOf', 'startBackup', 'fixBackup']) {
    const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\{`))[0];
    declarations.push(match.slice(0, -1).replace(/\b(public|external)\b/g, '').replace(/\bcalldata\b/g, '').replace(/\s+/g, ' ').trim());
  }
  assert.match(source, /IDrandSource public constant DRAND = IDrandSource\(DrandSourcePins.ADDRESS_MAINNET\)/);
  declarations.push('function DRAND() view returns (address)');
  const original = v.parseAbi(declarations);
  assert.ok(ABIS.backedSource, 'backed source ABI exists');
  for (const fragment of ABIS.backedSource) {
    const other = original.find(e => e.type === fragment.type && e.name === fragment.name);
    assert.deepEqual(fragment, other, fragment.name);
  }
  for (const fragment of original.filter(e => e.name !== 'Requested')) {
    assert.ok(ABIS.backedSource.some(e => e.name === fragment.name), fragment.name);
  }
});

test('laptop recipe resolves DRAND, posts there and proves backup headers before Ledger sends', () => {
  const text = read('docs/runbooks/never-stuck.md');
  for (const phrase of ["SOURCE=$(cast call <tickets> 'source()(address)')", "DRAND=$(cast call \"$SOURCE\" 'DRAND()(address)')",
    'Backup (box 0, F143)', "'backupOf(uint256)(uint64,uint64,uint64,bytes32)'", "'startBackup(uint256,uint256,bytes)'",
    "'fixBackup(uint256,bytes)'", 'cast block "$((N-1))" --raw', 'cast block <target> --raw',
    'cast block finalized --field number', 'cast keccak', 'within about 80 seconds', '5 days 18 hours',
    'cast send --ledger "$DRAND" \'postRound(uint256,bytes)\'']) assert.ok(text.includes(phrase), phrase);
  assert.doesNotMatch(text, /cast send --ledger (?:<source>|"\$SOURCE") 'postRound/);
  for (const fn of ['requestOf', 'wordOf']) assert.ok(text.includes(`cast call "$SOURCE" '${fn}`));
});
