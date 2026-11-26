/**
 * SH-192 (BOXSPEC-AUTOSAVE): the creator's copy of the reveal data on the box page (RevealCopyV2). Only the connected
 * creator of a box that commits a reveal root sees it, while the chain counts unrevealed items: "Reveal data saved on
 * this device" with Download again, or the plain line that this device has none. Once every item is revealed the copy
 * is removed. The chain's counts and the device's copy are test doubles; the real IndexedDB module is reveal-keep.test.ts.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as viem from 'viem';
import { IDBFactory } from 'fake-indexeddb';
import { getAddress, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, createQueryClient } from '../../../app-providers';
import type { BoxRecordV2 } from '../../../../../../packages/chain/src/core/v2';
import { REVEAL_KEEP_FORMAT, keptKey, keepReveal, readKept, forgetKeptCopy, type KeptReveal } from '../../create/v2/reveal-keep';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { completedReveal } from './reveal-finalized';
import { REVEAL_COPY_NONE, REVEAL_COPY_SAVED, RevealCopyV2, revealCountText, type RevealCounts } from './RevealCopyV2';

vi.mock('viem', async (original) => {
  const module = await original<typeof import('viem')>();
  return { ...module, createPublicClient: vi.fn(module.createPublicClient) };
});

const a = (n: bigint) => getAddress(`0x${n.toString(16).padStart(40, '0')}`) as Address;
const creator = a(50n);
const other = a(51n);
const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 11155111, kind: 'injected', defaultDialog: 'browser', signer: null }));
vi.mock('../../wallet', async (original) => ({ ...(await original<object>()), useWallet: () => wallet }));

const SPEC_HASH = `0x${'5e'.repeat(32)}` as Hex;
const ROOT = `0x${'70'.repeat(32)}` as Hex;
const TOKEN = a(9n);
const record: BoxRecordV2 = {
  boxId: 1n, templateId: zeroHash, specHash: SPEC_HASH, creator, pricingListingId: 0, q: zeroAddress,
  raise: 1n, poolManager: a(52n), poolId: zeroHash, creationBlock: 7n, openAt: 1n, randomness: a(53n),
  contracts: Array.from({ length: 24 }, (_, i) => a(BigInt(i + 1))), codeHashes: Array.from({ length: 24 }, () => zeroHash),
};
const source = { network: 'sepolia', manifest: { chainId: 11155111 }, origin: 'http://127.0.0.1:1', rpc: 'http://127.0.0.1:1', art: [] } as unknown as V2Source;
const viewOf = (artMode = 1, revealRoot: Hex = ROOT) => ({ record, token: TOKEN, spec: { artMode, revealRoot } }) as unknown as V2Snapshot;
const copy = (patch: Partial<KeptReveal> = {}): KeptReveal => ({
  format: REVEAL_KEEP_FORMAT, key: keptKey(11155111, TOKEN), chainId: 11155111, token: TOKEN.toLowerCase() as Address, creator, specHash: SPEC_HASH,
  revealRoot: ROOT, artMode: 'open', n: 500, fileName: 'rentfree-reveal-data-v2.json', text: '{"format":"squarehole.boxspec/2"}\n', savedAt: 1, ...patch,
});

function mount(options: { realStorage?: boolean; complete?: typeof completedReveal; counts?: RevealCounts | Error; kept?: KeptReveal | null; view?: V2Snapshot } = {}) {
  const read = vi.fn(options.realStorage ? readKept : async () => options.kept ?? null);
  const forget = vi.fn(options.realStorage ? forgetKeptCopy : async () => undefined);
  const counts = vi.fn(async () => { if (options.counts instanceof Error) throw options.counts; return options.counts ?? { revealed: 12n, size: 500n }; });
  const complete = options.complete ?? (async () => options.counts instanceof Error ? false : options.counts?.revealed === 500n);
  const client = createQueryClient();
  const view = render(<AppProviders queryClient={client}><RevealCopyV2 view={options.view ?? viewOf()} source={source} counts={counts} complete={complete} kept={{ read, forget }} /></AppProviders>);
  return { ...view, read, forget, counts, client };
}
const panel = () => screen.queryByRole('region', { name: 'Reveal data' });

let clicks: ReturnType<typeof vi.spyOn>;
const urls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
beforeEach(() => {
  Object.assign(wallet, { account: creator, status: 'connected' });
  clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:copy'), revokeObjectURL: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.assign(URL, urls); });

describe('SH-192 the reveal data on the box page', () => {
  it('the creator with a copy here: the count first, "Reveal data saved on this device", and Download again gives the file', async () => {
    const t = mount({ kept: copy() });
    await waitFor(() => expect(panel()?.textContent).toContain(REVEAL_COPY_SAVED));
    expect(await screen.findByText(revealCountText(488n, 500n))).toBeTruthy();
    expect(t.read).toHaveBeenCalledWith(11155111, TOKEN);
    let saved: Blob | null = null;
    vi.mocked(URL.createObjectURL).mockImplementation((blob) => { saved = blob as Blob; return 'blob:copy'; });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Download again' })));
    expect(clicks).toHaveBeenCalledTimes(1);
    const link = clicks.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('rentfree-reveal-data-v2.json');
    expect(await (saved as unknown as Blob).text()).toBe(copy().text);
    expect(t.forget).not.toHaveBeenCalled();
  });

  it('the creator without a copy here, items unrevealed: one plain line says so', async () => {
    mount({ kept: null });
    expect((await screen.findByRole('alert')).textContent).toBe(REVEAL_COPY_NONE);
    expect(screen.queryByRole('button', { name: 'Download again' })).toBeNull();
  });

  it('a copy made for another spec is not this box’s: the page says this device has none', async () => {
    mount({ kept: copy({ specHash: `0x${'aa'.repeat(32)}` }) });
    expect((await screen.findByRole('alert')).textContent).toBe(REVEAL_COPY_NONE);
  });

  it('every item revealed on chain: the copy is removed and the panel goes', async () => {
    const t = mount({ kept: copy(), counts: { revealed: 500n, size: 500n } });
    await waitFor(() => expect(t.forget).toHaveBeenCalledWith(copy()));
    expect(panel()).toBeNull();
  });

  it('head N/N cannot delete: waits for matching identity/root/size/count at one finalized block', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('navigator', { storage: { persist: async () => true } });
    await keepReveal(copy());
    let revealed = 499n;
    let available = true;
    const getBlock = vi.fn(async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) => {
      expect(blockTag === 'finalized' || blockNumber === 42n).toBe(true);
      if (!available) throw new Error('no finality');
      return { number: 42n, hash: viem.zeroHash };
    });
    const readContract = vi.fn(async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      const answers: Record<string, unknown> = { initialHolder: creator, collection: a(1n), specHash: SPEC_HASH, revealRoot: ROOT,
        collectionSize: 500n, revealedCount: blockNumber === 42n ? revealed : 500n };
      return answers[functionName];
    });
    vi.mocked(viem.createPublicClient).mockReturnValue({ getChainId: async () => 11155111, getBlock, readContract } as never);
    const t = mount({ realStorage: true, counts: { size: 500n, revealed: 500n }, complete: completedReveal });
    await waitFor(() => expect(readContract).toHaveBeenCalledTimes(6));
    expect(t.forget).not.toHaveBeenCalled();
    expect(await readKept(11155111, TOKEN)).toEqual(copy());
    available = false;
    await act(async () => { await t.client.invalidateQueries({ queryKey: ['v2-reveal-finalized'] }); });
    expect(t.forget).not.toHaveBeenCalled();
    expect(await readKept(11155111, TOKEN)).toEqual(copy());
    available = true; revealed = 500n;
    await act(async () => { await t.client.invalidateQueries({ queryKey: ['v2-reveal-finalized'] }); });
    await waitFor(() => expect(t.forget).toHaveBeenCalledWith(copy()));
    await waitFor(async () => expect(await readKept(11155111, TOKEN)).toBeNull());
    expect(readContract.mock.calls.every(([args]) => args.blockNumber === 42n)).toBe(true);
  });

  it('an unread chain: a copy is still offered, and no alarm without the chain’s count; nothing is removed', async () => {
    const t = mount({ kept: copy(), counts: new Error('rpc down') });
    await waitFor(() => expect(panel()?.textContent).toContain(REVEAL_COPY_SAVED));
    expect(screen.queryByText(/not revealed/)).toBeNull();
    cleanup();
    mount({ kept: null, counts: new Error('rpc down') });
    await waitFor(() => expect(t.read).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(panel()).toBeNull();
    expect(t.forget).not.toHaveBeenCalled();
  });

  it('nobody else sees it: another wallet, no wallet, a token box (no reveal root)', async () => {
    Object.assign(wallet, { account: other });
    const t = mount({ kept: copy() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(panel()).toBeNull();
    expect(t.read).not.toHaveBeenCalled();
    expect(t.counts).not.toHaveBeenCalled();
    cleanup();
    Object.assign(wallet, { account: null, status: 'disconnected' });
    mount({ kept: copy() });
    expect(panel()).toBeNull();
    cleanup();
    Object.assign(wallet, { account: creator, status: 'connected' });
    const token = mount({ kept: copy(), view: viewOf(1, zeroHash) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(panel()).toBeNull();
    expect(token.read).not.toHaveBeenCalled();
  });

  it('hidden art: the same panel for its reveal file', async () => {
    mount({ kept: copy({ artMode: 'hidden', fileName: 'owl-reveal-file.json' }), view: viewOf(2) });
    await waitFor(() => expect(panel()?.textContent).toContain(REVEAL_COPY_SAVED));
  });
});
