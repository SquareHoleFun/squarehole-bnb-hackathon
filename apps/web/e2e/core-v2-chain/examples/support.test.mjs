import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feeAllocation, assertAllocation, proRata, assertPaid, assertProperties, chunkChain, validatePorts, nextSources } from './support.mjs';

test('fee sides conserve exact large P and keep their own rounding dust', () => {
  // Hand-calculated quotient 600479950316067 with remainder 4; above the JS safe integer limit.
  const buy = feeAllocation(9007199254741009n, 'grow');
  assert.deepEqual(buy, { fit: 1200959900632134n, platform: 600479950316067n, pool: 1200959900632134n,
    branch: 6004799503160670n, dust: 4n, choice: 'grow' });
  const sale = feeAllocation(31n, 'items');
  assert.equal(sale.branch, 20n); assert.equal(sale.dust, 1n);
  const actual = { fit: buy.fit + sale.fit, platform: buy.platform + sale.platform,
    pool: buy.pool + sale.pool, grow: buy.branch, items: sale.branch, burn: 0n, keep: 0n, holders: 0n, pile: 0n, shop: 0n, eat: 0n, 'holders-t': 0n, 'items-t': 0n, dust: 5n };
  assertAllocation([buy, sale], actual);
  assert.throws(() => assertAllocation([buy, sale], { ...actual, grow: actual.grow + 1n }));
  assert.throws(() => assertAllocation([buy, sale], { ...actual, items: 0n, grow: actual.grow + actual.items }));
  // v2.1: an eat side's or a T payout's share is its own destination, never another's.
  const eat = feeAllocation(30n, 'eat'); const t = feeAllocation(45n, 'items-t');
  assertAllocation([eat, t], { ...Object.fromEntries(Object.keys(actual).map(key => [key, 0n])), fit: 10n, platform: 5n, pool: 10n, eat: 20n, 'items-t': 30n });
  assert.throws(() => feeAllocation(1n, 'module'));
});

test('claims account for native gas while ERC-20 payouts stay exact', () => {
  assertPaid({ before: 1000n, after: 1083n, quote: 100n, gas: 17n, native: true });
  assertPaid({ before: 1000n, after: 1100n, quote: 100n, gas: 17n, native: false });
  assert.throws(() => assertPaid({ before: 1000n, after: 1099n, quote: 100n, gas: 17n, native: false }));
  assert.equal(proRata(1000000n, 333333333333333333n, 1000000000000000000n), 333333n);
  assert.equal(proRata(7n, 3n, 3n), 7n); // last failure claimant conserves the residue
  assert.throws(() => proRata(1n, 1n, 0n));
  assert.throws(() => proRata(1n, 2n, 1n));
});

test('every declared property must have executed; pending is not a pass', () => {
  assertProperties(['page-state', 'fee-conservation'], new Set(['page-state', 'fee-conservation']));
  assert.throws(() => assertProperties(['supply-burn'], new Set()));
});

test('hash-chain loader retains terminal and multi-chunk bytes exactly', () => {
  assert.deepEqual(chunkChain('0x', 2).chunks, []);
  const result = chunkChain('0x0102030405', 2);
  assert.deepEqual(result.chunks.map(c => c.data), ['0x0102', '0x0304', '0x05']);
  assert.equal(result.chunks.at(-1).nextHash, `0x${'0'.repeat(64)}`);
  assert.notEqual(result.root, chunkChain('0x0102030406', 2).root);
  assert.throws(() => chunkChain('0x01', 0));
});

test('all ticket-reserved ports and collisions are refused before stack startup', () => {
  const ports = { appPort: 5410, gatewayPort: 5411, artPort: 5412, chainPort: 8576 };
  assert.deepEqual(validatePorts(ports), ports);
  for (const port of [4173, 4174, 4175, 5173, 5387, 5391, 5397, 8547, 8548, 8549, 8552, 8564, 8566]) {
    assert.throws(() => validatePorts({ ...ports, appPort: port }));
  }
  assert.throws(() => validatePorts({ ...ports, appPort: 8576 }));
});

test('SH-RC6-RR-FEEPATH: a collect takes at most two closed sources a side from that side\'s own cursor, buyers first', async () => {
  // The hook's tradeBatch(id): odd ids are buyers' sources, even ids sellers'. `open` lists the ids still open.
  const hook = (open, netP = id => id * 30n) => async id => ({ closed: !open.includes(id), netP: netP(id) });
  const ids = picked => picked.map(source => `${source.side}:${source.id}`);
  // From the start: buyers 1 and 3, then sellers 2 and 4, never a fifth source.
  let next = await nextSources({ buyers: 0n, sellers: 0n }, hook([]));
  assert.deepEqual(ids(next.picked), ['buyers:1', 'buyers:3', 'sellers:2', 'sellers:4']);
  assert.deepEqual(next.last, { buyers: 3n, sellers: 4n });
  assert.deepEqual(next.picked.map(source => source.netP), [30n, 90n, 60n, 120n]);
  // An open seller source no longer holds the buyers back (the single cursor stopped at 2 and took only 1).
  next = await nextSources({ buyers: 0n, sellers: 0n }, hook([2n]));
  assert.deepEqual(ids(next.picked), ['buyers:1', 'buyers:3']);
  assert.deepEqual(next.last, { buyers: 3n, sellers: 0n });
  // The next collect resumes each side where it stopped: buyers from 5, sellers from 2, and nothing is taken twice.
  next = await nextSources(next.last, hook([7n]));
  assert.deepEqual(ids(next.picked), ['buyers:5', 'sellers:2', 'sellers:4']);
  assert.deepEqual(next.last, { buyers: 5n, sellers: 4n });
  // Each side stops at its own first open source, even with later closed ones (the examples' graduated tail).
  next = await nextSources({ buyers: 23n, sellers: 22n }, hook([24n, 27n]));
  assert.deepEqual(ids(next.picked), ['buyers:25']);
  assert.deepEqual(next.last, { buyers: 25n, sellers: 22n });
  next = await nextSources(next.last, hook([]));
  assert.deepEqual(ids(next.picked), ['buyers:27', 'buyers:29', 'sellers:24', 'sellers:26']);
});


test('rc7: five sub-unit passes per side, then two quota places; fifteen always uses quota', async () => {
  const hook = async id => ({ closed: id < 21n, netP: id < 11n ? (id % 3n === 0n ? 0n : 14n) : 15n });
  const next = await nextSources({ buyers: 0n, sellers: 0n }, hook);
  assert.equal(next.picked.length, 14);
  assert.deepEqual(next.last, { buyers: 13n, sellers: 14n });
  const capped = await nextSources({ buyers: 0n, sellers: 0n }, async () => ({ closed: true, netP: 14n }));
  assert.equal(capped.picked.length, 14);
  const interleaved = await nextSources({ buyers: 0n, sellers: 0n }, async id => ({ closed: true, netP: id === 3n || id === 4n ? 14n : 15n }));
  assert.deepEqual(interleaved.last, { buyers: 5n, sellers: 6n });
  const failure = await nextSources({ buyers: 0n, sellers: 0n }, hook, true);
  assert.deepEqual(failure.picked.map(x => x.id), [1n, 3n, 2n, 4n]);
  assert.deepEqual(failure.last, { buyers: 0n, sellers: 0n }, 'terminal allocation does not persist cursors');
});
