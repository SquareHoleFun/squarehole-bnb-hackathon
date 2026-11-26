/**
 * SH-EXISTING-NFTS-E08C: a set box's page in its five states, numbers first, with exactly the add-on's actions: named
 * picks and returns once graduated; the items going back to the creator, the close and the claims for a failed raise;
 * nothing to draw, reveal or collect, no trust wording, and no wallet request until a press. The chain and E-08B's
 * sender are the in-memory chain (test-support/set-chain.ts); the indexer answers from it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, toFunctionSelector, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBoxDataSchema, setVaultV2Abi } from '@squarehole/chain/core/set-v2';
import type { SetSubmit } from './set-calls';
import { AppProviders } from '../../app-providers';
import { appCopyFraming, renderedCopy } from '../legal/wording';
import { SetBoxPage } from './SetBoxPage';
import { forgetOwners } from './set-owners';
import { resetItemPicturesForTests } from './set-pictures';
import type { SetIndexer } from './set-indexer';
import { setRecord, type SetPhase } from './set-model';
import { CREATOR, FakeSetChain, HOLDER, OTHER, asOfOf, membersOf, sparseIds, specFor, wireOf } from './test-support/set-chain';
import { FORBIDDEN } from './test-support/words';

const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: null as null | { request: ReturnType<typeof vi.fn> } }));
vi.mock('../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));


const ids = sparseIds(40);
const STATES: Record<SetPhase, Parameters<FakeSetChain['seed']>[2]> = {
  pending: { loaded: 16 }, open: {}, graduated: { graduated: true, picked: 3 }, failed: { failed: true, loaded: 24 }, recovering: { failed: true, released: 10 },
};

function rig(phase: SetPhase, account: Address | null = null, state: Parameters<FakeSetChain['seed']>[2] = STATES[phase], before?: (chain: FakeSetChain) => void) {
  const chain = new FakeSetChain({ ids });
  chain.seed(specFor(chain, ids), ids, state);
  before?.(chain);
  // The box's own read (a mock, so a test can see the page read it again).
  const boxRead = vi.fn(async () => ({ schema: 'sh.core-set-box.v1' as const, chainId: chain.chainIdValue, asOf: asOfOf(chain), box: setBoxDataSchema.parse(wireOf(chain)) }));
  const indexer: SetIndexer = {
    feed: async () => ({ schema: 'sh.core-set-feed.v1', chainId: chain.chainIdValue, asOf: asOfOf(chain), boxes: [setBoxDataSchema.parse(wireOf(chain))] }),
    box: boxRead,
    members: async () => membersOf(chain),
  };
  const request = vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0x7a69' : [account]));
  wallet.account = account;
  wallet.status = account ? 'connected' : 'disconnected';
  wallet.signer = account ? { request } : null;
  const record = setRecord(setBoxDataSchema.parse(wireOf(chain)), chain.source, asOfOf(chain));
  render(<AppProviders><MemoryRouter><SetBoxPage record={record} seams={{ reads: chain, indexer, submit: chain.submit }} /></MemoryRouter></AppProviders>);
  return { chain, request, record, boxRead };
}

const figures = async () => {
  const list = await screen.findByLabelText('Numbers');
  return Object.fromEntries([...list.querySelectorAll('div')].map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]));
};

afterEach(() => {
  cleanup();
  forgetOwners();
  resetItemPicturesForTests();
});

describe('a set box’s page', () => {
  it('shows each of the five states numbers first, with only its own actions, no forbidden word and no wallet request', async () => {
    const expected: Record<SetPhase, { line: string; figures: Record<string, string | RegExp>; regions: readonly string[] }> = {
      pending: { line: 'OUT · Loading 16/40', figures: { Loaded: '16/40', Raise: '4.206980085 ETH', 'Pick fee': '5%' }, regions: ['Items'] },
      open: { line: 'OUT · Open', figures: { Items: '40', Raise: '4.206980085 ETH', 'Pick fee': '5%', Deadline: '30 days' }, regions: ['Items'] },
      graduated: { line: 'OUT · Graduated', figures: { 'In the box': '37', Out: '3', 'Pick one': / OUT$/, 'One back pays': / OUT$/ }, regions: ['Pick and return'] },
      failed: { line: 'OUT · Failed', figures: { Back: '0/24', 'Claim pot': '3 ETH', 'Coins left': '500 OUT' }, regions: ['Back to the creator', 'Items'] },
      recovering: { line: 'OUT · Failed · 10/40 back', figures: { Back: '10/40', 'Claim pot': '3 ETH', 'Coins left': '500 OUT' }, regions: ['Back to the creator', 'Items'] },
    };
    for (const phase of Object.keys(expected) as SetPhase[]) {
      const { request } = rig(phase);
      const want = expected[phase];
      expect(await screen.findByText(want.line)).toBeTruthy();
      await waitFor(async () => {
        const shown = await figures();
        for (const [label, value] of Object.entries(want.figures)) {
          if (typeof value === 'string') expect(shown[label], `${phase} ${label}`).toBe(value);
          else expect(shown[label], `${phase} ${label}`).toMatch(value);
        }
      });
      for (const name of ['Pick and return', 'Back to the creator', 'Close', 'Items']) {
        expect(screen.queryAllByRole('region', { name }).length > 0, `${phase}: ${name}`).toBe(want.regions.includes(name));
      }
      const text = document.body.textContent ?? '';
      expect(text, phase).not.toMatch(FORBIDDEN);
      expect(appCopyFraming(renderedCopy(document.body)), phase).toEqual([]);
      expect(screen.queryAllByRole('button', { name: /^(buy|sell|swap|draw|reveal)/i })).toEqual([]);
      expect(request, `${phase}: navigation never asks the wallet`).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('graduated: two named items, priced at one block; Pick 2 sends an exact approval of the limit, then withdrawBatch', async () => {
    const { chain, request } = rig('graduated', HOLDER);
    const panel = await screen.findByRole('region', { name: 'Pick and return' });
    const find = within(panel).getByRole('textbox', { name: 'Find id' });
    for (const id of [ids[10] as bigint, ids[11] as bigint]) {
      fireEvent.change(find, { target: { value: id.toString() } });
      fireEvent.click(await within(panel).findByRole('button', { name: `#${id.toString()}` }));
    }
    expect(within(panel).getByText(/2\/32 chosen/)).toBeTruthy();
    await waitFor(() => expect(panel.querySelector('[data-set-quote]')?.textContent).toMatch(/OUT · at most .* OUT$/));
    expect(request).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Pick 2' })); });
    await waitFor(() => expect(panel.querySelector('[data-set-status]')?.textContent).toBe('Picked 2'));
    expect(chain.sent.map((s) => s.kind)).toEqual(['approveToken', 'pick']);
    expect(chain.box.members.get((ids[10] as bigint).toString())).toBe('Outside');
    // The wallet was asked only for its network and account (the sender is E-08B's; here the chain's double).
    expect(request.mock.calls.map(([call]) => (call as { method: string }).method).every((method) => method === 'eth_chainId' || method === 'eth_accounts')).toBe(true);
  });

  it('Return: only this wallet’s items out of the box can be chosen; Return 1 approves that item, then returns it', async () => {
    const { chain } = rig('graduated', HOLDER);
    chain.move(ids[1] as bigint, CREATOR);
    const panel = await screen.findByRole('region', { name: 'Pick and return' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Return' }));
    expect(await within(panel).findByText(/3 out · 0\/16 chosen/)).toBeTruthy();
    const mine = await within(panel).findByRole('button', { name: `#${(ids[0] as bigint).toString()}` });
    await waitFor(() => expect(within(panel).getAllByText('Yours').length).toBe(2));
    // Another wallet's item is shown, never choosable.
    expect(within(panel).queryByRole('button', { name: `#${(ids[1] as bigint).toString()}` })).toBeNull();
    fireEvent.click(mine);
    await waitFor(() => expect(panel.querySelector('[data-set-quote]')?.textContent).toMatch(/OUT · at least .* OUT$/));
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Return 1' })); });
    await waitFor(() => expect(panel.querySelector('[data-set-status]')?.textContent).toBe('Returned 1'));
    expect(chain.sent.map((s) => s.kind)).toEqual(['approveItem', 'return']);
  });

  it('Return 1 of 3: the wallet’s other 2 items still read as its own and can be chosen (the holder rows read again after every action)', async () => {
    rig('graduated', HOLDER);
    const panel = await screen.findByRole('region', { name: 'Pick and return' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Return' }));
    const id = (ids[0] as bigint).toString();
    const mine = await within(panel).findByRole('button', { name: `#${id}` });
    await waitFor(() => expect(within(panel).getAllByText('Yours').length).toBe(3));
    fireEvent.click(mine);
    await waitFor(() => expect(panel.querySelector('[data-set-quote]')?.textContent).toMatch(/at least/));
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Return 1' })); });
    await waitFor(() => expect(panel.querySelector('[data-set-status]')?.textContent).toBe('Returned 1'));
    // The returned item is inside again; the other two read as this wallet's again and can be chosen.
    await waitFor(() => expect(within(panel).queryByRole('button', { name: `#${id}` })).toBeNull());
    await waitFor(() => expect(within(panel).getAllByText('Yours').length).toBe(2));
    const choosable = within(panel).getAllByRole('button', { name: /^#/ }).map((button) => button.getAttribute('aria-label')).sort();
    expect(choosable).toEqual([`#${(ids[1] as bigint).toString()}`, `#${(ids[2] as bigint).toString()}`].sort());
    fireEvent.click(within(panel).getByRole('button', { name: `#${(ids[1] as bigint).toString()}` }));
    expect(within(panel).getByText(/2 out · 1\/16 chosen/)).toBeTruthy();
  });

  it('every item loaded, complete() not sent: the page says Loading 40/40 once the trading gate is read, never Open (XR F1)', async () => {
    const { chain } = rig('pending', null, { complete: false });
    expect(await screen.findByText('OUT · Loading 40/40')).toBeTruthy();
    // The page has read the coordinator by now (its close rule needs it): still loading.
    await waitFor(() => expect(chain.calls).toContain('effectiveOpenAt'));
    expect(screen.queryByText('OUT · Open')).toBeNull();
    expect(screen.getByText('OUT · Loading 40/40')).toBeTruthy();
  });

  it('a failed raise: Send back 30 returns the loaded items to the creator; anyone may send them', async () => {
    const { chain } = rig('recovering', HOLDER);
    const panel = await screen.findByRole('region', { name: 'Back to the creator' });
    const button = await within(panel).findByRole('button', { name: 'Send back 30' });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(panel.querySelector('[data-set-status]')?.textContent).toBe('Sent back 30/30'));
    expect(chain.sent.map((s) => s.kind)).toEqual(['release']);
    expect(ids.slice(10).every((id) => chain.owners.get(id.toString()) === CREATOR)).toBe(true);
  });

  it('Send back after someone else sent the same items back: nothing is sent, and the refusal stays through the refresh', async () => {
    const { chain, boxRead } = rig('recovering', HOLDER);
    const panel = await screen.findByRole('region', { name: 'Back to the creator' });
    const button = await within(panel).findByRole('button', { name: 'Send back 30' });
    // Someone else's releaseToCreator for these 30 items is mined after the page read its list.
    for (const id of ids.slice(10)) {
      chain.box.members.set(id.toString(), 'Released');
      chain.owners.set(id.toString(), CREATOR);
      chain.box.inside -= 1n;
    }
    const before = boxRead.mock.calls.length;
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(boxRead.mock.calls.length).toBeGreaterThan(before));
    // The page read again: nothing is left to send back, and the refusal is still there.
    await waitFor(() => expect(within(panel).queryByRole('button', { name: /^Send back/ })).toBeNull());
    expect(panel.querySelector('[data-set-status]')?.textContent).toBe('Nothing to send back.');
    expect(chain.sent).toEqual([]);
  });

  it('Send back (XR2 F3) after someone else released the item and it was sent back to the vault: nothing is sent, and the refusal stays', async () => {
    const { chain, boxRead } = rig('failed', HOLDER, { failed: true, loaded: 1 });
    const panel = await screen.findByRole('region', { name: 'Back to the creator' });
    const button = await within(panel).findByRole('button', { name: 'Send back 1' });
    const id = (ids[0] as bigint).toString();
    // Before the press: someone else's releaseToCreator, then the item's transfer back into the vault.
    chain.box.members.set(id, 'Released');
    chain.box.inside -= 1n;
    chain.owners.set(id, chain.box.vault);
    const before = boxRead.mock.calls.length;
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(boxRead.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: /^Send back/ })).toBeNull());
    expect(panel.querySelector('[data-set-status]')?.textContent).toBe('Nothing to send back.');
    expect(chain.sent).toEqual([]);
    expect(chain.owners.get(id)).toBe(chain.box.vault);
  });

  it('a full page the collection refuses never blocks the rest: untried items go next, the refused retry apart; the count is the chain’s (XR F2)', async () => {
    const chain = new FakeSetChain({ ids });
    const box = chain.seed(specFor(chain, ids), ids, { failed: true });
    const blocked = new Set(ids.slice(0, 32).map(String));
    const deferred = new Set<string>();
    const pages: bigint[][] = [];
    // SetVaultV2 isolates an item its collection refuses: the batch succeeds, that item stays inside, deferred.
    const submit: SetSubmit = async (request) => {
      pages.push([...(decodeFunctionData({ abi: setVaultV2Abi, data: request.call.data }).args?.[0] as readonly bigint[])]);
      const hash = await chain.submit(request);
      for (const id of pages.at(-1) ?? []) {
        if (!blocked.has(String(id))) continue;
        box.members.set(String(id), 'Inside');
        chain.owners.set(String(id), box.vault);
        box.inside += 1n;
        deferred.add(String(id));
      }
      return hash;
    };
    const indexer: SetIndexer = {
      feed: async () => { throw new Error('unused'); },
      box: async () => ({ schema: 'sh.core-set-box.v1', chainId: chain.chainIdValue, asOf: asOfOf(chain), box: setBoxDataSchema.parse(wireOf(chain)) }),
      members: async () => { const wire = membersOf(chain); return { ...wire, members: wire.members.map((m) => (deferred.has(m.id) ? { ...m, state: 'Deferred' as const } : m)) }; },
    };
    wallet.account = HOLDER;
    wallet.status = 'connected';
    wallet.signer = { request: vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0x7a69' : [HOLDER])) };
    const record = setRecord(setBoxDataSchema.parse(wireOf(chain)), chain.source, asOfOf(chain));
    render(<AppProviders><MemoryRouter><SetBoxPage record={record} seams={{ reads: chain, indexer, submit }} /></MemoryRouter></AppProviders>);
    const panel = await screen.findByRole('region', { name: 'Back to the creator' });
    const status = () => panel.querySelector('[data-set-status]')?.textContent;
    await act(async () => { fireEvent.click(await within(panel).findByRole('button', { name: 'Send back 32' })); });
    await waitFor(() => expect(status()).toBe('Sent back 0/32'));
    // The 8 never tried come next; the 32 refused wait behind their own Retry.
    const next = await within(panel).findByRole('button', { name: 'Send back 8' });
    expect(within(panel).getByRole('button', { name: 'Retry 32' })).toBeTruthy();
    await act(async () => { fireEvent.click(next); });
    await waitFor(() => expect(status()).toBe('Sent back 8/8'));
    expect(pages.map((page) => page.length)).toEqual([32, 8]);
    expect(pages[1]).toEqual(ids.slice(32));
    expect(ids.slice(32).every((id) => chain.owners.get(id.toString()) === CREATOR)).toBe(true);
    await waitFor(() => expect(within(panel).queryByRole('button', { name: /^Send back/ })).toBeNull());
    expect(within(panel).getByRole('button', { name: 'Retry 32' })).toBeTruthy();
  });

  it('retries take turns: with 64 refused and the first 32 refused for good, a later retry reaches the 32 whose refusal cleared (XR2 F2)', async () => {
    const all = sparseIds(64);
    const chain = new FakeSetChain({ ids: all });
    const box = chain.seed(specFor(chain, all), all, { failed: true });
    const blocked = new Set(all.map(String));
    const deferred = new Set<string>();
    const pages: bigint[][] = [];
    // SetVaultV2 isolates an item its collection refuses: the batch succeeds, that item stays inside, deferred.
    const submit: SetSubmit = async (request) => {
      const page = [...(decodeFunctionData({ abi: setVaultV2Abi, data: request.call.data }).args?.[0] as readonly bigint[])];
      pages.push(page);
      const hash = await chain.submit(request);
      for (const id of page) {
        if (!blocked.has(String(id))) { deferred.delete(String(id)); continue; }
        box.members.set(String(id), 'Inside');
        chain.owners.set(String(id), box.vault);
        box.inside += 1n;
        deferred.add(String(id));
      }
      return hash;
    };
    const indexer: SetIndexer = {
      feed: async () => { throw new Error('unused'); },
      box: async () => ({ schema: 'sh.core-set-box.v1', chainId: chain.chainIdValue, asOf: asOfOf(chain), box: setBoxDataSchema.parse(wireOf(chain)) }),
      members: async () => { const wire = membersOf(chain); return { ...wire, members: wire.members.map((m) => (deferred.has(m.id) ? { ...m, state: 'Deferred' as const } : m)) }; },
    };
    wallet.account = HOLDER;
    wallet.status = 'connected';
    wallet.signer = { request: vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0x7a69' : [HOLDER])) };
    const record = setRecord(setBoxDataSchema.parse(wireOf(chain)), chain.source, asOfOf(chain));
    render(<AppProviders><MemoryRouter><SetBoxPage record={record} seams={{ reads: chain, indexer, submit }} /></MemoryRouter></AppProviders>);
    const panel = await screen.findByRole('region', { name: 'Back to the creator' });
    const status = () => panel.querySelector('[data-set-status]');
    const press = async (name: string, count: number) => {
      await act(async () => { fireEvent.click(await within(panel).findByRole('button', { name })); });
      await waitFor(() => expect(pages).toHaveLength(count));
      await waitFor(() => expect(status()?.getAttribute('data-state')).toBe('done'));
    };
    // Both pages of untried items are refused: 64 deferred.
    await press('Send back 32', 1);
    await waitFor(() => expect(deferred.size).toBe(32));
    await press('Send back 32', 2);
    await waitFor(() => expect(deferred.size).toBe(64));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: /^Send back/ })).toBeNull());
    // The later 32's refusal clears; the first 32 stay refused for good.
    all.slice(32).forEach((id) => blocked.delete(String(id)));
    await press('Retry 32', 3);
    expect(pages[2]).toEqual(all.slice(0, 32));
    await waitFor(() => expect(status()?.textContent).toBe('Sent back 0/32'));
    // The next retry starts after the last one: it reaches the 32 that can go now.
    await press('Retry 32', 4);
    expect(pages[3]).toEqual(all.slice(32));
    await waitFor(() => expect(status()?.textContent).toBe('Sent back 32/32'));
    expect(all.slice(32).every((id) => chain.owners.get(id.toString()) === CREATOR)).toBe(true);
    // Then round again to the ones still refused.
    await press('Retry 32', 5);
    expect(pages[4]).toEqual(all.slice(0, 32));
    expect(pages.map((page) => page.length)).toEqual([32, 32, 32, 32, 32]);
  });

  it('a full raise shows Graduate to any wallet, and only then; pressing it sends graduate() and the box is graduated (E-09C)', async () => {
    const { chain, request } = rig('open', OTHER, { filled: true });
    const panel = await screen.findByRole('region', { name: 'Graduate' });
    expect(screen.getByText('OUT · Open')).toBeTruthy();
    expect(request, 'navigation never asks the wallet').not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Graduate' })); });
    await waitFor(() => expect(chain.graduations).toEqual([OTHER]));
    expect(chain.sent.map((s) => [s.kind, s.fn, s.to.toLowerCase(), s.value])).toEqual([['graduate', 'graduate', chain.box.coordinator.toLowerCase(), 0n]]);
    expect(await screen.findByText('OUT · Graduated', {}, { timeout: 5_000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Graduate' })).toBeNull());
    // The button goes with the phase; the press's own line stays.
    expect(screen.getByText('Graduated', { selector: '[data-set-status]' }).getAttribute('data-state')).toBe('done');
    cleanup();
    // Not yet full, past graduation, failed (also a full curve whose box failed), loading: no Graduate.
    const others = [['open', {}], ['graduated', STATES.graduated], ['failed', STATES.failed], ['failed', { filled: true, failed: true }], ['recovering', STATES.recovering], ['pending', STATES.pending]] as const;
    for (const [phase, state] of others) {
      const shown = rig(phase as SetPhase, OTHER, state);
      const line = { pending: 'Loading', open: 'Open', graduated: 'Graduated', failed: 'Failed', recovering: 'Failed' }[phase];
      expect(await screen.findByText(new RegExp(`^OUT · ${line}`))).toBeTruthy();
      // The coordinator's facts read to their end (the hook's closedAt), then given time to render.
      await waitFor(() => expect(shown.chain.calls).toContain('closedAt'));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      expect(screen.queryByRole('region', { name: 'Graduate' }), `${phase} ${JSON.stringify(state)}`).toBeNull();
      cleanup();
    }
  });

  it('Graduate (XR1 F1): a read that fails while E-09C prepares (empty closed() data, a timed-out call) says so, sends nothing, and the page reads again', async () => {
    for (const failure of ['empty closed() data', 'a timed-out read'] as const) {
      const { chain, request, boxRead } = rig('open', OTHER, { filled: true });
      const panel = await screen.findByRole('region', { name: 'Graduate' });
      // E-09C's pinned closed() read (the page's own facts read the hook through the site's reads, not this call).
      const call = chain.chain.call;
      chain.chain.call = async (sent, block) => {
        if (sent.data !== toFunctionSelector('closed()')) return call(sent, block);
        if (failure === 'a timed-out read') throw new Error('RPC request timed out');
        return '0x';
      };
      const before = boxRead.mock.calls.length;
      await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Graduate' })); });
      await waitFor(() => expect(boxRead.mock.calls.length, failure).toBeGreaterThan(before));
      const status = await within(panel).findByText('A read did not answer. Try again.');
      expect(status.getAttribute('data-state'), failure).toBe('failed');
      expect(chain.sent, failure).toEqual([]);
      expect(request.mock.calls.map(([asked]) => asked.method), failure).not.toContain('eth_sendTransaction');
      // Still a full raise: the button stays for another try.
      expect(within(panel).getByRole('button', { name: 'Graduate' })).toBeTruthy();
      cleanup();
    }
  });

  it('Graduate (XR1 F2): someone else graduates the box just before the press; nothing is sent, the page reads again, and the refusal stays', async () => {
    const { chain, request, boxRead } = rig('open', OTHER, { filled: true });
    const panel = await screen.findByRole('region', { name: 'Graduate' });
    expect(request, 'navigation never asks the wallet').not.toHaveBeenCalled();
    // Another sender's graduate() is mined after the page read the box, before this press.
    chain.graduate();
    const before = boxRead.mock.calls.length;
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Graduate' })); });
    await waitFor(() => expect(boxRead.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('OUT · Graduated', {}, { timeout: 5_000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Graduate' })).toBeNull());
    const refusal = screen.getByText('This box cannot graduate now.');
    expect(refusal.getAttribute('data-state')).toBe('failed');
    // Where the button was: above the next phase's panel.
    expect(refusal.compareDocumentPosition(await screen.findByRole('region', { name: 'Pick and return' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chain.sent).toEqual([]);
    expect(chain.graduations).toEqual([]);
    expect(request.mock.calls.map(([asked]) => asked.method)).not.toContain('eth_sendTransaction');
  });

  it('Close (the same pattern as XR1 F2): someone else closes the raise just before the press; nothing is sent, the page reads again, and the refusal stays', async () => {
    const { chain, request, boxRead } = rig('pending', HOLDER, STATES.pending, (fake) => { fake.time += 1_209_600n; });
    const panel = await screen.findByRole('region', { name: 'Close' });
    expect(request, 'navigation never asks the wallet').not.toHaveBeenCalled();
    // Another sender's failClosed() is mined after the page read the raise, before this press.
    chain.failBox();
    const before = boxRead.mock.calls.length;
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Close box' })); });
    await waitFor(() => expect(boxRead.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('OUT · Failed', {}, { timeout: 5_000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Close' })).toBeNull());
    const refusal = screen.getByText('This raise cannot be closed now.');
    expect(refusal.getAttribute('data-state')).toBe('failed');
    expect(refusal.compareDocumentPosition(await screen.findByRole('region', { name: 'Back to the creator' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chain.sent).toEqual([]);
    expect(request.mock.calls.map(([asked]) => asked.method)).not.toContain('eth_sendTransaction');
  });

  it('pick, return and claim keep their refusal through the refresh after someone else moved first (their panels stay mounted)', async () => {
    // Pick: another holder picks the chosen item first.
    {
      const { chain, boxRead } = rig('graduated', HOLDER);
      const panel = await screen.findByRole('region', { name: 'Pick and return' });
      const id = (ids[10] as bigint).toString();
      fireEvent.change(within(panel).getByRole('textbox', { name: 'Find id' }), { target: { value: id } });
      fireEvent.click(await within(panel).findByRole('button', { name: `#${id}` }));
      await waitFor(() => expect(panel.querySelector('[data-set-quote]')?.textContent).toMatch(/at most/));
      chain.box.members.set(id, 'Outside');
      chain.owners.set(id, OTHER);
      chain.box.inside -= 1n;
      const before = boxRead.mock.calls.length;
      await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Pick 1' })); });
      await waitFor(() => expect(boxRead.mock.calls.length).toBeGreaterThan(before));
      // The page read again: the item is out of the list, and the refusal is still there.
      await waitFor(() => expect(within(panel).queryByRole('button', { name: `#${id}` })).toBeNull());
      expect(panel.querySelector('[data-set-status]')?.textContent).toBe(`#${id} is not in the box.`);
      expect(chain.sent).toEqual([]);
      cleanup();
    }
    // Return: the chosen item leaves this wallet first.
    {
      const { chain, boxRead } = rig('graduated', HOLDER);
      const panel = await screen.findByRole('region', { name: 'Pick and return' });
      fireEvent.click(within(panel).getByRole('button', { name: 'Return' }));
      const id = (ids[0] as bigint).toString();
      const mine = await within(panel).findByRole('button', { name: `#${id}` });
      await waitFor(() => expect(within(panel).getAllByText('Yours').length).toBe(3));
      fireEvent.click(mine);
      await waitFor(() => expect(panel.querySelector('[data-set-quote]')?.textContent).toMatch(/at least/));
      chain.move(ids[0] as bigint, OTHER);
      const before = boxRead.mock.calls.length;
      await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Return 1' })); });
      await waitFor(() => expect(boxRead.mock.calls.length).toBeGreaterThan(before));
      // The page read again (given time to render); the refusal is still there.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      expect(panel.querySelector('[data-set-status]')?.textContent).toBe(`#${id} is not in your wallet.`);
      expect(chain.sent).toEqual([]);
      cleanup();
    }
    // Claim: the other holders claim the whole pot first.
    {
      const { chain, boxRead } = rig('failed', HOLDER, STATES.failed, (fake) => { fake.box.tBalance.set(HOLDER.toLowerCase(), 500n * 10n ** 18n); });
      const panel = await screen.findByRole('region', { name: 'Back to the creator' });
      fireEvent.change(await within(panel).findByRole('textbox', { name: 'Your OUT' }), { target: { value: '500' } });
      chain.box.tLeft = 0n;
      chain.box.pot = 0n;
      const before = boxRead.mock.calls.length;
      await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: 'Claim' })); });
      await waitFor(() => expect(boxRead.mock.calls.length).toBeGreaterThan(before));
      // The claim's own controls go with the pot; the refusal stays.
      await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Claim' })).toBeNull());
      expect(panel.querySelector('[data-set-status]')?.textContent).toBe('More coins than this wallet can claim with.');
      expect(chain.sent).toEqual([]);
    }
  });

  it('loading past the gate’s cap: anyone may close it; before that, no close', async () => {
    rig('pending', HOLDER);
    expect(await screen.findByText('OUT · Loading 16/40')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Close' })).toBeNull();
    cleanup();
    const chain = new FakeSetChain({ ids });
    chain.seed(specFor(chain, ids), ids, { loaded: 16 });
    chain.time += 1_209_600n;
    const indexer: SetIndexer = {
      feed: async () => { throw new Error('unused'); },
      box: async () => ({ schema: 'sh.core-set-box.v1', chainId: chain.chainIdValue, asOf: asOfOf(chain), box: setBoxDataSchema.parse(wireOf(chain)) }),
      members: async () => membersOf(chain),
    };
    wallet.account = HOLDER; wallet.status = 'connected';
    wallet.signer = { request: vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0x7a69' : [HOLDER])) };
    render(<AppProviders><MemoryRouter><SetBoxPage record={setRecord(setBoxDataSchema.parse(wireOf(chain)), chain.source, asOfOf(chain))} seams={{ reads: chain, indexer, submit: chain.submit }} /></MemoryRouter></AppProviders>);
    const close = await screen.findByRole('region', { name: 'Close' });
    await act(async () => { fireEvent.click(within(close).getByRole('button', { name: 'Close box' })); });
    await waitFor(() => expect(chain.sent.map((s) => s.fn)).toEqual(['failClosed']));
    // The raise is closed: the button goes with the phase, the press's own line stays.
    expect(await screen.findByText('OUT · Failed', {}, { timeout: 5_000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Close' })).toBeNull());
    expect(screen.getByText('Closed', { selector: '[data-set-status]' }).getAttribute('data-state')).toBe('done');
  });

  it('hostile metadata never blocks an action and draws nothing it names', async () => {
    const { chain } = rig('graduated', HOLDER);
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    let flip = 0;
    for (const id of ids) chain.tokenUris.set(id.toString(), () => [`javascript:alert(1)`, `data:image/svg+xml,${encodeURIComponent(SVG)}`, 'https://evil.example/x.json'][flip++ % 3]);
    const panel = await screen.findByRole('region', { name: 'Pick and return' });
    await waitFor(() => expect(chain.calls.filter((fn) => fn === 'tokenURI').length).toBeGreaterThan(3));
    expect([...document.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '').filter((src) => /javascript|svg|evil/.test(src))).toEqual([]);
    expect(document.body.innerHTML).not.toMatch(/<script|javascript:/);
    fireEvent.click(within(panel).getAllByRole('button', { name: /^#/ })[0] as HTMLElement);
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Pick 1' })).toHaveProperty('disabled', false));
  });
});
