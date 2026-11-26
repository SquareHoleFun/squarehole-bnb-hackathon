import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { writeFileSync, readFileSync, statSync, readdirSync, symlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createSender, validateClaim } from '../services/alpha/sender/engine.mjs';
import { senderSettings } from '../services/alpha-sender.mjs';
import { account, claim, desk, token, id, scratch, fakeChain } from './fixtures/alpha-sender/helpers.mjs';
import { cycle } from './fixtures/alpha-sender/cycle.mjs';

const options = (paths, chain, extra = {}) => ({ ...paths, chain, address: desk.address, teth: token, mode: 'live', ...extra });

describe('alpha sender policy', () => {
  it('defaults disabled/dry and refuses non-Sepolia or conflicting flags', () => {
    expect(senderSettings({})).toMatchObject({ enabled: false, mode: 'dry-run' });
    for (const env of [{ SH_ALPHA_CHAIN_ID: '1' }, { SH_SERVICE_ALLOW_MAINNET: '1' },
      { SH_SERVICE_MODE: 'send' }, { SH_SERVICE_ENABLED: 'yes' }, { SH_KEEPER_PRIVATE_KEY: 'test' }]) {
      expect(() => senderSettings(env)).toThrow();
    }
  });
  it.each([
    ['missing field', c => { delete c.privyDid; }], ['version', c => { c.v = 2; }],
    ['uuid', c => { c.id = 'bad'; }], ['x ID', c => { c.xId = 'x'; }],
    ['noncanonical x ID', c => { c.xId = '001'; }], ['overlong x ID', c => { c.xId = '1'.repeat(21); }],
    ['DID', c => { c.privyDid = 'other'; }], ['checksum', c => { c.address = c.address.toLowerCase(); }],
    ['time', c => { c.requestedAt = 'tomorrow'; }], ['unsigned', c => { delete c.signature; }],
    ['signature', c => { c.signature = `0x${'00'.repeat(65)}`; }],
    ['wrong signer', c => { c.address = account(99).address; }],
    ['extra field', c => { c.allow = true; }],
  ])('refuses %s', async (_, mutate) => {
    const c = await claim(1); mutate(c);
    expect(await validateClaim(c, id(1))).not.toBeNull();
  });
  it.each(['id', 'xId', 'address'])('refuses a signed message missing this %s', async field => {
    const c = await claim(12, { message: `Claim ${field === 'id' ? 'absent' : id(12)} X ${field === 'xId' ? 'absent' : '12'} address ${field === 'address' ? 'absent' : account(12).address}` });
    expect(await validateClaim(c, c.id)).toBe('signed message does not name this claim');
  });
  it('requires the filename ID, and token boundaries in the signed text', async () => {
    expect(await validateClaim(await claim(1), id(2))).toBe('invalid claim schema');
    const c = await claim(1, { message: `X 111 ${account(1).address} ${id(1)}` });
    expect(await validateClaim(c, c.id)).toBe('signed message does not name this claim');
  });
  it('reads in name order, refuses malformed/unsigned files, ignores temporary files and rejects symlinks', async () => {
    const p = scratch(), { chain } = fakeChain();
    p.put(await claim(3)); p.put(await claim(2));
    writeFileSync(join(p.queue, `${id(1)}.json`), '{');
    const unsigned = await claim(4); delete unsigned.signature; p.put(unsigned);
    writeFileSync(join(p.queue, 'partial.new'), '{');
    symlinkSync(join(p.queue, `${id(3)}.json`), join(p.queue, `${id(5)}.json`));
    const s = await createSender(options(p, chain));
    try {
      await s.cycle();
      expect(chain.sent).toEqual([account(2).address.toLowerCase(), account(3).address.toLowerCase()]);
      for (const n of [1, 4, 5]) expect(p.receipt(n).status).toBe('refused');
      expect(p.receipt(2)).toMatchObject({ v: 1, id: id(2), status: 'sent', reason: null });
      expect(s.monitor()).toMatchObject({ queueLength: 0, dayCount: 2, floatWei: chain.funds.toString() });
    } finally { s.close(); }
  });
  it('deduplicates x IDs and addresses permanently, including across restart and midnight', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    let s = await createSender(options(p, chain)); await s.cycle(); s.close();
    p.put(await claim(2, { xId: '1' }));
    p.put(await claim(1, { id: id(3), xId: '3' }));
    s = await createSender(options(p, chain, { now: () => Date.parse('2026-11-01T00:00:00Z') }));
    try {
      await s.cycle(); expect(chain.sent).toHaveLength(1);
      expect(p.receipt(2).reason).toBe('X account already claimed');
      expect(p.receipt(3).reason).toBe('address already claimed');
    } finally { s.close(); }
  });
  it('enforces 20 per UTC day across midnight and restarts', async () => {
    const p = scratch(), { chain } = fakeChain();
    // Like an automining RPC whose receipt/head has not caught up at the first poll,
    // every admission and transfer needs a later cycle to observe confirmation.
    const receipt = chain.receipt, observed = new Set();
    chain.receipt = async hash => {
      const result = await receipt(hash);
      if (!result || observed.has(hash)) return result;
      observed.add(hash);
      return { ...result, confirmed: false };
    };
    for (let n = 1; n <= 21; n++) p.put(await claim(n));
    let at = Date.parse('2026-10-29T23:59:59Z');
    let s = await createSender(options(p, chain, { now: () => at }));
    try {
      // Each claim needs a later confirmation cycle. The daily stop leaves claim 21 queued, not refused.
      for (let n = 0; n <= 20; n++) expect(await s.cycle()).toBe(false);
      expect(chain.sent).toHaveLength(20); expect(() => p.receipt(21)).toThrow();
      expect(s.monitor()).toMatchObject({ dayCount: 20, queueLength: 1, lastError: 'daily claim limit reached' });
      expect(await s.cycle()).toBe(false); expect(chain.sent).toHaveLength(20);
    } finally { s.close(); }
    at += 1000; p.put(await claim(22));
    s = await createSender(options(p, chain, { now: () => at }));
    try {
      await cycle(s); expect(chain.sent).toHaveLength(22); expect(s.monitor().dayCount).toBe(2);
      expect(p.receipt(21)).toMatchObject({ id: id(21), status: 'sent' });
    }
    finally { s.close(); }
  }, shLimit(60000));
  it('the cycle helper reports a stalled confirmation without completing or resending the claim', async () => {
    const p = scratch(), { chain, mined } = fakeChain(); p.put(await claim(1));
    const broadcast = chain.broadcast;
    chain.broadcast = async tx => { await broadcast(tx); mined.get(tx.hash).confirmed = false; };
    const s = await createSender(options(p, chain));
    try {
      await expect(cycle(s, { timeoutMs: 1 })).rejects.toThrow('awaiting transaction confirmation');
      // SH-181: the admission and the starter go out together, each exactly once; the receipt waits.
      expect(chain.prepares).toEqual(['admit', 'send']); expect(chain.broadcasts).toHaveLength(2);
      expect(new Set(chain.broadcasts).size).toBe(2); expect(chain.sent).toEqual([account(1).address.toLowerCase()]);
      expect(() => p.receipt(1)).toThrow();
    } finally { s.close(); }
  });
  it('pauses insufficient float including both gas budgets; equality resumes the same claim', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    chain.funds = 50000000000000000n + 242000n - 1n;
    const s = await createSender(options(p, chain));
    try {
      await s.cycle(); expect(() => p.receipt(1)).toThrow();
      expect(s.monitor()).toMatchObject({ lowFloat: true, waitingClaims: 1 });
      expect(chain.prepares).toEqual([]);
      expect(chain.broadcasts).toHaveLength(0);
      chain.funds++; p.put(await claim(2)); await s.cycle();
      expect(p.receipt(1).status).toBe('sent'); expect(() => p.receipt(2)).toThrow();
      chain.funds += 50000000000000000n; await s.cycle(); expect(p.receipt(2).status).toBe('sent');
      expect(chain.sent).toHaveLength(2);
    } finally { s.close(); }
  });
  it('already admitted needs only the transfer', async () => {
    const p = scratch(), { chain, admitted } = fakeChain(); const c = await claim(1); p.put(c); admitted.add(c.address);
    const s = await createSender(options(p, chain));
    try { await s.cycle(); expect(chain.prepares).toEqual(['send']); expect(p.receipt(1).admitTx).toBeNull(); }
    finally { s.close(); }
  });
  it('dry run writes receipts and a separate journal, with no signatures or broadcasts', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    const s = await createSender(options(p, chain, { mode: 'dry-run' }));
    try {
      await s.cycle(); expect(p.receipt(1)).toMatchObject({ status: 'skipped', admitTx: null, sendTx: null, reason: 'dry run; no transactions' });
      expect(chain.prepares).toEqual([]); expect(chain.broadcasts).toEqual([]);
      expect(readdirSync(p.state)).toContain('journal.dry.json');
      expect(statSync(join(p.state, 'journal.dry.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(p.receipts, `${id(1)}.json`)).mode & 0o777).toBe(0o640);
    } finally { s.close(); }
  });
  // alpha-api releases a claim at this exact receipt and invites the person to claim again (alpha-api.mjs releaseDry).
  it('dry run releases each claim at its skipped receipt: the same X account and address claim again, both skipped', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    const s = await createSender(options(p, chain, { mode: 'dry-run' }));
    try {
      await s.cycle(); p.put(await claim(1, { id: id(2) })); await s.cycle();
      for (const n of [1, 2]) expect(p.receipt(n)).toMatchObject({ status: 'skipped', admitTx: null, sendTx: null, reason: 'dry run; no transactions' });
      const { entries } = JSON.parse(readFileSync(join(p.state, 'journal.dry.json'), 'utf8'));
      expect(entries.map(e => e.id)).toEqual([id(1), id(2)]);
      // Only the claim ID and its outcome stay: no X ID, address, day or simulated cost is held after the receipt.
      for (const e of entries) expect(Object.keys(e).sort()).toEqual(['id', 'outcome', 'reserved']);
      expect(entries.every(e => e.reserved === false)).toBe(true);
      expect(s.monitor().dayCount).toBe(0); expect(chain.prepares).toEqual([]); expect(chain.broadcasts).toEqual([]);
    } finally { s.close(); }
  });
  it('a dry journal written before the release lets go of its skipped claims on the next cycle', async () => {
    const p = scratch(), { chain } = fakeChain(), c = await claim(1);
    const outcome = { v: 1, id: id(1), status: 'skipped', admitTx: null, sendTx: null, reason: 'dry run; no transactions', at: '2026-11-01T10:17:00.000Z' };
    // As the earlier sender left it: the skipped claim still reserved X ID 1, its address and its day.
    writeFileSync(join(p.state, 'journal.dry.json'), `${JSON.stringify({ v: 1, identity: `11155111:${desk.address}:${token}:dry-run`, entries: [
      { id: id(1), reserved: true, xId: c.xId, address: c.address, days: ['2026-11-01'], needsAdmit: true,
        quote: { admitGas: '120001', sendGas: '25201', maxFeePerGas: '2', maxPriorityFeePerGas: '1' }, outcome }] })}\n`, { mode: 0o600 });
    p.put(c); writeFileSync(join(p.receipts, `${id(1)}.json`), `${JSON.stringify(outcome)}\n`);
    p.put(await claim(1, { id: id(2) }));
    const s = await createSender(options(p, chain, { mode: 'dry-run', now: () => Date.parse('2026-11-01T10:20:00Z') }));
    try {
      await s.cycle(); expect(p.receipt(2)).toMatchObject({ status: 'skipped', reason: 'dry run; no transactions' });
      const { entries } = JSON.parse(readFileSync(join(p.state, 'journal.dry.json'), 'utf8'));
      expect(entries).toEqual([{ id: id(1), reserved: false, outcome }, expect.objectContaining({ id: id(2), reserved: false })]);
      expect(s.monitor().dayCount).toBe(0);
    } finally { s.close(); }
  });
  it('refuses a different RPC chain before reading the queue or sending', async () => {
    const p = scratch(), { chain } = fakeChain(); chain.chainId = async () => 1;
    await expect(createSender(options(p, chain))).rejects.toThrow('Sepolia');
    expect(chain.broadcasts).toEqual([]);
  });
  it('pauses an empty float before gas estimation can fail on insufficient funds', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1)); chain.funds = 0n;
    chain.quote = async () => { throw new Error('insufficient gas funds'); };
    const s = await createSender(options(p, chain));
    try {
      expect(await s.cycle()).toBe(false); expect(() => p.receipt(1)).toThrow();
      expect(s.monitor()).toMatchObject({ lowFloat: true, waitingClaims: 1 });
      expect(chain.prepares).toEqual([]); expect(chain.broadcasts).toEqual([]);
    }
    finally { s.close(); }
  });
});

describe('durable transaction recovery', () => {
  it.each(['admit+send:journal', 'admit:broadcast', 'send:broadcast', 'receipt:journal'])('recovers crash at %s with no double send', async point => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    const s = await createSender(options(p, chain, { checkpoint: async at => { if (at === point) throw new Error('fixture crash'); } }));
    await expect(s.cycle()).rejects.toThrow('fixture crash'); s.close();
    const restart = await createSender(options(p, chain));
    try { await restart.cycle(); await restart.cycle(); expect(chain.sent).toHaveLength(1); expect(p.receipt(1).status).toBe('sent'); }
    finally { restart.close(); }
  });
  it('stops on a consumed nonce without a known receipt, before new work', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    let s = await createSender(options(p, chain, { checkpoint: async at => { if (at === 'admit+send:journal') throw new Error('crash'); } }));
    await expect(s.cycle()).rejects.toThrow(); s.close(); chain.latest = 2; chain.pending = 2;
    p.put(await claim(2)); s = await createSender(options(p, chain));
    try { await expect(s.cycle()).rejects.toThrow('nonce'); expect(chain.sent).toEqual([]); }
    finally { s.close(); }
  });
  // An on-chain cap or revocation already stops the gas simulation before signing (Anvil suite). Only a role change
  // between that simulation and the block reverts a signed admission; SH-181 sends its starter in the same breath.
  it('an admission that reverts after its simulation fails the claim with both hashes; its starter went with it', async () => {
    const p = scratch(), { chain, mined } = fakeChain(); p.put(await claim(1));
    const send = chain.broadcast;
    chain.broadcast = async tx => { await send(tx); if (tx.kind === 'admit') mined.set(tx.hash, { status: 'reverted', confirmed: true }); };
    const s = await createSender(options(p, chain));
    try {
      await s.cycle();
      expect(p.receipt(1)).toMatchObject({ status: 'failed', reason: 'admit transaction reverted',
        admitTx: expect.stringMatching(/^0x[0-9a-f]{64}$/), sendTx: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
      expect(chain.prepares).toEqual(['admit', 'send']); expect(chain.sent).toEqual([account(1).address.toLowerCase()]);
    } finally { s.close(); }
  });
  it('charges a resumed transaction to its confirmation day before allowing new claims', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    let at = Date.parse('2026-10-29T23:59:59Z');
    let s = await createSender(options(p, chain, { now: () => at, checkpoint: async point => { if (point === 'send:broadcast') throw new Error('crash'); } }));
    await expect(s.cycle()).rejects.toThrow(); s.close(); at += 1000;
    for (let n = 2; n <= 21; n++) p.put(await claim(n));
    s = await createSender(options(p, chain, { now: () => at }));
    try {
      expect(await s.cycle()).toBe(false); expect(s.monitor().dayCount).toBe(20);
      expect(() => p.receipt(21)).toThrow(); expect(chain.sent).toHaveLength(20);
    }
    finally { s.close(); }
  }, shLimit(60000));
  it('an uncertain receipt or a pending pair blocks all new claims', async () => {
    const p = scratch(), { chain, mined } = fakeChain(); p.put(await claim(1)); p.put(await claim(2));
    const broadcast = chain.broadcast;
    chain.broadcast = async tx => { await broadcast(tx); mined.set(tx.hash, { status: 'success', confirmed: false }); };
    const s = await createSender(options(p, chain));
    try {
      expect(await s.cycle()).toBe(false); expect(chain.prepares).toEqual(['admit', 'send']);
      expect(await s.cycle()).toBe(false); expect(chain.sent).toEqual([account(1).address.toLowerCase()]);
      chain.receipt = async () => { throw new Error('RPC secret diagnostic'); };
      await expect(s.cycle()).rejects.toThrow();
      expect(JSON.stringify(s.monitor())).not.toContain('secret'); expect(chain.prepares).toEqual(['admit', 'send']);
    } finally { s.close(); }
  });
  it('locks out competing writers and refuses malformed state', async () => {
    const p = scratch(), { chain } = fakeChain(); const s = await createSender(options(p, chain));
    await expect(createSender(options(p, chain))).rejects.toThrow('lock'); s.close();
    writeFileSync(join(p.state, 'journal.json'), '{}');
    await expect(createSender(options(p, chain))).rejects.toThrow('journal');
  });
  it('a failed journal write poisons this process, even if storage later recovers', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    const prepare = chain.prepare;
    chain.prepare = async (...args) => {
      const tx = await prepare(...args);
      if (args[0] === 'send') {
        renameSync(p.state, `${p.state}.saved`);
        writeFileSync(p.state, 'fixture blocks the journal directory');
      }
      return tx;
    };
    const s = await createSender(options(p, chain));
    await expect(s.cycle()).rejects.toThrow();
    renameSync(p.state, `${p.state}.blocked`); renameSync(`${p.state}.saved`, p.state);
    try { await expect(s.cycle()).rejects.toThrow('journal'); expect(chain.sent).toEqual([]); }
    finally { s.close(); }
  });
  it('recovers a completed journal even if its receipt was not published', async () => {
    const p = scratch(), { chain } = fakeChain(); p.put(await claim(1));
    let s = await createSender(options(p, chain)); await s.cycle(); s.close();
    renameSync(join(p.receipts, `${id(1)}.json`), join(p.state, 'old-receipt.json'));
    const saved = readFileSync(join(p.state, 'journal.json'), 'utf8');
    expect(saved).not.toContain('privyDid'); expect(saved).not.toContain('signature');
    s = await createSender(options(p, chain));
    try { await s.cycle(); expect(p.receipt(1).status).toBe('sent'); expect(chain.sent).toHaveLength(1); }
    finally { s.close(); }
  });
});
