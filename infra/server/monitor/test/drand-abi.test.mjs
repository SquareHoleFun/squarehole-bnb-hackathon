import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DEFAULTS, configure } from '../config.mjs';
// F143: box 0 reads RANDOMNESS_SOURCE and its DRAND; v2 reads DRAND_SOURCE (monitor half of rc8 open item 73).
import { DRAND_SOURCE, RANDOMNESS_SOURCE, BACKUP_AFTER_SECONDS, BACKUP_LATEST_START_SECONDS, BACKUP_RECENT_BLOCKS, BACKUP_TARGET_BLOCKS } from '../../../../packages/box-spec/src/generated/box-spec.v1.ts';
import { ABIS, viem, vaultV2Abi, fixture, configInput, word } from './drand-fixture.mjs';
import * as d from '../drand.mjs';
const f = fixture(), t = f.consumers[0];
const samples = {
  DRAND: [[], DRAND_SOURCE], backupOf: [[33257816n], [1793008801n, 9000n, 1793012400n, word(123)]],
  tickets: [[], t.address], boxCount: [[], 3n], roleOf: [[2n, 7n], t.address],
  status: [[], Object.fromEntries(Object.keys(t.status).map((k, i) => [k, BigInt(i + 1)]))],
  source: [[], t.source], vault: [[], t.vault], gateOpenedAt: [[], 1792576800n], failureWindowEnds: [[], 1792676800n],
  requestOf: [[t.address, 3n], [1792576800n, 33257816n]], wordOf: [[t.address, 3n], [word(123), 1792576820n]],
};
for (const [name, [args, result]] of Object.entries(samples)) it(`pins ${name} encoding and layout to viem / generated ABI`, () => {
  const abi = ABIS[name], fn = abi.find(x => x.type === 'function' && x.name === name);
  expect(d.SELECTORS[name]).toBe(viem.toFunctionSelector(fn));
  expect(d.encodeCall(name, args)).toBe(viem.encodeFunctionData({ abi, functionName: name, args }));
  const encoded = viem.encodeFunctionResult({ abi, functionName: name, result });
  const decoded = d.decodeReply(name, encoded);
  const expected = name === 'status' ? Object.fromEntries(Object.entries(result).map(([k, v]) => [k, String(v)]))
    : name === 'requestOf' ? { requestedAt: '1792576800', round: '33257816' }
      : name === 'backupOf' ? { startedAt: '1793008801', targetBlock: '9000', fixedAt: '1793012400', mix: '123' }
      : name === 'wordOf' ? { word: '123', readyAt: '1792576820' } : String(result).toLowerCase();
  expect(decoded).toEqual(expected);
  expect(() => d.decodeReply(name, encoded + '00')).toThrow();
  expect(() => d.decodeReply(name, encoded.slice(0, -2))).toThrow();
});
it('pins the v2 gate and failure selector against its source declaration', () => {
  expect(viem.encodeFunctionData({ abi: vaultV2Abi, functionName: 'gateOpenedAt' })).toBe(d.SELECTORS.gateOpenedAt);
  expect(d.decodeReply('gateOpenedAt', viem.encodeFunctionResult({ abi: vaultV2Abi, functionName: 'gateOpenedAt', result: 123n }))).toBe('123');
  expect(readFileSync('packages/contracts/src/box-v2/libraries/VaultFailure.sol', 'utf8')).toContain('function failureWindowEnds() external view returns (uint256);');
});
it('pins all contract constants, source address and clock ownership', () => {
  expect(d.CONTRACT).toEqual({ silence: 604800n, unrequested: 2592000n, genesis: 1692803367n, period: 3n, ticketsRole: 7n,
    backupAfter: BACKUP_AFTER_SECONDS, latestStart: BACKUP_LATEST_START_SECONDS, recentBlocks: BACKUP_RECENT_BLOCKS,
    targetBlocks: BACKUP_TARGET_BLOCKS, historyWindow: 8191n });
  expect(DEFAULTS.drandSource).toBe(DRAND_SOURCE);
  expect(DEFAULTS.drandBackedSource).toBe(RANDOMNESS_SOURCE);
  const read = p => readFileSync(`packages/contracts/src/${p}`, 'utf8');
  for (const p of ['box/BoxTickets.sol', 'box-v2/BoxTicketsV2.sol']) {
    const s = read(p); expect(s).toMatch(/SILENCE = 7 days/); expect(s).toMatch(/SILENCE_UNREQUESTED = 30 days/);
    expect(s).toMatch(/_WORD_GAS = 50_000/); expect(s).toContain('since = s.wordRequestedAt;');
    expect(s).toContain('since = _draws[key].requestedAt;');
  }
  expect(read('box-v2/BoxTicketsV2.sol')).toContain('return end == 0 ? _gateOpenedAt() : end;');
  expect(read('box-v2/BoxTicketsV2.sol')).toContain('if (block.timestamp < at) revert TooEarly(at);');
  expect(read('box/randomness/DrandSource.sol')).toMatch(/MARGIN = 12 seconds/);
  expect(read('box/randomness/DrandSource.sol')).toContain('GENESIS_TIME + (round - 1) * PERIOD');
  expect(read('box/randomness/BoxDrandQuicknet.sol')).toMatch(/GENESIS_TIME = 1_692_803_367/);
  expect(read('box/randomness/BoxDrandQuicknet.sol')).toMatch(/PERIOD = 3;/);
  expect(read('box/randomness/DrandSourcePins.sol')).toContain(DRAND_SOURCE);
  const roles = readFileSync('packages/chain/src/core/roles.ts', 'utf8'); expect(roles).toMatch(/tickets: 7,/); expect(roles).toMatch(/ROLE_V2 = Object.freeze\(\{\s+\.\.\.ROLE,/);
});
it('keeps every founder default configurable and accepts legal overrides', () => {
  const c = configure(configInput(f), {});
  expect(c).toMatchObject({ drandSource: DRAND_SOURCE, drandLagSeconds: '900', drandLadder: '21600,86400,259200,432000,518400', drandLadderLevels: 'alert,critical,critical,emergency,emergency', drandUnrequestedLadder: '3600,86400,604800,1728000,2332800,2505600', drandUnrequestedLevels: 'alert,critical,critical,critical,emergency,emergency', drandMaxKeys: '64', rpcBatchSize: '50', wordOfGasAlert: '25000', criticalRepeatSeconds: '3600', emergencyRepeatSeconds: '900' });
  expect(configure({ ...configInput(f), drandMaxKeys: '1000', rpcBatchSize: '100', wordOfGasAlert: '49999', drandLadder: '100,200', drandLadderLevels: 'warn,alert' }, {}).drandMaxKeys).toBe('1000');
});
for (const bad of [
  { drandLadder: '2,1', drandLadderLevels: 'alert,critical' }, { drandLadder: '1,1', drandLadderLevels: 'alert,critical' },
  { drandLadder: '0', drandLadderLevels: 'alert' }, { drandLadder: '604800', drandLadderLevels: 'alert' },
  { drandUnrequestedLadder: '2592000', drandUnrequestedLevels: 'alert' }, { drandLadderLevels: 'alert' }, { drandUnrequestedLevels: 'alert' },
  { drandLadder: '1', drandLadderLevels: 'bogus' }, { drandLadder: '1,2', drandLadderLevels: 'emergency,critical' },
  { drandUnrequestedLadder: '1,2', drandUnrequestedLevels: 'critical,warn' },
  { wordOfGasAlert: '50000' }, { wordOfGasAlert: '0' }, { rpcBatchSize: '0' }, { rpcBatchSize: '101' },
  { drandMaxKeys: '0' }, { drandMaxKeys: '1001' }, { drandSource: 'oops' }, { drandLagSeconds: 900 },
  { drandLadder: [1, 2] }, { rpcBatchSize: '1e2' },
]) it(`refuses invalid config ${JSON.stringify(bad)}`, () => expect(() => configure({ ...configInput(f), ...bad }, {})).toThrow());

it('pins the backup declaration, public DRAND getter and constants to Solidity', () => {
  const text = readFileSync('packages/contracts/src/box/randomness/BoxBackedSource.sol', 'utf8');
  expect(text).toMatch(/function backupOf\(uint256 round\)\s+external\s+view\s+returns \(uint64 startedAt, uint64 targetBlock, uint64 fixedAt, bytes32 mix\)/);
  expect(text).toContain('IDrandSource public constant DRAND = IDrandSource(DrandSourcePins.ADDRESS_MAINNET);');
  for (const [name, value] of Object.entries({ BACKUP_AFTER: '5 days', LATEST_START: '5 days + 18 hours', RECENT_BLOCKS: '8', TARGET_BLOCKS: '256', HISTORY_WINDOW: '8191' })) {
    expect(text).toContain(`uint256 public constant ${name} = ${value};`);
  }
});
it('refuses uint64 overflow in each backup clock and address overflow in DRAND', () => {
  for (const index of [0, 1, 2]) {
    const words = [0n, 0n, 0n, 0n]; words[index] = 1n << 64n;
    expect(() => d.decodeReply('backupOf', '0x' + words.map(n => word(n).slice(2)).join(''))).toThrow();
  }
  expect(() => d.decodeReply('DRAND', word(1n << 160n))).toThrow();
});

it('monitor runtime modules stay below 400 lines and import only Node built-ins or their own modules', () => {
  for (const file of readdirSync('infra/server/monitor').filter(f => f.endsWith('.mjs') && f !== 'vitest.config.mjs')) {
    const source = readFileSync(`infra/server/monitor/${file}`, 'utf8');
    expect(source.trimEnd().split('\n').length, file).toBeLessThan(400);
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)) {
      expect(match[2].startsWith('node:') || /^\.\/[^/]+\.mjs$/.test(match[2]), `${file}: ${match[2]}`).toBe(true);
    }
  }
});
