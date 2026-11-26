/**
 * SH-EXISTING-NFTS-E08C: the existing-NFTs Create flow: four short steps, an Overview with every parameter and the full
 * list (windowed), the list file saved and bound to the set hash before Create, then Create, loading and its resume
 * against the in-memory chain standing in for the add-on and E-08B's sender. Navigation asks no wallet anything.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { keccak256, stringToHex, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { WalletRejectedError } from '@squarehole/chain/write';
import { AppProviders } from '../../../app-providers';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { FORBIDDEN } from '../../set/test-support/words';
import { resetItemPicturesForTests } from '../../set/set-pictures';
import { COLLECTION, CREATOR, FakeSetChain, OTHER, specFor } from '../../set/test-support/set-chain';
import type { SiteListing } from '../v2/listings';
import { CreateSetFlow } from './CreateSetFlow';
import { resetSetDraftForTests, updateSetDraft, type SetDraft } from './set-draft';
import { clearSetRun, saveSetRun } from './set-send-store';
import { prepareSetCreate } from './set-send';
import { createChainOf } from './useSetCreate';
import type { SetStepId } from './set-steps';

const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: null as null | { request: ReturnType<typeof vi.fn> }, switchChain: vi.fn() }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));

const logo = { sha256: keccak256(stringToHex('logo')).toLowerCase() as `0x${string}`, url: null, bytes: 4, data: btoa('logo') };

function listingsOf(chain: FakeSetChain): SiteListing[] {
  return [0, 1].map((id) => {
    const row = chain.listing(id);
    return { id: row.id, token: row.token, decimals: row.decimals, class: row.class, kind: row.kind, raise: row.raise, bootstrap: row.q.bootstrapQ, symbol: id === 0 ? 'ETH' : 'USDC', name: id === 0 ? 'ETH' : 'USDC', powers: [] };
  });
}

function fill(patch: Partial<SetDraft> = {}) {
  updateSetDraft((d) => ({ ...d, name: 'Outside Set', ticker: 'OUT', logo, collection: COLLECTION, ids: '0-39', ...patch }));
}

function connect(account: Address | null) {
  const request = vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0x7a69' : [account]));
  wallet.account = account;
  wallet.status = account ? 'connected' : 'disconnected';
  wallet.signer = account ? { request } : null;
  return request;
}

function show(step: SetStepId, chain: FakeSetChain, submit: FakeSetChain['submit'] | null = chain.submit) {
  return render(<AppProviders><MemoryRouter initialEntries={[`/create/${step}`]}>
    <CreateSetFlow step={step} source={chain.source} listings={listingsOf(chain)} reads={chain} submit={submit} />
  </MemoryRouter></AppProviders>);
}

const saved: string[] = [];
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:list');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSetDraftForTests();
  window.sessionStorage.clear();
  clearSetRun();
  resetItemPicturesForTests();
  saved.length = 0;
});

describe('the existing-NFTs Create flow', () => {
  it('Basics, Items and Raise: short steps, each with its own checks; navigation asks the wallet nothing', async () => {
    const chain = new FakeSetChain({ ids: Array.from({ length: 40 }, (_, i) => BigInt(i)) });
    const request = connect(CREATOR);
    show('set-basics', chain);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Basics');
    expect(within(screen.getByRole('group', { name: /^Priced in/ })).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['0x0000000000000000000000000000000000000000', chain.listing(1).token]);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('3 things to fix')).toBeTruthy();
    cleanup();
    show('set-items', chain);
    expect(screen.getByRole('textbox', { name: 'Collection' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Ids' }), { target: { value: '0-39' } });
    expect(await screen.findByText('40 ids')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: /^Pick fee/ })).getAllByRole('radio').map((r) => r.parentElement?.textContent)).toEqual(['1%', '5%', '25%']);
    cleanup();
    show('set-raise', chain);
    expect(screen.getByText('4.206980085 ETH')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: /^Deadline/ })).getAllByRole('radio')).toHaveLength(4);
    expect(screen.getByRole('textbox', { name: 'Your ETH at start' })).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  it('the Overview shows every parameter and the full list, windowed: 10,000 ids, a few rows in the page', async () => {
    const chain = new FakeSetChain();
    connect(null);
    fill({ ids: '1-10000', pickFeeBps: 2_500, deadlineDays: 60, about: 'Old friends' });
    show('set-overview', chain);
    const rows = (name: string) => Object.fromEntries([...screen.getByRole('region', { name }).querySelectorAll('.sh-newbox-row')].map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]));
    expect(rows('Basics')).toEqual({ 'Priced in': 'ETH', Token: 'Outside Set · OUT', Logo: 'Add a logo', About: 'Old friends' });
    const items = rows('Items');
    expect(items).toMatchObject({ Collection: COLLECTION, Items: '10,000', 'Pick fee': '25%', 'Return fee': '5%' });
    expect(items['Set hash']).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rows('Raise')).toEqual({ Raise: '4.206980085 ETH', Deadline: '60 days', Opens: 'Once loaded', 'Your ETH at start': '0 ETH', 'Trade fee': '1% · pool depth' });
    const list = screen.getByRole('region', { name: 'Every item, in order' });
    expect(screen.getByRole('heading', { name: 'List · 10,000' })).toBeTruthy();
    const shown = within(list).getAllByRole('listitem');
    expect(shown.length).toBeLessThan(40);
    expect(shown[0]?.getAttribute('aria-setsize')).toBe('10000');
    expect(shown[0]?.textContent).toContain('#1');
    fireEvent.scroll(list, { target: { scrollTop: 48 * 9_990 } });
    await waitFor(() => expect(within(list).getAllByRole('listitem').some((row) => row.textContent?.includes('#10000'))).toBe(true));
    expect(screen.getByRole('heading', { name: /^Create · 628 transactions$/ })).toBeTruthy();
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  it('the list file must be saved before Create, and only counts for the set hash it was saved for', async () => {
    const chain = new FakeSetChain({ ids: Array.from({ length: 40 }, (_, i) => BigInt(i)) });
    const request = connect(CREATOR);
    fill();
    show('set-overview', chain);
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save list file' }));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^out-list-[0-9a-f]{8}\.json$/);
    expect(await screen.findByRole('button', { name: 'Create' })).toBeTruthy();
    expect(screen.getByText('File saved')).toBeTruthy();
    // Another order of the same ids is another set: its own file first.
    act(() => fill({ ids: '39 0-38' }));
    expect(await screen.findByRole('button', { name: 'Save list file' })).toBeTruthy();
    expect(screen.getByText('File not saved')).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it('Create sends the plan step by step, loads in pages of 16, then offers Revoke; a reload resumes from the chain', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => BigInt(i));
    const chain = new FakeSetChain({ ids });
    connect(CREATOR);
    fill({ ids: '0-39', listSaved: null });
    show('set-overview', chain);
    fireEvent.click(screen.getByRole('button', { name: 'Save list file' }));
    // The first press stops after the first page (a hash held pending, its wait given up: the tab closed).
    chain.hold = false;
    let pages = 0;
    const submit = chain.submit;
    const stopping = async (request: Parameters<typeof submit>[0]) => {
      const hash = await submit(request);
      if (request.call.kind === 'load' && ++pages === 1) chain.failNextWait = true;
      return hash;
    };
    cleanup();
    show('set-overview', chain, stopping);
    const create = await screen.findByRole('button', { name: 'Create' });
    await act(async () => { fireEvent.click(create); });
    expect(await screen.findByText('The chain could not be read. Try again.')).toBeTruthy();
    expect(chain.sent.map((s) => s.kind)).toEqual(['createBox', 'approveAll', 'load']);
    // The failed loading attempt leaves the vault's approval on: it can be taken back right here (design § 4.11).
    expect(screen.getByRole('button', { name: 'Revoke loading approval' })).toBeTruthy();
    // A reload: the stored run is read from the chain before anything is sent; Continue goes on, nothing twice.
    cleanup();
    show('set-overview', chain);
    const resume = await screen.findByRole('button', { name: 'Continue' }, { timeout: 4_000 });
    await act(async () => { fireEvent.click(resume); });
    expect(chain.sent.map((s) => s.kind)).toEqual(['createBox', 'approveAll', 'load', 'load', 'load', 'complete']);
    expect(await screen.findByText('Created · trading open', {}, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open your box' }).getAttribute('href')).toBe(`/box/${chain.chainIdValue}/${chain.box.token.toLowerCase()}`);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revoke loading approval' })); });
    expect(await screen.findByText('Loading approval revoked')).toBeTruthy();
    expect(chain.sent.at(-1)?.kind).toBe('revokeAll');
  });

  it('a loading attempt that failed: Revoke takes the vault’s approval back at once, and Continue asks for it again', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => BigInt(i));
    const chain = new FakeSetChain({ ids });
    connect(CREATOR);
    fill({ ids: '0-39', listSaved: null });
    let pages = 0;
    const submit = chain.submit;
    const failing = async (request: Parameters<typeof submit>[0]) => {
      if (request.call.kind === 'load' && ++pages === 2) throw new WalletRejectedError();
      return submit(request);
    };
    show('set-overview', chain, failing);
    fireEvent.click(screen.getByRole('button', { name: 'Save list file' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    await screen.findByRole('button', { name: 'Continue' }, { timeout: 4_000 });
    expect(chain.sent.map((s) => s.kind)).toEqual(['createBox', 'approveAll', 'load']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revoke loading approval' })); });
    expect(await screen.findByText('Loading approval revoked')).toBeTruthy();
    expect(chain.sent.at(-1)?.kind).toBe('revokeAll');
    expect(screen.queryByRole('button', { name: 'Revoke loading approval' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continue' })); });
    expect(await screen.findByText('Created · trading open', {}, { timeout: 5_000 })).toBeTruthy();
    expect(chain.sent.map((s) => s.kind)).toEqual(['createBox', 'approveAll', 'load', 'revokeAll', 'approveAll', 'load', 'load', 'complete']);
  }, shLimit(15_000));

  it('a reload after the manifest changed on this chain: the stored run of the old release is refused and nothing is sent (XR F3)', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => BigInt(i));
    const chain = new FakeSetChain({ ids, native: false });
    const request = connect(CREATOR);
    fill({ ids: '0-39', listSaved: null });
    // A run this tab prepared under the old release, kept in the tab.
    saveSetRun(await prepareSetCreate(chain, createChainOf(chain.source), specFor(chain, ids), ids, CREATOR));
    const source = { ...chain.source, release: { ...chain.source.release, factory: { ...chain.source.release.factory, address: OTHER } } };
    render(<AppProviders><MemoryRouter initialEntries={['/create/set-overview']}>
      <CreateSetFlow step="set-overview" source={source} listings={listingsOf(chain)} reads={chain} submit={chain.submit} />
    </MemoryRouter></AppProviders>);
    expect(await screen.findByText('The factory is not this release’s.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(chain.sent).toEqual([]);
    expect(request.mock.calls.map(([call]) => (call as { method: string }).method)).not.toContain('eth_sendTransaction');
  });

  it('a build without the add-on’s sender reads and plans, and says it cannot send', async () => {
    const chain = new FakeSetChain({ ids: Array.from({ length: 40 }, (_, i) => BigInt(i)) });
    connect(CREATOR);
    fill();
    show('set-overview', chain, null);
    fireEvent.click(screen.getByRole('button', { name: 'Save list file' }));
    expect(((await screen.findByRole('button', { name: 'Create' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Sending is not available in this build.')).toBeTruthy();
    expect(chain.sent).toEqual([]);
  });

  it('the add-on is not on this source: one line and the way back to Launch', () => {
    render(<AppProviders><MemoryRouter><CreateSetFlow step="set-basics" source={null} /></MemoryRouter></AppProviders>);
    expect(screen.getByRole('status').textContent).toBe('Existing NFTs are not on this source.');
    expect(screen.getByRole('link', { name: 'Launch a box' }).getAttribute('href')).toBe('/create/v2-basics');
  });
});
