/** Independent M2-10C shop vectors. No product validator or generator model is imported. */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const { encodeAbiParameters, parseAbiParameters, zeroAddress } = createRequire(new URL('../../../../box-spec/package.json', import.meta.url))('viem');

const abi = parseAbiParameters('(uint256 seedT, uint256[4] givePricesT, uint16 pickBps, uint16 weeklyBps, uint16 collectionBps, uint32 listDelay, address curator, address[] collections, uint8[] tiers)');
const address = (i) => `0x${BigInt(i).toString(16).padStart(40, '0')}`;
const config = (n = 1) => ({ seedT: 10000n, givePricesT: [100n, 200n, 300n, 400n], pickBps: 12500,
  weeklyBps: 1000, collectionBps: 250, listDelay: 604800, curator: zeroAddress,
  collections: Array.from({ length: n }, (_, i) => address(i + 0x721)),
  tiers: Array.from({ length: n }, (_, i) => i % 4) });
const encode = (c) => encodeAbiParameters(abi, [c]);
const word = (p, i, v) => `${p.slice(0, 2 + i * 64)}${v.toString(16).padStart(64, '0')}${p.slice(2 + (i + 1) * 64)}`;
export const shopCases = [];
// flags: 1 adds a canonical empty loader, 2 removes list marker, 3 mismatches raise, 4 populates n.
const add = (name, contents, reason = 0, flags = 1, field = reason ? 30 : 0) => shopCases.push({ name, contents, reason, field, flags });
const valid = encode(config());
for (const n of [0, 1, 2, 63, 64]) add(`list length ${n}`, encode(config(n)), n === 0 ? 4 : 0);
add('list length 65 exceeds structural maximum', encode(config(65)), 5);
for (const pickBps of [12500, 15000, 20000, 30000]) for (const weeklyBps of [500, 1000]) {
  for (const collectionBps of [100, 250, 500]) for (const listDelay of [604800, 1209600, 2592000]) {
    add(`presets ${pickBps}/${weeklyBps}/${collectionBps}/${listDelay}`, encode({ ...config(), pickBps, weeklyBps, collectionBps, listDelay }));
  }
}
add('full-width increasing prices and curator', encode({ ...config(), seedT: 2n ** 256n - 1n, givePricesT: [2n ** 200n, 2n ** 220n, 2n ** 240n, 2n ** 256n - 1n], curator: address(2n ** 160n - 1n) }));
for (const seedT of [1n, 2n ** 200n, 2n ** 256n - 1n]) {
  add(`seed ${seedT} needs loader`, encode({ ...config(), seedT }), 18, 0);
  add(`seed ${seedT} with empty loader`, encode({ ...config(), seedT }), seedT < 4000n ? 4 : 0, 1);
}
add('empty list seed-only loader', encode({ ...config(0), seedT: 1n }), 4, 1);
add('zero seed with empty loader', encode({ ...config(), seedT: 0n }), 4, 1);
for (let i = 2; i <= 5; i++) {
  add(`zero price word ${i}`, word(valid, i, 0n), 4);
  if (i > 2) add(`equal price word ${i}`, word(valid, i, BigInt((i - 2) * 100)), 4);
}
for (const [i, values] of [[6, [0n, 12499n, 30001n, 65535n]], [7, [0n, 501n, 1001n]], [8, [0n, 251n, 501n]], [9, [0n, 604799n, 2592001n]]]) {
  for (const v of values) add(`invalid preset ${i}/${v}`, word(valid, i, v), 2);
}
for (const [i, bits] of [[6, 16], [7, 16], [8, 16], [9, 32], [10, 160], [14, 160], [16, 8]]) {
  add(`dirty narrow word ${i}`, word(valid, i, 1n << BigInt(bits)), 23);
}
for (const [i, values] of [[0, [0n, 64n, 2n ** 256n - 1n]], [11, [0n, 352n, 416n, 2n ** 256n - 1n]],
  [12, [0n, 416n, 480n, 2n ** 256n - 1n]], [13, [0n, 2n, 65n, 2n ** 256n - 1n]], [15, [0n, 2n, 2n ** 256n - 1n]]]) {
  for (const v of values) add(`invalid offset/count ${i}/${v}`, word(valid, i, v), 23);
}
add('zero collection', word(valid, 14, 0n), 7);
add('tier 4', word(valid, 16, 4n), 4);
add('tier 255', word(valid, 16, 255n), 4);
const duplicate = config(2); duplicate.collections[1] = duplicate.collections[0];
add('duplicate collections', encode(duplicate), 23);
const lateDuplicate = config(64); lateDuplicate.collections[63] = lateDuplicate.collections[0];
add('duplicate at list end', encode(lateDuplicate), 23);
add('more collections than tiers', encode({ ...config(2), tiers: [0] }), 23);
add('more tiers than collections', encode({ ...config(), tiers: [0, 1] }), 23);
for (const n of [0, 1, 31, 32, 479]) add(`short contents ${n}`, `0x${'00'.repeat(n)}`, 5);
for (const n of [480, 511, 543]) add(`truncated tail ${n}`, valid.slice(0, 2 + n * 2), 23);
add('trailing byte', `${valid}00`, 23);
add('trailing word', `${valid}${'00'.repeat(32)}`, 23);
add('over maximum bytes', `0x${'00'.repeat(4577)}`, 5);
add('narrow check before price', word(word(valid, 2, 0n), 16, 256n), 23);
add('price before preset', word(word(valid, 2, 0n), 6, 0n), 4);
add('preset before zero collection', word(word(valid, 6, 0n), 14, 0n), 2);
add('zero collection before bad tier', word(word(valid, 14, 0n), 16, 4n), 7);
add('tier before duplicate', encode({ ...duplicate, tiers: [0, 4] }), 4);
add('list before loader', word(encode({ ...config(), seedT: 1n }), 14, 0n), 7);
add('missing marker before shop', word(valid, 6, 0n), 18, 2, 29);
add('raise before shop', word(valid, 6, 0n), 10, 3, 11);
add('n rule before shop', word(valid, 6, 0n), 8, 4, 8);

export function solidityCases() {
  return [
    '// SPDX-License-Identifier: MIT', 'pragma solidity 0.8.26;', '',
    '// Generated by shop-cases.mjs; independent expected verdicts, never copied from either validator.',
    'library M210ShopCases {', `    uint256 internal constant COUNT = ${shopCases.length};`,
    '    function at(uint256 i) internal pure returns (bytes memory contents, uint16 reason, uint16 field, uint8 flags) {',
    ...shopCases.map((c, i) => `        if (i == ${i}) return (hex"${c.contents.slice(2)}", ${c.reason}, ${c.field}, ${c.flags});`),
    '        revert("shop case index");', '    }', '}', '',
  ].join('\n');
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const path = new URL('./ShopCases.sol', import.meta.url);
  const output = solidityCases();
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== output) throw new Error('ShopCases.sol is stale');
  } else writeFileSync(path, output);
  process.stdout.write(`${shopCases.length} independent shop parity cases ${process.argv.includes('--check') ? 'checked' : 'generated'}\n`);
}
