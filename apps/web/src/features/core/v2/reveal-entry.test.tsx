/**
 * SH-203: the way into Reveal items (RevealEntryV2). One button, for the connected creator of an open-art box that
 * commits a reveal root, only while the chain shows items left; visitors see nothing new. The sub-view sits in the URL
 * (`?view=reveal`, an allowlist), so a reload keeps it; closing drops it. The chain's counts are a test double.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { getAddress, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders, createQueryClient } from '../../../app-providers';
import type { BoxRecordV2 } from '../../../../../../packages/chain/src/core/v2';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { RevealEntryV2, opensReveal, useBoxSubView } from './RevealEntryV2';
import type { RevealCounts } from './RevealCopyV2';
import { REVEAL_WORDS as W } from './reveal-words';

const a = (n: bigint) => getAddress(`0x${n.toString(16).padStart(40, '0')}`) as Address;
const creator = a(50n);
const visitor = a(51n);
const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 11155111, kind: 'injected', defaultDialog: 'browser', signer: null }));
vi.mock('../../wallet', async (original) => ({ ...(await original<object>()), useWallet: () => wallet }));

const ROOT = `0x${'70'.repeat(32)}` as Hex;
const record: BoxRecordV2 = {
  boxId: 1n, templateId: zeroHash, specHash: zeroHash, creator, pricingListingId: 0, q: zeroAddress,
  raise: 1n, poolManager: a(52n), poolId: zeroHash, creationBlock: 7n, openAt: 1n, randomness: a(53n),
  contracts: Array.from({ length: 24 }, (_, i) => a(BigInt(i + 1))), codeHashes: Array.from({ length: 24 }, () => zeroHash),
};
const source = { network: 'sepolia', manifest: { chainId: 11155111 }, rpc: 'http://127.0.0.1:1' } as unknown as V2Source;
const viewOf = (artMode = 1, revealRoot: Hex = ROOT) => ({ record, token: a(9n), spec: { artMode, revealRoot } }) as unknown as V2Snapshot;

function Where() {
  const location = useLocation();
  const [sub, select] = useBoxSubView();
  return <p data-where="">{`${location.search}|${sub ?? 'box'}`}<button type="button" onClick={() => select(null)}>close</button></p>;
}
function mount(options: { counts?: RevealCounts; view?: V2Snapshot; at?: string } = {}) {
  const counts = vi.fn(async () => options.counts ?? { revealed: 12n, size: 41n });
  const onOpen = vi.fn();
  render(
    <MemoryRouter initialEntries={[options.at ?? '/box/11155111/0x9']}>
      <AppProviders queryClient={createQueryClient()}>
        <RevealEntryV2 view={options.view ?? viewOf()} source={source} onOpen={onOpen} counts={counts} />
        <Where />
      </AppProviders>
    </MemoryRouter>,
  );
  return { counts, onOpen };
}
const entry = () => screen.queryByRole('button', { name: W.entry });

beforeEach(() => { Object.assign(wallet, { account: creator, status: 'connected' }); });
afterEach(() => { cleanup(); });

describe('SH-203 the Reveal items entry', () => {
  it('shows one button to the creator while items are left; pressing it opens the view', async () => {
    const { onOpen } = mount();
    await waitFor(() => expect(entry()).toBeTruthy());
    expect(screen.getAllByRole('button', { name: W.entry })).toHaveLength(1);
    fireEvent.click(entry() as HTMLElement);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows nothing to a visitor, to nobody connected, once every item is revealed, before the chain answers, or on hidden or uncommitted art', async () => {
    for (const [name, setup] of [
      ['visitor', () => { wallet.account = visitor; return mount(); }],
      ['nobody', () => { Object.assign(wallet, { account: null, status: 'disconnected' }); return mount(); }],
      ['all revealed', () => mount({ counts: { revealed: 41n, size: 41n } })],
      ['hidden art', () => mount({ view: viewOf(2) })],
      ['no reveal root', () => mount({ view: viewOf(1, zeroHash) })],
    ] as const) {
      const { counts } = setup();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(entry(), name).toBeNull();
      if (name !== 'all revealed') expect(counts, name).not.toHaveBeenCalled();
      cleanup();
      Object.assign(wallet, { account: creator, status: 'connected' });
    }
  });

  it('af5 R4-L7a: once the chain’s count answers that every item is revealed, the entry is gone', async () => {
    // The control: the same mount with an item left shows the entry once the count answers.
    const left = mount({ counts: { revealed: 40n, size: 41n } });
    await waitFor(() => expect(entry()).toBeTruthy());
    expect(left.counts).toHaveBeenCalledTimes(1);
    cleanup();
    const { counts } = mount({ counts: { revealed: 41n, size: 41n } });
    await waitFor(() => expect(counts).toHaveBeenCalledTimes(1));
    await act(async () => { await counts.mock.results[0]?.value; await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(entry()).toBeNull();
  });

  it('the sub-view is in the URL by an allowlist: ?view=reveal opens it, anything else is the box, closing drops it', async () => {
    mount({ at: '/box/11155111/0x9?view=reveal&tab=x' });
    const where = () => screen.getByText((_t, el) => el?.getAttribute('data-where') === '').firstChild?.textContent;
    expect(where()).toBe('?view=reveal&tab=x|reveal');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'close' })));
    expect(where()).toBe('?tab=x|box');
    cleanup();
    mount({ at: '/box/11155111/0x9?view=other' });
    expect(where()).toBe('?view=other|box');
  });

  it('opens the view only for open art that commits its items and has a collection', () => {
    expect(opensReveal(viewOf())).toBe(true);
    expect(opensReveal(viewOf(2))).toBe(false);
    expect(opensReveal(viewOf(0))).toBe(false);
    expect(opensReveal(viewOf(1, zeroHash))).toBe(false);
  });
});
