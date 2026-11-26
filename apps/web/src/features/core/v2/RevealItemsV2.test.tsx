/**
 * SH-203: the creator's Reveal items view against a doubled reveal session. The double keeps the real session's public
 * interface and its press rule (an action is granted only while a click is being dispatched, once per click), and lets
 * each test put the session in any state. The view must give every state a face, call Prepare and Start (and a release's
 * ask and confirm) on separate presses only, keep export and release reachable while reading fails, and make the session
 * again when the wallet, its network or the file changes, and after a failed first read.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { getAddress, zeroHash, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createRevealSession, ReleaseDecision, RevealSessionOptions, RevealSessionState, UnresolvedReveal } from './reveal-session';
import { double } from './test-support/reveal-session-double';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { RevealItemsV2 } from './RevealItemsV2';
import { REVEAL_WORDS as W, REASON_FALLBACK, REASON_WORDS, ethUp, reasonText } from './reveal-words';
import { SOURCE_RETRY_MS } from './RevealRecoveryV2';

const a = (n: bigint) => getAddress(`0x${n.toString(16).padStart(40, '0')}`) as Address;
const creator = a(50n);
const visitor = a(51n);
const CHAIN = 11155111;
const listeners = vi.hoisted(() => ({ accounts: vi.fn(() => () => undefined), chain: vi.fn(() => () => undefined) }));
const wallet = vi.hoisted(() => ({
  account: null as string | null, status: 'connected', chainId: 11155111, kind: 'injected', walletName: 'test',
  signer: { request: (() => undefined) as unknown, walletName: 'test' } as { request: unknown; walletName: string } | null,
  onAccountsChanged: (() => () => undefined) as unknown, onChainChanged: (() => () => undefined) as unknown,
}));
vi.mock('../../wallet', async (original) => ({ ...(await original<object>()), useWallet: () => wallet }));

const record = { creator, specHash: zeroHash, contracts: Array.from({ length: 24 }, (_, i) => a(BigInt(i + 1))) };
const view = { record, token: a(2n), spec: { artMode: 1, revealRoot: `0x${'11'.repeat(32)}` } } as unknown as V2Snapshot;
const source = { network: 'sepolia', manifest: { chainId: CHAIN }, rpc: 'http://127.0.0.1:1' } as unknown as V2Source;
const counts = (latest: bigint, finalized = latest, size = 10n) => Object.freeze({ size, latest, finalized, remainingLatest: size - latest, remainingFinalized: size - finalized, finalizedComplete: finalized === size });
const plan = Object.freeze({ counts: counts(3n), batches: Object.freeze([{}, {}]), fee: {}, retryReserveWei: 0n, ceilingWei: 2_500_000_000_000_000n, spentWei: 0n }) as unknown as NonNullable<RevealSessionState['plan']>;
const attempt = (patch: Partial<UnresolvedReveal>): UnresolvedReveal => Object.freeze({ attempt: 'a1', ids: ['4', '5'], account: creator, createdAt: 0, capWei: '1000', status: 'unknown', ...patch }) as UnresolvedReveal;

let made: ReturnType<typeof double>[] = [];
let initial: Partial<RevealSessionState> = {};
let refuse: string | null = null;
const factory = vi.fn((options: RevealSessionOptions) => {
  if (refuse) throw new Error(refuse);
  const d = double(options, { outstandingCurrent: true, ...initial });
  made.push(d);
  return d.api as unknown as ReturnType<typeof createRevealSession>;
});
const last = () => { const d = made.at(-1); if (!d) throw new Error('no session'); return d; };

function mount(over: Partial<V2Snapshot> = {}) {
  const onClose = vi.fn();
  const ui = (v: V2Snapshot) => <RevealItemsV2 view={v} source={source} onClose={onClose} createSession={factory} />;
  const result = render(ui({ ...view, ...over }));
  return { onClose, rerender: (v: V2Snapshot = { ...view }) => result.rerender(ui(v)) };
}
const region = () => screen.getByRole('region', { name: W.title });
const status = () => within(region()).getByText((_t, el) => el?.getAttribute('data-reveal-status') === '').textContent;

beforeEach(() => {
  made = []; initial = {}; refuse = null; factory.mockClear();
  Object.assign(wallet, { account: creator, status: 'connected', chainId: CHAIN, kind: 'injected', signer: { request: () => undefined, walletName: 'test' },
    onAccountsChanged: listeners.accounts, onChainChanged: listeners.chain });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SH-203 Reveal items: numbers first', () => {
  it('shows revealed, left, final and in flight before any words, and Prepare once ready', () => {
    initial = { counts: counts(3n, 2n), unresolved: [attempt({ attempt: 'f', status: 'submitted', hash: `0x${'ab'.repeat(32)}` as Hex, hashDurable: true, ids: ['4', '5', '6'] })] };
    mount();
    const panel = region();
    const values = [...panel.querySelectorAll('[data-reveal-count]')].map((el) => [el.getAttribute('data-reveal-count'), el.textContent]);
    expect(values).toEqual([['revealed', '3/10'], ['left', '7'], ['final', '2/10'], ['in-flight', '3 items']]);
    expect(status()).toBe(W.ready);
    expect(within(panel).getByRole('button', { name: W.prepare })).toBeTruthy();
    // The codes stay behind Details, closed by default.
    expect(panel.querySelector('details')?.open).toBe(false);
  });

  it('passes the session the connected creator, the box, the navigation signal and the wallet’s own events', () => {
    mount();
    const options = last().options;
    expect(options).toMatchObject({ chainId: CHAIN, account: creator, rpc: source });
    expect(options.box.record).toBe(record);
    expect(options.signal.aborted).toBe(false);
    expect(options.wallet.onAccountsChanged).toBe(listeners.accounts);
    expect(options.wallet.onChainChanged).toBe(listeners.chain);
    expect(options.file).toBeUndefined();
  });
});

describe('SH-203 Reveal items: separate presses', () => {
  it('Prepare and Start are two presses; nothing is called by mounting, an effect or a timer', async () => {
    initial = { counts: counts(3n) };
    vi.useFakeTimers();
    try {
      mount();
      await act(async () => { vi.advanceTimersByTime(60_000); await Promise.resolve(); });
    } finally { vi.useRealTimers(); }
    const d = last();
    expect(d.calls).toEqual([]);
    fireEvent.click(within(region()).getByRole('button', { name: W.prepare }));
    expect(d.calls).toEqual([{ action: 'prepare', args: [], granted: true }]);
    // The session publishes the plan; the view shows its transactions and the most it can cost, and Start.
    d.set({ plan, busy: false });
    await d.resolve('prepare', plan);
    const shown = region().querySelector('[data-reveal-plan]');
    expect(shown?.textContent).toContain(`${W.transactions}2`);
    expect(shown?.textContent).toContain(ethUp(plan.ceilingWei));
    expect(d.calls.map((c) => c.action)).toEqual(['prepare']);
    fireEvent.click(within(region()).getByRole('button', { name: W.start }));
    expect(d.calls.map((c) => [c.action, c.granted])).toEqual([['prepare', true], ['start', true]]);
    // Start receives exactly the plan the session published.
    expect(d.calls[1]?.args[0]).toBe(plan);
  });

  it('a running batch shows its phase and Stop; Stop cancels without starting anything', async () => {
    initial = { counts: counts(3n), plan };
    mount();
    const d = last();
    fireEvent.click(within(region()).getByRole('button', { name: W.start }));
    for (const phase of ['running', 'wallet', 'receipt', 'confirmation', 'finality'] as const) {
      d.set({ busy: true, plan: undefined, progress: Object.freeze({ counts: counts(5n, 3n), reservedWei: 10n, phase }) });
      expect(status()).toBe(W.phase[phase]);
    }
    fireEvent.click(within(region()).getByRole('button', { name: W.stop }));
    expect(d.api.cancel).toHaveBeenCalledTimes(1);
    expect(d.calls.map((c) => c.action)).toEqual(['start']);
  });

  it('a release is an ask press and a confirm press, then a fresh Prepare and Start; never chained', async () => {
    initial = { counts: counts(3n), unresolved: [attempt({})] };
    mount();
    const d = last();
    const ask = () => fireEvent.click(within(region()).getByRole('button', { name: W.release }));
    ask();
    expect(d.calls.map((c) => [c.action, c.args[0], c.granted])).toEqual([['askRelease', 'a1', true]]);
    const wait: ReleaseDecision = Object.freeze({ token: null, attempt: 'a1', account: creator, ids: ['4', '5'], persistedAt: 0, capWei: 1000n, eligible: false, waitRemainingMs: 600_001,
      facts: ['send-may-still-land', 'second-send-may-spend-both-caps', 'confirm-no-pending-wallet-transaction'] as const });
    await d.resolve('askRelease', wait);
    expect(within(region()).getByText(W.releaseWait(11))).toBeTruthy();
    ask();
    const token = Object.freeze({});
    await d.resolve('askRelease', { ...wait, token, eligible: true, waitRemainingMs: 0 });
    const group = within(region()).getByRole('group', { name: W.release });
    expect(within(group).getByText(W.releaseFacts)).toBeTruthy();
    expect(within(group).getByText(`${W.releaseCost}: ${ethUp(1000n)}`)).toBeTruthy();
    expect(d.calls.map((c) => c.action)).toEqual(['askRelease', 'askRelease']);
    fireEvent.click(within(group).getByRole('button', { name: W.releaseConfirm }));
    expect(d.calls.at(-1)).toEqual({ action: 'confirmRelease', args: [token], granted: true });
    d.set({ unresolved: [] });
    await d.resolve('confirmRelease', undefined);
    expect(within(region()).getByText(W.releaseDone)).toBeTruthy();
    expect(d.calls.map((c) => c.action)).toEqual(['askRelease', 'askRelease', 'confirmRelease']);
  });
});

describe('SH-203 Reveal items: every state has a face', () => {
  const known = `0x${'cd'.repeat(32)}` as Hex;
  const cases: [string, Partial<RevealSessionState>, readonly string[]][] = [
    ['loading', { source: 'loading' }, [W.loading]],
    ['cancelled', { cancelled: true, actionReason: 'cancelled' }, [W.cancelled]],
    ['source missing', { source: 'needs-file' }, [W.needsFile, W.chooseFile]],
    ['source changed', { source: 'invalid', actionReason: 'wrong-spec' }, [REASON_WORDS['wrong-spec'] ?? '', W.tryAgain, W.chooseFile]],
    ['running in another tab', { pollReason: 'running-elsewhere' }, [`${W.pollOwner}: ${reasonText('running-elsewhere', 'poll')}`]],
    ['waiting for finality', { counts: counts(10n, 4n), actionReason: 'awaiting-finality' }, [W.allLatest, `${W.actionOwner}: ${REASON_WORDS['awaiting-finality']}`]],
    ['all final', { counts: counts(10n) }, [W.allDone]],
    ['known hash, saved', { unresolved: [attempt({ status: 'submitted', hash: known, hashDurable: true })] }, [W.attemptHash(known)]],
    ['known hash, live only', { unresolved: [attempt({ status: 'submitted', hash: known, hashDurable: false })] }, [W.attemptHash(known), W.attemptNotSaved]],
    ['no hash', { unresolved: [attempt({ status: 'unknown' })] }, [W.attemptNoHash, W.release]],
    ['read failure retried', { pollReason: 'read-failed' }, [`${W.pollOwner}: Could not read the chain. Trying again.`]],
    ['an action read failure is not retried by itself', { actionReason: 'read-failed' }, [`${W.actionOwner}: Could not read the chain. Try again.`]],
    ['read chain changed', { actionReason: 'read-chain-changed' }, [`${W.actionOwner}: ${REASON_WORDS['read-chain-changed']}`]],
    ['wallet chain changed', { cancelled: true, actionReason: 'chain-changed' }, [W.cancelled, `${W.actionOwner}: ${REASON_WORDS['chain-changed']}`]],
    ['both owners', { pollReason: 'running-elsewhere', actionReason: 'store-failed' }, [`${W.pollOwner}: ${REASON_WORDS['running-elsewhere']}`, `${W.actionOwner}: ${REASON_WORDS['store-failed']}`]],
    ['an unknown code', { actionReason: 'something-new' }, [`${W.actionOwner}: ${REASON_FALLBACK}`]],
  ];
  it.each(cases)('%s', (_name, state, texts) => {
    initial = { counts: counts(3n), ...state };
    mount();
    const text = region().textContent ?? '';
    for (const expected of texts) expect(text, expected).toContain(expected);
  });

  it('busy: a background read only disables the presses; a press of this tab says Working until it settles', async () => {
    initial = { counts: counts(3n), busy: true };
    mount();
    const d = last();
    expect(region().hasAttribute('data-reveal-busy')).toBe(true);
    expect((within(region()).getByRole('button', { name: W.prepare }) as HTMLButtonElement).disabled).toBe(true);
    expect(status()).toBe(W.ready);
    d.set({ busy: false });
    fireEvent.click(within(region()).getByRole('button', { name: W.prepare }));
    d.set({ busy: true });
    expect(status()).toBe(W.busy);
    d.set({ busy: false });
    await d.resolve('prepare', plan);
    expect(status()).toBe(W.ready);
  });

  it('a known hash offers no release; a send without one does', () => {
    initial = { unresolved: [attempt({ attempt: 'h', status: 'submitted', hash: known, hashDurable: true }), attempt({ attempt: 'n', status: 'intent' })] };
    mount();
    expect(region().querySelector('[data-attempt="h"] button')).toBeNull();
    expect(region().querySelector('[data-attempt="n"] button')?.textContent).toBe(W.release);
    expect(region().querySelector('[data-attempt="h"]')?.getAttribute('data-attempt-hash')).toBe('saved');
  });

  it('export and release stay reachable while reading fails', async () => {
    const created: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL) as typeof URL, { createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:x'; }, revokeObjectURL: () => undefined }));
    initial = { pollReason: 'read-failed', unresolved: [attempt({})] };
    mount();
    const d = last();
    const exportButton = within(region()).getByRole('button', { name: W.exportRecord }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false);
    await act(async () => { fireEvent.click(exportButton); });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(d.api.exportJournal).toHaveBeenCalledTimes(1);
    expect(await created[0]?.text()).toBe('{"version":1}');
    expect((within(region()).getByRole('button', { name: W.release }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('pictures: hosting not available is a normal state beside a finished reveal; Send pictures is one press with the chosen file', async () => {
    initial = { source: 'needs-file', counts: counts(10n) };
    mount();
    expect(within(region()).getByText(W.picturesNeedFile)).toBeTruthy();
    const file = new File(['{}'], 'box.json');
    await act(async () => { fireEvent.change(within(region()).getAllByLabelText(W.fileLabel)[0] as HTMLInputElement, { target: { files: [file] } }); });
    const d = last();
    expect(d.options.file).toBe(file);
    d.set({ source: 'ready' });
    fireEvent.click(within(region()).getByRole('button', { name: W.sendPictures }));
    expect(d.calls).toEqual([{ action: 'startPictures', args: [file], granted: true }]);
    // While the press runs, this tab says so; once it settles, the reveal's own line is back.
    expect(status()).toBe(W.busy);
    const result = Object.freeze({ outcomes: [{ id: 1n, role: 'image' as const, reason: 'not-available' as const }], revealed: { finalized: 10n, latest: 10n }, picturesReady: { finalized: 0n, latest: 0n } });
    d.set({ pictures: result });
    await d.resolve('startPictures', result);
    expect(within(region()).getByText(W.picturesOff)).toBeTruthy();
    expect(within(region()).getByText(W.picturesReady(0n, 10n))).toBeTruthy();
    expect(status()).toBe(W.allDone);
  });
});

describe('SH-203 Reveal items: the session is made again, never reused across identities', () => {
  it('on a wallet account change, a network change, a new file and Try again after a failed first read; not on a refreshed snapshot', async () => {
    const view2 = mount();
    expect(made).toHaveLength(1);
    // A refreshed snapshot of the same box keeps its session.
    view2.rerender({ ...view });
    expect(made).toHaveLength(1);
    // Another wallet account: the old one is disposed; this one is not the creator, so none is made.
    wallet.account = visitor; view2.rerender();
    expect(made[0]?.api.dispose).toHaveBeenCalledTimes(1);
    expect(made[0]?.options.signal.aborted).toBe(true);
    expect(made).toHaveLength(1);
    expect(within(region()).getByText(W.connect)).toBeTruthy();
    wallet.account = creator; view2.rerender();
    expect(made).toHaveLength(2);
    // Another network: disposed, and none on the wrong one.
    wallet.chainId = 1; view2.rerender();
    expect(made[1]?.api.dispose).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(2);
    wallet.chainId = CHAIN; view2.rerender();
    expect(made).toHaveLength(3);
    // Another wallet (a new connection): made again.
    wallet.signer = { request: () => undefined, walletName: 'other' }; view2.rerender();
    expect(made[2]?.api.dispose).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(4);
    // A failed first read: Try again makes a new one.
    made[3]?.set({ source: 'invalid', actionReason: 'invalid-source' });
    fireEvent.click(within(region()).getByRole('button', { name: W.tryAgain }));
    expect(made[3]?.api.dispose).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(5);
    // A new file: made again, with that file.
    const file = new File(['{}'], 'box.json');
    made[4]?.set({ source: 'needs-file' });
    await act(async () => { fireEvent.change(within(region()).getByLabelText(W.fileLabel), { target: { files: [file] } }); });
    expect(made[4]?.api.dispose).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(6);
    expect(made[5]?.options.file).toBe(file);
    // Leaving the view disposes the last one.
    cleanup();
    expect(made[5]?.api.dispose).toHaveBeenCalledTimes(1);
  });

  it('a session that refuses this wallet or box says so, and nothing is made', async () => {
    refuse = 'wrong-identity';
    mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(within(region()).getByText(REASON_WORDS['wrong-identity'] ?? '')).toBeTruthy();
    expect(made).toHaveLength(0);
  });

  it('control: the double refuses an action called outside a click, as the session does', async () => {
    initial = { counts: counts(3n) };
    mount();
    const d = last();
    await act(async () => { await expect(d.api.prepare()).rejects.toThrow('user-press-required'); });
    expect(d.calls).toEqual([{ action: 'prepare', args: [], granted: false }]);
  });

  it('an action the session refuses is said in one line', async () => {
    initial = { counts: counts(3n) };
    mount();
    const d = last();
    d.api.prepare.mockImplementationOnce(() => Promise.reject(new Error('action-unavailable')));
    await act(async () => { fireEvent.click(within(region()).getByRole('button', { name: W.prepare })); });
    expect(region().querySelector('[data-reason-owner="press"]')?.textContent).toBe(REASON_WORDS['action-unavailable']);
  });
});

describe('SH-203 af1: in flight, late answers and the file for pictures', () => {
  const inFlight = () => region().querySelector('[data-reveal-count="in-flight"]')?.textContent;
  it('M2: in flight names the batch at the wallet and awaiting its block, never 0 while one is out; unknown when it cannot be known', () => {
    initial = { counts: counts(0n, 0n, 41n), plan };
    mount();
    const d = last();
    expect(inFlight()).toBe('0');
    fireEvent.click(within(region()).getByRole('button', { name: W.start }));
    const first = Array.from({ length: 40 }, (_, i) => String(i + 1));
    // An empty journal (unresolved stays [] until the run ends): the batch comes from the run's own progress.
    d.set({ busy: true, plan: undefined, progress: Object.freeze({ counts: counts(0n, 0n, 41n), reservedWei: 0n, phase: 'wallet' as const, ids: Object.freeze(first) }) });
    expect(inFlight()).toBe(W.attemptItems(40));
    d.set({ progress: Object.freeze({ counts: counts(40n, 0n, 41n), reservedWei: 1n, phase: 'receipt' as const, ids: Object.freeze(first) }) });
    expect(inFlight()).toBe(W.attemptItems(40));
    // A batch out without its items: unknown, not 0.
    d.set({ progress: Object.freeze({ counts: counts(40n, 0n, 41n), reservedWei: 1n, phase: 'receipt' as const }) });
    expect(inFlight()).toBe(W.unknown);
    // Between batches nothing is out.
    d.set({ progress: Object.freeze({ counts: counts(40n, 0n, 41n), reservedWei: 1n, phase: 'running' as const }) });
    expect(inFlight()).toBe('0');
  });

  it('M2: unknown sends count, and another tab holding the run makes it unknown', () => {
    initial = { counts: counts(3n), unresolved: [attempt({ status: 'unknown', ids: ['4', '5'] }), attempt({ attempt: 'b', status: 'intent', ids: ['6'] })] };
    mount();
    expect(inFlight()).toBe(W.attemptItems(3));
    last().set({ pollReason: 'running-elsewhere' });
    expect(inFlight()).toBe(W.unknown);
  });

  it('L1: a late answer of a disposed session changes nothing in the new view (press note and release ask)', async () => {
    initial = { counts: counts(3n), unresolved: [attempt({})] };
    const view2 = mount();
    const old = last();
    fireEvent.click(within(region()).getByRole('button', { name: W.prepare }));
    fireEvent.click(within(region()).getByRole('button', { name: W.release }));
    // Another wallet: the old session is disposed, a new one shows.
    wallet.signer = { request: () => undefined, walletName: 'other' }; view2.rerender();
    expect(old.api.dispose).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(2);
    // The old session answers late: a refusal and an eligible release decision.
    await old.reject('prepare', new Error('action-unavailable'));
    await old.resolve('askRelease', Object.freeze({ token: Object.freeze({}), attempt: 'a1', account: creator, ids: ['4', '5'], persistedAt: 0, capWei: 1000n, eligible: true, waitRemainingMs: 0,
      facts: ['send-may-still-land', 'second-send-may-spend-both-caps', 'confirm-no-pending-wallet-transaction'] as const }));
    expect(region().querySelector('[data-reason-owner="press"]')).toBeNull();
    expect(within(region()).queryByRole('group', { name: W.release })).toBeNull();
    expect(within(region()).queryByText(REASON_WORDS['action-unavailable'] ?? '')).toBeNull();
    // And the new session's own presses still work.
    fireEvent.click(within(region()).getByRole('button', { name: W.prepare }));
    expect(last().calls.map((c) => c.action)).toEqual(['prepare']);
  });

  it('L2: the file choice stays beside Send pictures; a file without pictures says to choose the full box file', async () => {
    initial = { counts: counts(10n) };
    mount();
    const proofOnly = new File(['{}'], 'reveal-data.json');
    await act(async () => { fireEvent.change(within(region()).getByLabelText(W.fileLabel), { target: { files: [proofOnly] } }); });
    const d = last();
    expect(d.options.file).toBe(proofOnly);
    fireEvent.click(within(region()).getByRole('button', { name: W.sendPictures }));
    const result = Object.freeze({ outcomes: [{ id: 1n, role: 'image' as const, reason: 'needs-box-file' as const }, { id: 1n, role: 'avatar' as const, reason: 'needs-box-file' as const }],
      revealed: { finalized: 10n, latest: 10n }, picturesReady: { finalized: 0n, latest: 0n } });
    d.set({ pictures: result });
    await d.resolve('startPictures', result);
    expect(within(region()).getByText(W.picturesNotInFile(2))).toBeTruthy();
    expect(within(region()).queryByText(W.picturesFailed(2))).toBeNull();
    // The picker is still there: the full box file replaces the proof-only copy, in a new session.
    const full = new File(['{"pictures":[]}'], 'box.json');
    expect(within(region()).getByRole('button', { name: W.otherFile })).toBeTruthy();
    await act(async () => { fireEvent.change(within(region()).getByLabelText(W.fileLabel), { target: { files: [full] } }); });
    expect(last().options.file).toBe(full);
    expect(d.api.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('SH-203 af2 R2-M3 and R2-L2: in flight only for outstanding reveals; texts that hold where they show', () => {
  const inFlight = () => region().querySelector('[data-reveal-count="in-flight"]')?.textContent;
  const stale = Object.freeze({ counts: counts(10n), reservedWei: 5n, phase: 'receipt' as const, ids: Object.freeze(['10']) });

  it('R2-M3: Send pictures after a finished reveal is not a reveal run: the last batch is not in flight and its sent line does not return', async () => {
    // A finished reveal: the session still holds the last run's receipt progress (it keeps that fact after the run).
    initial = { counts: counts(10n), progress: stale };
    mount();
    expect(inFlight()).toBe('0');
    expect(status()).toBe(W.allDone);
    const full = new File(['{}'], 'box.json');
    await act(async () => { fireEvent.change(within(region()).getByLabelText(W.fileLabel), { target: { files: [full] } }); });
    const d = last();
    fireEvent.click(within(region()).getByRole('button', { name: W.sendPictures }));
    d.set({ busy: true, pictureProgress: Object.freeze({ completedItems: 1n, totalItems: 10n }) });
    expect(inFlight()).toBe('0');
    expect(status()).toBe(W.busy);
    expect(status()).not.toBe(W.phase.receipt);
    expect(within(region()).getByRole('button', { name: W.stop })).toBeTruthy();
    expect(region().querySelector('details')?.textContent).not.toContain(W.reserved);
  });

  it('R2-M3: a settled reveal run’s last progress has expired: a background read does not bring its batch or phase back', async () => {
    initial = { counts: counts(9n, 9n), plan };
    mount();
    const d = last();
    fireEvent.click(within(region()).getByRole('button', { name: W.start }));
    d.set({ busy: true, plan: undefined, progress: stale });
    expect(inFlight()).toBe(W.attemptItems(1));
    expect(status()).toBe(W.phase.receipt);
    d.set({ busy: false, counts: counts(10n) });
    await d.resolve('start', { counts: counts(10n), reservedWei: 5n, reason: 'complete' });
    // The session keeps its progress fact; a background read sets busy: nothing is out, and no phase line returns.
    d.set({ busy: true });
    expect(inFlight()).toBe('0');
    expect(status()).toBe(W.allDone);
  });

  it('R2-M3: contention from either reason owner makes in flight Unknown, never 0', () => {
    initial = { counts: counts(3n) };
    mount();
    const d = last();
    expect(inFlight()).toBe('0');
    // This tab's Prepare refused while another tab sends: the refusal is the action reason.
    d.set({ actionReason: 'running-elsewhere' });
    expect(inFlight()).toBe(W.unknown);
    d.set({ actionReason: undefined, pollReason: 'running-elsewhere' });
    expect(inFlight()).toBe(W.unknown);
  });

  it('R2-L2: a first read that failed on the chain is read again by itself (new session, backing off); a wrong file is not', async () => {
    vi.useFakeTimers();
    try {
      initial = { source: 'invalid', actionReason: 'read-failed' };
      mount();
      expect(status()).toBe('Could not read the chain. Trying again.');
      expect(made).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime((SOURCE_RETRY_MS[0] as number) - 1); });
      expect(made).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(made).toHaveLength(2);
      expect(made[0]?.api.dispose).toHaveBeenCalledTimes(1);
      // Backing off: the next wait is the second delay.
      await act(async () => { vi.advanceTimersByTime((SOURCE_RETRY_MS[1] as number) - 1); });
      expect(made).toHaveLength(2);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(made).toHaveLength(3);
      // The chain is back: the new session reads the box, the old failure is gone with its session.
      last().set({ source: 'ready', actionReason: undefined, counts: counts(3n) });
      expect(status()).toBe(W.ready);
      await act(async () => { vi.advanceTimersByTime(120_000); });
      expect(made).toHaveLength(3);
      cleanup();
      made = [];
      initial = { source: 'invalid', actionReason: 'wrong-spec' };
      mount();
      expect(status()).toBe(REASON_WORDS['wrong-spec']);
      await act(async () => { vi.advanceTimersByTime(300_000); });
      expect(made).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('R2-L2: the reason lines depend on who reports them; the keys nothing shows are gone', () => {
    expect(reasonText('read-failed', 'poll')).toBe('Could not read the chain. Trying again.');
    expect(reasonText('read-failed')).toBe('Could not read the chain. Try again.');
    expect(reasonText('read-failed', 'source')).toBe('Could not read the chain. Trying again.');
    expect(reasonText('invalid-source', 'source')).toBe(REASON_WORDS['invalid-source']);
    expect(reasonText('reorg')).toBe('The chain changed its last blocks. Try again.');
    expect(reasonText('reorg', 'poll')).toBe('The chain changed its last blocks. Checking again.');
    for (const key of ['needs-box-file', 'navigation', 'source-unavailable', 'not-available', 'deferred']) expect(Object.hasOwn(REASON_WORDS, key), key).toBe(false);
    for (const key of ['wrong-code', 'read-chain-changed', 'simulation-failed', 'wallet-refused']) expect(REASON_WORDS[key], key).toContain('Nothing more was sent.');
  });
});


describe('SH-203 af4 page facts', () => {
  it('C: stale zero and stale positive lists both show Unknown until reconciliation publishes', () => {
    initial = { counts: counts(3n), outstandingCurrent: false };
    mount();
    const flight = () => region().querySelector('[data-reveal-count="in-flight"]')?.textContent;
    expect(flight()).toBe(W.unknown);
    last().set({ unresolved: [attempt({ hash: `0x${'ab'.repeat(32)}` as Hex })] });
    expect(flight()).toBe(W.unknown);
    last().set({ outstandingCurrent: true, unresolved: [], counts: counts(10n) });
    expect(flight()).toBe('0');
  });

  it('D: a cleared contention reason does not return as a saved press note', async () => {
    initial = { counts: counts(3n) };
    mount(); const d = last();
    fireEvent.click(screen.getByRole('button', { name: W.prepare }));
    d.set({ actionReason: 'running-elsewhere', outstandingCurrent: false });
    await d.reject('prepare', new Error('running-elsewhere'));
    expect(region().textContent).toContain('Another tab');
    d.set({ actionReason: undefined, outstandingCurrent: true });
    expect(region().textContent).not.toContain('Another tab');
    expect(region().querySelector('[data-reveal-count="in-flight"]')?.textContent).toBe('0');
    d.set({ actionReason: 'wallet-refused', counts: counts(10n) });
    expect(region().textContent).toContain(REASON_WORDS['wallet-refused']);
    expect(region().textContent).not.toContain('Waiting for the chain to make it final');
  });

  it('E: missing transport says this site cannot send; it does not blame the server', () => {
    initial = { counts: counts(10n), pictures: { outcomes: [{ id: 1n, role: 'image', reason: 'transport-unavailable' }],
      revealed: { latest: 10n, finalized: 10n }, picturesReady: { latest: 9n, finalized: 9n } } };
    mount();
    expect(screen.getByText(W.picturesNoTransport)).toBeTruthy();
    expect(screen.getByText(W.picturesReady(9n, 10n))).toBeTruthy();
    expect(screen.queryByText(W.picturesOff)).toBeNull();
    expect(screen.queryByText(W.picturesFailed(1))).toBeNull();
  });

  // af6: the founder's words (desk round 95), pinned as approved; the two lines of desk round 96 are pinned in 'af6' below.
  it('F: working text states known facts for every review wording key', () => {
    expect(W.loading).toBe('Reading this box…');
    expect(W.phase.receipt).toBe('Sent. Checking for inclusion.');
    expect(W.phase.confirmation).toBe('In a block. Confirming.');
    expect(W.inFlightHelp).toBe('Includes sends waiting for confirmation.');
    expect(W.picturesOff).toBe('The picture upload was not confirmed. Revealing does not need it.');
    expect(REASON_WORDS['running-elsewhere']).toBe('Another tab was working on this box at the last check.');
    expect(REASON_WORDS['pictures-running-elsewhere']).toBe('Another tab was checking pictures at that press. Try again.');
    expect(REASON_WORDS['lock-unavailable']).toBe('This browser cannot keep tabs apart. No further send can start.');
    expect(REASON_WORDS['release-too-soon']).toBe('Release was too soon at the last check. Press Release to check again.');
    expect(W.needsFile).toBe('No box file found in this browser. Choose the one you saved.');
    expect(W.picturesNeedFile).toBe('Choose the full box file to send missing pictures.');
    expect(W.picturesLater).toBe('Some pictures are still waiting. Send again later.');
    expect(REASON_WORDS['wrong-registry']).toBe('The registry does not match this box.');
    expect(REASON_WORDS['wrong-token']).toBe('The token does not match this box.');
    expect(REASON_WORDS['wrong-spec']).toBe('The box settings do not match.');
    expect(REASON_WORDS['wrong-mode']).toBe('This box does not support this reveal action.');
    expect(REASON_WORDS['storage-unavailable']).toBe('The run could not be read or saved here. No further send can start.');
    expect(W.releaseWait(1)).toContain('At the last check: 1 more minute');
    // The four opener reasons name the moment of the press.
    for (const code of ['randomness', 'settlement', 'finality', 'grace']) expect(REASON_WORDS[code]).toMatch(/when you pressed/i);
    expect([REASON_WORDS.randomness, REASON_WORDS.settlement, REASON_WORDS.finality, REASON_WORDS.grace]).toEqual(['No random number yet when you pressed.',
      'The draw had not settled when you pressed.', 'Not final yet when you pressed.', 'When you pressed, only the wallet that drew it could open this item.']);
    expect(REASON_WORDS['receipt-pending']).toBe('Not confirmed yet at the last check.');
    expect(REASON_WORDS['awaiting-finality']).toBe('Not final yet at the last check.');
  });

  it('G: no Prepare at zero left; recovery and pictures remain', () => {
    initial = { counts: counts(10n) };
    mount();
    expect(screen.queryByRole('button', { name: W.prepare })).toBeNull();
    expect(screen.getByRole('button', { name: W.exportRecord })).toBeTruthy();
    expect(screen.getByRole('region', { name: W.pictures })).toBeTruthy();
  });

  it('G: an export pressed during a failed first read completes across its automatic retry', async () => {
    vi.useFakeTimers();
    const downloads: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL) as typeof URL, { createObjectURL: (blob: Blob) => { downloads.push(blob); return 'blob:af4'; }, revokeObjectURL: () => undefined }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      initial = { source: 'invalid', actionReason: 'read-failed' };
      mount(); const old = last();
      let finish!: (value: string) => void;
      old.api.exportJournal.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      fireEvent.click(screen.getByRole('button', { name: W.exportRecord }));
      await act(async () => { await vi.advanceTimersByTimeAsync(SOURCE_RETRY_MS[0] as number); });
      expect(made).toHaveLength(1); expect(old.api.dispose).not.toHaveBeenCalled();
      await act(async () => { finish('{"version":1}'); });
      expect(downloads).toHaveLength(1); expect(click).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(SOURCE_RETRY_MS[0] as number); });
      expect(made).toHaveLength(2); expect(old.api.dispose).toHaveBeenCalledTimes(1);
      cleanup();
      await act(async () => { await vi.advanceTimersByTimeAsync(SOURCE_RETRY_MS.at(-1) as number); });
      expect(made).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
    } finally { click.mockRestore(); vi.useRealTimers(); }
  });
});

describe('SH-203 af5: the fourth review', () => {
  const known = `0x${'cd'.repeat(32)}` as Hex;
  const decision = (patch: Partial<ReleaseDecision> = {}): ReleaseDecision => Object.freeze({ token: Object.freeze({}), attempt: 'a1', account: creator, ids: ['4', '5'], persistedAt: 0,
    capWei: 1000n, eligible: true, waitRemainingMs: 0, facts: ['send-may-still-land', 'second-send-may-spend-both-caps', 'confirm-no-pending-wallet-transaction'] as const, ...patch });
  const buttons = () => within(region()).getAllByRole('button').map((b) => b.textContent);

  it('R4-L1: a refused "Release it" leaves the row with Release again, and a new ask can be confirmed', async () => {
    initial = { counts: counts(3n), unresolved: [attempt({})] };
    mount();
    const d = last();
    fireEvent.click(within(region()).getByRole('button', { name: W.release }));
    await d.resolve('askRelease', decision());
    fireEvent.click(within(region()).getByRole('button', { name: W.releaseConfirm }));
    await d.reject('confirmRelease', new Error('running-elsewhere'));
    expect(buttons()).toContain(W.release); expect(buttons()).not.toContain(W.releaseConfirm);
    fireEvent.click(within(region()).getByRole('button', { name: W.release }));
    await d.resolve('askRelease', decision());
    expect(buttons()).toContain(W.releaseConfirm);
    expect(d.calls.map((c) => [c.action, c.granted])).toEqual([['askRelease', true], ['confirmRelease', true], ['askRelease', true]]);
  });

  it('R4-L2a: a send with an id the node no longer has says so and offers Release; one the read could not check says nothing', () => {
    // af6 C-L1: the line and Release follow the session's `absent` (both reads an explicit null), not the transaction read alone.
    initial = { counts: counts(3n), unresolved: [
      attempt({ attempt: 'gone', status: 'submitted', hash: known, hashDurable: true, transaction: null, absent: true }),
      attempt({ attempt: 'unread', status: 'submitted', hash: known, hashDurable: true }),
      attempt({ attempt: 'half', status: 'submitted', hash: known, hashDurable: true, transaction: null }),
      attempt({ attempt: 'there', status: 'submitted', hash: known, hashDurable: true, transaction: { from: creator, to: a(1n), nonce: 0n, value: 0n, blockNumber: null } }),
    ] };
    mount();
    const row = (id: string) => region().querySelector(`[data-attempt="${id}"]`) as HTMLElement;
    expect(within(row('gone')).getByText(W.attemptGone)).toBeTruthy();
    expect(within(row('gone')).getByRole('button', { name: W.release })).toBeTruthy();
    for (const id of ['unread', 'half', 'there']) {
      expect(within(row(id)).queryByText(W.attemptGone), id).toBeNull();
      expect(within(row(id)).queryByRole('button', { name: W.release }), id).toBeNull();
    }
  });

  it('R4-L3b: a wallet that signs on the press: no "Confirm in your wallet", and the release facts without its pending list', async () => {
    Object.assign(wallet, { signer: { request: () => undefined, walletName: 'made', confirmsInPage: true } });
    initial = { counts: counts(3n), plan, unresolved: [attempt({})] };
    mount();
    const d = last();
    fireEvent.click(within(region()).getByRole('button', { name: W.start }));
    d.set({ busy: true, plan: undefined, progress: Object.freeze({ counts: counts(3n), reservedWei: 1n, phase: 'wallet' as const }) });
    expect(status()).toBe(W.phase.running);
    d.set({ busy: false, progress: Object.freeze({ counts: counts(3n), reservedWei: 1n, phase: 'receipt' as const }) });
    expect(status()).toBe(W.phase.receipt);
    fireEvent.click(within(region()).getByRole('button', { name: W.release }));
    await d.resolve('askRelease', decision());
    const group = within(region()).getByRole('group', { name: W.release });
    expect(within(group).getByText(W.releaseFactsInPage)).toBeTruthy();
    expect(region().textContent).not.toContain(W.releaseFacts);
    expect(region().textContent).not.toContain(W.phase.wallet);
  });

  it('R4-L4: Stop or a wallet change says nothing more is sent only once this tab’s run has settled', async () => {
    initial = { counts: counts(3n), plan };
    mount();
    const d = last();
    fireEvent.click(within(region()).getByRole('button', { name: W.start }));
    d.set({ busy: true, plan: undefined, progress: Object.freeze({ counts: counts(3n), reservedWei: 1n, phase: 'wallet' as const }) });
    fireEvent.click(within(region()).getByRole('button', { name: W.stop }));
    d.set({ cancelled: true, actionReason: 'account-changed' });
    // The request is still at the wallet: it may or may not go out.
    expect(status()).toBe(REASON_WORDS['unknown-send']);
    expect(region().textContent).not.toContain(W.cancelled);
    expect(region().textContent).not.toContain(REASON_WORDS['account-changed']);
    expect(region().textContent).toContain(`${W.actionOwner}: ${REASON_WORDS['unknown-send']}`);
    d.set({ busy: false });
    await d.resolve('start', { counts: counts(3n), reservedWei: 1n, reason: 'account-changed' });
    expect(status()).toBe(W.cancelled);
    expect(region().textContent).toContain(`${W.actionOwner}: ${REASON_WORDS['account-changed']}`);
  });

  it('R4-L5: every item final and no kept copy: the finished line, the file asked for only in the pictures part', () => {
    initial = { source: 'needs-file', counts: counts(10n) };
    mount();
    expect(status()).toBe(W.allDone);
    expect(region().textContent).not.toContain(W.needsFile);
    const pictures = within(region()).getByRole('region', { name: W.pictures });
    expect(within(region()).getAllByRole('button', { name: W.chooseFile })).toEqual([within(pictures).getByRole('button', { name: W.chooseFile })]);
    expect(within(region()).queryByRole('button', { name: W.prepare })).toBeNull();
  });
});

describe('SH-203 af6', () => {
  it('the two lines with the founder (desk round 96) are the proposals as worded, pinned so a change is a decision', () => {
    expect(W.attemptGone).toBe('Not found on the network at the last check.');
    expect(W.releaseFactsInPage).toBe('The old send may still go through. If both go through, you pay gas for both.');
    // The line for a wallet with a window stays as approved (desk round 95, as built).
    expect(W.releaseFacts).toBe('This send may still go out. Release only if your wallet shows nothing pending. If both go out, both can cost up to their limit.');
  });
});
