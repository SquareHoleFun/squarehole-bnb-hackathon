/**
 * SH-218 rail 2 (design section 6, `policy-read-fails-closed-and-expires`, the page's half; af1 review findings F2, F3,
 * F4, F6 and change G): the Create page reads the selected release's list on entry and permits creation only while a
 * good read is younger than 60 seconds, started after this mount and after the tab was last shown, in a visible tab.
 * A healthy API is read again before the 60 are over, so permission has no gap; a failed read ends it at once; a read
 * that waits 5 seconds or an offline browser is a failed read (line B), never a silent wait. A failure keeps the last
 * good list for the marks only. Retry reads the module directory too. Every mount starts from nothing.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { V2Source } from '../../core/v2/indexer-v2';
import * as alchemist from './alchemist';
import { CREATE_OPTIONS_FRESH_MS, CREATE_OPTIONS_TIMEOUT_MS, createOptionsFetchForTests, type CreateOptionsFetch } from './create-options';
import { CREATE_OPTIONS_REFRESH_LEAD_MS, useCreateOptions, useModuleDirectory } from './useCreateOptions';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../packages/chain/src/create-options/fixtures');
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');
const release = (factory: string) => ({ factory: { address: factory }, registry: { address: '0x5d2866ef084d801ae734d3a2a6e4f7179898737c' },
  versionCodeHash: '0x31927f086fff14638c18ca1194dc874c12d6faec88b9356fc939d066f485baaa', implementations: { receiver: { address: '0x00000000000000000000000000000000000000e1' }, coordinator: { address: '0x00000000000000000000000000000000000000e2' } } });
const SOURCE = { network: 'sepolia', origin: 'https://api.test', rpc: 'https://rpc.test', manifest: { chainId: 11155111, chain: { poolManager: { address: '0x00000000000000000000000000000000000000e3' } }, releases: [release('0xfae1e6cff43cadcbe01885bdd0aa6218263de393')] } } as unknown as V2Source;
const OTHER = { ...SOURCE, manifest: { chainId: 11155111, releases: [release('0x1111111111111111111111111111111111111111')] } } as unknown as V2Source;
const ok = () => new Response(fixture('two-off.json'), { status: 200 });
const empty = () => new Response(fixture('empty.json'), { status: 200 });
const down = () => new Response('{"error":"create options unavailable"}', { status: 503 });
const keys = (doc: { off: readonly { key: string }[] } | null) => doc?.off.map((entry) => entry.key) ?? null;
const pending = (replies: ((response: Response) => void)[]) => () => new Promise<Response>((resolve) => { replies.push(resolve); });

let answer: () => Response | Promise<Response>;
const fetch = vi.fn<CreateOptionsFetch>(async () => answer());
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  answer = ok;
  fetch.mockReset();
  fetch.mockImplementation(async () => answer());
  createOptionsFetchForTests(fetch);
  client = new QueryClient();
});
afterEach(() => {
  cleanup();
  createOptionsFetchForTests(null);
  setVisibility('visible');
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('policy-read-fails-closed-and-expires: the Create page’s list', () => {
  it('reads on entry; nothing permits creation until the read answers', async () => {
    const replies: ((response: Response) => void)[] = [];
    answer = pending(replies);
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    expect(result.current.phase).toBe('reading');
    expect(result.current.fresh).toBe(false);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.test/v2/create-options/11155111/0xfae1e6cff43cadcbe01885bdd0aa6218263de393.json');
    await act(async () => replies[0]?.(ok()));
    await waitFor(() => expect(result.current.fresh).toBe(true));
    expect(result.current.phase).toBe('ok');
    expect(keys(result.current.document)).toEqual(['fee.buyers.holders-p', 'template.holders']);
  });

  it('F3: a healthy API leaves no gap: read again before the 60 are over, the permission kept until the answer', async () => {
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(result.current.fresh).toBe(true));
    const replies: ((response: Response) => void)[] = [];
    answer = pending(replies);
    // (The fake clock also follows real time while the test runs, so the margins are one second.)
    await act(async () => { await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_FRESH_MS - CREATE_OPTIONS_REFRESH_LEAD_MS + 1_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.fresh).toBe(true);
    await act(async () => replies[0]?.(empty()));
    await waitFor(() => expect(keys(result.current.document)).toEqual([]));
    await act(async () => { await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_REFRESH_LEAD_MS); });
    // Past the first read's 60 seconds: the new read permits, without any moment off.
    expect(result.current.fresh).toBe(true);
  });

  it('F3: a failed re-read blocks at once, before the 60 are over; the expiry alone blocks too', async () => {
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(result.current.fresh).toBe(true));
    answer = down;
    await act(async () => { await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_FRESH_MS - CREATE_OPTIONS_REFRESH_LEAD_MS + 1_000); });
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.fresh).toBe(false);
    // A read that never answers: the 60-second timer ends the permission even so.
    cleanup();
    client = new QueryClient();
    answer = ok;
    const again = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(again.result.current.fresh).toBe(true));
    answer = () => new Promise(() => undefined);
    await act(async () => { await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_FRESH_MS - 1_000); });
    expect(again.result.current.fresh).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(again.result.current.fresh).toBe(false);
  });

  it('F3: a first read that waits its 5 seconds is a failed read (line B), not a silent wait', async () => {
    fetch.mockImplementation((_url, init) => new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }));
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(result.current.phase).toBe('reading');
    await act(async () => { await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_TIMEOUT_MS); });
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.fresh).toBe(false);
  });

  it('F3: offline, the read is not paused: it fails at once (line B with Retry)', async () => {
    onlineManager.setOnline(false);
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.fresh).toBe(false);
  });

  it('F6: a failed read keeps the last good list’s marks, never its permission; Retry reads again', async () => {
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(result.current.fresh).toBe(true));
    answer = down;
    await act(async () => { result.current.retry(); });
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.fresh).toBe(false);
    expect(keys(result.current.document)).toEqual(['fee.buyers.holders-p', 'template.holders']);
    answer = ok;
    await act(async () => { result.current.retry(); });
    await waitFor(() => expect(result.current.fresh).toBe(true));
  });

  it('F6: with no good read yet, a failure marks nothing; check() asks afresh', async () => {
    answer = down;
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.document).toBeNull();
    expect(result.current.fresh).toBe(false);
    answer = ok;
    let checked: Awaited<ReturnType<typeof result.current.check>> = null;
    await act(async () => { checked = await result.current.check(); });
    expect(checked).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    // Fresh now: check() answers from this read without another request.
    await waitFor(() => expect(result.current.fresh).toBe(true));
    await act(async () => { checked = await result.current.check(); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a hidden tab loses permission at once; shown again, only a read started since then permits', async () => {
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(result.current.fresh).toBe(true));
    act(() => setVisibility('hidden'));
    expect(result.current.fresh).toBe(false);
    const replies: ((response: Response) => void)[] = [];
    answer = pending(replies);
    act(() => setVisibility('visible'));
    // The read from before the tab was hidden no longer counts, though it is younger than 60 seconds.
    expect(result.current.fresh).toBe(false);
    await waitFor(() => expect(replies).toHaveLength(1));
    await act(async () => replies[0]?.(ok()));
    await waitFor(() => expect(result.current.fresh).toBe(true));
  });

  it('af2 (review C2, change L): a hidden tab starts no read at all, neither the early one nor at 60 s, until it is shown', async () => {
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(result.current.fresh).toBe(true));
    const before = fetch.mock.calls.length;
    act(() => setVisibility('hidden'));
    // Past the early re-read, past the 60 seconds, and two more minutes: no request while hidden.
    await act(async () => { await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_FRESH_MS - CREATE_OPTIONS_REFRESH_LEAD_MS + 1_000); });
    expect(fetch.mock.calls.length).toBe(before);
    await act(async () => { await vi.advanceTimersByTimeAsync(CREATE_OPTIONS_FRESH_MS * 3); });
    expect(fetch.mock.calls.length).toBe(before);
    expect(result.current.fresh).toBe(false);
    act(() => setVisibility('visible'));
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(result.current.fresh).toBe(true));
  });

  it('F2: hidden and shown during the very first read: that read is cancelled and a new one permits at once', async () => {
    const replies: ((response: Response) => void)[] = [];
    answer = pending(replies);
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(replies).toHaveLength(1));
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    await waitFor(() => expect(replies).toHaveLength(2));
    // The first read's late answer does not land; the new one permits, long before any 60-second timer.
    await act(async () => replies[0]?.(ok()));
    expect(result.current.fresh).toBe(false);
    await act(async () => replies[1]?.(ok()));
    await waitFor(() => expect(result.current.fresh).toBe(true));
  });

  it('G: a remount starts from nothing: no cached read is shown, and none permits, until the new one answers', async () => {
    const first = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(first.result.current.fresh).toBe(true));
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const replies: ((response: Response) => void)[] = [];
    answer = pending(replies);
    const second = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    expect(second.result.current.document).toBeNull();
    expect(second.result.current.fresh).toBe(false);
    await waitFor(() => expect(replies).toHaveLength(1));
    expect(second.result.current.fresh).toBe(false);
    await act(async () => replies[0]?.(ok()));
    await waitFor(() => expect(second.result.current.fresh).toBe(true));
  });

  it('F4: Retry reads the module directory again too', async () => {
    const directory = '0x00000000000000000000000000000000000d1e00' as const;
    const read = vi.spyOn(alchemist, 'alchemistReleaseV21').mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValue({ directory, poolManager: directory, receiverImplementation: directory, coordinatorImplementation: directory });
    const { result } = renderHook(() => ({ list: useCreateOptions(SOURCE), dir: useModuleDirectory(SOURCE, true) }), { wrapper });
    await waitFor(() => expect(result.current.dir.state).toBe('failed'));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { result.current.list.retry(); });
    await waitFor(() => expect(result.current.dir).toEqual({ state: 'ready', directory }));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('another release starts again from nothing; two releases read the first one\'s list (SH-300); no source reads nothing', async () => {
    const { result, rerender } = renderHook(({ source }) => useCreateOptions(source), { wrapper, initialProps: { source: SOURCE as V2Source | null } });
    await waitFor(() => expect(result.current.fresh).toBe(true));
    const replies: ((response: Response) => void)[] = [];
    answer = pending(replies);
    rerender({ source: OTHER });
    expect(result.current.fresh).toBe(false);
    expect(result.current.document).toBeNull();
    // The two-off list names the first release: for the other one it is refused, and nothing is marked.
    await waitFor(() => expect(replies).toHaveLength(1));
    await act(async () => replies[0]?.(ok()));
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    expect(result.current.document).toBeNull();
    const two = { ...SOURCE, manifest: { ...SOURCE.manifest, releases: [...SOURCE.manifest.releases, ...OTHER.manifest.releases] } } as V2Source;
    rerender({ source: two });
    // SH-300: with two releases Create's list is the first release's, read and taken as with one.
    await waitFor(() => expect(result.current.fresh || replies.length > 1).toBe(true));
    if (replies.length > 1) await act(async () => replies[1]?.(ok()));
    await waitFor(() => expect(result.current.fresh).toBe(true));
    fetch.mockClear();
    rerender({ source: null });
    expect(result.current.phase).toBe('none');
    expect(result.current.fresh).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a late answer of an older read never lands after a newer one (a newer read cancels it)', async () => {
    const { result } = renderHook(() => useCreateOptions(SOURCE), { wrapper });
    await waitFor(() => expect(result.current.fresh).toBe(true));
    const replies: ((response: Response) => void)[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    fetch.mockImplementation((_url, init) => { signals.push(init.signal); return new Promise((resolve) => { replies.push(resolve); }); });
    await act(async () => { result.current.retry(); });
    await waitFor(() => expect(replies).toHaveLength(1));
    await act(async () => { result.current.retry(); });
    await waitFor(() => expect(replies).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => replies[1]?.(down()));
    await waitFor(() => expect(result.current.phase).toBe('failed'));
    // The cancelled read answers with another list: it neither permits nor replaces the marks.
    await act(async () => replies[0]?.(empty()));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current.phase).toBe('failed');
    expect(result.current.fresh).toBe(false);
    expect(keys(result.current.document)).toEqual(['fee.buyers.holders-p', 'template.holders']);
  });
});
