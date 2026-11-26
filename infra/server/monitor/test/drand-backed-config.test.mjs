import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DEFAULTS, configure } from '../config.mjs';
import { RANDOMNESS_SOURCE } from '../../../../packages/box-spec/src/generated/box-spec.v1.ts';
import { fixture, configInput } from './drand-fixture.mjs';
const defaults = { drandBackedSource: RANDOMNESS_SOURCE, drandBackupStartLadder: '43200,21600,7200',
  drandBackupFixGraceBlocks: '300', drandBackupFixClosingBlocks: '8000' };
it('pins the backed source and backup clocks in defaults and the install example', () => {
  expect(DEFAULTS).toMatchObject(defaults);
  expect(configure(configInput(fixture()), {})).toMatchObject(defaults);
  expect(JSON.parse(readFileSync('infra/server/monitor/config.example.json', 'utf8'))).toMatchObject(defaults);
  const pins = readFileSync('packages/contracts/src/box/randomness/BackedSourcePins.sol', 'utf8');
  for (const chain of ['MAINNET', 'SEPOLIA']) expect(pins).toContain(`ADDRESS_${chain} = ${DEFAULTS.drandBackedSource};`);
});
it('accepts public overrides with descending start thresholds and decimal block counts', () => {
  const overrides = { drandBackedSource: '0x' + 'ab'.repeat(20), drandBackupStartLadder: '3600,600',
    drandBackupFixGraceBlocks: '100', drandBackupFixClosingBlocks: '8100' };
  expect(configure({ ...configInput(fixture()), ...overrides }, {})).toMatchObject(overrides);
});
for (const bad of [
  { drandBackedSource: 'bad' }, { drandBackedSource: 1 }, { drandBackupStartLadder: '1,2' },
  { drandBackupStartLadder: '1,1' }, { drandBackupStartLadder: '0' }, { drandBackupStartLadder: '64800' },
  { drandBackupStartLadder: '01' }, { drandBackupStartLadder: '' }, { drandBackupStartLadder: 3600 },
  { drandBackupFixGraceBlocks: '0' }, { drandBackupFixGraceBlocks: '-1' }, { drandBackupFixGraceBlocks: 300 },
  { drandBackupFixClosingBlocks: '0' }, { drandBackupFixClosingBlocks: '1e3' },
]) it(`refuses malformed backup config ${JSON.stringify(bad)}`, () => {
  expect(() => configure({ ...configInput(fixture()), ...bad }, {})).toThrow();
});

for (const [grace, closing] of [['8000', '300'], ['300', '300'], ['300', '8183'], ['300', '9000']]) {
  it(`refuses unordered or unreachable fix thresholds ${grace}/${closing}`, () => {
    expect(() => configure({ ...configInput(fixture()), drandBackupFixGraceBlocks: grace, drandBackupFixClosingBlocks: closing }, {})).toThrow();
  });
}
for (const closing of ['8000', '8100']) it(`accepts ordered fix thresholds 300/${closing}`, () => {
  expect(configure({ ...configInput(fixture()), drandBackupFixGraceBlocks: '300', drandBackupFixClosingBlocks: closing }, {}).drandBackupFixClosingBlocks).toBe(closing);
});
