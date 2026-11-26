/**
 * TA-22 fix round 1: the hook's run against the in-memory chain (test-support/create-send-fake.ts). Leaving Create stops
 * its run: the step already sent finishes and its hash is kept, no later step is sent until Continue, and a Create page
 * opened meanwhile starts no second runner. The page and the hook share one resume decision (`resumes`).
 */
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { CreateSendPanel } from './CreateSendPanel';
import { IDBFactory } from 'fake-indexeddb';
import { keepReveal, readKept, REVEAL_KEEP_FORMAT, keptKey } from './reveal-keep';
import { decodeFunctionData, keccak256, type Hex } from 'viem';
import { factoryV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2Source } from '../../core/v2/indexer-v2';
import { OWNER } from '../test-support/fixtures';
import { required } from '../../core/v2/test-support/required';
import { prepareCreateV2, specOfRun, type CreateReadsV2 } from './create-send';
import { clearRunV2, loadRunV2, saveRunV2 } from './create-send-store';
import { DEMO_LISTINGS } from './listings';
import { encodeBoxSpecV2 } from './spec-types';
import { CHAIN, addr, config, kinds, setup } from './test-support/create-send-fake';
import { NATIVE_TOKEN } from './listings';
import { starterItemsOf, type ShopChoice } from './shop';
import { resumesRun, useCreateSend, CreateSendScope } from './useCreateSend';

/** SH-218 rail 2: no Create option switched off (the switches' own cases: create-options-send.test.ts). */
const NO_SWITCHES = async (): Promise<void> => undefined;

const SOURCE = {
  network: 'local', origin: 'http://127.0.0.1:1', rpc: 'http://127.0.0.1:1',
  manifest: { chainId: CHAIN.chainId, releases: [{ factory: { address: CHAIN.factory }, listingRegistry: { address: CHAIN.listingRegistry }, implementations: { coordinator: { address: CHAIN.coordinatorImplementation } } }] },
} as unknown as V2Source;

/** The fake chain with the first receipt held until `release()` (the approval's, here). */
function heldChain() {
  const t = setup('depth-reward', {}, { firstIn: '100' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held: Hex | null = null;
  const reads: CreateReadsV2 = { ...t.fake.reads, wait: async (hash) => {
    held ??= hash;
    if (hash === held) await gate;
    return t.fake.reads.wait(hash);
  } };
  t.fake.holdNext = true;
  return { ...t, reads, release };
}
const sends = (fake: ReturnType<typeof setup>['fake']) => fake.wallet.mock.calls.filter(([request]) => request.method === 'eth_sendTransaction').length;

beforeEach(() => clearRunV2());
afterEach(() => { cleanup(); clearRunV2(); });

describe('TA-22 fix round 1: leaving Create', () => {
  it('an old start callback after unmount cannot prepare or request the wallet', async () => {
    const { spec, fake } = setup('gas-guzzlers');
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads }));
    const start = hook.result.current.start;
    hook.unmount();
    await start();
    expect(fake.wallet).not.toHaveBeenCalled();
    expect(loadRunV2()).toBeNull();
  });

  it('leaving during wallet preflight prevents later wallet requests, including the send', async () => {
    const { spec, fake } = setup('gas-guzzlers');
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const requests: string[] = [];
    const request = async (call: Parameters<typeof fake.wallet>[0]) => {
      requests.push(call.method);
      if (call.method === 'eth_chainId') await pending;
      return fake.wallet(call);
    };
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: request, listings: DEMO_LISTINGS, reads: fake.reads }));
    let running!: Promise<void>;
    act(() => { running = hook.result.current.start(); });
    await waitFor(() => expect(requests).toContain('eth_chainId'));
    hook.unmount();
    const before = [...requests];
    finish();
    await running;
    expect(requests).toEqual(before);
    expect(kinds(fake)).toEqual([]);
  });

  it('unmount while the approval’s receipt is pending: its hash is kept, nothing later is sent, Continue goes on', async () => {
    const { spec, fake, reads, release } = heldChain();
    const props = { createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads };
    const first = renderHook(() => useCreateSend(props));
    let running!: Promise<void>;
    act(() => { running = first.result.current.start(); });
    await waitFor(() => expect(kinds(fake)).toEqual(['approve']));
    const hash = loadRunV2()?.sent.approve;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    first.unmount();
    release();
    await running;
    // The approval was mined; createBox waits for a press of Continue on the page.
    expect(kinds(fake)).toEqual(['approve']);
    expect(loadRunV2()?.sent).toEqual({ approve: hash });

    const again = renderHook(() => useCreateSend(props));
    await waitFor(() => expect(again.result.current.view.phase).toBe('stopped'));
    expect(again.result.current.resumes).toBe(true);
    expect(sends(fake)).toBe(1);
    await act(async () => { await again.result.current.start(); });
    expect(again.result.current.view.phase).toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
  });

  it('a Create page opened while the left run’s receipt is pending shows it stopping and starts no second runner', async () => {
    const { spec, fake, reads, release } = heldChain();
    const props = { createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads };
    const first = renderHook(() => useCreateSend(props));
    let running!: Promise<void>;
    act(() => { running = first.result.current.start(); });
    await waitFor(() => expect(kinds(fake)).toEqual(['approve']));
    first.unmount();

    const again = renderHook(() => useCreateSend(props));
    await waitFor(() => expect(again.result.current.view).toMatchObject({ phase: 'running', stopping: true }));
    await act(async () => { await again.result.current.start(); });
    expect(sends(fake)).toBe(1);
    release();
    await running;
    await waitFor(() => expect(again.result.current.view.phase).toBe('stopped'));
    expect(kinds(fake)).toEqual(['approve']);
    await act(async () => { await again.result.current.start(); });
    expect(again.result.current.view.phase).toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
  });
});

describe('SH-192 abandoned reveal copies', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const keep = async (run: import('./create-send').CreateRunV2, _created: () => Promise<boolean>, attempt: string) => {
    await keepReveal({ format: REVEAL_KEEP_FORMAT, key: keptKey(run.chainId, run.token), chainId: run.chainId, token: run.token,
      creator: run.creator, specHash: keccak256(run.encoded), revealRoot: specOfRun(run).revealRoot, artMode: 'open', n: 12, fileName: 'reveal.json', text: 'secret salts', savedAt: 1, attempt });
  };
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('navigator', { storage: { persist: async () => true } });
  });

  it('leaving during keep removes the unsent copy once the write finishes and never asks the wallet', async () => {
    const { spec, fake } = setup('gas-guzzlers');
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let wrote!: () => void;
    const written = new Promise<void>((resolve) => { wrote = resolve; });
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads,
      keep: async (run, created, attempt) => { await keep(run, created, attempt); wrote(); await pending; } }));
    let running!: Promise<void>;
    act(() => { running = hook.result.current.start(); });
    try {
      await act(async () => written);
      const run = loadRunV2();
      if (!run) throw new Error('Missing run');
      hook.unmount();
      finish();
      await running;
      expect(fake.wallet).not.toHaveBeenCalled();
      expect(await readKept(run.chainId, run.token)).toBeNull();
    } finally { hook.unmount(); finish(); await running; }
  });

  it.each(['during absence read', 'before stop', 'before older writer starts'] as const)(
    'two tabs resume one unsent run: B is durable %s and A cannot abandon its copy', async (order) => {
      const { spec, fake } = setup('gas-guzzlers');
      const saved = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
      saveRunV2(saved);
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => { resolve = done; });
        return { promise, resolve };
      };
      const aWritten = deferred(); const finishAKeep = deferred();
      const absenceRead = deferred(); const finishAbsence = deferred();
      const bDurable = deferred(); const finishB = deferred();
      let holdAbsence = false;
      const aReads = { ...fake.reads, code: async (address: Parameters<typeof fake.reads.code>[0]) => {
        if (holdAbsence) { absenceRead.resolve(); await finishAbsence.promise; return '0x' as const; }
        return fake.reads.code(address);
      } };
      const aScope = new CreateSendScope(); const bScope = new CreateSendScope();
      const props = { createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS };
      const a = renderHook(() => useCreateSend({ ...props, scope: aScope, reads: aReads,
        keep: async (run, created, attempt) => { await keep(run, created, attempt); aWritten.resolve(); await finishAKeep.promise; } }));
      const b = renderHook(() => useCreateSend({ ...props, scope: bScope, reads: fake.reads, keep,
        beforeWallet: async () => { bDurable.resolve(); await finishB.promise; return false; } }));
      await waitFor(() => { expect(a.result.current.resumes).toBe(true); expect(b.result.current.resumes).toBe(true); });
      let runA: Promise<void> | undefined; let runB: Promise<void> | undefined;
      const startB = async () => { act(() => { runB = b.result.current.start(); }); await act(async () => bDurable.promise); };
      try {
        if (order === 'before older writer starts') await startB();
        act(() => { runA = a.result.current.start(); });
        await act(async () => aWritten.promise);
        if (order === 'before stop') await startB();
        act(() => a.result.current.stop());
        holdAbsence = true;
        finishAKeep.resolve();
        if (order === 'during absence read') {
          await act(async () => absenceRead.promise);
          await startB();
        }
        const durable = await readKept(saved.chainId, saved.token);
        expect(durable?.owners?.length).toBeGreaterThan(0);
        finishAbsence.resolve();
        await act(async () => runA);
        const remaining = await readKept(saved.chainId, saved.token);
        expect(remaining).toMatchObject({ attempt: durable?.attempt, text: durable?.text });
        expect(remaining?.discardWhenAbsent).not.toBe(true);
        expect(remaining?.abandoned).not.toBe(true);
        expect(remaining?.owners).toHaveLength(1);
        expect(fake.wallet).not.toHaveBeenCalled();
      } finally {
        finishAKeep.resolve(); finishAbsence.resolve(); finishB.resolve();
        a.unmount(); b.unmount();
        await Promise.all([runA, runB]);
      }
    },
  );

  it('an ambiguous wallet error keeps the copy and pending marker even after Start over', async () => {
    const { spec, fake } = setup('gas-guzzlers');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let uncertain = true;
    const request = async (call: Parameters<typeof fake.wallet>[0]) => {
      if (uncertain && call.method === 'eth_sendTransaction') throw new Error('connection lost after possible send');
      return fake.wallet(call);
    };
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: request, listings: DEMO_LISTINGS, reads: fake.reads, keep }));
    await act(async () => hook.result.current.start());
    const run = loadRunV2();
    if (!run) throw new Error('Missing run');
    expect(run.walletPending).toBe(true);
    // A rejected retry must not erase uncertainty about the earlier send.
    fake.rejectNext = true;
    uncertain = false;
    await act(async () => hook.result.current.start());
    expect(loadRunV2()?.walletPending).toBe(true);
    await act(async () => hook.result.current.forget());
    expect(await readKept(run.chainId, run.token)).not.toBeNull();
  });

  it('an offline absence check records the unsent abandonment for a later app check', async () => {
    const { spec, fake } = setup('gas-guzzlers');
    let offline = false;
    const reads = { ...fake.reads, code: async (address: Parameters<typeof fake.reads.code>[0]) => {
      if (offline) throw new Error('offline');
      return fake.reads.code(address);
    } };
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads, keep,
      beforeWallet: async () => { offline = true; return false; } }));
    await act(async () => hook.result.current.start());
    const run = loadRunV2();
    if (!run) throw new Error('Missing run');
    expect(fake.wallet).not.toHaveBeenCalled();
    expect(await readKept(run.chainId, run.token)).toMatchObject({ discardWhenAbsent: true });
  });

  it('a declined first wallet request and Start over remove the unsent secret copy', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('navigator', { storage: { persist: async () => true } });
    const { spec, fake } = setup('gas-guzzlers');
    fake.rejectNext = true;
    const keep = async (run: import('./create-send').CreateRunV2, _created: () => Promise<boolean>, attempt: string) => {
      await keepReveal({ format: REVEAL_KEEP_FORMAT, key: keptKey(run.chainId, run.token), chainId: run.chainId, token: run.token,
        creator: run.creator, specHash: keccak256(run.encoded), revealRoot: spec.revealRoot, artMode: 'open', n: 12, fileName: 'reveal.json', text: 'secret salts', savedAt: 1, attempt });
    };
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads, keep }));
    await act(async () => hook.result.current.start());
    const run = hook.result.current.run;
    if (!run) throw new Error('Missing prepared run');
    expect(kinds(fake)).toEqual([]);
    expect(hook.result.current.view).toMatchObject({ phase: 'failed', message: 'Declined in the wallet.' });
    await act(async () => hook.result.current.forget());
    await waitFor(async () => expect(await readKept(run.chainId, run.token)).toBeNull());
  });
});

describe('SH-256: a saved run with approvals only is not resumed once the draft differs', () => {
  it('the page reopened with another spec: the run is forgotten, the press prepares the draft, the mined approval is not asked again', async () => {
    const { spec, fake, reads, release } = heldChain();
    const props = { createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads };
    const first = renderHook(() => useCreateSend(props));
    let running!: Promise<void>;
    act(() => { running = first.result.current.start(); });
    await waitFor(() => expect(kinds(fake)).toEqual(['approve']));
    first.unmount();
    release();
    await running;
    expect(Object.keys(loadRunV2()?.sent ?? {})).toEqual(['approve']);

    // The creator changed the draft (a fee, here the name stands for it) and came back: the Overview shows this spec.
    const changed = { ...spec, tokenName: `${spec.tokenName} changed` };
    const again = renderHook(() => useCreateSend({ ...props, spec: changed }));
    await waitFor(() => expect(again.result.current.view.phase).toBe('idle'));
    expect(again.result.current.resumes).toBe(false);
    expect(again.result.current.otherBox).toBeNull();
    expect(loadRunV2()).toBeNull();
    await act(async () => { await again.result.current.start(); });
    // The new run's approval is read on the chain (the allowance is in) and not asked again; createBox is the draft's.
    expect(kinds(fake).slice(0, 2)).toEqual(['approve', 'createBox']);
    expect(kinds(fake).filter((kind) => kind === 'approve')).toHaveLength(1);
    const created = fake.sent.find((call) => call.to.toLowerCase() === CHAIN.factory.toLowerCase());
    const [sentSpec] = decodeFunctionData({ abi: factoryV2Abi, data: required(created).data }).args as unknown as readonly [{ readonly tokenName: string }];
    expect(sentSpec.tokenName).toBe(changed.tokenName);
    expect(specOfRun(required(loadRunV2())).tokenName).toBe(changed.tokenName);
  });
});

describe('SH-256 E1b: a pending request records what it was', () => {
  it('an approval request the wallet never answered: kept as pending with its kind; another spec then prepares the draft', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const hanging = vi.fn(async (request: Parameters<typeof fake.wallet>[0]) => (request.method === 'eth_sendTransaction' ? new Promise<never>(() => undefined) : fake.wallet(request)));
    // A tab whose request never returns, then a fresh document (its own scope: the hanging press belongs to the old page).
    const props = { createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: hanging as unknown as typeof fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads, scope: new CreateSendScope() };
    const first = renderHook(() => useCreateSend(props));
    act(() => { void first.result.current.start(); });
    await waitFor(() => expect(loadRunV2()?.walletPending).toBe(true));
    expect(loadRunV2()?.walletPendingKind).toBe('approve');
    first.unmount();
    const changed = { ...spec, tokenName: `${spec.tokenName} changed` };
    const fresh = new CreateSendScope();
    const again = renderHook(() => useCreateSend({ ...props, spec: changed, wallet: fake.wallet, scope: fresh }));
    await waitFor(() => expect(again.result.current.view.phase).toBe('idle'));
    expect(again.result.current.resumes).toBe(false);
    // H5: the press prepares B: the wallet's createBox carries B's spec (A's approval was never answered or mined).
    await act(async () => { await again.result.current.start(); });
    const created = fake.sent.find((call) => call.to.toLowerCase() === CHAIN.factory.toLowerCase());
    const [sentSpec] = decodeFunctionData({ abi: factoryV2Abi, data: required(created).data }).args as unknown as readonly [{ readonly tokenName: string }];
    expect(sentSpec.tokenName).toBe(changed.tokenName);
    expect(specOfRun(required(loadRunV2())).tokenName).toBe(changed.tokenName);
  });

  it('H4: an approval hash while an older createBox request of the run is still uncertain keeps the createBox mark', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    // The run's createBox was asked and never answered; the allowance is short, so Continue asks the approval first.
    saveRunV2({ ...run, walletPending: true, walletPendingKind: 'createBox' });
    let sends = 0;
    const wallet = vi.fn(async (request: Parameters<typeof fake.wallet>[0]) => {
      if (request.method === 'eth_sendTransaction' && ++sends === 2) fake.rejectNext = true;
      return fake.wallet(request);
    });
    const tab = new CreateSendScope();
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: wallet as unknown as typeof fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads, scope: tab }));
    await waitFor(() => expect(hook.result.current.view.phase).toBe('stopped'));
    await act(async () => { await hook.result.current.start(); });
    // The approval went (its hash came back), the createBox request was declined: the older createBox stays uncertain.
    expect(kinds(fake)).toEqual(['approve']);
    expect(loadRunV2()).toMatchObject({ walletPending: true, walletPendingKind: 'createBox' });
  });
});

describe('SH-256 round 2b: the panel and the press speak of the same run (H1, H3)', () => {
  const declineSecond = (fake: ReturnType<typeof setup>['fake']) => {
    let sends = 0;
    return vi.fn(async (request: Parameters<typeof fake.wallet>[0]) => {
      if (request.method === 'eth_sendTransaction' && ++sends === 2) fake.rejectNext = true;
      return fake.wallet(request);
    }) as unknown as typeof fake.wallet;
  };

  it('H1: createBox declined after a mined approval, the draft changed in the same document: the old run leaves the view and the storage; the panel shows the draft’s plan', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const scope = new CreateSendScope();
    const wallet = declineSecond(fake);
    let draft = spec;
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec: draft, owner: OWNER, wallet, listings: DEMO_LISTINGS, reads: fake.reads, scope }));
    await act(async () => { await hook.result.current.start(); });
    expect(hook.result.current.view).toMatchObject({ phase: 'failed', message: 'Declined in the wallet.' });
    expect(Object.keys(loadRunV2()?.sent ?? {})).toEqual(['approve']);
    draft = { ...spec, tokenName: `${spec.tokenName} changed` };
    hook.rerender();
    await waitFor(() => expect(hook.result.current.view.phase).toBe('idle'));
    expect(hook.result.current.run).toBeNull();
    expect(hook.result.current.resumes).toBe(false);
    expect(loadRunV2()).toBeNull();
    const planned = ['Approve 1 P', 'Create the box'];
    render(<CreateSendPanel view={hook.result.current.view} planned={planned} runTicker={hook.result.current.otherBox} blockedTitle={null} />);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(planned);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Create · 2 transactions');
  });

  it('H1 after a superseded restore: the next restore finds nothing stored, and an edit in the same document still clears the old run', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const stored = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    saveRunV2(stored);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reads: CreateReadsV2 = { ...fake.reads, code: async (address) => { await gate; return fake.reads.code(address); } };
    const tab = new CreateSendScope();
    const wallet = declineSecond(fake);
    let draft = spec;
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec: draft, owner: OWNER, wallet, listings: DEMO_LISTINGS, reads, scope: tab }));
    await waitFor(() => expect(hook.result.current.run).not.toBeNull());
    // The chain read is in flight; the tab's run goes away and the restore runs again (back from the cache): nothing stored.
    clearRunV2();
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    act(() => { window.dispatchEvent(event); });
    await waitFor(() => expect(hook.result.current.run).toBeNull());
    release();
    await act(async () => { await gate; });
    // H1's sequence: approval mined, createBox declined, the draft edited in this document.
    await act(async () => { await hook.result.current.start(); });
    expect(hook.result.current.view).toMatchObject({ phase: 'failed', message: 'Declined in the wallet.' });
    draft = { ...spec, tokenName: `${spec.tokenName} changed` };
    hook.rerender();
    await waitFor(() => expect(hook.result.current.view.phase).toBe('idle'));
    expect(hook.result.current.run).toBeNull();
    expect(loadRunV2()).toBeNull();
  });

  it('H3: a press while the chain read of a stored run is held goes on with that run when its createBox may be pending', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    saveRunV2({ ...run, walletPending: true, walletPendingKind: 'createBox' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reads: CreateReadsV2 = { ...fake.reads, code: async (address) => { await gate; return fake.reads.code(address); } };
    const changed = { ...spec, tokenName: `${spec.tokenName} changed` };
    const tab = new CreateSendScope();
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec: changed, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads, scope: tab }));
    // Before the chain answers: the stored run is known from the tab's storage, and a press goes on with it.
    await waitFor(() => expect(hook.result.current.run).not.toBeNull());
    expect(hook.result.current.resumes).toBe(true);
    let pressed!: Promise<void>;
    act(() => { pressed = hook.result.current.start(); });
    release();
    await act(async () => { await pressed; });
    const created = fake.sent.find((call) => call.to.toLowerCase() === CHAIN.factory.toLowerCase());
    const [sentSpec] = decodeFunctionData({ abi: factoryV2Abi, data: required(created).data }).args as unknown as readonly [{ readonly tokenName: string }];
    expect(sentSpec.tokenName).toBe(spec.tokenName);
    expect(specOfRun(required(loadRunV2())).tokenName).toBe(spec.tokenName);
  });

  it('H3: a failed chain read keeps the stored run (never "no run")', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    saveRunV2({ ...run, walletPending: true, walletPendingKind: 'createBox' });
    const reads: CreateReadsV2 = { ...fake.reads, code: async () => { throw new Error('rpc down'); } };
    const tab = new CreateSendScope();
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec: { ...spec, tokenName: 'Other' }, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads, scope: tab }));
    await waitFor(() => expect(hook.result.current.view.phase).toBe('failed'));
    expect(hook.result.current.run?.coordinator).toBe(run.coordinator);
    expect(hook.result.current.resumes).toBe(true);
    expect(loadRunV2()?.coordinator).toBe(run.coordinator);
  });

  it('H3: a document back from the back/forward cache reads the stored run again', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const tab = new CreateSendScope();
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads, scope: tab }));
    await waitFor(() => expect(hook.result.current.view.phase).toBe('idle'));
    expect(hook.result.current.run).toBeNull();
    // Another document of the tab stored a run whose createBox may be pending, then this one came back from the cache.
    const run = await prepareCreateV2(fake.reads, CHAIN, { ...spec, tokenName: 'Other' }, OWNER);
    saveRunV2({ ...run, walletPending: true, walletPendingKind: 'createBox' });
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    act(() => { window.dispatchEvent(event); });
    await waitFor(() => expect(hook.result.current.run?.coordinator).toBe(run.coordinator));
    expect(hook.result.current.resumes).toBe(true);
  });
});

describe('TA-22 fix round 1: one resume decision', () => {
  it('resumes only the saved run: this draft’s own, one whose createBox was sent or is pending, or one the chain shows created', () => {
    const { spec } = setup('depth-reward', {}, { firstIn: '100' });
    const other = setup('depth-reward', {}, { firstIn: '200' }).spec;
    const run = { chainId: CHAIN.chainId, creator: OWNER, factory: CHAIN.factory, encoded: '0x' as Hex, cs: '0x' as Hex, hs: '0x' as Hex,
      coordinator: CHAIN.factory, token: CHAIN.factory, bootstrapQ: '1', sent: {} };
    const own = { ...run, encoded: encodeBoxSpecV2(spec) };
    expect(resumesRun(null, CHAIN.chainId, OWNER, spec, false)).toBe(false);
    expect(resumesRun(own, CHAIN.chainId, OWNER, spec, false)).toBe(true);
    // A declined first request saved nothing sent: an edited draft is prepared again (and checked by the page).
    expect(resumesRun(own, CHAIN.chainId, OWNER, other, false)).toBe(false);
    expect(resumesRun({ ...own, walletPending: true }, CHAIN.chainId, OWNER, other, false)).toBe(true);
    // SH-256: approvals alone never resume a run whose spec is not the draft's: the press prepares the draft, so the
    // createBox the wallet is asked for is the one the Overview shows (the mined approval stays an allowance).
    const approved = { ...own, sent: { approve: `0x${'1'.repeat(64)}` as Hex } };
    expect(resumesRun(approved, CHAIN.chainId, OWNER, other, false)).toBe(false);
    expect(resumesRun(approved, CHAIN.chainId, OWNER, spec, false)).toBe(true);
    // Its createBox sent (mined or not), or its box on the chain: the run is finished, whatever the draft says now.
    expect(resumesRun({ ...approved, sent: { ...approved.sent, createBox: `0x${'2'.repeat(64)}` as Hex } }, CHAIN.chainId, OWNER, other, false)).toBe(true);
    expect(resumesRun(own, CHAIN.chainId, OWNER, other, true)).toBe(true);
    // E1b: a request still pending is past the approvals only when it may have been createBox (its kind recorded; a run
    // saved before the kind was recorded counts as one, the careful side).
    const pendingApproval = { ...own, walletPending: true, walletPendingKind: 'approve' };
    expect(resumesRun(pendingApproval, CHAIN.chainId, OWNER, spec, false)).toBe(true);
    expect(resumesRun(pendingApproval, CHAIN.chainId, OWNER, other, false)).toBe(false);
    expect(resumesRun({ ...own, walletPending: true, walletPendingKind: 'createBox' }, CHAIN.chainId, OWNER, other, false)).toBe(true);
    expect(resumesRun({ ...own, walletPending: true }, CHAIN.chainId, OWNER, other, false)).toBe(true);
    // No chain or no creator: nothing to resume.
    expect(resumesRun(own, null, OWNER, spec, false)).toBe(false);
    expect(resumesRun(own, CHAIN.chainId, null, spec, false)).toBe(false);
  });
});

describe('SH-ARWEAVE-PICTURES-WEB fix round 1: the pictures before the wallet', () => {
  it('the press prepares the run, then hands its own spec to beforeWallet before any wallet request; false stops it there, the next press goes on', async () => {
    const { spec, fake } = setup('rug-rugs');
    const seen: { spec: unknown; sends: number }[] = [];
    let answer = false;
    const beforeWallet = async (given: unknown) => { seen.push({ spec: given, sends: sends(fake) }); return answer; };
    const { result } = renderHook(() => useCreateSend({ createOptionsCheck: NO_SWITCHES, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads, beforeWallet }));
    await act(async () => { await result.current.start(); });
    expect(seen).toEqual([{ spec: specOfRun({ encoded: encodeBoxSpecV2(spec) }), sends: 0 }]);
    expect(result.current.view.phase).toBe('stopped');
    expect(sends(fake)).toBe(0);
    expect(result.current.resumes).toBe(true);
    answer = true;
    await act(async () => { await result.current.start(); });
    expect(seen).toHaveLength(2);
    expect(result.current.view.phase).toBe('done');
    expect(kinds(fake)).toEqual(['createBox']);
  });
});

// XR-SH-SHOP-CREATE F2 (fix round 1): the page's own check said every starter item was the creator's; one left the
// wallet before Create. The press reads every item again first: nothing reaches the wallet, and the line says how many.
describe('SH-SHOP-CREATE fix round 1: Create reads the starter items again', () => {
  it('an item that left after the page’s check: the run stops before the wallet, saying how many are missing', async () => {
    const shop: ShopChoice = { ...(config('curio-corner').shop as ShopChoice), curator: 'none', collections: [
      { address: '0x00000000000000000000000000000000000000a1', tier: 0, ids: '1-10' }, { address: '0x00000000000000000000000000000000000000b2', tier: 2, ids: '' }] };
    const t = setup('curio-corner', { pricing: NATIVE_TOKEN, shop });
    t.fake.state.owners.set('0x00000000000000000000000000000000000000a1:4', addr(0xbeefn));
    const props = { createOptionsCheck: NO_SWITCHES, source: SOURCE, spec: t.spec, starters: starterItemsOf(shop) ?? [], owner: OWNER, wallet: t.fake.wallet, listings: DEMO_LISTINGS, reads: t.fake.reads };
    const view = renderHook(() => useCreateSend(props));
    await act(async () => { await view.result.current.start(); });
    expect(view.result.current.view).toMatchObject({ phase: 'failed', message: 'Not in your wallet: 1 starter item' });
    expect(sends(t.fake)).toBe(0);
    expect(kinds(t.fake)).toEqual([]);
  });
});
