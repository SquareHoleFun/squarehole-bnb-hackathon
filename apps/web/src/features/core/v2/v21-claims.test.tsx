/**
 * SH-V21-FE12 in the claim views: payouts in the box token T (v2.1 step 2) beside those in P, never added up, each
 * claimed by its own call (claimT for an item's T credit). Real panels, query cache, readers and the shared sender; only
 * the RPC answers and the wallet are doubles.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, encodeAbiParameters, type Address, type Hex } from 'viem';
import { AppProviders } from '../../../app-providers';
import { holderLedgerV2Abi, itemLedgerV2Abi, rolesOfV2, type SideV2 } from '../../../../../../packages/chain/src/core/v2';
import { assertSendableCallV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { submitWrite } from '@squarehole/chain/write';
import * as actions from './actions-v2';
import { ClaimAllV2 } from './ClaimAllV2';
import { claimsIndexIO } from './claims-index';
import { m3Target } from './m3-actions';
import { publishedM2 } from './test-support/m2-published';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { holderCreditOf, type HolderClaimV2 } from './actions-v2';
import { boxSteps, stepP, stepT, type SingleState } from './claim-all';
import { indexedBoxOf } from './claims-index';
import { batchState } from './holder-claims';
import { ItemPayoutsV2 } from './ItemPayoutsV2';
import { parseSnapshotV2 } from './indexer-v2';
import { batchInT, holderHistoryOf } from './payouts-t';
import { claimsBoxOfView, claimsPage } from './test-support/claims-page';
import { m3RpcFixture, type M3RpcOptions } from './test-support/m3-rpc';
import { A, ETH, H, publishedItems } from './test-support/m3-published';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

const wallet = vi.hoisted(() => ({ account: '' as string | null, status: 'connected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const uint8 = (n: number) => encodeAbiParameters([{ type: 'uint8' }], [n]);
const items = (leg: 1 | 2, inside: 1 | 2): SideV2 => ({ a: { leg, dest: 8, legParams: '0x', destParams: uint8(inside) }, b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' }, split: 1, splitParams: '0x' });
type Tx = { from: Address; to: Address; data: Hex; value: Hex };
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));
function connect() {
  wallet.account = A; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  let count = 0;
  wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_sendTransaction' ? H(80 + ++count) : [wallet.account]);
}

describe('items paid in the box token', () => {
  async function rig(sides: { buyers?: SideV2; sellers?: SideV2 }, rpc: M3RpcOptions) {
    connect();
    const { body, source, at } = await publishedItems({ sides, itemBalanceT: 3n * ETH });
    const view = parseSnapshotV2(body, source);
    const fixture = m3RpcFixture({ owners: { '1': A, '2': A }, vault: at(3), ...rpc });
    vi.stubGlobal('fetch', rpcFetch(fixture.request));
    render(<AppProviders><MemoryRouter><ItemPayoutsV2 view={view} source={source} symbol="ETH" ticker="MINERS" disabled={false} /></MemoryRouter></AppProviders>);
    return { view };
  }
  const panel = () => screen.getByRole('region', { name: 'Item payouts' });

  it('an item’s T credit is its own row, total and Claim; it claims with claimT([item], you) on the item ledger', async () => {
    const { view } = await rig({ buyers: items(2, 1), sellers: items(2, 1) }, { creditsT: { '1': [ETH / 2n, ETH / 4n] } });
    expect(await within(panel()).findByText('1 ready')).toBeTruthy();
    expect(panel().querySelector('.sh-v2-value')?.textContent).toBe('0.75 MINERS');
    const row = required(panel().querySelector('li[data-coin="T"]'));
    expect(row.textContent).toMatch(/^Item #1 · stash 0\.25 MINERS0\.75 MINERS/);
    expect(panel().querySelector('li[data-coin="P"]')).toBeNull();
    // A T-only box shows no P figures: nothing is paid per item in P there.
    expect(within(panel()).queryByText('Paid per item')).toBeNull();
    expect(within(panel()).getByText('Item ledger · MINERS').nextElementSibling?.textContent).toBe('3 MINERS');
    fireEvent.click(screen.getByRole('button', { name: 'Claim item 1 in MINERS' }));
    expect(within(screen.getByRole('group', { name: 'Confirm claim' })).getByText('Item #1 · 0.75 MINERS')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm claim' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const tx = required(sends()[0]);
    expect(tx.to.toLowerCase()).toBe(required(view.claimRow?.contracts.itemLedger).toLowerCase());
    expect(decodeFunctionData({ abi: itemLedgerV2Abi, data: tx.data })).toMatchObject({ functionName: 'claimT', args: [[1n], A] });
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
  });

  it('with buyers in P and sellers in T, an item has a row per coin and the totals stay apart', async () => {
    await rig({ buyers: items(1, 1), sellers: items(2, 2) }, { credits: { '1': [ETH, 0n] }, creditsT: { '1': [2n * ETH, 0n] } });
    expect(await within(panel()).findByText('2 ready')).toBeTruthy();
    expect([...panel().querySelectorAll('.sh-v2-value .sh-v2-claims__sum')].map((n) => n.textContent)).toEqual(['1 ETH', ' · 2 MINERS']);
    expect([...panel().querySelectorAll('li')].map((li) => li.getAttribute('data-coin'))).toEqual(['P', 'T']);
    expect(screen.getByRole('button', { name: 'Claim item 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Claim item 1 in MINERS' })).toBeTruthy();
  });
});

describe('holder batches paid in the box token', () => {
  const read = (t: { claimableT: bigint | null; payout: 'available' | 'empty' | 'not_ready' }, status: HolderClaimV2['status'] = 'settling') =>
    holderCreditOf({ hash: H(1), batchId: 2n, holder: A, status, hookClosed: true, fundingFinal: true, fundingP: 0n, complete: false, holderCursor: 0n, noticeCursor: 0n,
      residueP: 0n, claimableP: 0n, failedBox: false, payout: 'empty', t: { token: A, fundingT: 9n, residueT: 0n, creditT: t.claimableT ?? 0n, claimableT: t.claimableT, payout: t.payout } });

  it('reads the T quote: any credit is claimable now, even while later tranches settle; P batches are read as they are', () => {
    expect(read({ claimableT: 7n, payout: 'available' })).toMatchObject({ status: 'settled', claimableP: 7n, payout: 'available', grows: true });
    expect(read({ claimableT: null, payout: 'not_ready' })).toMatchObject({ status: 'settling', claimableP: null, grows: true });
    const p = { ...read({ claimableT: 1n, payout: 'available' }), t: undefined } as unknown as Parameters<typeof holderCreditOf>[0];
    expect(holderCreditOf(p)).toBe(p);
  });

  it('after a claim, more T is what the batch can claim now, not a lost claim; nothing left is Claimed', () => {
    const claim = { tx: H(9), block: 100n, paidP: 7n };
    expect(batchState({ claim, read: { block: 101n, credit: read({ claimableT: 3n, payout: 'available' }) } })).toEqual({ kind: 'ready', amount: 3n });
    expect(batchState({ claim, read: { block: 101n, credit: read({ claimableT: null, payout: 'not_ready' }) } })).toEqual({ kind: 'claimed', amount: 7n, checked: true });
    // A P batch keeps M2's rule: credit left after its claim means the claim did not hold.
    expect(batchState({ claim, read: { block: 101n, credit: { status: 'settled', claimableP: 7n, payout: 'available' } } })).toMatchObject({ kind: 'unconfirmed' });
  });

  it('a side’s batches are paid in its coin, and its T batches join the read plan until all their credit is paid', async () => {
    const spec = { buyers: items(1, 1), sellers: { ...items(2, 1), a: { leg: 2, dest: 6, legParams: '0x' as const, destParams: uint8(2) } } };
    expect([1n, 2n, 3n, 4n].map((batch) => batchInT(spec, batch))).toEqual([false, true, false, true]);
    const view = { m2: { history: { failed: false, batches: {}, shop: null, starter: null }, money: null }, payInT: { history: { boughtT: 0n, holdersFundedT: 0n, itemsFundedT: 0n, holdersPaidT: 0n, itemsPaidT: 0n,
      batches: { '2': { fundingT: 40n, holderT: 38n, residueT: 2n, paidT: 10n, flushedT: 0n } } }, money: null } } as const;
    expect(holderHistoryOf(view)?.batches['2']).toMatchObject({ fundingP: 40n, complete: true, holderP: 38n, paidP: 10n, payments: {} });
  });
});

describe('Claim all and the claims index', () => {
  it('lists T payouts beside P ones and never adds them to P', () => {
    const none: SingleState = { kind: 'none' };
    const steps = boxSteps({ holder: [{ batch: 2n, amount: 5n, inT: true }, { batch: 1n, amount: 4n }], items: [{ id: 3n, amount: 2n }], itemsT: [{ id: 3n, amount: 6n }, { id: 1n, amount: 1n }],
      creator: none, remainder: none, handIn: none });
    expect(steps).toEqual([
      { kind: 'holder', batch: 1n, amount: 4n }, { kind: 'holder', batch: 2n, amount: 5n, inT: true },
      { kind: 'item-t', id: 1n, amount: 1n }, { kind: 'item', id: 3n, amount: 2n }, { kind: 'item-t', id: 3n, amount: 6n },
    ]);
    expect(steps.map(stepP)).toEqual([4n, 0n, 0n, 2n, 0n]);
    expect(steps.map(stepT)).toEqual([0n, 5n, 1n, 0n, 6n]);
  });

  it('takes the index’s rows in the box token: a T batch only on its side, an item’s T credit apart from its P credit', async () => {
    const { body, source } = await publishedItems({ sides: { buyers: items(1, 1), sellers: items(2, 1) } });
    const view = parseSnapshotV2(body, source);
    const box = claimsBoxOfView(view); const inT = { ...box, q: view.token };
    const page = claimsPage({ chainId: 31337, wallet: A, block: 500n, rows: [
      { box, row: { kind: 'item', id: 1n, amount: ETH } },
      { box: inT, row: { kind: 'item', id: 1n, amount: 2n * ETH, stash: ETH } },
      { box: { ...box, q: `0x${'4'.repeat(40)}` }, row: { kind: 'item', id: 2n, amount: 5n } },
    ] });
    const ix = indexedBoxOf(page, view);
    expect(ix.items.get('1')).toMatchObject({ claimableP: ETH });
    expect(ix.itemsT.get('1')).toMatchObject({ claimableP: 2n * ETH, stashP: ETH, outsideP: ETH });
    expect(ix.items.has('2') || ix.itemsT.has('2')).toBe(false);
  });
});

describe('V21-SITE-02: Claim all lists and claims payouts in the box token, from the claims index', () => {
  const HOLDERS_T: SideV2 = { a: { leg: 2, dest: 6, legParams: '0x', destParams: uint8(2) }, b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' }, split: 1, splitParams: '0x' };
  it('a holder-T row and an item-T row: both listed in T apart from P, each sent through the guarded sender', async () => {
    connect();
    // A holder box whose sellers chose To holders in the box token: batch 2 is a sellers' batch, paid in T.
    const m2 = await publishedM2(false); const parsed = parseSnapshotV2(m2.body, m2.source);
    const holderView = { ...parsed, spec: { ...parsed.spec, sellers: HOLDERS_T }, choices: { ...parsed.choices, sellers: 'holders-t' as const } };
    const receipt = async (hash: Hex) => ({ transactionHash: hash, blockNumber: holderView.block + 2n, blockHash: H(99), status: 'success' as const });
    vi.spyOn(actions, 'holderActionIO').mockImplementation((_source, v, request) => ({
      feeReader: TEST_FEE_READER, chainId: async () => m2.source.manifest.chainId, request, simulate: async () => undefined, estimate: async () => 100000n, submit: submitWrite, receipt,
      // The re-check before the send reads the batch's T quote at the index's hash (holderCreditOf, as the real IO does).
      claim: async (batch: bigint, holder: Address) => holderCreditOf({ hash: v.blockHash, batchId: batch, holder, status: 'settling', hookClosed: true, fundingFinal: true, fundingP: 0n, complete: false,
        holderCursor: 0n, noticeCursor: 0n, residueP: 0n, claimableP: 0n, failedBox: false, payout: 'empty', t: { token: v.token, fundingT: 9n * ETH, residueT: 0n, creditT: 5n * ETH, claimableT: 5n * ETH, payout: 'available' } }),
    }) as unknown as actions.HolderActionIO);
    // An item box whose sides pay items in the box token.
    const published = await publishedItems({ sides: { buyers: items(2, 1), sellers: items(2, 1) } });
    const itemsView = parseSnapshotV2(published.body, published.source);
    const rpc = m3RpcFixture({ owners: { '1': A }, creditsT: { '1': [2n * ETH, 0n] }, vault: published.at(3), receiptBlock: 500n });
    vi.stubGlobal('fetch', rpcFetch(rpc.request));
    vi.spyOn(claimsIndexIO, 'read').mockImplementation(async () => claimsPage({ chainId: 31337, wallet: A, block: holderView.block, hash: H(71), rows: [
      { box: { ...claimsBoxOfView(holderView), q: holderView.token }, row: { kind: 'holder', batch: 2n, amount: 5n * ETH } },
      { box: { ...claimsBoxOfView(itemsView), q: itemsView.token }, row: { kind: 'item', id: 1n, amount: 2n * ETH } },
    ] }));
    render(<AppProviders><MemoryRouter><ClaimAllV2 scope="wallet" boxes={[
      { key: 'holders', view: holderView, source: m2.source, name: 'Shop box', symbol: 'USDC', ticker: 'B52', disabled: false },
      { key: 'items', view: itemsView, source: published.source, name: 'Item box', symbol: 'ETH', ticker: 'MINERS', disabled: false },
    ]} /></MemoryRouter></AppProviders>);
    const panel = screen.getByRole('region', { name: 'Your claims' });
    expect(await within(panel).findByText('2 ready')).toBeTruthy();
    expect([...panel.querySelectorAll('.sh-v2-value .sh-v2-claims__sum')].map((n) => n.textContent)).toEqual(['5 B52', ' · 2 MINERS']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Claim all' }));
    const confirm = within(panel).getByRole('group', { name: 'Confirm Claim all' });
    expect(Array.from(confirm.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['Batch 25 B52', 'Item #12 MINERS']);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    expect(await within(panel).findByText('2 / 2 done')).toBeTruthy();
    const holderRoles = rolesOfV2(holderView.record).contracts; const itemRoles = rolesOfV2(itemsView.record).contracts;
    const [first, second] = sends();
    expect(required(first).to).toBe(holderRoles.holderLedger);
    expect(decodeFunctionData({ abi: holderLedgerV2Abi, data: required(first).data })).toMatchObject({ functionName: 'claim', args: [2n, A] });
    expect(required(second).to.toLowerCase()).toBe(required(itemRoles.itemLedger).toLowerCase());
    expect(decodeFunctionData({ abi: itemLedgerV2Abi, data: required(second).data })).toMatchObject({ functionName: 'claimT', args: [[1n], A] });
    for (const [tx, view, source] of [[required(first), holderView, m2.source], [required(second), itemsView, published.source]] as const) {
      expect(() => assertSendableCallV2({ to: tx.to, data: tx.data, value: 0n }, m3Target(source, view), A)).not.toThrow();
    }
  });
});
