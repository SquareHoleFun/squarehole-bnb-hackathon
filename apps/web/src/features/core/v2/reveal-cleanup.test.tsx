import { cleanup, render, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as viem from 'viem';
import { TermsAccessContext } from '../../legal/terms-access';
import { abandonKept, forgetKeptCopy, keepReveal, listKept, readKept, REVEAL_KEEP_FORMAT, keptKey, type KeptReveal } from '../../create/v2/reveal-keep';
import { completedReveal, reconcileRevealCopies, RevealKeepCleanup } from './RevealKeepCleanup';
import type { V2Source } from './indexer-v2';

vi.mock('viem', async (original) => {
  const module = await original<typeof import('viem')>();
  return { ...module, createPublicClient: vi.fn(module.createPublicClient) };
});

const token = '0x0000000000000000000000000000000000000001';
const copy = (patch: Partial<KeptReveal> = {}): KeptReveal => ({
  format: REVEAL_KEEP_FORMAT, key: keptKey(11155111, token), chainId: 11155111, token,
  creator: token, specHash: `0x${'a1'.repeat(32)}`, revealRoot: `0x${'b2'.repeat(32)}`,
  artMode: 'hidden', n: 12, fileName: 'reveal.json', text: 'secret salts', savedAt: 1, ...patch,
});
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', { storage: { persist: async () => true } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('SH-192 device-wide cleanup', () => {
  it('at app start removes a completed copy with no wallet or box page mounted', async () => {
    await keepReveal(copy());
    const complete = vi.fn(async () => true);
    render(<RevealKeepCleanup complete={complete} />);
    await waitFor(async () => expect(await listKept()).toEqual([]));
    expect(complete).toHaveBeenCalledWith(copy());
  });

  it('waits for terms acceptance, including on the gate-free privacy page', async () => {
    await keepReveal(copy());
    const complete = vi.fn(async () => true);
    const page = render(<TermsAccessContext value={false}><RevealKeepCleanup complete={complete} /></TermsAccessContext>);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(complete).not.toHaveBeenCalled();
    expect(await listKept()).toHaveLength(1);
    page.rerender(<TermsAccessContext value><RevealKeepCleanup complete={complete} /></TermsAccessContext>);
    await waitFor(async () => expect(await listKept()).toEqual([]));
  });

  it('a failed deletion is retried on the next pass and really removes the IndexedDB record', async () => {
    await keepReveal(copy());
    const forget = vi.fn(forgetKeptCopy).mockRejectedValueOnce(new Error('temporary storage failure'));
    await reconcileRevealCopies(async () => true, forget);
    expect(await readKept(11155111, token)).toEqual(copy());
    await reconcileRevealCopies(async () => true, forget);
    expect(forget).toHaveBeenCalledTimes(2);
    expect(await readKept(11155111, token)).toBeNull();
  });

  it('keeps incomplete or unreadable boxes; removes a persisted abandoned marker without network reads', async () => {
    await keepReveal(copy());
    await reconcileRevealCopies(async () => false);
    expect(await listKept()).toHaveLength(1);
    await reconcileRevealCopies(async () => { throw new Error('offline'); });
    expect(await listKept()).toHaveLength(1);
    await keepReveal(copy({ abandoned: true }));
    const complete = vi.fn(async () => false);
    await reconcileRevealCopies(complete);
    expect(complete).not.toHaveBeenCalled();
    expect(await listKept()).toEqual([]);
  });

  it('a stale deletion cannot remove the backup of a newer attempt', async () => {
    await keepReveal(copy());
    const old = (await listKept())[0];
    if (!old) throw new Error('Missing copy');
    await keepReveal(copy({ savedAt: 2 }));
    await forgetKeptCopy(old);
    expect((await readKept(11155111, token))?.savedAt).toBe(2);
    await abandonKept(old);
    expect((await readKept(11155111, token))?.savedAt).toBe(2);
    await abandonKept(copy({ savedAt: 2 }));
    expect(await listKept()).toEqual([]);
  });

  it('checks the RPC chain, spec, reveal root and full count before deletion', async () => {
    let chainId = 11155111;
    const answers: Record<string, unknown> = { initialHolder: token, collection: token, specHash: copy().specHash, revealRoot: copy().revealRoot, collectionSize: 12n, revealedCount: 12n };
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => answers[functionName]);
    vi.mocked(viem.createPublicClient).mockReturnValue({ getChainId: async () => chainId, getBlock: async () => ({ number: 7n, hash: viem.zeroHash }), getCode: async () => '0x', readContract } as never);
    const source = { rpc: 'http://127.0.0.1:1' } as V2Source;
    expect(await completedReveal(copy(), source)).toBe(true);
    expect(await completedReveal(copy({ discardWhenAbsent: true }), source)).toBe(true);
    chainId = 1;
    expect(await completedReveal(copy(), source)).toBe(false);
    chainId = 11155111;
    for (const [key, value] of Object.entries({ specHash: viem.zeroHash, revealRoot: viem.zeroHash, collectionSize: 13n, revealedCount: 11n })) {
      const previous = answers[key];
      answers[key] = value;
      expect(await completedReveal(copy(), source), key).toBe(false);
      answers[key] = previous;
    }
  });
  it('retains head-complete copies until one finalized snapshot has N of N', async () => {
    await keepReveal(copy());
    let finalizedCount = 11n;
    let finalityAvailable = true;
    const getBlock = vi.fn(async (args: { blockTag?: string; blockNumber?: bigint }) => {
      expect(args.blockTag === 'finalized' || args.blockNumber === 7n).toBe(true);
      if (!finalityAvailable) throw new Error('finality unavailable');
      return { number: 7n, hash: viem.zeroHash };
    });
    const readContract = vi.fn(async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      const answers: Record<string, unknown> = { initialHolder: token, collection: token, specHash: copy().specHash,
        revealRoot: copy().revealRoot, collectionSize: 12n, revealedCount: blockNumber === 7n ? finalizedCount : 12n };
      return answers[functionName];
    });
    vi.mocked(viem.createPublicClient).mockReturnValue({ getChainId: async () => 11155111, getBlock, readContract } as never);
    const source = { rpc: 'http://127.0.0.1:1' } as V2Source;
    const reconcile = () => reconcileRevealCopies((held) => completedReveal(held, source));
    await reconcile();
    expect(await readKept(11155111, token)).toEqual(copy());
    finalityAvailable = false;
    await reconcile();
    expect(await readKept(11155111, token)).toEqual(copy());
    finalityAvailable = true;
    finalizedCount = 12n;
    await reconcile();
    expect(await readKept(11155111, token)).toBeNull();
    expect(readContract.mock.calls.every(([args]) => args.blockNumber === 7n)).toBe(true);
  });

});
