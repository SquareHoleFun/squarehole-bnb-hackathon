import assert from 'node:assert/strict';
import { concat, keccak256, zeroHash } from 'viem';

export const ROOT = new URL('../../../../../', import.meta.url);
export const RUN = new URL('.cache/examples-e2e/run/', ROOT);
/** Example-only art: each box's committed pictures, written before its creation and served only by this stack. */
export const EXAMPLE_ART = new URL('art/', RUN);
export const stringify = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export const DEFAULT_PORTS = { appPort: 5410, gatewayPort: 5411, artPort: 5412, chainPort: 8576 };

export function validatePorts(ports) {
  const reserved = new Set([4173, 4174, 4175, 5173, 8547, 8548, 8549, 8552, 8562, 8564, 8566]);
  for (let port = 5387; port <= 5397; port++) reserved.add(port);
  assert.equal(Object.keys(ports).sort().join(','), 'appPort,artPort,chainPort,gatewayPort');
  for (const port of Object.values(ports)) assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && !reserved.has(port), `refused port ${port}`);
  assert.equal(new Set(Object.values(ports)).size, 4, 'ports must differ');
  return ports;
}
export const portsFromEnv = () => validatePorts(JSON.parse(process.env.SH_EXAMPLES_PORTS ?? JSON.stringify(DEFAULT_PORTS)));

/** Every fee choice a recipe can name (v2.1 adds eat, holders-t, items-t and pile). */
export const CHOICES = Object.freeze(['keep', 'burn', 'grow', 'holders', 'items', 'pile', 'eat', 'holders-t', 'items-t', 'shop']);
/** 2:1:2:10 split, computed per fee side in raw P. Caller tracks M1 carry between collections. */
export function feeAllocation(amount, choice) {
  assert.ok(typeof amount === 'bigint' && amount >= 0n);
  assert.ok(CHOICES.includes(choice));
  const unit = amount / 15n;
  return { fit: 2n * unit, platform: unit, pool: 2n * unit, branch: 10n * unit, dust: amount % 15n, choice };
}
/**
 * The rc7 allocation walk: two quota places plus at most five passes for netP below 15 per side, buyers first.
 * Each side stops at its first unready source. Failure settlement disables passes and freezes persisted cursors.
 * `last` holds each side's last allocated id (0n before any); amounts remain raw bigint P.
 */
export async function nextSources(last, tradeBatch, failureSettled = false) {
  const picked = []; const cursor = { ...last };
  for (const side of ['buyers', 'sellers']) {
    let id = cursor[side] === 0n && side === 'buyers' ? 1n : cursor[side] + 2n;
    let passes = 0;
    for (let quota = 0; quota < 2; id += 2n) {
      const source = await tradeBatch(id);
      if (!source.closed) break;
      if (!failureSettled && source.netP < 15n && passes < 5) passes++;
      else quota++;
      picked.push({ side, id, netP: source.netP });
      if (!failureSettled) cursor[side] = id;
    }
  }
  return { picked, last: cursor };
}
export function assertAllocation(sides, actual) {
  const expected = { fit: 0n, platform: 0n, pool: 0n, ...Object.fromEntries(CHOICES.map(choice => [choice, 0n])), dust: 0n };
  for (const side of sides) {
    for (const key of ['fit', 'platform', 'pool', 'dust']) expected[key] += side[key];
    expected[side.choice] += side.branch;
  }
  assert.deepEqual(actual, expected, 'each fee side must reach its selected destination, including raw-unit dust');
}
export function proRata(pot, amount, supply) {
  assert.ok(supply > 0n && amount >= 0n && amount <= supply && pot >= 0n);
  return pot * amount / supply;
}
export function assertPaid({ before, after, quote, gas, native }) {
  assert.equal(after - before + (native ? gas : 0n), quote, 'claim must pay exactly the quoted raw amount');
}
export function assertProperties(expected, complete) {
  assert.deepEqual(expected.filter(id => !complete.has(id)), [], 'a declared property was not exercised');
}
export function chunkChain(data, size) {
  assert.ok(Number.isSafeInteger(size) && size > 0);
  assert.match(data, /^0x(?:[0-9a-fA-F]{2})*$/);
  const pieces = [];
  for (let i = 2; i < data.length; i += size * 2) pieces.push(`0x${data.slice(i, i + size * 2)}`);
  let root = zeroHash;
  const chunks = [];
  for (const data of pieces.reverse()) {
    chunks.unshift({ data, nextHash: root });
    root = keccak256(concat([data, root]));
  }
  return { root, chunks };
}
