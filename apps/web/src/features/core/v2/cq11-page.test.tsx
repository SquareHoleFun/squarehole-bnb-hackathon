import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { recordV2, summaryV2 } from './record-v2';
import { publishedV2 } from './test-support/published-v2';
import { createQueryClient } from '../../../app-providers';
import type { QueryClient } from '@tanstack/react-query';
import { rolesOfV2 } from '../../../../../../packages/chain/src/core/v2';
import { withSingleClaim, type SingleKnown } from './claim-all';
import { singleSessionKey } from './claim-reads';
import { m3RpcFixture } from './test-support/m3-rpc';
import { rpcFetch } from './test-support/rpc-fetch';
import { openPart, CLOSED_BOX_HEADINGS, headingsUpTo, pictureLoaded } from './test-support/picture-loaded';
vi.mock('./SafesV2', () => ({ SafesV2: () => <p>Safe read panel</p> }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => <p>Burn log panel</p> }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function page(patch: Partial<V2Snapshot> = {}, queryClient?: QueryClient) {
  const { body, source } = await publishedV2();
  const view = { ...parseSnapshotV2(body, source), verified: true, ...patch };
  // SH-BOX-LIFE-VIEW: the record names its price coin (the synthetic listing's 6-decimal coin) by its symbol.
  const record = recordV2(view, source, null, 'tUSDC');
  const adapter = createDemoWalletAdapter({ latencyMs: 0 }); const connect = vi.spyOn(adapter, 'connect');
  const tree = (r: typeof record) => <AppProviders walletAdapter={adapter} queryClient={queryClient}><MemoryRouter><V2BoxPage record={r} /></MemoryRouter></AppProviders>;
  const { rerender } = render(tree(record));
  return { view, source, connect, rerender: (next: V2Snapshot) => rerender(tree(recordV2(next, source, null, 'tUSDC'))) };
}
describe('CQ11-E4 v2 chain page', () => {
  it.each([
    { timestamp: 999n, open: true, state: 'upcoming', label: 'Upcoming' },
    { timestamp: 1000n, open: true, state: 'bonding', label: 'Raising' },
    { timestamp: 1001n, open: false, state: 'upcoming', label: 'Upcoming' },
  ])('uses the snapshot opening boundary for card and page: $timestamp / $open', async ({ timestamp, open, state, label }) => {
    const { view } = await page({ failed: null, closedAt: 0n, timestamp, gate: { open, effectiveOpenAt: 1000n, deadline: 2000n } });
    // SH-255: the state in the picture's phase pill, the ticker beside the token's address.
    const head = await pictureLoaded();
    expect(head.querySelector('.sh-bpic-phase')?.textContent).toBe(label);
    expect(head?.querySelector('.sh-fit-ca strong')?.textContent).toBe(view.spec.tokenSymbol);
    const { source } = await publishedV2();
    expect(summaryV2(recordV2(view, source), view, false).state).toBe(state);
  });
  it('puts the closing price first, short per 1M coins (the exact digits behind the closed Claim details), shows both P choices and the recorded raise, and never requests a wallet on navigation', async () => {
    const { connect } = await page();
    // SH-255: the closing price leads the picture's number tiles, and the page under the picture.
    const head = await pictureLoaded();
    expect(head.querySelector('.sh-box-stat dt')?.textContent).toBe('Closing price');
    // Review R-16: the whole order up to the closing price, the picture's own cards first and nothing else.
    expect(headingsUpTo('Closing price')).toEqual(CLOSED_BOX_HEADINGS);
    const claim = screen.getByRole('region', { name: 'Failure claim' });
    expect(claim.querySelector('.sh-v2-value')?.textContent).toBe('3,333,333 tUSDC per 1M B4');
    // SH-BOX-LIFE-VIEW: the pot and the coins left short, the exact figures behind Claim details, closed.
    expect([...claim.querySelectorAll('dt')].map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`)).toEqual(['Claim pot: 10 tUSDC', 'Coins left: 3 B4']);
    expect(within(claim).getByText('Exact: 3.333333666666666666666666 tUSDC per B4')).toBeTruthy();
    expect((claim.querySelector('details') as HTMLDetailsElement).open).toBe(false);
    // SH-V2-FE3: P names itself here, so no "P = P" line; the claim line is one short line, not two sentences.
    expect(screen.queryByText(/^P = /)).toBeNull();
    // RC5-A (F136, superseding F127 R40A's year sweep): the claim never closes, and the line says so; no year is named.
    expect(screen.getByText('Approve, then claim · claims do not expire')).toBeTruthy();
    expect(screen.queryByText(/1 year|one year|sweep/i)).toBeNull();
    // SH-255: both P choices in Where the fees go; the Fees card's line, the creator's stored claim and the recorded
    // raise in the sheets of the buyers' side, the creator and the raise (the last behind its closed (?)).
    await pictureLoaded();
    expect(screen.getAllByText('Grow the pool', { selector: '.sh-bpic-ledger-place' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(await openPart('buyers')).getByText(/^1% of every trade: in tUSDC on buys, in .+ on sales$/)).toBeTruthy();
    expect(within(await openPart('creator')).getByText('900719925474099300.000001 tUSDC')).toBeTruthy();
    expect(within(await openPart('raise')).getByText(/Recorded raise:/, { ignore: false })).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^(buy|sell|swap)$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close box' })).toBeNull();
  });
  it.each([{ verified: false }, { stale: true }, { money: null }])('disables claims on unsafe reads %j', async (patch) => {
    await page(patch); fireEvent.change(screen.getByRole('textbox', { name: 'Coins to claim' }), { target: { value: '1' } });
    expect((screen.getByRole('button', { name: 'Claim tUSDC' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows the hatch at seven days exactly, using fail(), and never after graduation', async () => {
    const filled = { failed: null, closing: null, closedAt: 1000n, timestamp: 605799n };
    await page(filled); expect(screen.queryByRole('button', { name: 'Close box' })).toBeNull(); cleanup();
    const { connect } = await page({ ...filled, timestamp: 605800n });
    expect(screen.getByRole('heading', { name: 'Graduation hatch' })).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close box' }));
    expect(await screen.findByRole('dialog')).toBeTruthy(); cleanup();
    await page({ ...filled, timestamp: 605800n, graduated: true }); expect(screen.queryByRole('button', { name: 'Close box' })).toBeNull();
  });
  it('exhausted coins never create a division error or a fresh entitlement from late P', async () => {
    await page({ closing: { pot: 13n, initialT: 3n * 10n ** 18n, tLeft: 0n, creatorEntitlement: 0n } });
    expect(within(screen.getByRole('region', { name: 'Failure claim' })).getByText('No coins left to claim')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Claim tUSDC' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Claim creator remainder' })).toBeNull();
  });

  // FINAL-OC01: after graduation the creator's claim is the receiver's next payment to its payee, read as the payee with
  // no wallet; the stored creatorOwed (here 900719925474099300.000001 P) is not it.
  it('after graduation, Creator’s claim is the payee’s next payment (lazy royalties included), and its button follows it', async () => {
    const quote = { next: 1234n, refuse: false };
    const payee = (await publishedV2()).body.money?.values['receiver.creatorPayee'] as `0x${string}`;
    const rpc = m3RpcFixture({ creator: { payee, owed: 0n, next: () => quote.next, refuse: () => quote.refuse } });
    vi.stubGlobal('fetch', rpcFetch(rpc.request));
    const { connect } = await page({ failed: null, graduated: true, closing: null });
    // SH-255: the Creator's claim is the creator's sheet on the picture.
    await openPart('creator');
    const panel = () => screen.getByRole('heading', { level: 2, name: 'Creator’s claim' }).closest('section') as HTMLElement;
    expect(await within(panel()).findByText('0.001234 tUSDC')).toBeTruthy();
    expect(within(panel()).queryByText('900719925474099300.000001 tUSDC')).toBeNull();
    expect(screen.getByRole('button', { name: 'Claim creator fees' })).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
    expect(rpc.calls.some((c) => c.method === 'eth_call' && (c.params?.[0] as { from?: string }).from?.toLowerCase() === payee.toLowerCase())).toBe(true);
    cleanup();
    // Nothing payable: no button. A refused or failed quote: "Unavailable", never 0, and no button.
    quote.next = 0n;
    await page({ failed: null, graduated: true, closing: null, block: 102n, blockHash: `0x${'0'.repeat(62)}66` });
    await openPart('creator');
    expect(await within(panel()).findByText('0 tUSDC')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Claim creator fees' })).toBeNull();
    cleanup();
    quote.refuse = true;
    await page({ failed: null, graduated: true, closing: null, block: 103n, blockHash: `0x${'0'.repeat(62)}67` });
    await openPart('creator');
    expect(await within(panel()).findByText('Unavailable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Claim creator fees' })).toBeNull();
  });

  // Review FE11 point 2: a claim mined in this session hides the button (and says Claimed) until a read at its block
  // or later decides, so a second press cannot send an empty claim while the indexer still serves the same snapshot.
  it('after a creator claim is mined, the button waits for a later read; that read decides what is left', async () => {
    const quote = { next: 1234n };
    const payee = (await publishedV2()).body.money?.values['receiver.creatorPayee'] as `0x${string}`;
    vi.stubGlobal('fetch', rpcFetch(m3RpcFixture({ creator: { payee, owed: 0n, next: () => quote.next } }).request));
    const client = createQueryClient();
    const { view, source, rerender } = await page({ failed: null, graduated: true, closing: null }, client);
    // SH-255: the Creator's claim is the creator's sheet on the picture.
    await openPart('creator');
    const panel = () => screen.getByRole('heading', { level: 2, name: 'Creator’s claim' }).closest('section') as HTMLElement;
    expect(await within(panel()).findByText('0.001234 tUSDC')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim creator fees' })).toBeTruthy();
    const receiver = rolesOfV2(view.record).contracts.receiver ?? null;
    await act(async () => { client.setQueryData<SingleKnown>(singleSessionKey('creator', source.manifest.chainId, receiver, payee), (known) => withSingleClaim(known, { tx: `0x${'ab'.repeat(32)}`, block: view.block + 1n, paid: 1234n })); });
    expect(await within(panel()).findByText('Claimed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Claim creator fees' })).toBeNull();
    quote.next = 7n;
    await act(async () => rerender({ ...view, block: view.block + 1n, blockHash: `0x${'0'.repeat(62)}77` }));
    expect(await within(panel()).findByText('0.000007 tUSDC')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim creator fees' })).toBeTruthy();
  });
});
