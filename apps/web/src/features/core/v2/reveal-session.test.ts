// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { decodeBoxSpecV2, encodeBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2/record-v2';
import { createRevealSession, trustedRevealPresses, type RevealSessionOptions } from './reveal-session';
import { installRevealTestSeam } from './reveal-test-seam.test-support';
import { readRevealProgress, saveRevealIntent, revealProgressKey } from './reveal-items-store';
import { createHiddenOpeningSession, sendHidden, type HiddenIO, type HiddenRoles } from './hidden-draws';
import { addr, digest, must, runFixture } from './reveal-items.test-support';
import type { createRevealRPC } from './reveal-rpc';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { indexedDBRevealStore } from './reveal-indexeddb';
import { rawCidV1 } from '@squarehole/artwork';
import type { RevealIntent } from './reveal-items-store';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, type Hex } from 'viem';
import { boxCollectionAbi, boxTicketsAbi } from '@squarehole/chain/abi';
import { readRevealFile } from './reveal-file';
import { multicall3Abi } from '../../../../../../packages/chain/src/core/v2/reveal-batch-calls-v2';
import { REVEAL_GAS_CAP } from './reveal-items';
// Vitest proxies custom import.meta.env keys through process.env, which normally coerces booleans to strings.
// A temporary plain env object gives this test the build's actual boolean literal. Restore the real env after each case.
let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => { previousEnv = process.env; process.env = { ...previousEnv }; Object.assign(process.env, { SH_SEPOLIA_TRADE: true }); });
afterEach(() => { process.env = previousEnv; });
function fixture(n = 4, withFile = true) {
  const f = runFixture(n); let credit = false;
  const accounts = new Set<(a: readonly `0x${string}`[]) => void>(), chains = new Set<(c: number) => void>();
  const wallet = { signer: { request: f.ports.wallet, walletName: 'test' },
    onAccountsChanged: (fn: (a: readonly `0x${string}`[]) => void) => { accounts.add(fn); return () => { accounts.delete(fn); }; },
    onChainChanged: (fn: (c: number) => void) => { chains.add(fn); return () => { chains.delete(fn); }; } };
  const options = { chainId: f.identity.chainId, account: f.identity.creator, wallet, signal: f.controller.signal,
    box: { record: f.record, spec: decodeBoxSpecV2(f.file.encoded), release: {} }, rpc: {},
    ...(withFile ? { file: new Blob([JSON.stringify(f.file)]) } : {}) } as unknown as RevealSessionOptions;
  const adapter = { identity: f.identity, roles: rolesOfV2(f.record).contracts, chain: f.ports.chain, feeReader: f.ports.feeReader,
    estimate: (...args: Parameters<typeof f.ports.estimate>) => f.ports.estimate(...args),
    simulate: (...args: Parameters<typeof f.ports.simulate>) => f.ports.simulate(...args), canonical: f.ports.chain.canonical,
    transaction: async () => null, assetRead: async () => ({ block: f.snapshot.block, items: new Map(f.file.revealList.items.map(i => [BigInt(i.id),
      { revealed: true, image: i.imageSha256, avatar: i.avatarSha256, model: i.modelSha256 }])) }),
  } as unknown as ReturnType<typeof createRevealRPC>;
  const seam = { adapter, store: f.ports.store, lock: f.ports.lock, clock: f.ports.clock, press: () => { const v = credit; credit = false; return v; }, poll: false,
    fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })) };
  installRevealTestSeam(options, { session: seam });
  return { f, options, seam, accounts, chains, press: () => { credit = true; }, session: () => createRevealSession(options) };
}
it('af2 CDE requires distinct presses and session-issued plans; sender records intent and hash itself', async () => {
  const f = fixture(), s = f.session(); await s.ready;
  await expect(s.prepare()).rejects.toThrow('user-press-required');
  f.press(); const plan = await s.prepare();
  await expect(s.start(plan)).rejects.toThrow('user-press-required');
  f.press(); await expect(s.start({ ...plan })).rejects.toThrow('invalid-plan');
  const request = must(f.options.wallet.signer).request;
  Object.assign(f.options.wallet, { signer: { request: async (r: Parameters<typeof request>[0]) => {
    if (r.method === 'eth_sendTransaction') expect([...f.f.saved.values()].join('')).toContain('"status":"intent"');
    return request(r);
  } } });
  f.press(); expect((await s.start(plan)).reason).toBe('complete');
  expect(await s.exportJournal()).toContain(digest(1));
  s.dispose();
});
it('af2 E release token is one-use and specific; timers cannot chain release prepare start', async () => {
  const f = fixture(1), key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
  const p = await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash);
  await saveRevealIntent(f.f.ports.store, key, p, { attempt: 'old', ids: ['1'], account: f.f.identity.creator, capWei: '123', createdAt: 0, status: 'unknown',
    clock: { wall: 0, tick: 0, epoch: 'test', elapsed: 0 } });
  const s = f.session(); await s.ready;
  f.press(); expect((await s.askRelease('old')).eligible).toBe(false);
  f.f.time = 1_800_000; f.press(); const ask = await s.askRelease('old'); expect(ask.eligible).toBe(true);
  expect(ask).toMatchObject({ account: f.f.identity.creator, ids: ['1'], persistedAt: 0, capWei: 123n });
  await expect(s.confirmRelease(must(ask.token))).rejects.toThrow('user-press-required');
  f.press(); await s.confirmRelease(must(ask.token));
  await expect(s.prepare()).rejects.toThrow('user-press-required');
  f.press(); await expect(s.confirmRelease(must(ask.token))).rejects.toThrow('release-not-allowed');
  f.press(); const plan = await s.prepare(); expect(plan.spentWei).toBe(123n);
  await expect(s.start(plan)).rejects.toThrow('user-press-required'); expect(f.f.sends).toHaveLength(0); s.dispose();
});
it('af2 C unavailable Web Locks and failed durable storage refuse before send', async () => {
  const f = fixture(); f.seam.lock = null; const s = f.session(); await s.ready;
  f.press(); await expect(s.prepare()).rejects.toThrow('lock-unavailable'); expect(f.f.sends).toHaveLength(0); s.dispose();
  const g = fixture(), t = g.session(); await t.ready; g.press(); const plan = await t.prepare();
  g.f.ports.store.put = async () => { throw new Error('quota'); };
  g.press(); expect((await t.start(plan)).reason).toBe('store-failed'); expect(g.f.sends).toHaveLength(0); t.dispose();
});
it.each(['account', 'chain', 'navigation'] as const)('af2 F cancels subsequent wallet requests on %s changes inside the run', async kind => {
  const f = fixture(41), s = f.session(); await s.ready; f.press(); const plan = await s.prepare();
  f.f.onSend = async ids => {
    ids.forEach(id => { f.f.latest.add(id); f.f.finalized.add(id); });
    if (kind === 'account') f.accounts.forEach(fn => fn([addr(99)]));
    if (kind === 'chain') f.chains.forEach(fn => fn(1));
    if (kind === 'navigation') f.f.controller.abort();
  };
  f.press(); await s.start(plan);
  expect(f.f.sends).toHaveLength(1); expect(s.getState().cancelled).toBe(true);
  expect(f.accounts.size).toBe(0); expect(f.chains.size).toBe(0); s.dispose();
});
it('af2 G full box pictures work after kept cleanup without account data and distinguish not-available', async () => {
  const f = fixture(1, false); const item = must(f.f.file.revealList.items[0]);
  const full = new Blob([JSON.stringify({ ...f.f.file, pictures: [{ sha256: item.imageSha256, base64: btoa('rent-free:image:0') },
    { sha256: item.avatarSha256, base64: btoa('rent-free:avatar:0') }], models: [{ sha256: item.modelSha256, base64: btoa('rent-free:model:0') }] })]);
  f.seam.fetch.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response(JSON.stringify({ error: 'feature-disabled' }), { status: 503 }) : new Response(null, { status: 404 }));
  const s = f.session(); await s.ready; expect(s.getState().source).toBe('needs-file'); f.press();
  const result = await s.startPictures(full); expect(result.outcomes[0]?.reason).toBe('not-available');
  const requests = f.seam.fetch.mock.calls;
  expect(JSON.stringify(requests).toLowerCase()).not.toContain(f.f.identity.creator.toLowerCase());
  const post = requests.find(([, init]) => init?.method === 'POST');
  expect(post?.[1]).toMatchObject({ credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
  expect(new TextDecoder().decode(post?.[1]?.body as Uint8Array)).toBe('rent-free:image:0'); s.dispose();
});
it('SH-203 af4 E: the mainnet session checks hosting but has no upload transport', async () => {
  Object.assign(process.env, { SH_SEPOLIA_TRADE: false });
  const f = fixture(1), s = f.session();
  try {
    await s.ready; f.press();
    const result = await s.startPictures(must(f.options.file));
    expect(result.outcomes[0]?.reason).toBe('transport-unavailable');
    expect(f.seam.fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['HEAD', 'HEAD', 'HEAD']);
  } finally { s.dispose(); }
});
it('af2 H legacy openings refuse and page replacement is the shared session', async () => {
  expect(createHiddenOpeningSession).toBe(createRevealSession);
  await expect(sendHidden({} as HiddenRoles, addr(50), { kind: 'open', ticket: 1n, file: {} as never }, {} as HiddenIO)).rejects.toThrow('opening-session-required');
});
it('af2 E synthetic events do not grant a trusted press capability', () => {
  const target = new EventTarget(), gate = trustedRevealPresses(target); target.dispatchEvent(new Event('click'));
  expect(gate.take()).toBe(false); expect(gate.take()).toBe(false); gate.dispose();
});

it('af2 DE exposes and exports an unpersisted known hash and refuses its release', async () => {
  const f = fixture(1), s = f.session(); await s.ready; f.press(); const plan = await s.prepare();
  const put = f.f.ports.store.put;
  f.f.onSend = async () => { f.f.ports.store.put = async () => { throw new Error('quota'); }; };
  f.press(); const result = await s.start(plan); expect(result.reason).toBe('store-failed');
  expect(s.getState().unresolved[0]).toMatchObject({ hash: digest(1), hashDurable: false });
  expect(await s.exportJournal()).toContain(digest(1));
  f.f.ports.store.put = put; f.f.time = 1_800_000;
  f.press(); await expect(s.askRelease(s.getState().unresolved[0]?.attempt ?? '')).rejects.toThrow('release-not-allowed');
  expect(f.f.sends).toHaveLength(1); s.dispose();
});

it('af2 E publishes run and picture progress before actions settle', async () => {
  const f = fixture(41), s = f.session(); await s.ready;
  let running = false, pictures = false;
  const off = s.subscribe(state => {
    if (state.busy && !state.run && state.progress?.counts.latest === 40n) {
      running = true; expect(Object.isFrozen(state.progress.counts)).toBe(true);
    }
    if (state.busy && !state.pictures && state.pictureProgress?.completedItems === 1n) {
      pictures = true; expect(state.pictureProgress.totalItems).toBe(41n);
    }
  });
  f.press(); const plan = await s.prepare(); f.press(); await s.start(plan);
  expect(running).toBe(true);
  f.press(); await s.startPictures(must(f.options.file)); expect(pictures).toBe(true);
  off(); s.dispose();
});

it('SH-203 af1 M2 publishes the items of the batch at the wallet and awaiting its block, read-only', async () => {
  const f = fixture(41), s = f.session(); await s.ready;
  const seen: { phase: string; ids?: readonly string[]; sends: number }[] = [];
  const off = s.subscribe(state => {
    const p = state.progress;
    if (state.busy && p && (seen.at(-1)?.phase !== p.phase || seen.at(-1)?.ids !== p.ids)) seen.push({ phase: p.phase, ...(p.ids ? { ids: p.ids } : {}), sends: f.f.sends.length });
  });
  f.press(); const plan = await s.prepare(); f.press(); expect((await s.start(plan)).reason).toBe('complete');
  off();
  const first = Array.from({ length: 40 }, (_, i) => String(i + 1));
  // Each batch is named at the wallet (before its send) and while it awaits its block (after its send).
  expect(seen.filter(e => e.phase === 'wallet').map(e => [e.ids, e.sends])).toEqual([[first, 0], [['41'], 1]]);
  expect(seen.filter(e => e.phase === 'receipt').every(e => e.ids?.join() === (e.sends === 1 ? first : ['41']).join())).toBe(true);
  expect(seen.some(e => e.phase === 'receipt')).toBe(true);
  // Between batches nothing is named, and the fact is frozen.
  expect(seen.filter(e => e.phase === 'running').every(e => e.ids === undefined)).toBe(true);
  expect(seen.filter(e => e.ids).every(e => Object.isFrozen(e.ids))).toBe(true);
  // The fact adds no send: one per batch, as before.
  expect(f.f.sends.map(x => x.ids.length)).toEqual([40, 1]);
  s.dispose();
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));

it('af3 R3-L1 af4 R4-L1 an observer scans zero records during another session 250-batch run and 250 after unlock', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  // Journal replay cost depends on the 250 records, not the IDs per record. A gas-limited
  // provider makes 250 genuine one-item batches without repeating the separate 10,000-item proof workload.
  const f = fixture(250), factory = new IDBFactory();
  const assetRead = f.seam.adapter.assetRead;
  f.seam.adapter.assetRead = async (...args) => {
    const result = await assetRead(...args);
    return { ...result, items: new Map([...result.items].map(([id, item]) => [id, { ...item, revealed: f.f.finalized.has(id) }])) };
  };
  f.f.ports.estimate = async call => decodeFunctionData({ abi: multicall3Abi, data: call.data }).args[0].length === 1 ? 300_000n : REVEAL_GAS_CAP;
  f.seam.store = indexedDBRevealStore(factory, 'af3-observer');
  const observerStore = indexedDBRevealStore(factory, 'af3-observer');
  let scanned = 0;
  const read = must(observerStore.records).read;
  must(observerStore.records).read = async (...args) => { const result = await read(...args); scanned += result?.records?.length ?? 0; return result; };
  const observerOptions = { ...f.options, file: undefined };
  installRevealTestSeam(observerOptions, { session: { ...f.seam, store: observerStore, poll: true } });
  const writer = f.session(), observer = createRevealSession(observerOptions);
  const pollObserver = async () => {
    let busy = false;
    const settled = new Promise<void>(resolve => {
      const off = observer.subscribe(state => { if (state.busy) busy = true; else if (busy) { off(); resolve(); } });
    });
    await vi.advanceTimersByTimeAsync(5_000); await settled;
  };
  try {
    await Promise.all([writer.ready, observer.ready]);
    expect(observer.getState().counts?.finalized).toBe(0n);
    f.f.onSend = async ids => {
      ids.forEach(id => { f.f.latest.add(id); f.f.finalized.add(id); });
      await pollObserver();
      if (scanned > 0) f.f.controller.abort(); // Stop the failing HEAD replay at the first excess scan.
    };
    f.press(); const plan = await writer.prepare(); f.press(); const run = await writer.start(plan);
    expect(scanned).toBe(0); expect(run.reason).toBe('complete'); expect(f.f.sends).toHaveLength(250);
    expect(observer.getState().reason).toBe('running-elsewhere');
    Object.assign(f.f.snapshot.block, { number: 101n, hash: digest(101) });
    await pollObserver(); expect(scanned).toBe(250);
    expect(observer.getState().counts).toMatchObject({ finalized: 250n, latest: 250n, finalizedComplete: true });
    expect(observer.getState().reason).toBeUndefined();
    await pollObserver(); expect(scanned).toBe(250);
    f.press(); await expect(observer.start(plan)).rejects.toThrow('invalid-plan');
    await pollObserver(); expect(observer.getState().reason).toBe('invalid-plan');
  } finally { writer.dispose(); observer.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); }
}, shLimit(120_000));

it('af4 R4-L2 retries failed item reconciliation at unchanged heads on the next scheduled poll', async () => {
  vi.useFakeTimers(); const f = fixture(1); f.seam.poll = true;
  f.f.ports.chain.snapshot = async () => ({ ...f.f.snapshot, block: { ...f.f.snapshot.block } });
  f.f.ports.chain.heads = async () => ({ latest: f.f.snapshot.block, finalized: f.f.snapshot.block });
  const read = vi.spyOn(f.f.ports.chain, 'revealed'), s = f.session();
  try {
    await s.ready; expect(s.getState().counts?.finalized).toBe(0n);
    f.f.finalized.add(1n); f.f.latest.add(1n);
    Object.assign(f.f.snapshot.block, { number: 101n, hash: digest(101) });
    read.mockRejectedValueOnce(new Error('transient-item-read'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.getState().reason).toBe('read-failed'); expect(s.getState().counts?.finalized).toBe(0n);
    read.mockClear(); await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalled();
    expect(s.getState().counts).toMatchObject({ finalized: 1n, latest: 1n, finalizedComplete: true });
  } finally { s.dispose(); vi.useRealTimers(); }
});

it('af4 R4-L1 unchanged-head observation clears only contention', async () => {
  vi.useFakeTimers(); const f = fixture(1); f.seam.poll = true;
  f.f.ports.chain.heads = async () => ({ latest: f.f.snapshot.block, finalized: f.f.snapshot.block });
  const s = f.session();
  try {
    await s.ready;
    await must(f.f.ports.lock).run(revealProgressKey(f.f.identity.chainId, f.f.identity.token), async () => {
      await vi.advanceTimersByTimeAsync(5_000); expect(s.getState().reason).toBe('running-elsewhere');
    });
    await vi.advanceTimersByTimeAsync(5_000); expect(s.getState().reason).toBeUndefined();
    f.press(); await expect(s.start({} as Awaited<ReturnType<typeof s.prepare>>)).rejects.toThrow('invalid-plan');
    await vi.advanceTimersByTimeAsync(10_000); expect(s.getState().reason).toBe('invalid-plan');
  } finally { s.dispose(); vi.useRealTimers(); }
});

it('af4 R4-M1 checks the read chain early and at the boundary and stops the next send after an endpoint switch', async () => {
  const f = fixture(41); let chainId = f.f.identity.chainId;
  const chain = vi.spyOn(f.f.ports.chain, 'chainId').mockImplementation(async () => chainId);
  const s = f.session();
  try {
    await s.ready; f.press(); const plan = await s.prepare(); expect(chain).toHaveBeenCalledTimes(1);
    chain.mockClear(); f.f.onSend = async ids => {
      ids.forEach(id => { f.f.latest.add(id); f.f.finalized.add(id); }); chainId = 1;
    };
    f.press(); expect((await s.start(plan)).reason).toBe('read-chain-changed');
    expect(chain).toHaveBeenCalledTimes(3); expect(f.f.sends).toHaveLength(1);
    expect(f.f.sends[0]?.ids).toHaveLength(40); expect(f.f.latest.has(41n)).toBe(false);
  } finally { s.dispose(); }
});

it.each(['own-final', 'outside', 'before-journal', 'included', 'outside-after-failure', 'reverted', 'noncanonical'] as const)(
  'af3 pictures send transaction hints only for final receipt successes: %s', async kind => {
  const f = fixture(1, false), item = must(f.f.file.revealList.items[0]);
  f.f.latest.add(1n); f.f.finalized.add(1n);
  const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
  if (!['outside', 'before-journal'].includes(kind)) {
    const intent: RevealIntent = { attempt: 'own', ids: ['1'], account: f.f.identity.creator, createdAt: 0, capWei: '100', hash: digest(77),
      status: kind === 'included' ? 'included' : kind === 'reverted' ? 'reverted' : 'finalized',
      succeeded: kind === 'reverted' ? [] : ['1'], emitted: kind === 'outside-after-failure' || kind === 'reverted' ? [] : ['1'],
      receiptStatus: kind === 'reverted' ? 'reverted' : 'success', block: { number: kind === 'included' ? '101' : '99', hash: digest(99) } };
    await saveRevealIntent(f.f.ports.store, key, await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash), intent);
  }
  if (kind === 'noncanonical') { f.f.ports.chain.canonical = async b => b.hash !== digest(99); f.seam.adapter.canonical = f.f.ports.chain.canonical; }
  const bytes = { image: 'rent-free:image:0', avatar: 'rent-free:avatar:0', model: 'rent-free:model:0' };
  const hashes = { image: item.imageSha256, avatar: item.avatarSha256, model: item.modelSha256 };
  const full = new Blob([JSON.stringify({ ...f.f.file, pictures: ['image', 'avatar'].map(role => ({ sha256: hashes[role as 'image'], base64: btoa(bytes[role as 'image']) })),
    models: [{ sha256: hashes.model, base64: btoa(bytes.model) }] })]);
  f.seam.fetch.mockImplementation(async (url, init) => {
    if (init?.method === 'HEAD') return new Response(null, { status: 404 });
    const role = (Object.keys(bytes) as (keyof typeof bytes)[]).find(role => String(url).endsWith(`/${role}`) || String(url).endsWith(rawCidV1(hashes[role])));
    if (!role) throw new Error('unexpected-asset');
    return init?.method === 'POST' ? new Response(JSON.stringify({ cid: rawCidV1(hashes[role]), stored: true })) : new Response(bytes[role]);
  });
  const s = f.session();
  try {
    await s.ready; f.press(); await s.startPictures(full);
    const posts = f.seam.fetch.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(posts).toHaveLength(3);
    for (const [, init] of posts) expect(new Headers(init?.headers).get('X-SH-Reveal-Tx')).toBe(kind === 'own-final' ? digest(77) : null);
  } finally { s.dispose(); }
});

it.each(['own-final', 'not-final', 'outside', 'closed-without-reveal'] as const)(
  'af3 hidden picture hints require the final opening receipt and its matching reveal event: %s', async kind => {
  const f = fixture(1, false), item = must(f.f.file.revealList.items[0]);
  const encodedSpec = encodeBoxSpecV2({ ...decodeBoxSpecV2(f.f.file.encoded), artMode: 2 });
  Object.assign(f.f.identity, { specHash: keccak256(encodedSpec) });
  Object.assign(f.f.record, { specHash: f.f.identity.specHash });
  Object.assign(f.f.snapshot, { specHash: f.f.identity.specHash, encodedSpec, triggers: 1 });
  Object.assign(f.options.box, { spec: decodeBoxSpecV2(encodedSpec) });
  const full = new Blob([JSON.stringify({ ...f.f.file.revealList, revealRoot: f.f.snapshot.root,
    pictures: [{ sha256: item.imageSha256, base64: btoa('rent-free:image:0') }] })]);
  const selected = must((await readRevealFile(full, f.f.snapshot.root, 1n)).revealOf(1n));
  const receipt = { hash: digest(77), from: f.f.identity.creator, to: addr(8), nonce: 1n, value: 0n,
    input: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'openDraw', args: [1n, f.f.identity.creator, selected] }),
    block: { number: kind === 'not-final' ? 101n : 99n, hash: digest(99) }, status: 'success' as const,
    logs: kind === 'closed-without-reveal' ? [] : [{ address: addr(5),
      topics: encodeEventTopics({ abi: boxCollectionAbi, eventName: 'Revealed', args: { id: 1n } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
        [selected.traitsPacked, selected.imageHash, selected.avatarHash, selected.modelHash]) }] };
  f.seam.adapter.hidden = { snapshot: async () => ({ block: f.f.snapshot.block, requested: 1n, timestamp: 100n }),
    draw: async () => ({ id: 1n, itemId: 1n, drawer: f.f.identity.creator, status: 'opened', posted: true, drawerCode: '0x', revealFallbackAt: 0n }),
    canonical: async () => true, receipt: async () => kind === 'outside' ? null : receipt };
  if (kind !== 'outside') {
    const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
    await saveRevealIntent(f.f.ports.store, key, await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash),
      { attempt: 'opening', ticket: '1', ids: ['1'], account: f.f.identity.creator, createdAt: 0, capWei: '100', status: 'submitted', hash: digest(77) });
  }
  f.seam.fetch.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response(JSON.stringify({ cid: rawCidV1(item.imageSha256), stored: true }))
    : init?.method === 'GET' ? new Response('rent-free:image:0') : new Response(null, { status: 404 }));
  const s = f.session();
  try {
    await s.ready; f.press(); await s.startPictures(full);
    const posts = f.seam.fetch.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(posts).toHaveLength(1);
    expect(new Headers(posts[0]?.[1]?.headers).get('X-SH-Reveal-Tx')).toBe(kind === 'own-final' ? digest(77) : null);
    if (kind === 'own-final') expect(JSON.parse(await s.exportJournal())).toMatchObject({ intents: [{ status: 'closed', succeeded: ['1'], emitted: ['1'], receiptStatus: 'success' }] });
  } finally { s.dispose(); }
});


it.each([['observer', false], ['observer', true], ['reload', false], ['reload', true]] as const)(
  'af5 M2 %s publishes recovery facts with hash=%s', async (kind, hashed) => {
  vi.useFakeTimers();
    const f = fixture(2); f.seam.poll = true;
    f.f.ports.chain.snapshot = async () => ({ ...f.f.snapshot, block: { ...f.f.snapshot.block } });
    f.f.ports.chain.heads = async () => ({ latest: { ...f.f.snapshot.block }, finalized: { ...f.f.snapshot.block } });
    let s = f.session(); await s.ready;
    f.press(); await s.prepare(); expect(s.getState().plan).toBeDefined();
    if (kind === 'reload') s.dispose();
    const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
    await saveRevealIntent(f.f.ports.store, key, await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash),
      { attempt: 'unresolved', ids: ['1'], account: f.f.identity.creator, createdAt: 0, capWei: '123',
        status: hashed ? 'submitted' : 'unknown', ...(hashed ? { hash: digest(77) } : {}) });
    f.f.ports.chain.receipt = async () => { throw new Error('receipt-read-failed'); };
    f.f.latest.add(2n); f.f.finalized.add(2n);
    Object.assign(f.f.snapshot.block, { number: 101n, hash: digest(101) });
    if (kind === 'reload') { s = f.session(); await s.ready; }
    else await vi.advanceTimersByTimeAsync(5_000);
    try {
      expect(s.getState().unresolved).toMatchObject([{ attempt: 'unresolved', status: hashed ? 'submitted' : 'unknown', ...(hashed ? { hash: digest(77) } : {}) }]);
      expect(s.getState().counts).toMatchObject({ finalized: 1n, latest: 1n });
      expect(s.getState().reason).toBe(hashed ? 'read-failed' : 'unknown-send');
      expect(s.getState().plan).toBeUndefined();
      expect(await s.exportJournal()).toContain('unresolved');
      f.press();
      if (hashed) await expect(s.askRelease('unresolved')).rejects.toThrow('release-not-allowed');
      else {
        expect((await s.askRelease('unresolved')).eligible).toBe(false);
        f.f.time = 1_800_000; f.press(); const decision = await s.askRelease('unresolved');
        expect(decision.eligible).toBe(true); f.press(); await s.confirmRelease(must(decision.token));
        expect(s.getState().unresolved).toEqual([]);
      }
    } finally { s.dispose(); vi.useRealTimers(); }
});

it.each(['action-first', 'contention-first'] as const)('af5 L1 %s keeps action failure across contention and clears recovered read failure', async order => {
  vi.useFakeTimers(); const f = fixture(1); f.seam.poll = true;
  f.f.ports.chain.heads = async () => ({ latest: { ...f.f.snapshot.block }, finalized: { ...f.f.snapshot.block } });
  const s = f.session();
  const failAction = async () => { f.press(); await expect(s.start({} as Awaited<ReturnType<typeof s.prepare>>)).rejects.toThrow('invalid-plan'); };
  try {
    await s.ready;
    if (order === 'action-first') await failAction();
    await must(f.f.ports.lock).run(revealProgressKey(f.f.identity.chainId, f.f.identity.token), async () => {
      await vi.advanceTimersByTimeAsync(5_000); expect(s.getState().reason).toBe('running-elsewhere');
      if (order === 'contention-first') await failAction();
    });
    await vi.advanceTimersByTimeAsync(5_000); expect(s.getState().reason).toBe('invalid-plan');
    f.press(); await s.prepare(); // A new successful action clears its own failure.
    const heads = f.f.ports.chain.heads;
    f.f.ports.chain.heads = async () => { throw new Error('read-failed'); };
    await vi.advanceTimersByTimeAsync(5_000); expect(s.getState().reason).toBe('read-failed');
    f.f.ports.chain.heads = heads;
    await vi.advanceTimersByTimeAsync(5_000); expect(s.getState().reason).toBeUndefined();
  } finally { s.dispose(); vi.useRealTimers(); }
});

it.each(['heads', 'revision', 'press', 'cancel'] as const)('af5 L2 resets failure backoff on %s', async reset => {
  vi.useFakeTimers(); const f = fixture(1); f.seam.poll = true;
  f.f.ports.chain.heads = async () => ({ latest: { ...f.f.snapshot.block }, finalized: { ...f.f.snapshot.block } });
  f.f.ports.chain.snapshot = async () => ({ ...f.f.snapshot, block: { ...f.f.snapshot.block } });
  const s = f.session();
  try {
    await s.ready;
    Object.assign(f.f.snapshot.block, { number: 101n, hash: digest(101) });
    const starts: number[] = [], start = Date.now();
    f.f.ports.chain.revealed = async () => { starts.push(Date.now() - start); throw new Error('read-failed'); };
    for (const delay of [5_000, 5_000, 10_000, 20_000]) await vi.advanceTimersByTimeAsync(delay);
    expect([...new Set(starts)]).toEqual([5_000, 10_000, 20_000, 40_000]);
    if (reset === 'heads') Object.assign(f.f.snapshot.block, { number: 102n, hash: digest(102) });
    if (reset === 'revision') {
      const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
      await saveRevealIntent(f.f.ports.store, key, await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash),
        { attempt: 'changed', ids: ['1'], account: f.f.identity.creator, createdAt: 0, capWei: '0', status: 'refused' });
    }
    if (reset === 'press') { f.press(); await expect(s.start({} as Awaited<ReturnType<typeof s.prepare>>)).rejects.toThrow('invalid-plan'); }
    if (reset === 'cancel') s.cancel();
    starts.length = 0;
    const immediate = reset === 'press' || reset === 'cancel';
    await vi.advanceTimersByTimeAsync(immediate ? 5_000 : 40_000);
    const first = starts[0]; expect(first).toBe(immediate ? 45_000 : 80_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect([...new Set(starts)]).toEqual([first, must(first) + 5_000]);
  } finally { s.dispose(); vi.useRealTimers(); }
});

it('af5 L2 waits for the surviving failed refresh branch before releasing busy or retrying', async () => {
  vi.useFakeTimers(); const f = fixture(1); f.seam.poll = true;
  f.f.ports.chain.heads = async () => ({ latest: { ...f.f.snapshot.block }, finalized: { ...f.f.snapshot.block } });
  f.f.ports.chain.snapshot = async () => ({ ...f.f.snapshot, block: { ...f.f.snapshot.block } });
  const s = f.session(); let finish!: () => void;
  const sibling = new Promise<void>(resolve => { finish = resolve; });
  try {
    await s.ready; Object.assign(f.f.snapshot.block, { number: 101n, hash: digest(101) });
    let calls = 0;
    f.f.ports.chain.revealed = async () => { if (++calls === 1) throw new Error('read-failed'); await sibling; return [false]; };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.getState().busy).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000); expect(calls).toBe(2);
    finish(); await vi.advanceTimersByTimeAsync(0); expect(s.getState().busy).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999); expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1); expect(calls).toBe(4);
  } finally { finish(); s.dispose(); vi.useRealTimers(); }
});


it('SH-203 af4 C: returned live hash with failing journal is published and never certifies zero', async () => {
  vi.useFakeTimers();
  const f = fixture(1); f.seam.poll = true;
  const get = f.f.ports.store.get, put = f.f.ports.store.put;
  const s = f.session();
  try {
    await s.ready; expect(s.getState().outstandingCurrent).toBe(true);
    f.press(); const plan = await s.prepare();
    f.f.onSend = async () => {
      f.f.ports.store.get = async () => { throw new Error('storage-unavailable'); };
      f.f.ports.store.put = async () => { throw new Error('storage-unavailable'); };
    };
    f.press(); await expect(s.start(plan)).rejects.toThrow('storage-unavailable');
    expect(f.f.sends).toHaveLength(1);
    expect(s.getState().actionReason).toBe('storage-unavailable');
    expect(s.getState().unresolved[0]).toMatchObject({ ids: ['1'], hash: digest(1), hashDurable: false });
    expect(Object.isFrozen(s.getState().unresolved[0]?.clock)).toBe(true);
    expect(s.getState().outstandingCurrent).toBe(false);
    f.f.ports.store.get = get; f.f.ports.store.put = put;
    f.f.latest.add(1n); f.f.finalized.add(1n);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.getState().outstandingCurrent).toBe(true);
    expect(s.getState().unresolved).toEqual([]);
    // An unrelated real action failure is still visible after observations recover.
    expect(s.getState().actionReason).toBe('storage-unavailable');
  } finally { s.dispose(); vi.useRealTimers(); }
});

it('SH-203 af4 C: failed publication after finality cannot retain a positive outstanding count', async () => {
  vi.useFakeTimers();
  const f = fixture(1); f.seam.poll = true;
  f.f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.f.snapshot, block: { ...f.f.snapshot.block,
    ...(tag === 'latest' ? { number: f.f.snapshot.block.number + 1n, hash: digest(103) } : {}) } });
  const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
  await saveRevealIntent(f.f.ports.store, key, await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash),
    { attempt: 'earlier-send', ids: ['1'], account: f.f.identity.creator, createdAt: 0, capWei: '100', status: 'submitted', hash: digest(77) });
  const s = f.session();
  try {
    await s.ready;
    expect(s.getState().unresolved).toHaveLength(1);
    expect(s.getState().outstandingCurrent).toBe(true);
    const get = f.f.ports.store.get;
    f.f.latest.add(1n); f.f.finalized.add(1n);
    Object.assign(f.f.snapshot.block, { number: 101n, hash: digest(102) });
    const lock = must(f.f.ports.lock), run = lock.run.bind(lock); let calls = 0;
    lock.run = async (key, work) => run(key, async () => {
      calls++;
      if (calls === 3) f.f.ports.store.get = async () => { throw new Error('storage-unavailable'); };
      return work();
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.getState().counts?.finalizedComplete).toBe(true);
    expect(s.getState().unresolved).toEqual([]);
    expect(s.getState().outstandingCurrent).toBe(false);
    f.f.ports.store.get = get; lock.run = run;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.getState().outstandingCurrent).toBe(true);
    expect(s.getState().unresolved).toEqual([]);
  } finally { s.dispose(); vi.useRealTimers(); }
});

it('SH-203 af4 D: successful polling clears refused Prepare contention and expired finality, not failures', async () => {
  vi.useFakeTimers();
  const f = fixture(1); f.seam.poll = true;
  f.f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.f.snapshot, block: { ...f.f.snapshot.block,
    ...(tag === 'latest' ? { number: f.f.snapshot.block.number + 1n, hash: digest(103) } : {}) } }); const s = f.session();
  try {
    await s.ready;
    await must(f.f.ports.lock).run(revealProgressKey(f.f.identity.chainId, f.f.identity.token), async () => {
      f.press(); await expect(s.prepare()).rejects.toThrow('running-elsewhere');
    });
    expect(s.getState().outstandingCurrent).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.getState().actionReason).toBeUndefined(); expect(s.getState().outstandingCurrent).toBe(true);
    f.f.onSend = async ids => { ids.forEach(id => f.f.latest.add(id)); };
    f.press(); const plan = await s.prepare(); f.press(); await s.start(plan);
    expect(s.getState().actionReason).toBe('awaiting-finality');
    f.f.finalized.add(1n);
    Object.assign(f.f.snapshot.block, { number: 101n, hash: digest(102) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.getState().counts?.finalizedComplete).toBe(true);
    expect(s.getState().actionReason).toBeUndefined();
  } finally { s.dispose(); vi.useRealTimers(); }
});

it('SH-203 af4 D: latest included batch reports confirmation, not waiting for inclusion', async () => {
  const f = fixture(1), s = f.session();
  const phases: string[] = [];
  try {
    await s.ready;
    s.subscribe(state => { if (state.progress?.counts.latest === 1n) phases.push(state.progress.phase); });
    f.press(); const plan = await s.prepare(); f.press(); await s.start(plan);
    expect(phases).toContain('confirmation');
    expect(phases.slice(phases.indexOf('confirmation'))).not.toContain('receipt');
  } finally { s.dispose(); }
});


it('SH-203 af4 D: picture-lock contention is a picture outcome, not revealing', async () => {
  const f = fixture(1), s = f.session();
  try {
    await s.ready;
    const key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
    await must(f.f.ports.lock).run(`${key}:pictures`, async () => {
      f.press(); await expect(s.startPictures(must(f.options.file))).rejects.toThrow('pictures-running-elsewhere');
    });
    expect(s.getState().actionReason).toBe('pictures-running-elsewhere');
    expect(f.f.sends).toHaveLength(0);
  } finally { s.dispose(); }
});


it('SH-203 af4 D: a partially revealed batch still reports its known inclusion', async () => {
  const f = fixture(2), s = f.session();
  let partialConfirmation = false;
  try {
    await s.ready;
    f.f.onSend = async ids => {
      const id = ids[0]; if (id !== undefined) { f.f.latest.add(id); f.f.finalized.add(id); }
    };
    s.subscribe(state => {
      if (state.progress?.counts.latest === 1n && state.progress.ids?.length === 2 && state.progress.phase === 'confirmation') partialConfirmation = true;
    });
    f.press(); const plan = await s.prepare(); f.press(); expect((await s.start(plan)).reason).toBe('plan-changed');
    expect(partialConfirmation).toBe(true);
    // af5 (R4-L3a): the hole is one send more than the press showed; a new Prepare shows it and the next press sends it.
    expect(f.f.sends.map(send => send.ids)).toEqual([[1n, 2n]]);
    f.press(); const again = await s.prepare(); expect(again.batches.map(b => b.batch.ids)).toEqual([['2']]);
    f.press(); expect((await s.start(again)).reason).toBe('complete');
    expect(f.f.sends.map(send => send.ids)).toEqual([[1n, 2n], [2n]]);
  } finally { s.dispose(); }
});

/**
 * SH-203 af5: a send with an id whose receipt never came (the node dropped it), as an earlier run saved it: submitted,
 * with its id, its limit and its items. (A run here would wait 30 minutes of real time for its receipt.)
 */
async function droppedSend(n = 4) {
  const f = fixture(n), key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
  const p = await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash);
  await saveRevealIntent(f.f.ports.store, key, p, { attempt: 'dropped', ids: ['1', '2', '3', '4'].slice(0, n), account: f.f.identity.creator, capWei: '4000000',
    createdAt: 0, status: 'submitted', hash: digest(1) });
  const s = f.session(); await s.ready;
  const attempt = must(s.getState().unresolved[0]).attempt;
  const adapter = f.seam.adapter as unknown as { transaction: (hash: Hex) => Promise<unknown> };
  const ask = async () => { f.press(); return s.askRelease(attempt); };
  return { f, s, attempt, adapter, ask };
}
const known = { from: addr(50), to: addr(1), nonce: 0n, value: 0n, blockNumber: null };

it('SH-203 af5 R4-L2b: a send with an id is released only after a whole wait in which every read found it gone', async () => {
  const { f, s, attempt, adapter, ask } = await droppedSend();
  try {
    expect(s.getState().unresolved[0]).toMatchObject({ hash: digest(1), status: 'submitted', transaction: null });
    // While the node knows the transaction, or has a receipt for it: no release, whatever the time.
    adapter.transaction = async () => known;
    await expect(ask()).rejects.toThrow('release-not-allowed');
    adapter.transaction = async () => null;
    f.f.receipts.set(digest(1), { hash: digest(1), from: f.f.identity.creator, block: f.f.snapshot.block, status: 'success', logs: [], nonce: 0n, to: addr(1), input: '0x', value: 0n });
    await expect(ask()).rejects.toThrow('release-not-allowed');
    f.f.receipts.delete(digest(1));
    // Gone at this read: the wait starts; reads every 100 s for 30 minutes all find it gone.
    const first = await ask(); expect(first).toMatchObject({ eligible: false, waitRemainingMs: 1_800_000, token: null });
    for (let n = 0; n < 17; n++) { f.f.time += 100_000; expect((await ask()).eligible).toBe(false); }
    f.f.time += 100_000; const decision = await ask();
    expect(decision.eligible).toBe(true); expect(decision.capWei).toBeGreaterThan(0n);
    f.press(); await s.confirmRelease(must(decision.token));
    const p = await readRevealProgress(f.f.ports.store, revealProgressKey(f.f.identity.chainId, f.f.identity.token), f.f.identity.specHash);
    expect(p.intents.find(i => i.attempt === attempt)).toMatchObject({ status: 'user-released', hash: digest(1) });
    expect(s.getState().unresolved).toEqual([]);
    // The items are planned again, with the released send's limit in what the new press can cost.
    f.press(); const again = await s.prepare();
    expect(again.batches.map(b => b.batch.ids)).toEqual([['1', '2', '3', '4']]); expect(again.spentWei).toBe(decision.capWei);
    expect(f.f.sends).toHaveLength(0);
  } finally { s.dispose(); }
}, shLimit(60_000));

it('SH-203 af5 R4-L2b: a failed read, a read that finds it, or a gap of over two minutes starts the wait again; a confirm after that is refused', async () => {
  const { f, s, adapter, ask } = await droppedSend();
  try {
    await ask();
    for (let n = 0; n < 18; n++) { f.f.time += 100_000; await ask(); }
    const eligible = await ask(); expect(eligible.eligible).toBe(true);
    // A failed read is never absence: it ends the window, and the confirm of the earlier ask is refused.
    adapter.transaction = async () => { throw new Error('The request took too long to respond.'); };
    await expect(ask()).rejects.toThrow('release-not-allowed');
    adapter.transaction = async () => null;
    f.press(); await expect(s.confirmRelease(must(eligible.token))).rejects.toThrow('release-not-allowed');
    expect(await ask()).toMatchObject({ eligible: false, waitRemainingMs: 1_800_000 });
    // A gap of more than two minutes between reads: the wait starts again.
    f.f.time += 100_000; expect((await ask()).waitRemainingMs).toBe(1_700_000);
    f.f.time += 200_000; expect((await ask()).waitRemainingMs).toBe(1_800_000);
    // A read that finds the transaction ends it too.
    adapter.transaction = async () => known; await expect(ask()).rejects.toThrow('release-not-allowed');
    adapter.transaction = async () => null; expect((await ask()).waitRemainingMs).toBe(1_800_000);
    expect(s.getState().unresolved).toHaveLength(1); expect(f.f.sends).toHaveLength(0);
  } finally { s.dispose(); }
}, shLimit(60_000));

it('SH-203 af5 R4-L7b: the outstanding list is certified only after a run that ends complete or waiting for finality', async () => {
  const f = fixture(8), s = f.session();
  try {
    await s.ready; f.press(); const plan = await s.prepare(); expect(s.getState().outstandingCurrent).toBe(true);
    const estimate = f.f.ports.estimate;
    f.f.ports.estimate = async (...args) => {
      if (decodeFunctionData({ abi: multicall3Abi, data: args[0].data }).args[0].length > 4) throw new Error('gas required exceeds allowance');
      return estimate(...args);
    };
    f.press(); expect((await s.start(plan)).reason).toBe('plan-changed');
    expect(s.getState().outstandingCurrent).toBe(false);
    f.press(); const again = await s.prepare(); f.press(); expect((await s.start(again)).reason).toBe('complete');
    expect(s.getState().outstandingCurrent).toBe(true);
  } finally { s.dispose(); }
});

it('SH-203 af5 R4-L7c: a session disposed while the wallet answers asks the wallet nothing more', async () => {
  const f = fixture(), s = f.session();
  await s.ready; f.press(); const plan = await s.prepare();
  const asked: string[] = []; let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const request = f.f.ports.wallet;
  Object.assign(f.options.wallet, { signer: { walletName: 'test', request: async (r: Parameters<typeof request>[0]) => {
    asked.push(r.method); if (asked.length === 1) await held; return request(r);
  } } });
  f.press(); const run = s.start(plan).catch((error: unknown) => error);
  await vi.waitFor(() => expect(asked).toEqual(['eth_chainId']));
  s.dispose(); release(); await run;
  expect(asked).toEqual(['eth_chainId']); expect(f.f.sends).toHaveLength(0);
});

it('SH-203 af6 C-L1: a send is absent on its row only when the transaction read and the receipt read each answered nothing', async () => {
  const f = fixture(4), key = revealProgressKey(f.f.identity.chainId, f.f.identity.token);
  const p = await readRevealProgress(f.f.ports.store, key, f.f.identity.specHash);
  // A send made seconds ago: the site's node has not had it yet (the transaction read answers null) and its receipt read fails.
  await saveRevealIntent(f.f.ports.store, key, p, { attempt: 'new', ids: ['1', '2', '3', '4'], account: f.f.identity.creator, capWei: '4000000',
    createdAt: 0, status: 'submitted', hash: digest(1) });
  const receipt = f.f.ports.chain.receipt;
  f.f.ports.chain.receipt = async () => { throw new Error('The request took too long to respond.'); };
  const s = f.session();
  try {
    await s.ready;
    const row = () => must(s.getState().unresolved[0]);
    expect(row()).toMatchObject({ hash: digest(1), transaction: null });
    expect(row().absent).toBeUndefined();
    // Both reads answer nothing: absent.
    f.f.ports.chain.receipt = receipt;
    f.press(); await s.askRelease('new');
    expect(row().absent).toBe(true);
  } finally { s.dispose(); }
  // The transaction read fails while the receipt read answers nothing: not absent either (a new session's first read).
  const adapter = f.seam.adapter as unknown as { transaction: (hash: Hex) => Promise<unknown> };
  adapter.transaction = async () => { throw new Error('The request took too long to respond.'); };
  const t = f.session();
  try {
    await t.ready;
    expect(must(t.getState().unresolved[0]).hash).toBe(digest(1));
    expect(must(t.getState().unresolved[0]).absent).toBeUndefined();
  } finally { t.dispose(); }
});

it('SH-203 af6 C-L3 (A5b): read again as on a reload, a released send with an id keeps its limit in the spent total and the cost', async () => {
  const { f, s, attempt, ask } = await droppedSend();
  let cap: bigint | undefined;
  try {
    await ask();
    for (let n = 0; n < 18; n++) { f.f.time += 100_000; await ask(); }
    const decision = await ask(); expect(decision.eligible).toBe(true); cap = decision.capWei;
    f.press(); await s.confirmRelease(must(decision.token));
  } finally { s.dispose(); }
  // A reload: a new session over a new store object on the same saved record (each store keeps its own read cache).
  const saved = f.f.saved;
  f.seam.store = { get: async (k: string) => saved.get(k) ?? null, put: async (k: string, v: string) => { saved.set(k, v); } };
  const t = f.session();
  try {
    await t.ready;
    const p = await readRevealProgress(f.seam.store, revealProgressKey(f.f.identity.chainId, f.f.identity.token), f.f.identity.specHash);
    expect(p.intents.find(i => i.attempt === attempt)).toMatchObject({ status: 'user-released', hash: digest(1) });
    f.press(); const plan = await t.prepare();
    expect(plan.spentWei).toBe(must(cap));
    expect(plan.ceilingWei).toBe(must(cap) + plan.retryReserveWei + plan.batches.reduce((n, b) => n + b.capWei, 0n));
    expect(plan.batches.map(b => b.batch.ids)).toEqual([['1', '2', '3', '4']]);
  } finally { t.dispose(); }
}, shLimit(60_000));

it('SH-203 af7 D-N1: a Release press publishes its own read to the row before a refusal; an absent read keeps the mark', async () => {
  const { f, s, attempt, adapter, ask } = await droppedSend();
  const row = () => must(s.getState().unresolved.find(r => r.attempt === attempt));
  try {
    expect(row().absent).toBe(true);
    // An ask whose read finds the transaction: refused, and right away (no poll runs here) the row is not absent.
    adapter.transaction = async () => known;
    await expect(ask()).rejects.toThrow('release-not-allowed');
    expect(row().absent).toBeUndefined(); expect(row().transaction).toMatchObject({ nonce: 0n });
    // Absent again: a whole wait, then an eligible ask.
    adapter.transaction = async () => null;
    await ask(); expect(row().absent).toBe(true);
    for (let n = 0; n < 18; n++) { f.f.time += 100_000; await ask(); }
    const eligible = await ask(); expect(eligible.eligible).toBe(true);
    // A confirm whose read fails: refused, and right away the row is not absent and its transaction is unread.
    adapter.transaction = async () => { throw new Error('The request took too long to respond.'); };
    f.press(); await expect(s.confirmRelease(must(eligible.token))).rejects.toThrow('release-not-allowed');
    expect(row().absent).toBeUndefined(); expect(row().transaction).toBeUndefined();
    // The control: a confirm refused for another reason (its window was replaced after a gap) whose read was absent keeps the mark.
    adapter.transaction = async () => null;
    await ask();
    for (let n = 0; n < 18; n++) { f.f.time += 100_000; await ask(); }
    const first = await ask(); expect(first.eligible).toBe(true);
    f.f.time += 200_000; expect((await ask()).eligible).toBe(false);
    f.press(); await expect(s.confirmRelease(must(first.token))).rejects.toThrow('release-not-allowed');
    expect(row().absent).toBe(true); expect(row().transaction).toBeNull();
    expect(f.f.sends).toHaveLength(0);
  } finally { s.dispose(); }
}, shLimit(60_000));
