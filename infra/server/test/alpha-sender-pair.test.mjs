import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSender } from '../services/alpha/sender/engine.mjs';
import { createChain, STARTER, STARTER_GAS_CAP, MAX_FEE_CEILING } from '../services/alpha/sender/chain.mjs';
import { account, claim, desk, id, legacyAdmission, scratch, token, viem } from './fixtures/alpha-sender/helpers.mjs';
import { fakeNode } from './fixtures/alpha-sender/node.mjs';

// SH-181: a claim's admission and starter go out back to back at consecutive nonces, normally in one block; the
// receipt still waits for twelve canonical confirmations of both. Production adapter, real signatures, a node
// stand-in that pools, refuses copies and mines only when a test says so. No listener and no network.
const low = { maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n };
const high = { maxFeePerGas: 7000000000n, maxPriorityFeePerGas: 2000000000n };
const pad = gas => gas * 12n / 10n + 1n;

function fixture() {
  const paths = scratch(), node = fakeNode();
  const signer = { signTransaction: vi.fn(tx => desk.signTransaction(tx)) };
  const chain = createChain({ address: desk.address, teth: token, account: signer, client: node.client });
  const sender = extra => createSender({ ...paths, address: desk.address, teth: token, mode: 'live', chain, ...extra });
  const journal = () => JSON.parse(readFileSync(join(paths.state, 'journal.json'), 'utf8')).entries;
  // Cycles until done: a block for what is pooled, then eleven empty ones (twelve confirmations).
  const drain = async s => {
    for (let round = 0; round < 6; round++) { if (await s.cycle()) return; node.mine(); node.advance(11); }
    throw new Error(`sender did not finish: ${JSON.stringify(s.monitor())}`);
  };
  const crashAt = point => ({ checkpoint: async at => { if (at === point) throw new Error('fixture crash'); } });
  return { paths, node, signer, chain, sender, journal, drain, crashAt };
}

describe('alpha sender: a claim\'s two transactions back to back (SH-181)', () => {
  beforeAll(() => vi.stubGlobal('fetch', () => { throw new Error('fixture forbids network'); }));
  afterAll(() => vi.unstubAllGlobals());

  it('both go out in the pickup cycle and land in one block; the receipt and the next claim wait for twelve confirmations', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    const s = await f.sender();
    try {
      expect(await s.cycle()).toBe(false);
      const [e] = f.journal();
      expect([e.admit.nonce, e.send.nonce]).toEqual([0, 1]);
      expect(f.node.sent).toEqual([e.admit.hash, e.send.hash]);
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
      expect(s.monitor().lastError).toBe('awaiting transaction confirmation');
      f.paths.put(await claim(2));
      expect(f.node.mine().txs).toEqual([e.admit.hash, e.send.hash]);
      expect(f.node.admitted).toEqual(new Set([account(1).address.toLowerCase()]));
      expect(f.node.sends.map(tx => [tx.to, tx.value])).toEqual([[account(1).address.toLowerCase(), STARTER]]);
      f.node.advance(10); // eleven confirmations: no receipt, and the next claim is not taken
      expect(await s.cycle()).toBe(false);
      expect(() => f.paths.receipt(1)).toThrow(); expect(f.journal()).toHaveLength(1);
      f.node.advance(1); // twelve
      expect(await s.cycle()).toBe(false);
      expect(f.paths.receipt(1)).toMatchObject({ status: 'sent', admitTx: e.admit.hash, sendTx: e.send.hash, reason: null });
      const next = f.journal()[1];
      expect([next.admit.nonce, next.send.nonce]).toEqual([2, 3]);
      expect(f.node.sent).toEqual([e.admit.hash, e.send.hash, next.admit.hash, next.send.hash]);
    } finally { s.close(); }
  });

  it('an already admitted address gets the starter alone, at the next nonce', async () => {
    const f = fixture(); const c = await claim(1); f.paths.put(c); f.node.admitted.add(c.address.toLowerCase());
    const s = await f.sender();
    try {
      await f.drain(s);
      const [e] = f.journal();
      expect(e.admit).toBeUndefined(); expect(e.send.nonce).toBe(0);
      expect(f.paths.receipt(1)).toMatchObject({ status: 'sent', admitTx: null, sendTx: e.send.hash });
    } finally { s.close(); }
  });

  it('a pair still pooled at the next cycle is no error: the node holds both copies; nothing is signed again', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    const s = await f.sender();
    try {
      expect(await s.cycle()).toBe(false);
      const [e] = f.journal();
      expect(await s.cycle()).toBe(false); // a missed slot: both still in the pool
      expect(f.node.refused).toEqual([[e.admit.hash, 'already known'], [e.send.hash, 'already known']]);
      expect(s.monitor().lastError).toBe('awaiting transaction confirmation');
      await f.drain(s);
      expect(f.paths.receipt(1).status).toBe('sent');
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
      expect(new Set(f.node.sent)).toEqual(new Set([e.admit.hash, e.send.hash]));
    } finally { s.close(); }
  });

  it.each([
    ['admit+send:journal', 0], ['admit:broadcast', 1], ['send:broadcast', 2], ['receipt:journal', 0],
  ])('recovers a crash at %s with identical bytes only: one admission, one starter', async (point, pooled) => {
    const f = fixture(); f.paths.put(await claim(1));
    let s = await f.sender(f.crashAt(point));
    if (point === 'receipt:journal') { expect(await s.cycle()).toBe(false); f.node.mine(); f.node.advance(11); }
    await expect(s.cycle()).rejects.toThrow('fixture crash'); s.close();
    const [saved] = f.journal();
    expect(f.node.pool.size).toBe(pooled);
    s = await f.sender();
    try {
      await f.drain(s);
      expect(f.paths.receipt(1)).toMatchObject({ status: 'sent', admitTx: saved.admit.hash, sendTx: saved.send.hash });
      expect(f.journal()[0]).toMatchObject({ admit: saved.admit, send: saved.send });
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
      expect(f.node.sent.every(hash => [saved.admit.hash, saved.send.hash].includes(hash))).toBe(true);
      expect(f.node.sends).toHaveLength(1); expect(f.node.admitted.size).toBe(1);
    } finally { s.close(); }
  });

  it('one mined, one dropped: the starter goes out again with its identical bytes, then the receipt', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    const s = await f.sender();
    try {
      await s.cycle();
      const [e] = f.journal();
      expect(f.node.mine({ take: 1 }).txs).toEqual([e.admit.hash]);
      f.node.drop(e.send.hash);
      expect(await s.cycle()).toBe(false);
      expect(f.node.sent).toEqual([e.admit.hash, e.send.hash, e.send.hash]);
      expect(f.node.mine().txs).toEqual([e.send.hash]);
      f.node.advance(10); expect(await s.cycle()).toBe(false); // the admission is final, the starter not yet
      f.node.advance(1); expect(await s.cycle()).toBe(true);
      expect(f.paths.receipt(1)).toMatchObject({ status: 'sent', admitTx: e.admit.hash, sendTx: e.send.hash });
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
    } finally { s.close(); }
  });

  it('both dropped: both go out again in nonce order with identical bytes, and land in one block', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    const s = await f.sender();
    try {
      await s.cycle();
      const [e] = f.journal();
      f.node.drop(e.admit.hash); f.node.drop(e.send.hash);
      expect(await s.cycle()).toBe(false);
      expect(f.node.sent).toEqual([e.admit.hash, e.send.hash, e.admit.hash, e.send.hash]);
      expect(f.node.mine().txs).toEqual([e.admit.hash, e.send.hash]);
      f.node.advance(11); expect(await s.cycle()).toBe(true);
      expect(f.paths.receipt(1).status).toBe('sent'); expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
    } finally { s.close(); }
  });

  it('a reverted admission fails the claim with both hashes once both are final; the starter went with it; the reservation stays', async () => {
    const f = fixture(); f.paths.put(await claim(1)); f.node.reverts.add(account(1).address.toLowerCase());
    const s = await f.sender();
    try {
      expect(await s.cycle()).toBe(false); f.node.mine(); f.node.advance(10);
      expect(await s.cycle()).toBe(false); expect(() => f.paths.receipt(1)).toThrow();
      f.node.advance(1); expect(await s.cycle()).toBe(true);
      const [e] = f.journal();
      expect(f.paths.receipt(1)).toMatchObject({ status: 'failed', reason: 'admit transaction reverted', admitTx: e.admit.hash, sendTx: e.send.hash });
      expect(f.node.mined.get(e.admit.hash).status).toBe('reverted');
      expect(f.node.sends).toHaveLength(1); expect(f.node.admitted.size).toBe(0);
      f.paths.put(await claim(1, { id: id(2) })); await s.cycle();
      expect(f.paths.receipt(2).reason).toBe('X account already claimed');
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2); expect(f.node.sent).toHaveLength(2);
    } finally { s.close(); }
  });

  it('a receipt the RPC cannot read is no proof that nothing was sent: the cycle stops and nothing is signed again', async () => {
    const f = fixture(); f.paths.put(await claim(1)); f.paths.put(await claim(2));
    const s = await f.sender();
    try {
      await s.cycle(); f.node.mine(); f.node.receiptFailure = 'fixture RPC failure';
      await expect(s.cycle()).rejects.toThrow('fixture RPC failure');
      expect(s.monitor().lastError).toBe('sender reconciliation failed; inspect chain and journal');
      expect(f.node.sent).toHaveLength(2); expect(f.journal()).toHaveLength(1);
      f.node.receiptFailure = null; f.node.advance(11);
      expect(await s.cycle()).toBe(false); // claim 1 final, claim 2's pair out
      expect(f.paths.receipt(1).status).toBe('sent'); expect(f.signer.signTransaction).toHaveBeenCalledTimes(4);
    } finally { s.close(); }
  });

  it.each([-1n, 0n])('checks the whole claim (both gas ceilings and the starter) against the float before either is signed: budget %s wei', async delta => {
    const f = fixture(); f.node.fees = [low, high]; // accepted at the low quote, signed at the fresh high one
    f.node.funds = STARTER + (pad(f.node.gas.admit) + pad(f.node.gas.send)) * high.maxFeePerGas + delta;
    f.paths.put(await claim(1));
    const s = await f.sender();
    try {
      await s.cycle();
      const [e] = f.journal();
      if (delta < 0n) {
        expect(() => f.paths.receipt(1)).toThrow();
        expect(e.outcome).toBeUndefined(); expect(e.pausedReason).toBe('insufficient float for starter and gas');
        expect(s.monitor().waitingClaims).toBe(1);
        expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.node.sent).toEqual([]);
        expect(e.admit).toBeUndefined(); expect(e.send).toBeUndefined();
      } else {
        expect(viem.parseTransaction(e.admit.raw)).toMatchObject({ ...high, gas: pad(f.node.gas.admit), nonce: 0 });
        expect(viem.parseTransaction(e.send.raw)).toMatchObject({ ...high, gas: pad(f.node.gas.send), nonce: 1, value: STARTER });
        expect(f.node.sent).toEqual([e.admit.hash, e.send.hash]); expect(e.outcome).toBeUndefined();
      }
    } finally { s.close(); }
  });

  it('a journal from the earlier engine (admission signed alone) keeps that order: the starter is signed after the admission is final, at a fresh quote', async () => {
    const f = fixture(), c = await claim(1); f.paths.put(c);
    const at = Date.parse('2026-11-01T10:17:00Z');
    const admit = await legacyAdmission(f.paths, c, { day: '2026-11-01' });
    f.node.fees = [high];
    const s = await f.sender({ now: () => at });
    try {
      expect(await s.cycle()).toBe(false); // the journaled admission goes out (it never had), no starter yet
      expect(f.node.sent).toEqual([admit.hash]); expect(f.journal()[0].send).toBeUndefined();
      f.node.mine(); f.node.advance(10);
      expect(await s.cycle()).toBe(false); expect(f.journal()[0].send).toBeUndefined();
      f.node.advance(1);
      expect(await s.cycle()).toBe(false);
      const e = f.journal()[0];
      expect(e.admit).toEqual(admit); expect(e.quote.admitGas).toBe('0');
      expect(viem.parseTransaction(e.send.raw)).toMatchObject({ ...high, nonce: 1, value: STARTER, gas: pad(f.node.gas.send) });
      await f.drain(s);
      expect(f.paths.receipt(1)).toMatchObject({ status: 'sent', admitTx: admit.hash, sendTx: e.send.hash });
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(1);
    } finally { s.close(); }
  });

  it('dry-run is unchanged: no nonce read, no signature, no broadcast', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    const nonces = vi.spyOn(f.node.client, 'getTransactionCount');
    const s = await f.sender({ mode: 'dry-run' });
    try {
      await s.cycle();
      expect(f.paths.receipt(1)).toMatchObject({ status: 'skipped', admitTx: null, sendTx: null, reason: 'dry run; no transactions' });
      expect(nonces).not.toHaveBeenCalled(); expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.node.sent).toEqual([]);
    } finally { s.close(); }
  });
});

describe('af1: nonce floor, starter gas cap, fee ceiling', () => {
  beforeAll(() => vi.stubGlobal('fetch', () => { throw new Error('fixture forbids network'); }));
  afterAll(() => vi.unstubAllGlobals());

  it('a lagging backend answering latest == pending at a used nonce: nothing signed or saved; the next cycle proceeds', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    const s = await f.sender();
    try {
      await f.drain(s); f.paths.put(await claim(2));
      const counts = f.node.client.getTransactionCount;
      f.node.client.getTransactionCount = async () => 1; // nonce 1 is claim 1's starter, mined and final
      await expect(s.cycle()).rejects.toThrow('stale nonce view');
      expect(s.monitor().lastError).toBe('stale nonce view');
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2); expect(f.node.sent).toHaveLength(2);
      expect(f.journal()[1]).toMatchObject({ id: id(2), reserved: true }); expect(f.journal()[1].admit).toBeUndefined();
      f.node.client.getTransactionCount = counts;
      expect(await s.cycle()).toBe(false);
      expect([f.journal()[1].admit.nonce, f.journal()[1].send.nonce]).toEqual([2, 3]);
      await f.drain(s); expect(f.paths.receipt(2).status).toBe('sent');
    } finally { s.close(); }
  });

  it('refuses a claim whose starter needs more gas than the cap (code or a 7702 delegation), before anything is signed', async () => {
    const f = fixture(); f.paths.put(await claim(1)); f.node.gas.send = STARTER_GAS_CAP; // padded: above the cap
    const s = await f.sender();
    try {
      await s.cycle();
      expect(f.paths.receipt(1)).toMatchObject({ status: 'refused', reason: 'address needs too much gas for the starter', admitTx: null, sendTx: null });
      expect(f.journal()[0]).toEqual(expect.objectContaining({ id: id(1), reserved: false }));
      expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.node.sent).toEqual([]);
    } finally { s.close(); }
  });

  it('a starter estimate that grows past the cap by signing time fails the reserved claim unsigned', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    const estimate = f.node.client.estimateGas; let sends = 0;
    f.node.client.estimateGas = async args => args.to === token ? estimate(args) : (++sends === 1 ? 21000n : STARTER_GAS_CAP);
    const s = await f.sender();
    try {
      await s.cycle();
      expect(f.paths.receipt(1)).toMatchObject({ status: 'failed', reason: 'address needs too much gas for the starter', admitTx: null, sendTx: null });
      expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.node.sent).toEqual([]);
    } finally { s.close(); }
  });

  it('waits, unsigned and unreserved, while the max fee is above the ceiling; proceeds when it falls', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    f.node.fees = [{ maxFeePerGas: MAX_FEE_CEILING + 1n, maxPriorityFeePerGas: 1000000000n }];
    const s = await f.sender();
    try {
      expect(await s.cycle()).toBe(false);
      expect(s.monitor().lastError).toBe('fees above the ceiling; waiting');
      expect(f.node.sent).toEqual([]); expect(f.signer.signTransaction).not.toHaveBeenCalled();
      expect(() => f.paths.receipt(1)).toThrow(); expect(() => f.journal()).toThrow(); // no journal written: nothing reserved
      f.node.fees = [low];
      await f.drain(s); expect(f.paths.receipt(1).status).toBe('sent');
    } finally { s.close(); }
  });
});

describe('af2: a starter transfer that reverts is an answer about the address; an outage is retried', () => {
  beforeAll(() => vi.stubGlobal('fetch', () => { throw new Error('fixture forbids network'); }));
  afterAll(() => vi.unstubAllGlobals());
  // As viem raises them: EstimateGasExecutionError around ExecutionRevertedError, or around a transport error.
  const wrapped = cause => Object.assign(new Error('fixture estimate failed'), { name: 'EstimateGasExecutionError', cause });
  const revert = () => wrapped(Object.assign(new Error('execution reverted'), { name: 'ExecutionRevertedError' }));
  const outage = () => wrapped(Object.assign(new Error('HTTP request failed'), { name: 'HttpRequestError' }));
  const failSends = (f, which) => {
    const estimate = f.node.client.estimateGas; let sends = 0;
    f.node.client.estimateGas = async args => {
      if (args.to === token) return estimate(args);
      const error = which(++sends, args); if (error) throw error;
      return estimate(args);
    };
  };

  it('refuses a new claim whose starter reverts, unreserved and unsigned; the next claim is not held up', async () => {
    const f = fixture(); f.paths.put(await claim(1)); f.paths.put(await claim(2));
    failSends(f, (n, args) => args.to.toLowerCase() === account(1).address.toLowerCase() ? revert() : null);
    const s = await f.sender();
    try {
      expect(await s.cycle()).toBe(false);
      expect(f.paths.receipt(1)).toMatchObject({ status: 'refused', reason: 'address cannot receive the starter', admitTx: null, sendTx: null });
      expect(f.journal()[0]).toEqual(expect.objectContaining({ id: id(1), reserved: false }));
      const second = f.journal()[1]; expect([second.admit.nonce, second.send.nonce]).toEqual([0, 1]);
      await f.drain(s); expect(f.paths.receipt(2).status).toBe('sent');
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
    } finally { s.close(); }
  });

  it('fails a reserved claim whose starter re-quote reverts, with nothing signed', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    failSends(f, n => n === 2 ? revert() : null); // accepted at the first quote, reverts at signing time
    const s = await f.sender();
    try {
      await s.cycle();
      expect(f.paths.receipt(1)).toMatchObject({ status: 'failed', reason: 'address cannot receive the starter', admitTx: null, sendTx: null });
      expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.node.sent).toEqual([]);
    } finally { s.close(); }
  });

  it('an RPC outage during the starter estimate is a retried cycle, never a refusal', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    failSends(f, n => n === 1 ? outage() : null);
    const s = await f.sender();
    try {
      await expect(s.cycle()).rejects.toThrow('fixture estimate failed');
      expect(s.monitor().lastError).toBe('sender reconciliation failed; inspect chain and journal');
      expect(() => f.paths.receipt(1)).toThrow(); expect(f.node.sent).toEqual([]);
      await f.drain(s); expect(f.paths.receipt(1).status).toBe('sent');
    } finally { s.close(); }
  });
});

describe('nonce views that only our own in-flight pair explains', () => {
  beforeAll(() => vi.stubGlobal('fetch', () => { throw new Error('fixture forbids network'); }));
  afterAll(() => vi.unstubAllGlobals());

  it('a pending transaction before a pair is signed stops the sender unsigned', async () => {
    const f = fixture(); f.paths.put(await claim(1)); await f.node.foreign(0);
    const s = await f.sender();
    try {
      await expect(s.cycle()).rejects.toThrow('unexplained pending nonce');
      expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.node.sent).toEqual([]);
      expect(f.journal()[0]).toMatchObject({ id: id(1), reserved: true }); expect(f.journal()[0].admit).toBeUndefined();
    } finally { s.close(); }
  });

  it('a transaction pending beyond the pair stops the sender: no copy is sent and no next claim is signed', async () => {
    const f = fixture(); f.paths.put(await claim(1)); f.paths.put(await claim(2));
    const s = await f.sender();
    try {
      await s.cycle(); const [e] = f.journal();
      await f.node.foreign(2);
      await expect(s.cycle()).rejects.toThrow('unexplained consumed nonce');
      expect(f.node.sent).toEqual([e.admit.hash, e.send.hash]); expect(f.journal()).toHaveLength(1);
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
    } finally { s.close(); }
  });

  it('the admission\'s nonce taken by another transaction stops the restarted sender before any broadcast', async () => {
    const f = fixture(); f.paths.put(await claim(1)); f.paths.put(await claim(2));
    let s = await f.sender(f.crashAt('admit+send:journal'));
    await expect(s.cycle()).rejects.toThrow('fixture crash'); s.close();
    await f.node.foreign(0); f.node.mine();
    s = await f.sender();
    try {
      await expect(s.cycle()).rejects.toThrow('unexplained consumed nonce');
      expect(f.node.sent).toEqual([]); expect(f.journal()).toHaveLength(1);
    } finally { s.close(); }
  });

  it('our starter mined while another transaction took the admission\'s nonce stops the sender', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    const s = await f.sender();
    try {
      await s.cycle(); const [e] = f.journal();
      f.node.drop(e.admit.hash); await f.node.foreign(0);
      expect(f.node.mine().txs).toHaveLength(2);
      expect(f.node.mined.has(e.send.hash)).toBe(true);
      await expect(s.cycle()).rejects.toThrow('unexplained consumed nonce');
      expect(() => f.paths.receipt(1)).toThrow();
    } finally { s.close(); }
  });

  it('a confirmed count behind our first unmined transaction stops the sender', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    let s = await f.sender();
    await f.drain(s); s.close();
    f.paths.put(await claim(2));
    s = await f.sender(f.crashAt('admit+send:journal'));
    await expect(s.cycle()).rejects.toThrow('fixture crash'); s.close();
    f.node.latest = 1; // an RPC answering from a node one transaction behind
    s = await f.sender();
    try {
      await expect(s.cycle()).rejects.toThrow('unexplained consumed nonce');
      expect(f.node.sent).toHaveLength(2);
    } finally { s.close(); }
  });

  it('another transaction pooled at the admission\'s nonce: our copy is refused and the cycle fails, the starter is not sent', async () => {
    const f = fixture(); f.paths.put(await claim(1));
    let s = await f.sender(f.crashAt('admit+send:journal'));
    await expect(s.cycle()).rejects.toThrow('fixture crash'); s.close();
    const [saved] = f.journal(), other = await f.node.foreign(0);
    s = await f.sender();
    try {
      await expect(s.cycle()).rejects.toThrow('replacement transaction underpriced');
      expect(f.node.sent).toEqual([saved.admit.hash]);
      f.node.mine(); expect(f.node.mined.has(other)).toBe(true);
      await expect(s.cycle()).rejects.toThrow('unexplained consumed nonce');
      expect(f.node.sent).toEqual([saved.admit.hash]); expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
    } finally { s.close(); }
  });
});
