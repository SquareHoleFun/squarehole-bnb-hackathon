import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSender } from '../services/alpha/sender/engine.mjs';
import { createChain, STARTER } from '../services/alpha/sender/chain.mjs';
import { account, claim, desk, id, legacyAdmission, scratch, token, viem } from './fixtures/alpha-sender/helpers.mjs';

const low = { maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n };
const high = { maxFeePerGas: 7000000000n, maxPriorityFeePerGas: 2000000000n };
const pad = gas => gas * 12n / 10n + 1n;
const today = () => new Date().toISOString().slice(0, 10);

// Only RPC responses are simulated: production estimation, signing, confirmation and journal paths run.
function fixture() {
  const paths = scratch(), mined = new Map(), admitted = new Set(), sends = [], broadcasts = [];
  const state = { head: 100n, nonce: 0, funds: 10n * STARTER, baseFee: 1000000000n,
    fees: low, sendGas: 21000n, admitGas: 50000n };
  const journal = () => JSON.parse(readFileSync(join(paths.state, 'journal.json'), 'utf8')).entries;
  const client = {
    getChainId: async () => 11155111,
    getBalance: async () => state.funds,
    getBlockNumber: async () => state.head,
    getBlock: async ({ blockNumber }) => ({ hash: `block-${blockNumber}` }),
    getTransactionCount: async () => state.nonce,
    readContract: async ({ args: [address] }) => admitted.has(address.toLowerCase()),
    estimateFeesPerGas: vi.fn(async () => state.fees),
    estimateGas: vi.fn(async ({ to }) => to === token ? state.admitGas : state.sendGas),
    getTransactionReceipt: async ({ hash }) => {
      if (mined.has(hash)) return mined.get(hash);
      throw Object.assign(new Error('not mined'), { name: 'TransactionReceiptNotFoundError' });
    },
    sendRawTransaction: async ({ serializedTransaction: raw }) => {
      const tx = viem.parseTransaction(raw), hash = viem.keccak256(raw);
      const entry = journal().find(e => e.admit?.hash === hash || e.send?.hash === hash);
      const kind = entry?.admit?.hash === hash ? 'admit' : 'send';
      // A real signature and its fresh quote must already be on disk before any broadcast attempt.
      expect(entry?.[kind]).toMatchObject({ raw, hash, nonce: tx.nonce });
      expect(entry.quote).toMatchObject({ maxFeePerGas: String(tx.maxFeePerGas),
        maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas), [`${kind}Gas`]: String(tx.gas) });
      broadcasts.push(raw);
      if (tx.maxFeePerGas < state.baseFee) throw new Error('max fee below base fee');
      if (mined.has(hash)) return hash;
      expect(tx.nonce).toBe(state.nonce++);
      state.funds -= (tx.value ?? 0n) + tx.gas * state.baseFee;
      if (kind === 'send') sends.push(tx);
      else admitted.add(entry.address.toLowerCase());
      mined.set(hash, { status: 'success', blockNumber: state.head, blockHash: `block-${state.head}` });
      return hash;
    },
    getTransaction: async ({ hash }) => {
      if (mined.has(hash)) return { hash };
      throw Object.assign(new Error('not known'), { name: 'TransactionNotFoundError' });
    },
  };
  const signer = { signTransaction: vi.fn(tx => desk.signTransaction(tx)) };
  const chain = createChain({ address: desk.address, teth: token, account: signer, client });
  const sender = extra => createSender({ ...paths, address: desk.address, teth: token, mode: 'live', chain, ...extra });
  const rise = () => { state.baseFee = 3000000000n; state.fees = high; state.sendGas = 35000n; };
  return { paths, state, client, signer, sender, journal, rise, admitted, sends, broadcasts };
}

describe('alpha sender fee refresh with the production signer and twelve confirmations', () => {
  beforeAll(() => vi.stubGlobal('fetch', () => { throw new Error('fixture forbids network'); }));
  afterAll(() => vi.unstubAllGlobals());

  // SH-181 signs a claim's admission and starter together. A journal the earlier engine left mid-claim (the admission
  // signed alone) keeps that order: its starter is quoted afresh once the admission has twelve confirmations.
  it.each([false, true])("refreshes a legacy claim's starter after its admission's fees rise; restart during wait: %s", async restart => {
    const f = fixture(); const first = await claim(1); f.paths.put(first); f.paths.put(await claim(2));
    f.admitted.add(account(2).address.toLowerCase());
    const admit = await legacyAdmission(f.paths, first, { day: today(), admitGas: pad(50000n), sendGas: pad(21000n) });
    let s = await f.sender();
    try {
      expect(await s.cycle()).toBe(false);
      expect(f.journal()[0].admit).toEqual(admit); expect(f.broadcasts).toEqual([admit.raw]);
      expect(f.signer.signTransaction).not.toHaveBeenCalled();
      f.rise(); f.state.head = 110n;
      if (restart) { s.close(); s = await f.sender(); }
      expect(await s.cycle()).toBe(false); // Only eleven confirmations: no starter yet.
      expect(f.journal()[0].send).toBeUndefined();
      f.state.head = 111n;
      expect(await s.cycle()).toBe(false);
      expect(f.sends).toHaveLength(1);
      expect(f.sends[0]).toMatchObject({ ...high, gas: pad(35000n), value: STARTER, nonce: 1 });
      expect(f.journal()[0].admit).toEqual(admit);
      expect(f.journal()[0].quote.admitGas).toBe('0');
      f.state.head = 122n; expect(await s.cycle()).toBe(false);
      f.state.head = 133n; expect(await s.cycle()).toBe(true);
      expect(f.sends.map(tx => [tx.to, tx.value, tx.nonce])).toEqual([
        [account(1).address.toLowerCase(), STARTER, 1], [account(2).address.toLowerCase(), STARTER, 2],
      ]);
      expect(f.paths.receipt(1).status).toBe('sent'); expect(f.paths.receipt(2).status).toBe('sent');
      expect(s.monitor().queueLength).toBe(0);
    } finally { s.close(); }
  });

  // The acceptance quote passes; the pair's fresh quote or its second signature fails. Neither transaction is saved.
  it.each(['fees', 'gas', 'signing'])('recovers a %s failure while the pair is quoted or signed, with a restart', async failure => {
    const f = fixture(); f.paths.put(await claim(1));
    const interruption = new Error(`fixture ${failure} interruption`);
    if (failure === 'fees') f.client.estimateFeesPerGas.mockResolvedValueOnce(low).mockRejectedValueOnce(interruption);
    if (failure === 'gas') {
      const gas = f.client.estimateGas.getMockImplementation();
      f.client.estimateGas.mockImplementationOnce(gas).mockImplementationOnce(gas).mockRejectedValueOnce(interruption);
    }
    if (failure === 'signing') f.signer.signTransaction.mockImplementationOnce(tx => desk.signTransaction(tx)).mockRejectedValueOnce(interruption);
    let s = await f.sender();
    try {
      await expect(s.cycle()).rejects.toThrow(interruption.message);
      const [saved] = f.journal();
      expect(saved).toMatchObject({ id: id(1), reserved: true }); expect(saved.admit).toBeUndefined(); expect(saved.send).toBeUndefined();
      expect(f.broadcasts).toEqual([]);
      s.close(); f.rise(); s = await f.sender();
      expect(await s.cycle()).toBe(false);
      expect(viem.parseTransaction(f.journal()[0].admit.raw)).toMatchObject({ ...high, gas: pad(50000n), nonce: 0 });
      expect(f.sends[0]).toMatchObject({ ...high, gas: pad(35000n), nonce: 1 });
      f.state.head = 111n; expect(await s.cycle()).toBe(true);
      expect(f.paths.receipt(1).status).toBe('sent');
      expect(f.sends).toHaveLength(1);
    } finally { s.close(); }
  });

  it.each(['admit', 'send'])('refreshes the unsigned %s stage on recovery from a reserved claim', async kind => {
    const f = fixture(); f.paths.put(await claim(1));
    if (kind === 'send') f.admitted.add(account(1).address.toLowerCase());
    f.signer.signTransaction.mockRejectedValueOnce(new Error('fixture signing interruption'));
    let s = await f.sender();
    try {
      await expect(s.cycle()).rejects.toThrow('fixture signing interruption');
      expect(f.journal()[0][kind]).toBeUndefined();
      s.close(); f.rise(); s = await f.sender();
      expect(await s.cycle()).toBe(false);
      expect(viem.parseTransaction(f.journal()[0][kind].raw)).toMatchObject(high);
      // An admission goes out with its starter (SH-181); an admitted address gets the starter alone.
      expect(f.broadcasts).toHaveLength(kind === 'admit' ? 2 : 1);
    } finally { s.close(); }
  });

  it.each([
    ['admit', -1n], ['admit', 0n], ['already admitted', -1n], ['already admitted', 0n],
    ['after admission', -1n], ['after admission', 0n],
  ])('checks refreshed bigint float for %s at budget + %s wei', async (stage, delta) => {
    const f = fixture(); const c = await claim(1); f.paths.put(c);
    if (stage === 'already admitted') f.admitted.add(account(1).address.toLowerCase());
    // 'after admission' exists only in a journal from before SH-181: the admission signed alone.
    if (stage === 'after admission') await legacyAdmission(f.paths, c, { day: today(), admitGas: pad(50000n), sendGas: pad(21000n) });
    const s = await f.sender();
    try {
      if (stage === 'after admission') { await s.cycle(); f.state.head = 111n; }
      f.rise();
      if (stage !== 'after admission') f.client.estimateFeesPerGas.mockResolvedValueOnce(low);
      f.state.funds = STARTER + (pad(f.state.sendGas) + (stage === 'admit' ? pad(f.state.admitGas) : 0n)) * high.maxFeePerGas + delta;
      await s.cycle();
      const e = f.journal()[0], kind = stage === 'admit' ? 'admit' : 'send';
      if (delta < 0n) {
        expect(e[kind]).toBeUndefined(); expect(e.send).toBeUndefined(); expect(f.sends).toEqual([]);
        if (stage === 'after admission') expect(f.paths.receipt(1)).toMatchObject({ status: 'failed', reason: 'insufficient float for starter and gas' });
        else {
          expect(() => f.paths.receipt(1)).toThrow();
          expect(e.pausedReason).toBe('insufficient float for starter and gas');
          expect(s.monitor().waitingClaims).toBe(1);
        }
        expect(f.signer.signTransaction).not.toHaveBeenCalled();
      } else {
        // For an admission the budget is the whole claim: both gas ceilings and the starter, signed together.
        expect(viem.parseTransaction(e[kind].raw)).toMatchObject(high);
        expect(viem.parseTransaction(e.send.raw)).toMatchObject({ ...high, value: STARTER });
        expect(e.outcome).toBeUndefined();
      }
    } finally { s.close(); }
  });

  it('retains journaled bytes across higher fees, repeated retries, 24 blocks and restart', async () => {
    const f = fixture(); f.paths.put(await claim(1)); f.paths.put(await claim(2));
    let s = await f.sender({ checkpoint: async point => { if (point === 'admit+send:journal') throw new Error('fixture crash'); } });
    try {
      await expect(s.cycle()).rejects.toThrow('fixture crash');
      const saved = f.journal()[0], quotes = f.client.estimateFeesPerGas.mock.calls.length;
      expect(saved.admit).toBeDefined(); expect(saved.send).toBeDefined(); expect(f.broadcasts).toEqual([]);
      s.close(); f.rise(); f.state.head += 24n; s = await f.sender();
      // A refused admission is not known to the node: the cycle fails, and its starter is not sent ahead of it.
      for (let i = 0; i < 2; i++) await expect(s.cycle()).rejects.toThrow('max fee below base fee');
      expect(f.broadcasts).toEqual([saved.admit.raw, saved.admit.raw]);
      expect(f.client.estimateFeesPerGas).toHaveBeenCalledTimes(quotes);
      expect(f.signer.signTransaction).toHaveBeenCalledTimes(2);
      expect(f.journal()).toEqual([saved]); expect(s.monitor().queueLength).toBe(2);
      s.close(); s = await f.sender();
      await expect(s.cycle()).rejects.toThrow('max fee below base fee');
      expect(f.journal()).toEqual([saved]);
      f.state.baseFee = low.maxFeePerGas;
      expect(await s.cycle()).toBe(false);
      expect(f.sends).toHaveLength(1); expect(f.sends[0].nonce).toBe(1);
      expect(f.journal()[0].send).toEqual(saved.send);
    } finally { s.close(); }
  });
});
