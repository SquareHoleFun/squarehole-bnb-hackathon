/**
 * SH-218 rail 2 (design section 6, `last-send-check-uses-the-run` and `already-created-run-can-finish`): the run asks
 * the Create switches right before the wallet for the payment approval and every createBox attempt (Continue and a
 * dropped send's retry included), with its own plan (its exact spec bytes, chain and factory, never the page's draft);
 * a refusal sends nothing and never marks the run as maybe sent; once the chain shows the box created, its chunks,
 * starter items, seed and completion go on whatever the list says. The executor's guard and the in-memory chain of
 * create-send.test.ts (test-support/create-send-fake.ts).
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateSendPlanV2 } from '../../../../../../packages/chain/src/core/v2';
import type { V2Source } from '../../core/v2/indexer-v2';
import { OWNER } from '../test-support/fixtures';
import { CREATE_OFF, CREATE_UNAVAILABLE } from './create-options-words';
import { CreateRefusal, prepareCreateV2, runCreateV2, specOfRun } from './create-send';
import { clearRunV2, loadRunV2 } from './create-send-store';
import { DEMO_LISTINGS } from './listings';
import { encodeBoxSpecV2 } from './spec-types';
import { CHAIN, kinds, setup } from './test-support/create-send-fake';
import { useCreateSend } from './useCreateSend';

const off = () => new CreateRefusal('refused', CREATE_OFF);

describe('last-send-check-uses-the-run: the runner and the executor', () => {
  it('an ERC-20 price coin: asked before the approval and before createBox, with the run’s own plan; never for the chunk', async () => {
    const { spec, fake, hooks, createOptionsCheck } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
    expect(createOptionsCheck).toHaveBeenCalledTimes(2);
    for (const [plan] of createOptionsCheck.mock.calls) {
      expect(encodeBoxSpecV2((plan as CreateSendPlanV2).spec)).toBe(run.encoded);
      expect(plan).toMatchObject({ chainId: run.chainId, factory: run.factory, creator: run.creator, coordinator: run.coordinator });
    }
  });

  it('a refusal before the approval sends nothing and leaves the run unmarked; Continue asks again and goes on', async () => {
    const { spec, fake, hooks, createOptionsCheck, stored } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    createOptionsCheck.mockRejectedValueOnce(off());
    await expect(runCreateV2(run, hooks())).rejects.toThrow(CREATE_OFF);
    expect(kinds(fake)).toEqual([]);
    expect(fake.wallet.mock.calls.map(([call]) => call.method)).not.toContain('eth_sendTransaction');
    expect(stored()).toBeNull();
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
    expect(createOptionsCheck).toHaveBeenCalledTimes(3);
  });

  it('a refusal between the mined approval and createBox: createBox is not sent; every later attempt asks again', async () => {
    const { spec, fake, hooks, createOptionsCheck } = setup('depth-reward', {}, { firstIn: '100' });
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    createOptionsCheck.mockResolvedValueOnce(undefined).mockRejectedValueOnce(off()).mockRejectedValueOnce(off());
    await expect(runCreateV2(run, hooks())).rejects.toThrow(CREATE_OFF);
    expect(kinds(fake)).toEqual(['approve']);
    // Continue: the approval is mined (never resent); createBox asks again and is refused again.
    await expect(runCreateV2(run, hooks())).rejects.toThrow(CREATE_OFF);
    expect(kinds(fake)).toEqual(['approve']);
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
    expect(createOptionsCheck).toHaveBeenCalledTimes(4);
  });

  it('already-created-run-can-finish: once createBox is mined, the chunks, a pile’s seed approval and its load go on with every option off', async () => {
    const { spec, fake, hooks, createOptionsCheck } = setup('dragons-hoard');
    const run = await prepareCreateV2(fake.reads, CHAIN, spec, OWNER);
    const first = hooks(() => kinds(fake).includes('createBox'));
    await expect(runCreateV2(run, first)).resolves.toBe('stopped');
    expect(kinds(fake)).toEqual(['createBox']);
    createOptionsCheck.mockClear();
    createOptionsCheck.mockRejectedValue(off());
    await expect(runCreateV2(run, hooks())).resolves.toBe('done');
    expect(kinds(fake).slice(1)).toEqual(['approve', 'loadSeed']);
    expect(createOptionsCheck).not.toHaveBeenCalled();
  });
});

describe('last-send-check-uses-the-run: the page’s hook', () => {
  const SOURCE = {
    network: 'local', rpc: 'http://127.0.0.1:8545', origin: 'http://127.0.0.1:8596',
    manifest: { chainId: 31337, releases: [{ factory: { address: CHAIN.factory }, listingRegistry: { address: CHAIN.listingRegistry }, implementations: { coordinator: { address: CHAIN.coordinatorImplementation } } }] },
  } as unknown as V2Source;
  beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); clearRunV2(); });
  afterEach(() => { cleanup(); clearRunV2(); vi.unstubAllGlobals(); });

  it('a refused send fails with the check’s line, keeps the saved run unmarked, and Continue asks again with the same bytes', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const check = vi.fn<(plan: CreateSendPlanV2) => Promise<void>>(async () => { throw new CreateRefusal('refused', CREATE_UNAVAILABLE); });
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: check, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads }));
    await waitFor(() => expect(hook.result.current.available).toBe(true));
    await act(async () => { await hook.result.current.start(); });
    expect(hook.result.current.view).toMatchObject({ phase: 'failed', message: CREATE_UNAVAILABLE });
    expect(kinds(fake)).toEqual([]);
    const saved = loadRunV2();
    expect(saved?.walletPending).not.toBe(true);
    expect(saved?.encoded).toBe(encodeBoxSpecV2(spec));
    expect(hook.result.current.resumes).toBe(true);
    // Continue checks the saved run's own bytes again.
    check.mockImplementation(async () => undefined);
    await act(async () => { await hook.result.current.start(); });
    await waitFor(() => expect(hook.result.current.view.phase).toBe('done'));
    expect(check.mock.calls.every(([plan]) => encodeBoxSpecV2(plan.spec) === saved?.encoded)).toBe(true);
    expect(specOfRun(saved ?? { encoded: '0x' }).tokenSymbol).toBe(spec.tokenSymbol);
  });

  it('N2: nothing is published for a creation the switches refuse: the fresh check comes before the pictures, and the last one stays', async () => {
    const { spec, fake } = setup('depth-reward', {}, { firstIn: '100' });
    const order: string[] = [];
    const check = vi.fn<(plan: CreateSendPlanV2) => Promise<void>>(async (plan) => { order.push(`check ${encodeBoxSpecV2(plan.spec) === encodeBoxSpecV2(spec)}`); throw new CreateRefusal('refused', CREATE_OFF); });
    const beforeWallet = vi.fn(async () => { order.push('publish'); return true; });
    const hook = renderHook(() => useCreateSend({ createOptionsCheck: check, beforeWallet, source: SOURCE, spec, owner: OWNER, wallet: fake.wallet, listings: DEMO_LISTINGS, reads: fake.reads }));
    await waitFor(() => expect(hook.result.current.available).toBe(true));
    await act(async () => { await hook.result.current.start(); });
    expect(hook.result.current.view).toMatchObject({ phase: 'failed', message: CREATE_OFF });
    expect(beforeWallet).not.toHaveBeenCalled();
    expect(order).toEqual(['check true']);
    expect(kinds(fake)).toEqual([]);
    // Continue with the list on again: the check, then the pictures, then the approval asks the executor's check too.
    check.mockImplementation(async (plan) => { order.push(`check ${encodeBoxSpecV2(plan.spec) === encodeBoxSpecV2(spec)}`); });
    await act(async () => { await hook.result.current.start(); });
    await waitFor(() => expect(hook.result.current.view.phase).toBe('done'));
    expect(order.slice(0, 4)).toEqual(['check true', 'check true', 'publish', 'check true']);
    expect(beforeWallet).toHaveBeenCalledTimes(1);
    expect(kinds(fake)).toEqual(['approve', 'createBox', 'loadChunk']);
  });
});
