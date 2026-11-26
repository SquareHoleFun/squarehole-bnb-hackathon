import { authorizeRevealTestTarget, installRevealTestSeam } from './reveal-test-seam.test-support';
import { submitWrite } from '../../../../../../packages/chain/src/write/executor';
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { multicall3Abi } from '../../../../../../packages/chain/src/core/v2/reveal-batch-calls-v2';
import { loadRevealItems, prepareRevealItems, runRevealItems, UNKNOWN_WAIT_MS, type RevealResult, type RevealRun } from './reveal-items';
import { readRevealProgress, revealProgressKey, webRevealLock } from './reveal-items-store';
import * as revealRun from './reveal-items';
import { saveRevealIntent } from './reveal-items-store';
import { addr, digest, must, runFixture, runPresses, traceRevealSends } from './reveal-items.test-support';

function result(r: RevealResult<RevealRun>): RevealRun { if (!r.ok) throw new Error(r.reason); return r.value; }

describe('SH202 source provenance and original files', () => {
  it('accepts the original file and matching kept copy without resalting', async () => {
    const f = runFixture(); const source = await f.source();
    const text = JSON.stringify(f.file);
    const kept = { format: 'squarehole.reveal-keep/1' as const, key: `${f.identity.chainId}:${f.identity.token}`, ...f.identity,
      artMode: 'open' as const, n: 4, revealRoot: source.file.root, fileName: 'saved.json', savedAt: 0, text };
    expect((await loadRevealItems(f.identity, f.identity.creator, kept, f.ports.chain)).ok).toBe(true);
    expect(await loadRevealItems(f.identity, f.identity.creator, { ...kept, chainId: 1 }, f.ports.chain)).toEqual({ ok: false, reason: 'invalid-source' });
    expect(JSON.stringify(f.file)).toBe(text);
  });
  it.each(['chainId', 'registry', 'token', 'creator', 'specHash', 'collectionCode', 'root', 'size', 'firstId', 'triggers'] as const)('refuses wrong chain %s before a run', async field => {
    const f = runFixture();
    const values = { chainId: 1, registry: addr(99), token: addr(99), creator: addr(99), specHash: digest(99), collectionCode: '0x6001', root: digest(99), size: 9n, firstId: 2n, triggers: 1 };
    f.ports.chain.snapshot = async () => ({ ...f.snapshot, [field]: values[field] });
    expect((await loadRevealItems(f.identity, f.identity.creator, new Blob([JSON.stringify(f.file)]), f.ports.chain)).ok).toBe(false);
    expect(f.sends).toHaveLength(0);
  });
  it.each(['id', 'traitsPacked', 'imageSha256', 'avatarSha256', 'modelSha256', 'salt', 'missing', 'reordered', 'listHash', 'hidden', 'spec', 'trailing'])('refuses damaged original %s', async field => {
    const f = runFixture();
    const item = must(f.file.revealList.items[0]);
    if (field === 'id') item.id = '2';
    else if (field === 'traitsPacked') item.traitsPacked = '99';
    else if (field === 'missing') f.file.revealList.items.pop();
    else if (field === 'reordered') f.file.revealList.items.reverse();
    else if (field === 'listHash') f.file.spec.revealListId = digest(99);
    else if (field === 'hidden') f.file.spec.artMode = 2;
    else if (field === 'spec') f.file.specHash = digest(99);
    else if (field !== 'trailing') item[field as 'imageSha256' | 'avatarSha256' | 'modelSha256' | 'salt'] = digest(99);
    const blob = new Blob([JSON.stringify(f.file), field === 'trailing' ? 'x' : '']);
    expect((await loadRevealItems(f.identity, f.identity.creator, blob, f.ports.chain)).ok).toBe(false);
  });
});

describe('SH202 shown plan and bounded execution', () => {
  it('500 items plan twelve batches of 40 and one of 20, then finish', async () => {
    const f = runFixture(500); const plan = await f.plan();
    expect(plan.batches.map(b => b.batch.ids.length)).toEqual([...Array<number>(12).fill(40), 20]);
    expect(plan.ceilingWei).toBe(plan.batches.reduce((n, b) => n + b.gasLimit * plan.fee.maxFeePerGas, plan.retryReserveWei));
    const end = result(await runRevealItems(plan, f.ports, f.controller.signal));
    expect(end.reason).toBe('complete'); expect(end.counts.finalized).toBe(500n);
    expect(f.sends).toHaveLength(13); expect(end.reservedWei).toBeLessThanOrEqual(plan.ceilingWei);
  }, shLimit(120_000));
  it('shrinks the actual calldata when estimate plus the existing margin exceeds the gas cap', async () => {
    const f = runFixture(40); const estimate = f.ports.estimate;
    f.ports.estimate = async (...args) => (await estimate(...args)) * 2n;
    expect((await f.plan()).batches.map(b => b.batch.ids.length)).toEqual([20, 20]);
  });
  it('refuses a single oversized call, failed estimate and inner simulation failure', async () => {
    const f = runFixture(1); const source = await f.source();
    f.ports.estimate = async () => 20_000_000n;
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'gas-cap' });
    f.ports.estimate = async () => { throw new Error(); };
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'estimate-failed' });
    f.ports.estimate = async () => 1n;
    f.ports.simulate = async () => encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: [{ success: false, returnData: '0x' }] });
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'simulation-failed' });
  });
  it('higher ceiling or changed scope stops before sending; a cloned plan cannot start', async () => {
    const f = runFixture(); const plan = await f.plan(); const estimate = f.ports.estimate;
    f.ports.estimate = async (...args) => await estimate(...args) + 1_000n;
    expect(result(await runRevealItems(plan, f.ports, f.controller.signal)).reason).toBe('plan-changed');
    expect(await runRevealItems({ ...plan }, f.ports, f.controller.signal)).toEqual({ ok: false, reason: 'invalid-plan' });
    f.latest.add(1n); f.finalized.add(1n);
    expect(result(await runRevealItems(plan, f.ports, f.controller.signal)).reason).toBe('plan-changed');
    expect(f.sends).toHaveLength(0);
  });
  it('mixed inner success rereads each id and only sends the holes', async () => {
    const f = runFixture();
    f.onSend = async ids => {
      for (const id of f.sends.length === 1 ? ids.slice(0, 2) : ids) { f.latest.add(id); f.finalized.add(id); }
    };
    // af5 (R4-L3a): the holes are one send more than the press showed: that press stops; the next one sends them.
    const { presses, last } = await runPresses(f);
    expect(presses.map(p => [p.run.reason, p.shown, p.sent])).toEqual([['plan-changed', 1, 1], ['complete', 1, 1]]);
    expect(last.reason).toBe('complete'); expect(f.sends.map(s => s.ids)).toEqual([[1n, 2n, 3n, 4n], [3n, 4n]]);
  });
  it('someone else reveals a future batch first: chain success removes it', async () => {
    const f = runFixture(41);
    f.onSend = async ids => { for (const id of [...ids, 41n]) { f.latest.add(id); f.finalized.add(id); } };
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('complete');
    expect(f.sends).toHaveLength(1);
  });
  it('whole batch revert preserves nothing, retries smaller and stops after two retries', async () => {
    // af5 (R4-L3a): within the three transactions the press showed (120 items), so the retries stay in this press.
    const f = runFixture(120);
    f.onSend = async (_ids, hash) => { f.receipts.set(hash, { ...must(f.receipts.get(hash)), status: 'reverted' }); };
    const plan = await f.plan(); expect(plan.batches).toHaveLength(3);
    const end = result(await runRevealItems(plan, f.ports, f.controller.signal));
    expect(end.reason).toBe('revert-limit'); expect(f.finalized.size).toBe(0);
    expect(f.sends.map(s => s.ids.length)).toEqual([40, 20, 10]);
  }, shLimit(60_000));
  it('lost receipt blocks any resend until finalized states reconcile it', async () => {
    const f = runFixture(); const source = await f.source();
    f.onSend = async (_ids, hash) => { f.receipts.delete(hash); };
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('receipt-pending');
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'receipt-pending' });
    expect(f.sends).toHaveLength(1);
    for (let id = 1n; id <= 4n; id++) { f.latest.add(id); f.finalized.add(id); }
    const resumed = await prepareRevealItems(source, f.ports);
    expect(resumed.ok && resumed.value.batches.length).toBe(0);
  });
  it('rechecks previously resolved hashes on reload, including a removed receipt', async () => {
    const f = runFixture();
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('complete');
    f.receipts.clear(); f.finalized.clear(); f.latest.clear();
    expect(await prepareRevealItems(await f.source(), f.ports)).toEqual({ ok: false, reason: 'receipt-pending' });
    expect(f.sends).toHaveLength(1);
  });
  it('refuses an unrelated transaction recipient', async () => {
    const f = runFixture();
    f.onSend = async (_ids, hash) => { f.receipts.set(hash, { ...must(f.receipts.get(hash)), to: addr(99) }); };
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('read-failed');
    expect(f.sends).toHaveLength(1);
  });
  it('store failure after wallet result leaves an unknown durable intent for reload', async () => {
    const f = runFixture(); const plan = await f.plan();
    const put = f.ports.store.put;
    f.onSend = async () => { f.ports.store.put = async () => { throw new Error('quota'); }; };
    expect(result(await runRevealItems(plan, f.ports, f.controller.signal)).reason).toBe('store-failed');
    f.ports.store.put = put;
    expect(await prepareRevealItems(await f.source(), f.ports)).toEqual({ ok: false, reason: 'unknown-send' });
    expect(f.sends).toHaveLength(1);
  });
  it('unknown send survives reload; time and finalized nonce cannot unlock it', async () => {
    const f = runFixture();
    f.onSend = async (_ids, hash) => { f.receipts.delete(hash); throw new Error('connection-lost'); };
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('unknown-send');
    const source = await f.source();
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'unknown-send' });
    f.time = UNKNOWN_WAIT_MS; // Time alone does not unlock.
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'unknown-send' });
    f.time = 0; f.nonce = 1n; // Nonce alone does not unlock.
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'unknown-send' });
    f.time = UNKNOWN_WAIT_MS;
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'unknown-send' });
    expect(f.sends).toHaveLength(1);
  });
  it('cancel and account or chain switch stop cleanly before wallet request', async () => {
    for (const stop of ['cancel', 'account', 'chain']) {
      const f = runFixture(); const plan = await f.plan();
      if (stop === 'cancel') f.controller.abort(); else if (stop === 'account') f.account = addr(99); else f.network = 1;
      const reason = result(await runRevealItems(plan, f.ports, f.controller.signal)).reason;
      expect(reason).toBe(stop === 'cancel' ? 'cancelled' : `${stop}-changed`); expect(f.sends).toHaveLength(0);
    }
  });
  it('account change inside executor balance check refuses before intent', async () => {
    const f = runFixture(); const plan = await f.plan();
    f.ports.feeReader.getBalance = async () => { f.account = addr(99); return 10n ** 30n; };
    expect(result(await runRevealItems(plan, f.ports, f.controller.signal)).reason).toBe('account-changed');
    const p = await readRevealProgress(f.ports.store, revealProgressKey(f.identity.chainId, f.identity.token), f.identity.specHash);
    expect(p.intents).toEqual([]); expect(f.sends).toHaveLength(0);
  });
  it('two tabs only let the lock holder send, and missing Web Locks fails closed', async () => {
    const f = runFixture(); const plan = await f.plan(); const source = await f.source();
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.onSend = async ids => { entered(); await new Promise<void>(resolve => { release = resolve; }); for (const id of ids) { f.latest.add(id); f.finalized.add(id); } };
    const run = runRevealItems(plan, f.ports, f.controller.signal); await waiting;
    expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'running-elsewhere' });
    release(); expect(result(await run).reason).toBe('complete');
    expect((await prepareRevealItems(source, f.ports)).ok).toBe(true);
    expect(webRevealLock(undefined)).toBeNull();
    expect(await prepareRevealItems(source, authorizeRevealTestTarget({ ...f.ports, lock: null }))).toEqual({ ok: false, reason: 'lock-unavailable' });
  });
  it('reload after batch 6 resumes from chain holes, not a batch cursor', async () => {
    const f = runFixture(500);
    f.onSend = async ids => { for (const id of ids) { f.latest.add(id); f.finalized.add(id); } if (f.sends.length === 6) f.controller.abort(); };
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('cancelled');
    f.onSend = async ids => { for (const id of ids) { f.latest.add(id); f.finalized.add(id); } };
    expect(result(await runRevealItems(await f.plan(), f.ports, new AbortController().signal)).reason).toBe('complete');
    expect(must(f.sends[6]).ids[0]).toBe(241n); expect(new Set(f.sends.flatMap(s => s.ids)).size).toBe(500);
  }, shLimit(120_000));
  it('reorged receipt remains unresolved and unfinalized counts cannot release cleanup', async () => {
    const f = runFixture();
    f.onSend = async (ids, hash) => { ids.forEach(id => f.latest.add(id)); f.receipts.set(hash, { ...must(f.receipts.get(hash)), block: { number: 101n, hash: digest(999) } }); };
    f.ports.chain.canonical = async block => block.hash !== digest(999);
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('reorg');
    const other = runFixture(); for (let id = 1n; id <= 4n; id++) other.latest.add(id);
    const plan = await other.plan(); expect(plan.counts.latest).toBe(4n); expect(plan.counts.finalizedComplete).toBe(false);
    expect(plan.counts.remainingFinalized).toBe(4n);
  });
  it('durable intent precedes wallet; storage failures cannot cause an unjournaled send', async () => {
    const f = runFixture(); const plan = await f.plan();
    f.ports.store.put = async () => { throw new Error('quota'); };
    expect(result(await runRevealItems(plan, f.ports, f.controller.signal)).reason).toBe('store-failed'); expect(f.sends).toHaveLength(0);
    const g = runFixture();
    g.onSend = async ids => {
      const p = await readRevealProgress(g.ports.store, revealProgressKey(g.identity.chainId, g.identity.token), g.identity.specHash);
      expect(p.intents.at(-1)?.status).toBe('intent'); expect(p.intents.at(-1)?.ids).toEqual(ids.map(String));
      ids.forEach(id => { g.latest.add(id); g.finalized.add(id); });
    };
    expect(result(await runRevealItems(await g.plan(), g.ports, g.controller.signal)).reason).toBe('complete');
  });
});

it('SH202 model: random outcomes, other reveals and reloads never duplicate unresolved ids or exceed approval', async () => {
  const started = performance.now();
  for (let seed = 1; seed <= 24; seed++) {
    let random = seed;
    const next = () => { random = (random * 1664525 + 1013904223) >>> 0; return random % 5; };
    const f = runFixture(7); const unresolved = new Set<bigint>();
    f.onSend = async (ids, hash) => {
      expect(ids.some(id => unresolved.has(id))).toBe(false);
      ids.forEach(id => unresolved.add(id));
      const outcome = next();
      if (outcome === 0) { f.receipts.delete(hash); throw new Error('unknown'); }
      if (outcome === 1) { f.receipts.delete(hash); return; }
      if (outcome === 2) f.receipts.set(hash, { ...must(f.receipts.get(hash)), status: 'reverted' });
      else for (const id of ids) if (outcome === 4 || next() > 1) { f.latest.add(id); f.finalized.add(id); }
      ids.forEach(id => unresolved.delete(id));
    };
    for (let reload = 0; reload < 3; reload++) {
      if (next() === 0) for (let id = 1n; id <= 7n; id++) { f.latest.add(id); f.finalized.add(id); }
      if ([...unresolved].every(id => f.finalized.has(id))) unresolved.clear();
      const prepared = await prepareRevealItems(await f.source(), f.ports);
      if (!prepared.ok) { expect(prepared.reason).toMatch(/unknown-send|receipt-pending/); break; }
      const before = f.sends.length;
      const run = result(await runRevealItems(prepared.value, f.ports, f.controller.signal));
      expect(run.reason.length).toBeGreaterThan(0);
      expect(f.sends.slice(before).reduce((sum, s) => sum + s.gas * s.maxFee, 0n)).toBeLessThanOrEqual(prepared.value.ceilingWei);
      if (run.reason === 'complete') { expect(f.finalized.size).toBe(7); break; }
    }
  }
  expect(performance.now() - started).toBeLessThan(30_000);
}, shLimit(30_000));


describe('af1 run regressions', () => {
  it('D1 advances at inclusion plus one block while finality stays behind', async () => {
    const f = runFixture(41);
    f.onSend = async ids => { ids.forEach(id => f.latest.add(id)); };
    f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot,
      block: tag === 'finalized' ? { number: 99n, hash: digest(99) } : { number: 101n, hash: digest(101) } });
    const run = result(await runRevealItems(await f.plan(), f.ports, f.controller.signal));
    expect(f.sends).toHaveLength(2);
    expect(run.reason).toBe('awaiting-finality');
    expect(run.counts).toMatchObject({ latest: 41n, finalized: 0n, finalizedComplete: false });
  });
  it('D2 adopts the actual wallet nonce instead of refusing its own transaction', async () => {
    const f = runFixture();
    f.onSend = async (ids, hash) => {
      ids.forEach(id => { f.latest.add(id); f.finalized.add(id); });
      f.receipts.set(hash, { ...must(f.receipts.get(hash)), nonce: 99n });
    };
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('complete');
    const p = await readRevealProgress(f.ports.store, revealProgressKey(f.identity.chainId, f.identity.token), f.identity.specHash);
    expect(p.intents[0]?.nonce).toBe('99');
  });
  it('M1 proves every displayed and sent gas limit with successful inner results at that exact limit', async () => {
    const f = runFixture(1); const simulated: bigint[] = [];
    f.ports.estimate = async () => 250_000n;
    f.ports.simulate = async (_call, _account, gas?: bigint) => {
      if (gas !== undefined) simulated.push(gas);
      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: [{ success: gas === undefined || gas >= 400_000n, returnData: '0x' }] });
    };
    const plan = await f.plan();
    expect(plan.batches[0]?.gasLimit).toBeGreaterThanOrEqual(400_000n);
    expect(simulated).toContain(plan.batches[0]?.gasLimit);
    expect(result(await runRevealItems(plan, f.ports, f.controller.signal)).reason).toBe('complete');
    expect(simulated).toContain(f.sends[0]?.gas);
  });
  it('M2 shrinks allowance errors down to one item and preserves unrelated RPC failures', async () => {
    const f = runFixture(4); const estimate = f.ports.estimate;
    f.ports.estimate = async (...args) => {
      if (decodeFunctionData({ abi: multicall3Abi, data: args[0].data }).args[0].length > 1) throw new Error('gas required exceeds allowance (1000000)');
      return estimate(...args);
    };
    expect((await f.plan()).batches.map(b => b.batch.ids.length)).toEqual([1, 1, 1, 1]);
    f.ports.estimate = async () => { throw new Error('RPC disconnected'); };
    expect(await prepareRevealItems(await f.source(), f.ports)).toEqual({ ok: false, reason: 'estimate-failed' });
  });
  it.each([500, 10_000])('M4 bounds read and write work for %s items and completed reload', async n => {
    const f = runFixture(n);
    // Count ids even on HEAD's per-id interface; af1 replaces it with a pinned bulk interface.
    let idReads = 0;
    const read = f.ports.chain.revealed;
    f.ports.chain.revealed = vi.fn(async (collection, ids, block) => { idReads += Array.isArray(ids) ? ids.length : 1; if (idReads > 10 * n) throw new Error('read-ceiling'); return read(collection, ids, block); });
    const receipt = vi.spyOn(f.ports.chain, 'receipt'), estimate = vi.spyOn(f.ports, 'estimate');
    const simulate = vi.spyOn(f.ports, 'simulate'), put = vi.spyOn(f.ports.store, 'put');
    expect(result(await runRevealItems(await f.plan(), f.ports, f.controller.signal)).reason).toBe('complete');
    const b = Math.ceil(n / 40);
    expect(idReads).toBeLessThanOrEqual(8 * n);
    expect(f.ports.chain.revealed).toHaveBeenCalledTimes(4 + 4 * b);
    expect(receipt.mock.calls.length).toBeLessThanOrEqual(b);
    expect(estimate.mock.calls.length).toBeLessThanOrEqual(2 * b);
    expect(simulate.mock.calls.length).toBeLessThanOrEqual(2 * b);
    expect(put.mock.calls.length).toBeLessThanOrEqual(3 * b);
    const before = { idReads, receipt: receipt.mock.calls.length, put: put.mock.calls.length };
    expect((await f.plan()).batches).toHaveLength(0);
    expect(idReads - before.idReads).toBe(2 * n);
    expect(receipt.mock.calls.length).toBe(before.receipt);
    expect(put.mock.calls.length).toBe(before.put);
  }, shLimit(360_000));
});

it('L4 rejects oversized kept text before constructing a Blob', async () => {
  const f = runFixture(); const kept = { format: 'squarehole.reveal-keep/1' as const, key: `${f.identity.chainId}:${f.identity.token}`, ...f.identity,
    artMode: 'open' as const, n: 4, revealRoot: f.snapshot.root, fileName: 'saved.json', savedAt: 0, text: ' '.repeat(64 * 1024 * 1024 + 1) };
  const Original = Blob; let constructions = 0;
  vi.stubGlobal('Blob', class extends Original { constructor(parts: BlobPart[]) { constructions++; super(parts); } });
  try { expect(await loadRevealItems(f.identity, f.identity.creator, kept, f.ports.chain)).toEqual({ ok: false, reason: 'invalid-source' }); expect(constructions).toBe(0); }
  finally { vi.unstubAllGlobals(); }
});

it.each(['unknown', 'intent'] as const)('D2 explicit user release recovers %s only after thirty minutes and charges its cap', async status => {
  const f = runFixture(); const source = await f.source(); const key = revealProgressKey(f.identity.chainId, f.identity.token);
  const progress = await readRevealProgress(f.ports.store, key, f.identity.specHash);
  await saveRevealIntent(f.ports.store, key, progress, { attempt: 'crash', ids: ['1', '2', '3', '4'], account: f.identity.creator, nonce: '0', createdAt: 0, clock: { wall: 0, tick: 0, epoch: 'test', elapsed: 0 }, capWei: '100', status });
  f.nonce = 999n; f.time = UNKNOWN_WAIT_MS - 1;
  expect(await revealRun.releaseUnknownRevealIntent(source, 'crash', f.ports)).toEqual({ ok: false, reason: 'release-too-soon' });
  f.time++;
  expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'unknown-send' });
  expect((await revealRun.releaseUnknownRevealIntent(source, 'crash', f.ports)).ok).toBe(true);
  const prepared = await prepareRevealItems(source, f.ports); if (!prepared.ok) throw new Error(prepared.reason);
  const end = result(await runRevealItems(prepared.value, f.ports, f.controller.signal));
  expect(end.reason).toBe('complete');
  expect(end.reservedWei).toBe(f.sends.reduce((sum, s) => sum + s.gas * s.maxFee, 100n));
  expect(end.reservedWei).toBeLessThanOrEqual(prepared.value.ceilingWei);
});


describe('af1 inclusion and finality transitions', () => {
  it('D1 requires one block after inclusion and finality alone enables finalized counts', async () => {
    const f = runFixture(41); let advanced = false;
    f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot,
      block: tag === 'finalized' ? { number: 99n, hash: digest(99) } : { number: advanced ? 101n : 100n, hash: digest(advanced ? 101 : 100) } });
    f.onSend = async ids => { ids.forEach(id => f.latest.add(id)); };
    f.ports.sleep = async () => { expect(f.sends).toHaveLength(1); advanced = true; };
    // Use the latest set for the inclusion-block read; final is height 99 here.
    f.ports.chain.revealed = async (_c, ids, block) => ids.map(id => (block.number === 99n ? f.finalized : f.latest).has(id));
    const source = await f.source(); const prepared = await prepareRevealItems(source, f.ports); if (!prepared.ok) throw new Error(prepared.reason);
    const end = result(await runRevealItems(prepared.value, f.ports, f.controller.signal));
    expect(advanced).toBe(true); expect(f.sends).toHaveLength(2); expect(end.counts.finalizedComplete).toBe(false);
    f.latest.forEach(id => f.finalized.add(id));
    f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot, block: { number: tag === 'finalized' ? 100n : 101n, hash: digest(tag === 'finalized' ? 100 : 101) } });
    expect(await revealRun.reconcileRevealItems(source, f.ports)).toMatchObject({ ok: true, value: { finalized: 41n, finalizedComplete: true } });
    expect(f.sends).toHaveLength(2);
  });
  it.each([false, true, 'returns'] as const)('D1 invalidates a reorged cache and blocks a removed receipt=%s before retrying holes', async removed => {
    const f = runFixture(41); let reorg = false, final = 99n, sleeps = 0;
    let replaced: Awaited<ReturnType<typeof f.ports.chain.receipt>> = null;
    f.ports.sleep = async () => {
      expect(f.sends).toHaveLength(2); sleeps++;
      if (removed === 'returns' && replaced) f.receipts.set(digest(1), replaced);
      if (removed !== true && sleeps >= 2) final = 102n;
    };

    f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot,
      block: tag === 'finalized' ? { number: final, hash: digest(final === 99n ? 99 : 102) } : { number: reorg ? 103n : 101n, hash: digest(reorg ? 103 : 101) } });
    f.ports.chain.canonical = async block => !(reorg && block.hash === digest(101));
    f.onSend = async (ids, hash) => {
      if (f.sends.length === 3) expect(final).toBe(102n);
      ids.forEach(id => f.latest.add(id));
      if (f.sends.length === 2) {
        reorg = true; f.latest.delete(1n);
        replaced = { ...must(f.receipts.get(digest(1))), block: { number: 102n, hash: digest(102) } };
        if (removed) f.receipts.delete(digest(1));
        else f.receipts.set(digest(1), { ...must(f.receipts.get(digest(1))), block: { number: 102n, hash: digest(102) } });
        f.receipts.set(hash, { ...must(f.receipts.get(hash)), block: { number: 102n, hash: digest(102) } });
      }
    };
    const end = result(await runRevealItems(await f.plan(), f.ports, f.controller.signal));
    // af5 (R4-L3a): the hole is one send more than the two shown: the press stops; the next Prepare shows one.
    expect(end.reason).toBe(removed === true ? 'receipt-pending' : 'plan-changed');
    expect(f.sends).toHaveLength(2);
    if (removed === true) return;
    const again = await f.plan(); expect(again.batches.map(b => b.batch.ids)).toEqual([['1']]);
    expect(result(await runRevealItems(again, f.ports, f.controller.signal)).reason).toBe('complete');
    expect(f.sends).toHaveLength(3); expect(f.sends[2]?.ids).toEqual([1n]);
  });
  it.each([500, 10_000])('M4 held-finality read/write ceilings and constant idle polls for %s items', async n => {
    const f = runFixture(n); let final = 99n;
    f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot,
      block: { number: tag === 'finalized' ? final : 101n, hash: digest(tag === 'finalized' ? (final === 99n ? 99 : 100) : 101) } });
    f.onSend = async ids => { ids.forEach(id => f.latest.add(id)); };
    let idReads = 0; const read = f.ports.chain.revealed;
    f.ports.chain.revealed = vi.fn(async (collection, ids, block) => { idReads += Array.isArray(ids) ? ids.length : 1; if (idReads > 10 * n) throw new Error('read-ceiling'); return read(collection, ids, block); });
    const receipt = vi.spyOn(f.ports.chain, 'receipt'), estimate = vi.spyOn(f.ports, 'estimate');
    const simulate = vi.spyOn(f.ports, 'simulate'), put = vi.spyOn(f.ports.store, 'put');
    const source = await f.source(); const prepared = await prepareRevealItems(source, f.ports); if (!prepared.ok) throw new Error(prepared.reason);
    expect(result(await runRevealItems(prepared.value, f.ports, f.controller.signal)).reason).toBe('awaiting-finality');
    const b = Math.ceil(n / 40);
    expect(idReads).toBe(8 * n); expect(receipt).toHaveBeenCalledTimes(b); expect(put).toHaveBeenCalledTimes(3 * b);
    for (let poll = 0; poll < 3; poll++) expect((await revealRun.reconcileRevealItems(source, f.ports)).ok).toBe(true);
    expect(idReads).toBe(8 * n); expect(receipt).toHaveBeenCalledTimes(b); expect(put).toHaveBeenCalledTimes(3 * b);
    final = 100n; f.latest.forEach(id => f.finalized.add(id));
    expect(await revealRun.reconcileRevealItems(source, f.ports)).toMatchObject({ ok: true, value: { finalizedComplete: true } });
    expect(idReads).toBe(10 * n); expect(f.ports.chain.revealed).toHaveBeenCalledTimes(6 + 4 * b);
    expect(receipt).toHaveBeenCalledTimes(2 * b); expect(estimate).toHaveBeenCalledTimes(2 * b);
    expect(simulate).toHaveBeenCalledTimes(2 * b); expect(put).toHaveBeenCalledTimes(3 * b + 1);
  }, shLimit(360_000));
});

it('D1 tracks finality for an outside reveal without a send intent', async () => {
  const f = runFixture(1); f.latest.add(1n); let final = 100n;
  f.ports.chain.snapshot = async (_i, tag) => ({ ...f.snapshot, block: { number: tag === 'finalized' ? final : 102n, hash: digest(tag === 'finalized' ? (final === 100n ? 100 : 102) : 102) } });
  f.ports.chain.revealed = async (_c, ids, block) => ids.map(id => (block.number === 100n ? f.finalized : f.latest).has(id));
  const source = await f.source(); const prepared = await prepareRevealItems(source, f.ports); if (!prepared.ok) throw new Error(prepared.reason);
  expect(result(await runRevealItems(prepared.value, f.ports, f.controller.signal)).reason).toBe('awaiting-finality');
  final = 102n;
  expect(await revealRun.reconcileRevealItems(source, f.ports)).toMatchObject({ ok: true, value: { finalizedComplete: true } });
  expect(f.sends).toHaveLength(0);
});
it('D2 retains a known hash even when the executor throws after the wallet returned', async () => {
  const f = runFixture();
  installRevealTestSeam(f.ports, { send: async options => { await submitWrite(options); throw new Error('post-send'); } });
  const end = result(await runRevealItems(await f.plan(), f.ports, f.controller.signal));
  expect(end.reason).toBe('receipt-pending');
  const p = await readRevealProgress(f.ports.store, revealProgressKey(f.identity.chainId, f.identity.token), f.identity.specHash);
  expect(p.intents[0]).toMatchObject({ status: 'submitted', hash: digest(1) });
  expect(end.reservedWei).toBe(f.sends.reduce((sum, sent) => sum + sent.gas * sent.maxFee, 0n));
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));


it.each(['original', 'split', 'retry'] as const)('af5 M1 every %s batch send immediately follows the read chain answer', async kind => {
  // SH-203 af5 (R4-L3a): the retry case has three planned transactions, so its retries stay within the press; the split
  // case's second piece is one send more than shown, so it goes out on the next press.
  const f = runFixture(kind === 'original' ? 41 : kind === 'retry' ? 120 : 8);
  const plan = await f.plan();
  if (kind === 'split') {
    const estimate = f.ports.estimate;
    f.ports.estimate = async (...args) => {
      if (decodeFunctionData({ abi: multicall3Abi, data: args[0].data }).args[0].length > 4) throw new Error('gas required exceeds allowance');
      return estimate(...args);
    };
  }
  if (kind === 'retry') f.onSend = async (_ids, hash) => { f.receipts.set(hash, { ...must(f.receipts.get(hash)), status: 'reverted' }); };
  const predecessors = traceRevealSends(f.ports);
  const { presses, last: run } = await runPresses(f, plan);
  expect(presses.every(p => p.sent <= p.shown)).toBe(true);
  expect(presses).toHaveLength(kind === 'split' ? 2 : 1);
  expect(run.reason).toBe(kind === 'retry' ? 'revert-limit' : 'complete');
  expect(f.sends).toHaveLength(kind === 'retry' ? 3 : 2);
  expect(predecessors).toEqual(f.sends.map(() => `read:chainId:${f.identity.chainId}`));
});

describe('SH-203 af5 R4-L3a: one press sends at most the transactions it showed', () => {
  const tooBig = (f: ReturnType<typeof runFixture>, max: number) => {
    const estimate = f.ports.estimate;
    f.ports.estimate = async (...args) => {
      if (decodeFunctionData({ abi: multicall3Abi, data: args[0].data }).args[0].length > max) throw new Error('gas required exceeds allowance');
      return estimate(...args);
    };
  };
  it('a split at send time: the press stops at its one transaction, keeps what it sent, and a new Prepare shows the rest', async () => {
    const f = runFixture(8); const plan = await f.plan(); expect(plan.batches).toHaveLength(1);
    tooBig(f, 4);
    const end = result(await runRevealItems(plan, f.ports, f.controller.signal));
    expect(end.reason).toBe('plan-changed'); expect(f.sends.map(s => s.ids)).toEqual([[1n, 2n, 3n, 4n]]);
    expect(end.reservedWei).toBeGreaterThan(0n); expect(end.reservedWei).toBeLessThanOrEqual(plan.ceilingWei);
    const progress = await readRevealProgress(f.ports.store, revealProgressKey(f.identity.chainId, f.identity.token), f.identity.specHash);
    expect(progress.intents.map(i => i.ids)).toEqual([['1', '2', '3', '4']]);
    const again = await f.plan(); expect(again.batches.map(b => b.batch.ids)).toEqual([['5', '6', '7', '8']]);
    expect(again.spentWei).toBe(BigInt(must(progress.intents[0]).capWei));
    expect(result(await runRevealItems(again, f.ports, f.controller.signal)).reason).toBe('complete'); expect(f.sends).toHaveLength(2);
  });
  it('a retry after a failed batch: the press stops at its one transaction; a new Prepare shows the retry', async () => {
    const f = runFixture(8);
    f.onSend = async (ids, hash) => {
      if (f.sends.length === 1) f.receipts.set(hash, { ...must(f.receipts.get(hash)), status: 'reverted' });
      else for (const id of ids) { f.latest.add(id); f.finalized.add(id); }
    };
    const plan = await f.plan(); expect(plan.batches).toHaveLength(1);
    const end = result(await runRevealItems(plan, f.ports, f.controller.signal));
    expect(end.reason).toBe('plan-changed'); expect(f.sends).toHaveLength(1); expect(end.reservedWei).toBeLessThanOrEqual(plan.ceilingWei);
    const again = await f.plan(); expect(again.batches.map(b => b.batch.ids.length)).toEqual([8]);
    expect(result(await runRevealItems(again, f.ports, f.controller.signal)).reason).toBe('complete'); expect(f.sends).toHaveLength(2);
  });
  // The dropped batch: 'D1 invalidates a reorged cache … before retrying holes' (af1 inclusion and finality transitions).
});

describe('SH-203 af5 R4-L2b: a send with an id released after the node lost it, which lands after all', () => {
  const old = digest(900);
  async function released(f: ReturnType<typeof runFixture>) {
    const key = revealProgressKey(f.identity.chainId, f.identity.token);
    const p = await readRevealProgress(f.ports.store, key, f.identity.specHash);
    await saveRevealIntent(f.ports.store, key, p, { attempt: 'old', ids: ['1', '2', '3', '4'], account: f.identity.creator, capWei: '5000000000000000',
      createdAt: 0, status: 'user-released', hash: old });
  }
  it('the released send counts in the new press’s "Most it can cost", and its ids are planned again', async () => {
    const f = runFixture(); await released(f);
    const plan = await f.plan();
    expect(plan.spentWei).toBe(5_000_000_000_000_000n); expect(plan.batches.map(b => b.batch.ids)).toEqual([['1', '2', '3', '4']]);
    expect(plan.ceilingWei).toBe(plan.spentWei + plan.retryReserveWei + plan.batches.reduce((n, b) => n + b.capWei, 0n));
  });
  it('it lands first, in the same block: the new reveals are refused on chain; the creator pays both, inside the new press’s ceiling', async () => {
    const f = runFixture(); await released(f); const plan = await f.plan();
    // The old transaction is mined before the new one: its reveals land; the new batch's inner reveals fail (no reveal event).
    f.onSend = async () => { for (let id = 1n; id <= 4n; id++) { f.latest.add(id); f.finalized.add(id); } };
    const end = result(await runRevealItems(plan, f.ports, f.controller.signal));
    expect(end.reason).toBe('complete'); expect(f.sends).toHaveLength(1);
    expect(end.reservedWei).toBe(5_000_000_000_000_000n + must(plan.batches[0]).capWei);
    expect(end.reservedWei).toBeLessThanOrEqual(plan.ceilingWei);
  });
  it('it lands before Start: the press sends nothing; only the old send cost', async () => {
    const f = runFixture(); await released(f); const plan = await f.plan();
    for (let id = 1n; id <= 4n; id++) { f.latest.add(id); f.finalized.add(id); }
    const end = result(await runRevealItems(plan, f.ports, f.controller.signal));
    expect(end.reason).toBe('plan-changed'); expect(f.sends).toHaveLength(0); expect(end.reservedWei).toBe(5_000_000_000_000_000n);
  });
});
