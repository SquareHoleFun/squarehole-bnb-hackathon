/**
 * SH-EXISTING-NFTS-E08C: where the add-on shows. Only on the local source of a build that names its manifest, parsed
 * against the local core manifest (never a v1 or v2.1 registry), and only once its factory's identity checked out on
 * chain; a refused or unreadable check shows nothing of it.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { decodeFunctionData, encodeFunctionResult, keccak256, stringToHex, toHex, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFactoryV2Abi } from '@squarehole/chain/core/set-v2';
import { synthManifestV2Json } from '../../../../../packages/chain/src/core/v2/test-support/synth-v2';
import type { CoreBuild } from '../core/core-build';
import { DATA_SOURCE_KEY, DataSourceProvider, resetDataSourceForTests, type DataSourceBuild } from '../data-source';
import { FACTORY_CHECK_DEADLINE_MS, recheckSetFactories, resetSetChecksForTests, setSourceOf, useSetSource, type FactoryCheck, type SetSource } from './set-build';
import { setManifestJson } from './test-support/set-chain';

const build = (set: unknown, manifests: readonly unknown[] = [synthManifestV2Json()]): CoreBuild => ({
  manifests, localRpcUrl: 'http://127.0.0.1:8599', indexers: { local: 'http://127.0.0.1:8597', sepolia: null }, artGateways: { local: ['http://127.0.0.1:8596'], sepolia: [] }, set,
});

const LOCAL: DataSourceBuild = { localManifest: null, sepoliaManifest: null, localRpcUrl: 'http://127.0.0.1:8599', coreLocal: true };

describe('the add-on’s source', () => {
  afterEach(() => {
    resetSetChecksForTests();
    window.localStorage.clear();
    resetDataSourceForTests();
  });

  it('is the local source’s only, with its own manifest parsed against the local core manifest', () => {
    const ready = setSourceOf('local', build(setManifestJson()));
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') throw new Error(ready.reason);
    expect(ready.source).toMatchObject({ network: 'local', chainId: 31_337, rpc: 'http://127.0.0.1:8599', origin: 'http://127.0.0.1:8597', art: ['http://127.0.0.1:8596'] });
    expect(ready.source.release.schema).toBe('squarehole.set-release/v1');
    for (const id of ['demo', 'sepolia'] as const) expect(setSourceOf(id, build(setManifestJson())).status).toBe('none');
    expect(setSourceOf('local', build(null)).status).toBe('none');
    expect(setSourceOf('local', build(undefined)).status).toBe('none');
    expect(setSourceOf('local', build(setManifestJson(), [])).status).toBe('none');
  });

  it('a manifest that names a core registry, a public network or an unknown field is invalid, never attached', () => {
    const core = synthManifestV2Json() as { releases: { registry: unknown }[] };
    for (const set of [{ ...setManifestJson(), network: 'sepolia' }, { ...setManifestJson(), extra: 1 }, { ...setManifestJson(), registry: core.releases[0]?.registry }, { schema: 'x' }]) {
      expect(setSourceOf('local', build(set)).status, JSON.stringify(set).slice(0, 40)).toBe('invalid');
    }
  });

  it('shows the add-on only once its factory answered as pinned; a refused check shows nothing', async () => {
    const seen: string[] = [];
    function Probe({ b }: { b: CoreBuild }) {
      const state = useSetSource(b);
      seen.push(state.status);
      return <p>{state.status}</p>;
    }
    let pass!: () => void;
    let fail!: (error: Error) => void;
    const checker = vi.fn(() => new Promise<void>((resolve, reject) => { pass = resolve; fail = reject; }));
    resetSetChecksForTests(checker);
    window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
    const b = build(setManifestJson());
    render(<DataSourceProvider build={LOCAL}><Probe b={b} /></DataSourceProvider>);
    expect(screen.getByText('checking')).toBeTruthy();
    await act(async () => { pass(); });
    expect(screen.getByText('ready')).toBeTruthy();
    expect(checker).toHaveBeenCalledTimes(1);
    cleanup();
    resetSetChecksForTests(checker);
    render(<DataSourceProvider build={LOCAL}><Probe b={b} /></DataSourceProvider>);
    await act(async () => { fail(new Error('factory versionCodeHash mismatch')); });
    expect(screen.getByText('refused')).toBeTruthy();
    // The demo source never asks: no add-on there.
    cleanup();
    window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'demo' }));
    resetDataSourceForTests();
    resetSetChecksForTests(checker);
    checker.mockClear();
    render(<DataSourceProvider build={LOCAL}><Probe b={b} /></DataSourceProvider>);
    expect(screen.getByText('none')).toBeTruthy();
    expect(checker).not.toHaveBeenCalled();
    expect(seen.filter((s) => s === 'ready').length).toBeGreaterThan(0);
  });

  it('XR-ITEM-3D-V2 F2: recheckSetFactories (the box page’s Retry) asks a refused check again at once; one that passed is not asked again', async () => {
    const checker = vi.fn<FactoryCheck>(async () => { throw new Error('The request took too long to respond.'); });
    resetSetChecksForTests(checker);
    window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
    const b = build(setManifestJson());
    function Probe() {
      return <p>{useSetSource(b).status}</p>;
    }
    render(<DataSourceProvider build={LOCAL}><Probe /></DataSourceProvider>);
    expect(await screen.findByText('refused')).toBeTruthy();
    expect(checker).toHaveBeenCalledTimes(1);
    let pass!: () => void;
    checker.mockImplementation(() => new Promise<void>((resolve) => { pass = resolve; }));
    act(() => { recheckSetFactories(); });
    expect(screen.getByText('checking')).toBeTruthy();
    expect(checker).toHaveBeenCalledTimes(2);
    await act(async () => { pass(); });
    expect(screen.getByText('ready')).toBeTruthy();
    act(() => { recheckSetFactories(); });
    expect(checker).toHaveBeenCalledTimes(2);
    expect(screen.getByText('ready')).toBeTruthy();
  });
});

/**
 * XR2-ITEM-3D-V2 F1: the real check (rpcFactoryCheck, viem's http transport) over a fetch that plays the RPC: the chain
 * id, the block number, then the factory's three pins by eth_call. A pin in `stall` gets its headers and a body that
 * never ends (only the request's signal ends it, as a browser's fetch does); a pin in `wrong` answers another value.
 */
function rpc(source: SetSource, { stall = [], wrong = [] }: { readonly stall?: readonly string[]; readonly wrong?: readonly string[] } = {}) {
  const pins: Record<string, Hex> = { versionCodeHash: source.release.versionCodeHash, RELEASE: source.release.release, TEMPLATE: source.release.templateId };
  const calls: { method: string; pin: string | null; signal: AbortSignal | null; done: boolean }[] = [];
  let mostStalled = 0;
  const stalled = () => calls.filter((call) => !call.done && !call.signal?.aborted).length;
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: readonly { data?: Hex }[] };
    const signal = init?.signal ?? null;
    const pin = body.method === 'eth_call' ? decodeFunctionData({ abi: setFactoryV2Abi, data: body.params?.[0]?.data as Hex }).functionName : null;
    const call = { method: body.method, pin, signal, done: false };
    calls.push(call);
    const result = body.method === 'eth_chainId' ? toHex(source.chainId) : body.method === 'eth_blockNumber' ? '0x10'
      : encodeFunctionResult({ abi: setFactoryV2Abi, functionName: pin as 'RELEASE', result: wrong.includes(pin as string) ? keccak256(stringToHex('another pin')) : pins[pin as string] as Hex });
    const headers = { 'content-type': 'application/json' };
    if (pin !== null && stall.includes(pin)) {
      mostStalled = Math.max(mostStalled, stalled());
      return new Response(new ReadableStream({
        start(stream) { signal?.addEventListener('abort', () => stream.error(signal.reason), { once: true }); },
      }), { headers });
    }
    call.done = true;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers });
  }));
  return { calls, stalled, mostStalled: () => mostStalled, pinReads: () => calls.filter((call) => call.method === 'eth_call') };
}

describe('XR2-ITEM-3D-V2 F1: a factory check ends whole, and by its deadline', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetSetChecksForTests();
    window.localStorage.clear();
    resetDataSourceForTests();
  });
  const b = build(setManifestJson());
  const source = (): SetSource => {
    const resolved = setSourceOf('local', b);
    if (resolved.status !== 'ready') throw new Error(resolved.reason);
    return resolved.source;
  };
  function Probe() {
    const state = useSetSource(b);
    return <p>{state.status === 'refused' ? `refused: ${state.reason}` : state.status}</p>;
  }
  const show = () => {
    window.localStorage.setItem(DATA_SOURCE_KEY, JSON.stringify({ source: 'local' }));
    render(<DataSourceProvider build={LOCAL}><Probe /></DataSourceProvider>);
  };
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('the real transport, a pin answer whose body never ends: refused at FACTORY_CHECK_DEADLINE_MS with every request aborted; Retry checks again', async () => {
    vi.useFakeTimers();
    const r = rpc(source(), { stall: ['versionCodeHash', 'RELEASE', 'TEMPLATE'] });
    resetSetChecksForTests();
    show();
    await tick(10);
    expect(screen.getByText('checking')).toBeTruthy();
    expect(r.calls.map((call) => call.method)).toEqual(['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_call', 'eth_call']);
    expect(r.stalled()).toBe(3);
    await tick(FACTORY_CHECK_DEADLINE_MS - 20);
    expect(screen.getByText('checking')).toBeTruthy();
    expect(r.calls.every((call) => call.signal?.aborted === false)).toBe(true);
    await tick(20);
    expect(screen.getByText('refused: no answer within 8 s')).toBeTruthy();
    // Every request of the check carried its signal, and none is left reading.
    expect(r.calls.every((call) => call.signal?.aborted === true)).toBe(true);
    expect(r.stalled()).toBe(0);
    act(() => { recheckSetFactories(); });
    expect(screen.getByText('checking')).toBeTruthy();
    await tick(10);
    expect(r.pinReads()).toHaveLength(6);
    expect(r.stalled()).toBe(3);
    expect(FACTORY_CHECK_DEADLINE_MS).toBe(8_000);
  });

  it('the real transport, a pin that does not match while its two sibling reads stall: refused at once, both aborted; repeated Retry runs one check at a time and leaves nothing reading', async () => {
    const r = rpc(source(), { wrong: ['RELEASE'], stall: ['versionCodeHash', 'TEMPLATE'] });
    resetSetChecksForTests();
    show();
    expect(await screen.findByText('refused: Set manifest rejected: factory RELEASE mismatch')).toBeTruthy();
    expect(r.pinReads()).toHaveLength(3);
    expect(r.stalled()).toBe(0);
    for (let press = 1; press <= 3; press += 1) {
      act(() => { recheckSetFactories(); });
      // A press while the check runs starts nothing more.
      act(() => { recheckSetFactories(); });
      expect(await screen.findByText('refused: Set manifest rejected: factory RELEASE mismatch')).toBeTruthy();
      expect(r.pinReads()).toHaveLength(3 * (press + 1));
      expect(r.stalled()).toBe(0);
    }
    // Never more than one check's two stalled reads at a time.
    expect(r.mostStalled()).toBeLessThanOrEqual(2);
  });

  it('a checker that ignores its signal still ends at the deadline (its signal aborted), and its late answer never changes the newer check', async () => {
    vi.useFakeTimers();
    let late: () => void = () => undefined;
    let pass: () => void = () => undefined;
    const signals: AbortSignal[] = [];
    const checker = vi.fn<FactoryCheck>((_source, signal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => { if (signals.length === 1) late = resolve; else pass = resolve; });
    });
    resetSetChecksForTests(checker);
    show();
    await tick(FACTORY_CHECK_DEADLINE_MS);
    expect(screen.getByText('refused: no answer within 8 s')).toBeTruthy();
    expect(signals[0]?.aborted).toBe(true);
    act(() => { recheckSetFactories(); });
    expect(checker).toHaveBeenCalledTimes(2);
    expect(screen.getByText('checking')).toBeTruthy();
    await act(async () => { late(); });
    expect(screen.getByText('checking')).toBeTruthy();
    await act(async () => { pass(); });
    expect(screen.getByText('ready')).toBeTruthy();
    expect(signals[1]?.aborted).toBe(false);
  });
});
