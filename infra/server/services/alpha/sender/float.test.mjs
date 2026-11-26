import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createSender } from './engine.mjs';
import { STARTER } from './chain.mjs';
import { account, claim, desk, token, id, scratch, fakeChain } from '../../../test/fixtures/alpha-sender/helpers.mjs';

const options = (p, chain, extra = {}) => ({ ...p, chain, address: desk.address, teth: token, mode: 'live', ...extra });
const progress = (p, n) => JSON.parse(readFileSync(join(p.receipts, `${id(n)}.progress.json`), 'utf8'));

for (const funds of [0n, STARTER, STARTER + 242000n - 1n]) {
  test(`low float ${funds}: preserves the same claim through restart and refill`, async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1)); p.put(await claim(2)); chain.funds = funds;
    const lines = [];
    let s = await createSender(options(p, chain, { log: line => lines.push(line) }));
    try {
      assert.equal(await s.cycle(), false);
      assert.throws(() => p.receipt(1)); assert.throws(() => p.receipt(2));
      assert.equal(progress(p, 1).status, 'waiting'); assert.equal(progress(p, 2).status, 'waiting');
      assert.equal(progress(p, 1).reason, 'insufficient float for starter and gas');
      assert.deepEqual(chain.prepares, []); assert.deepEqual(chain.broadcasts, []);
      assert.equal(s.monitor().lowFloat, true); assert.equal(s.monitor().waitingClaims, 2);
      assert.match(lines.at(-1), /lowFloat=true waitingClaims=2/);
      s.close(); s = await createSender(options(p, chain)); await s.cycle();
      chain.funds = STARTER * 2n + 242000n;
      await s.cycle(); await s.cycle();
      assert.equal(p.receipt(1).status, 'sent'); assert.equal(p.receipt(2).status, 'sent');
      assert.equal(s.monitor().waitingClaims, 0); assert.equal(chain.sent.length, 2);
      p.put(await claim(3, { xId: '1' })); p.put(await claim(1, { id: id(4), xId: '4' }));
      await s.cycle();
      assert.equal(p.receipt(3).reason, 'X account already claimed');
      assert.equal(p.receipt(4).reason, 'address already claimed'); assert.equal(chain.sent.length, 2);
    } finally { s.close(); }
  });
}

test('a float drop on the final quote pauses a reserved but unsigned claim across midnight', async () => {
  const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
  const quote = chain.quote; let quotes = 0, at = Date.parse('2026-11-11T23:59:59Z');
  chain.quote = async (...args) => { if (++quotes === 2) chain.funds = STARTER + 242000n - 1n; return quote(...args); };
  let s = await createSender(options(p, chain, { now: () => at }));
  try {
    await s.cycle(); assert.throws(() => p.receipt(1)); assert.deepEqual(chain.prepares, []);
    const saved = JSON.parse(readFileSync(join(p.state, 'journal.json'), 'utf8')).entries[0];
    assert.equal(saved.reserved, true); assert.equal(saved.pausedReason, 'insufficient float for starter and gas');
    // Reserved recovery must not rely on the API's queue file remaining available.
    renameSync(join(p.queue, `${id(1)}.json`), join(p.queue, `${id(1)}.archived`));
    s.close(); at += 1000; s = await createSender(options(p, chain, { now: () => at }));
    await s.cycle(); assert.equal(progress(p, 1).status, 'waiting');
    assert.equal(s.monitor().waitingClaims, 1);
    chain.funds = STARTER + 242000n; await s.cycle();
    assert.equal(p.receipt(1).status, 'sent'); assert.equal(chain.sent.length, 1);
    assert.equal(s.monitor().dayCount, 1);
  } finally { s.close(); }
});

test('acceptance order wins over UUID and challenge request time', async () => {
  const p = scratch(), { chain } = fakeChain();
  p.put(await claim(1, { requestedAt: '2026-11-11T10:00:00.000Z', acceptedAt: '2026-11-11T10:02:00.000Z' }));
  p.put(await claim(9, { requestedAt: '2026-11-11T10:01:00.000Z', acceptedAt: '2026-11-11T10:01:01.000Z' }));
  chain.funds = 0n;
  let s = await createSender(options(p, chain));
  try {
    await s.cycle(); s.close(); s = await createSender(options(p, chain));
    chain.funds = STARTER * 2n + 242000n; await s.cycle();
    assert.deepEqual(chain.sent, [account(9).address.toLowerCase(), account(1).address.toLowerCase()]);
  } finally { s.close(); }
});

test('a signed uncertain pair remains journaled and blocks the queue despite low float and refill', async () => {
  const p = scratch(), { chain } = fakeChain(); p.put(await claim(1)); p.put(await claim(2));
  let s = await createSender(options(p, chain, { checkpoint: async point => { if (point === 'admit+send:journal') throw new Error('crash'); } }));
  await assert.rejects(s.cycle(), /crash/); s.close();
  const saved = readFileSync(join(p.state, 'journal.json'), 'utf8');
  chain.latest = 2; chain.pending = 2;
  s = await createSender(options(p, chain));
  try {
    for (const funds of [0n, STARTER * 10n]) {
      chain.funds = funds; await assert.rejects(s.cycle(), /unexplained consumed nonce/);
      assert.equal(readFileSync(join(p.state, 'journal.json'), 'utf8'), saved);
      assert.equal(s.monitor().waitingClaims, 0); assert.equal(chain.prepares.length, 2);
      assert.equal(progress(p, 1).status, 'sending');
      assert.deepEqual(chain.broadcasts, []);
    }
  } finally { s.close(); }
});

test('an insufficient-funds estimate pauses before signing, while an RPC outage stays an error', async () => {
  const p = scratch(), { chain } = fakeChain(); p.put(await claim(1)); chain.funds = STARTER + 1n;
  const quote = chain.quote;
  chain.quote = async () => { throw Object.assign(new Error('estimate failed'), { cause: { name: 'InsufficientFundsError' } }); };
  const s = await createSender(options(p, chain));
  try {
    assert.equal(await s.cycle(), false); assert.equal(progress(p, 1).status, 'waiting');
    assert.throws(() => p.receipt(1)); assert.deepEqual(chain.prepares, []);
    chain.quote = async () => { throw Object.assign(new Error('RPC outage'), { cause: { name: 'HttpRequestError' } }); };
    await assert.rejects(s.cycle(), /RPC outage/); assert.throws(() => p.receipt(1));
    chain.quote = quote; chain.funds = STARTER + 242000n;
    await s.cycle(); assert.equal(p.receipt(1).status, 'sent'); assert.equal(chain.sent.length, 1);
  } finally { s.close(); }
});

test('dry-run waits for float, then skips in its own journal without signing', async () => {
  const p = scratch(), { chain } = fakeChain(); p.put(await claim(1)); chain.funds = 0n;
  let s = await createSender(options(p, chain, { mode: 'dry-run' }));
  try {
    await s.cycle(); assert.throws(() => p.receipt(1)); s.close();
    chain.funds = STARTER * 10n; s = await createSender(options(p, chain, { mode: 'dry-run' }));
    await s.cycle(); assert.equal(p.receipt(1).status, 'skipped');
    assert.throws(() => readFileSync(join(p.state, 'journal.json')));
    assert.deepEqual(chain.prepares, []); assert.deepEqual(chain.broadcasts, []);
    s.close(); p.put(await claim(1, { id: id(2) })); s = await createSender(options(p, chain));
    await s.cycle(); assert.equal(p.receipt(2).status, 'sent'); assert.equal(chain.sent.length, 1);
  } finally { s.close(); }
});

test('changing a queued file after a pause cannot reuse its earlier signature validation', async () => {
  const p = scratch(), { chain } = fakeChain(), c = await claim(1); p.put(c); chain.funds = 0n;
  const s = await createSender(options(p, chain));
  try {
    await s.cycle(); p.put({ ...c, signature: `0x${'00'.repeat(65)}` });
    chain.funds = STARTER * 5n; await s.cycle();
    assert.equal(p.receipt(1).status, 'refused'); assert.deepEqual(chain.prepares, []);
  } finally { s.close(); }
});

test('monitor warns below five starters by default and supports an exact decimal wei setting', async () => {
  const p = scratch(), { chain } = fakeChain(); chain.funds = STARTER * 5n - 1n;
  let s = await createSender(options(p, chain));
  try {
    await s.cycle(); assert.equal(s.monitor().lowFloat, true); assert.equal(s.monitor().waitingClaims, 0);
    assert.equal(s.monitor().lowFloatThresholdWei, String(STARTER * 5n));
    chain.funds++; await s.cycle(); assert.equal(s.monitor().lowFloat, false); s.close();
    s = await createSender(options(p, chain, { lowFloatThresholdWei: '250000000000000001' }));
    await s.cycle(); assert.equal(s.monitor().lowFloat, true);
  } finally { s.close(); }
  for (const value of ['0', '-1', '1.5', '1e18', 250000000000000000]) {
    await assert.rejects(createSender(options(p, chain, { lowFloatThresholdWei: value })), /float threshold/);
  }
});
