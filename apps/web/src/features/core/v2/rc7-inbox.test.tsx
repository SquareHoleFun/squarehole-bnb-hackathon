/**
 * SH-RC7-SITE-INBOX (rc7 open item 11) on the box page: each inbox coin's history parsed from decimal strings and shown
 * numbers first; the guarded public refresh and observe (each shown only when the chain says the call would do
 * something now: read, then dry-run); the payee's in-kind claim by coin address; the launch router's public sweep
 * (KF-5). The real page, viem clients and the shared sender; only the RPC answers and the wallet are doubles. Nothing
 * reads the chain for the inbox until its panel is opened, and the wallet is asked only on a press.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, type Address, type Hex } from 'viem';
import { AppProviders } from '../../../app-providers';
import { launchRouterV2Abi, royaltyRouterV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { V2BoxPage } from './V2BoxPage';
import { parseSnapshotV2, type InboxCoinV2, type V2Snapshot } from './indexer-v2';
import { recordV2 } from './record-v2';
import { inboxGasLimit } from './inbox-upkeep';
import { inboxRpcFixture, type InboxRpcWorld } from './test-support/inbox-rpc';
import { publishedV2 } from './test-support/published-v2';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';

const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
vi.mock('./SafesV2', () => ({ SafesV2: () => <p>Safe read panel</p> }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => <p>Burn log panel</p> }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); wallet.account = null; wallet.status = 'disconnected'; wallet.signer.request.mockReset(); });

type Json = Record<string, unknown>;
const USDC = '0x00000000000000000000000000000000000005dc' as Address;
const LINK = '0x0000000000000000000000000000000000000514' as Address;
const DUST = '0x0000000000000000000000000000000000000d05' as Address;
const NOW = BigInt(Math.floor(Date.now() / 1000));
const DAY = 86_400n;
/** A one-coin inbox call's selector: the calldata of fn(coin) starts with it. */
const selector = (fn: 'refreshOrder' | 'observe' | 'claimInKind'): string => encodeFunctionData({ abi: royaltyRouterV2Abi, functionName: fn, args: [USDC] } as never).slice(0, 10);
const coin = (c: Address, patch: Partial<InboxCoinV2> = {}): InboxCoinV2 => ({ coin: c, lot: 100n, balance: 0n, oldestUnsoldAt: 0n, registered: false, belowOneLot: false, ...patch });

/** The published live box with this inbox, its roles answered by the RPC double, and the connected account (if any). */
async function page(o: { coins: readonly InboxCoinV2[]; balances?: Record<string, bigint>; complete?: boolean; patch?: Partial<V2Snapshot>; world?: Partial<InboxRpcWorld>; account?: Address | 'payee' }) {
  const { body, source } = await publishedV2(false);
  const parsed = parseSnapshotV2(body, source);
  const money = required(parsed.money);
  const contracts = parsed.record.contracts;
  const router = required(contracts[8]); const payee = money.inbox?.payee ?? parsed.record.creator;
  const view: V2Snapshot = { ...parsed, verified: true, ...o.patch,
    money: { ...money, inbox: { router, payee, balances: o.balances ?? {}, listVersion: 3n, complete: o.complete ?? true, coins: o.coins } } };
  const world: InboxRpcWorld = { router, coordinator: required(contracts[0]), launchRouter: required(contracts[6]), weth: source.manifest.chain.weth.address as Address,
    relayer: '0x00000000000000000000000000000000000c0e00', payee, now: NOW,
    coins: Object.fromEntries(o.coins.map((c) => [c.coin.toLowerCase(), { lot: c.lot, held: c.balance, registered: c.registered, oldestUnsoldAt: c.oldestUnsoldAt }])), ...o.world };
  const rpc = inboxRpcFixture(world);
  vi.stubGlobal('fetch', rpcFetch(rpc.request));
  if (o.account) {
    wallet.account = o.account === 'payee' ? payee : o.account; wallet.status = 'connected';
    let n = 0;
    wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x7a69'
      : method === 'eth_sendTransaction' ? `0x${(++n).toString(16).padStart(64, '0')}` : [wallet.account]);
  }
  // SH-BOX-LIFE-VIEW: the record names its price coin (the synthetic listing's 6-decimal coin) by its symbol.
  render(<AppProviders><MemoryRouter><V2BoxPage record={recordV2(view, source, null, 'tUSDC')} /></MemoryRouter></AppProviders>);
  return { view, rpc, router, payee, launchRouter: world.launchRouter };
}
const openInbox = () => { const summary = screen.getByText('Inbox', { selector: 'summary' }); fireEvent.click(summary); (summary.parentElement as HTMLDetailsElement).open = true; fireEvent(summary.parentElement as HTMLElement, new Event('toggle')); };
const row = (c: Address) => required(document.querySelector<HTMLElement>(`[data-coin="${c.toLowerCase()}"]`));
type Tx = { from: Address; to: Address; data: Hex; value: Hex; gas: Hex };
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));
const routerReads = (rpc: { calls: readonly { method: string; params?: readonly unknown[] }[] }, router: Address) =>
  rpc.calls.filter((c) => (c.method === 'eth_call' && (c.params?.[0] as { to?: string }).to?.toLowerCase() === router.toLowerCase()) || c.method === 'eth_getStorageAt');

describe('INDEXER-INBOX request 1: each inbox coin’s history', () => {
  it('parses lastRefresh, lastSale and the four totals from decimal strings; an older publication has none; a malformed one is refused', async () => {
    const { body, source } = await publishedV2(false);
    const creator = ((body.row as Json).record as Json).creator as string;
    const ref = { blockNumber: '102', blockHash: `0x${'e8'.repeat(32)}`, txHash: `0x${'8f'.repeat(32)}`, txIndex: 0, logIndex: 0 };
    const published = { coin: USDC, lot: '100000000', balance: '900719925473999312345', oldestUnsoldAt: '1000100', registered: true, belowOneLot: false,
      lastRefresh: { balance: '900719925474099312345', oldestUnsoldAt: '1000000', at: '1800001212', ref },
      lastSale: { buyToken: `0x${'2e'.repeat(20)}`, sellAmount: '100000000', buyAmount: '77', feeAmount: '0', orderUid: '0xaabb', at: '1800001224', ref },
      inKindClaimed: '5', funded: '900719925474099312346', flushed: '0', unwrapped: '0' };
    const coins = (rows: readonly Json[]) => required(parseSnapshotV2({ ...body, money: { ...(body.money as Json), royalty: { router: `0x${'ee'.repeat(20)}`, payee: creator,
      balances: {}, listVersion: '3', complete: true, coins: rows } } }, source).money?.inbox).coins;
    expect(required(coins([published])[0]).history).toEqual({
      lastRefresh: { balance: 900719925474099312345n, oldestUnsoldAt: 1000000n, at: 1800001212n },
      lastSale: { buyToken: getAddress(`0x${'2e'.repeat(20)}`), sellAmount: 100000000n, buyAmount: 77n, feeAmount: 0n, orderUid: '0xaabb', at: 1800001224n, txHash: ref.txHash },
      inKindClaimed: 5n, funded: 900719925474099312346n, flushed: 0n, unwrapped: 0n });
    expect(required(coins([{ ...published, lastRefresh: null, lastSale: null }])[0]).history?.lastSale).toBeNull();
    const older = Object.fromEntries(Object.entries(published).filter(([key]) => !['lastRefresh', 'lastSale', 'inKindClaimed', 'funded', 'flushed', 'unwrapped'].includes(key)));
    expect(required(coins([older])[0]).history).toBeUndefined();
    for (const bad of [{ funded: 5 }, { lastSale: { ...published.lastSale, buyAmount: 77 } }, { lastSale: { ...published.lastSale, orderUid: 'aabb' } }, { unwrapped: undefined }]) {
      expect(() => coins([{ ...published, ...bad }])).toThrow();
    }
  });

  it('shows each coin’s last sale, last refresh and the totals that are not zero, on demand; a coin that sold out keeps its row', async () => {
    const history = { lastRefresh: { balance: 250n, oldestUnsoldAt: NOW - 3n * DAY, at: NOW - 3n * DAY }, lastSale: { buyToken: USDC, sellAmount: 200n, buyAmount: 7_700_000n, feeAmount: 0n, orderUid: '0xaabb' as Hex, at: NOW - 2n * DAY, txHash: `0x${'8f'.repeat(32)}` as Hex },
      inKindClaimed: 0n, funded: 0n, flushed: 0n, unwrapped: 0n };
    const eth = { lastRefresh: null, lastSale: null, inKindClaimed: 0n, funded: 0n, flushed: 900n, unwrapped: 400n };
    await page({ coins: [coin(USDC, { balance: 50n, registered: true, oldestUnsoldAt: NOW - DAY, belowOneLot: true, history }), coin(LINK, { history: { ...history, lastSale: null, lastRefresh: null } }),
      coin('0x0000000000000000000000000000000000000000', { lot: 0n, history: eth })], complete: false });
    openInbox();
    const usdc = row(USDC);
    expect(within(usdc).getByText(`${USDC.toLowerCase()}: 50 raw units · below one lot; the payee can claim in kind in 29 days if the clock does not restart`)).toBeTruthy();
    const dl = within(usdc).getByText('History', { selector: 'summary' }).parentElement as HTMLElement;
    expect(within(dl).getByText('Last sale', { selector: 'dt' }).nextElementSibling?.textContent).toBe('200 raw units for 7.7 tUSDC · 2 days ago');
    expect(within(dl).getByText('Last refresh', { selector: 'dt' }).nextElementSibling?.textContent).toBe('250 raw units · 3 days ago');
    expect(within(dl).queryByText('Taken in kind')).toBeNull();
    // A listed coin with nothing held and nothing to show has no row; the ETH row shows its flush totals only.
    expect(document.querySelector(`[data-coin="${LINK.toLowerCase()}"]`)).toBeNull();
    const ethRow = row('0x0000000000000000000000000000000000000000');
    expect(within(ethRow).getByText('Sent from the inbox', { selector: 'dt' }).nextElementSibling?.textContent).toBe('900 raw units');
    expect(within(ethRow).getByText('Unwrapped from WETH', { selector: 'dt' }).nextElementSibling?.textContent).toBe('400 raw units');
    expect(screen.getByText('Some coins could not be read.')).toBeTruthy();
    expect(appCopyFraming(renderedCopy(document.body).map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
  });

  it('SH-RC7-REVIEW: the P row’s totals are P, so they read in P like the rest of the page, never as raw units', async () => {
    // RoyaltyFunded only takes the box's price coin (BoxReceiverV2.fundRoyalty refuses any other), so "Into the box" is P.
    const { body, source } = await publishedV2(false);
    const p = parseSnapshotV2(body, source).record.q;
    const history = { lastRefresh: null, lastSale: null, inKindClaimed: 0n, funded: 12_500_000n, flushed: 0n, unwrapped: 0n };
    await page({ coins: [coin(p, { lot: 0n, balance: 0n, history }), coin(USDC, { balance: 50n, history: { ...history, funded: 0n, inKindClaimed: 3n } })] });
    openInbox();
    expect(within(row(p)).getByText('Into the box', { selector: 'dt' }).nextElementSibling?.textContent).toBe('12.5 tUSDC');
    // An outside coin keeps its raw units.
    expect(within(row(USDC)).getByText('Taken in kind', { selector: 'dt' }).nextElementSibling?.textContent).toBe('3 raw units');
  });
});

describe('the guarded public refresh and observe (COW-2’s last piece)', () => {
  it('reads nothing for the inbox until the panel opens; then offers the refresh only after the reads and its dry run, and never asks the wallet', async () => {
    const { rpc, router } = await page({ coins: [coin(USDC, { balance: 250n })] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(routerReads(rpc, router)).toEqual([]);
    openInbox();
    const button = await within(row(USDC)).findByRole('button', { name: 'Refresh · 2 lots' });
    expect(button).toBeTruthy();
    const dry = rpc.calls.filter((c) => c.method === 'eth_call' && (c.params?.[0] as { data: Hex }).data.startsWith(selector('refreshOrder')));
    expect(dry).toHaveLength(1);
    expect(wallet.signer.request).not.toHaveBeenCalled();
  });

  it('a press asks one confirmation, then sends exactly refreshOrder(coin) to the inbox with a 5M floor, and nothing else', async () => {
    const { router } = await page({ coins: [coin(USDC, { balance: 250n })], account: '0x00000000000000000000000000000000000000a1' });
    openInbox();
    fireEvent.click(await within(row(USDC)).findByRole('button', { name: 'Refresh · 2 lots' }));
    const confirm = screen.getByRole('group', { name: 'Confirm transaction' });
    expect(within(confirm).getByText('Offer 2 lots of this coin for tUSDC on CoW?')).toBeTruthy();
    expect(sends()).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Confirmed. Reading the updated box…');
    const [tx, ...more] = sends();
    expect(more).toEqual([]);
    expect(required(tx).to.toLowerCase()).toBe(router.toLowerCase());
    expect(required(tx).value).toBe('0x0');
    expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: required(tx).data })).toMatchObject({ functionName: 'refreshOrder', args: [getAddress(USDC)] });
    expect(BigInt(required(tx).gas)).toBe(5_000_000n);
  });

  it('offers an observation that starts a clock or records a sale, and nothing when neither would change anything', async () => {
    await page({ coins: [coin(USDC, { balance: 40n, belowOneLot: true }), coin(LINK, { balance: 40n, belowOneLot: true, oldestUnsoldAt: NOW - DAY }), coin(DUST, { balance: 100n, registered: true, oldestUnsoldAt: NOW - DAY })],
      world: { coins: { [USDC.toLowerCase()]: { lot: 100n, held: 40n }, [LINK.toLowerCase()]: { lot: 100n, held: 40n, oldestUnsoldAt: NOW - DAY },
        // 3 lots approved, 2 sold since: the allowance is below the recorded approval.
        [DUST.toLowerCase()]: { lot: 100n, held: 100n, registered: true, oldestUnsoldAt: NOW - DAY, allowance: 100n, approved: 300n } } } });
    openInbox();
    expect(await within(row(USDC)).findByRole('button', { name: 'Start clock' })).toBeTruthy();
    expect(await within(row(DUST)).findByRole('button', { name: 'Record sale' })).toBeTruthy();
    await waitFor(() => expect(within(row(LINK)).queryAllByRole('button')).toEqual([]));
  });

  it('SH-RC7-REVIEW: an inbox that holds only ETH still offers the WETH refresh, which wraps that ETH first', async () => {
    // Royalties paid in ETH land as ETH: refreshOrder(WETH) and observe(WETH) wrap it before they count (_wrap), so the
    // WETH row is where its public control lives, even while the inbox holds no WETH yet.
    const { source } = await publishedV2(false);
    const weth = getAddress(source.manifest.chain.weth.address) as Address;
    await page({ coins: [coin(weth, { balance: 0n })], balances: { [`0x${'0'.repeat(40)}`]: 250n },
      world: { eth: 250n, coins: { [weth.toLowerCase()]: { lot: 100n, held: 0n } } } });
    openInbox();
    expect(await within(row(weth)).findByRole('button', { name: 'Refresh · 2 lots' })).toBeTruthy();
  });

  it('shows nothing when the dry run refuses, on a failed box, or on a read that is not current and verified', async () => {
    const { rpc } = await page({ coins: [coin(USDC, { balance: 250n })], world: { coins: { [USDC.toLowerCase()]: { lot: 100n, held: 250n, refuse: 'NoOrder' } } } });
    openInbox();
    await waitFor(() => expect(rpc.calls.some((c) => c.method === 'eth_call' && (c.params?.[0] as { data: Hex }).data.startsWith(selector('refreshOrder')))).toBe(true));
    expect(within(row(USDC)).queryByRole('button')).toBeNull();
    cleanup();
    for (const patch of [{ failed: { cause: 'Deadline', at: NOW - DAY } }, { verified: false }, { stale: true }] as const) {
      const failed = await page({ coins: [coin(USDC, { balance: 250n })], patch });
      openInbox();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(within(row(USDC)).queryByRole('button')).toBeNull();
      expect(routerReads(failed.rpc, failed.router)).toEqual([]);
      cleanup();
    }
  });
});

describe('the payee’s in-kind claim', () => {
  it('only the connected payee gets the form; nothing for anyone else, and no input on navigation', async () => {
    await page({ coins: [coin(USDC, { balance: 250n })] });
    openInbox();
    expect(screen.queryByRole('textbox', { name: 'Coin to take' })).toBeNull();
    cleanup();
    await page({ coins: [coin(USDC, { balance: 250n })], account: '0x00000000000000000000000000000000000000a1' });
    openInbox();
    expect(screen.queryByRole('textbox', { name: 'Coin to take' })).toBeNull();
  });

  it('validates the address, refuses P before any read, says why a coin cannot be taken, and sends claimInKind only for a ready amount', async () => {
    const { router, payee, view } = await page({ coins: [coin(USDC, { balance: 250n, registered: true, oldestUnsoldAt: NOW - DAY })], account: 'payee',
      world: { coins: { [USDC.toLowerCase()]: { lot: 100n, held: 250n, registered: true, inKind: 'WaitForSale' }, [DUST.toLowerCase()]: { lot: 0n, held: 7n, inKind: 7n } } } });
    openInbox();
    const input = screen.getByRole('textbox', { name: 'Coin to take' });
    fireEvent.change(input, { target: { value: '0x1234' } });
    expect(screen.getByText('Enter a coin address.')).toBeTruthy();
    // A mixed-case address whose checksum is wrong is refused too.
    expect(isAddress(USDC.replace('dc', 'DC'))).toBe(false);
    fireEvent.change(input, { target: { value: USDC.replace('dc', 'DC') } });
    expect(screen.getByText('Enter a coin address.')).toBeTruthy();
    fireEvent.change(input, { target: { value: view.record.q } });
    expect(await screen.findByText('The price coin goes to the box, not in kind.')).toBeTruthy();
    fireEvent.change(input, { target: { value: USDC } });
    expect(await screen.findByText('Not yet: a coin on the sale list waits 30 days without a sale.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Take' })).toBeNull();
    fireEvent.change(input, { target: { value: LINK } });
    expect(await screen.findByText('The inbox holds none of this coin.')).toBeTruthy();
    fireEvent.change(input, { target: { value: DUST } });
    fireEvent.click(await screen.findByRole('button', { name: 'Take' }));
    const confirm = screen.getByRole('group', { name: 'Confirm transaction' });
    expect(within(confirm).getByText(`Take 7 raw units of ${DUST.slice(0, 6)}…${DUST.slice(-4)} to your wallet?`)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Confirmed. Reading the updated box…');
    const [tx, ...more] = sends();
    expect(more).toEqual([]);
    expect(required(tx).from.toLowerCase()).toBe(payee.toLowerCase());
    expect(required(tx).to.toLowerCase()).toBe(router.toLowerCase());
    expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: required(tx).data })).toMatchObject({ functionName: 'claimInKind', args: [getAddress(DUST)] });
  });
});

describe('SH-V21-RC7-INT release review IDX-SITE-1: the zero address is taken as WETH', () => {
  it('names WETH, not ETH, for claimInKind(0) in a box not priced in ETH, and still sends claimInKind(0), which wraps the ETH first', async () => {
    const zero = '0x0000000000000000000000000000000000000000' as Address;
    const { router, view } = await page({ coins: [], balances: { [zero]: 60n }, account: 'payee',
      world: { coins: { [zero]: { lot: 0n, held: 60n, inKind: 99n } } } });
    expect(BigInt(view.record.q)).not.toBe(0n);
    const weth = (await publishedV2(false)).source.manifest.chain.weth.address as Address;
    openInbox();
    expect(screen.getByText(/ ETH is taken as WETH\.$/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Coin to take' }), { target: { value: zero } });
    expect(await screen.findByText('99 raw units of WETH')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take' }));
    const confirm = screen.getByRole('group', { name: 'Confirm transaction' });
    expect(within(confirm).getByText(`Take 99 raw units of WETH (${weth.slice(0, 6)}…${weth.slice(-4)}) to your wallet?`)).toBeTruthy();
    expect(screen.queryByText(/of 0x0000…0000/)).toBeNull();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Confirmed. Reading the updated box…');
    const [tx] = sends();
    expect(required(tx).to.toLowerCase()).toBe(router.toLowerCase());
    expect(decodeFunctionData({ abi: royaltyRouterV2Abi, data: required(tx).data })).toMatchObject({ functionName: 'claimInKind', args: [zero] });
  });
});

describe('KF-5: the launch router’s public sweep', () => {
  it('after graduation shows the launch tax its dry run would move, and sends exactly sweep() to the launch router', async () => {
    const { launchRouter } = await page({ coins: [], patch: { graduated: true }, world: { sweep: 5_000_000n }, account: '0x00000000000000000000000000000000000000a1' });
    const panel = await screen.findByRole('region', { name: 'Launch tax' });
    expect(panel.querySelector('.sh-v2-value')?.textContent).toBe('5 tUSDC');
    expect(within(panel).getByText('Waits to move into the pool’s depth. Anyone may move it.')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Move' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Confirmed. Reading the updated box…');
    const [tx, ...more] = sends();
    expect(more).toEqual([]);
    expect(required(tx).to.toLowerCase()).toBe(launchRouter.toLowerCase());
    expect(decodeFunctionData({ abi: launchRouterV2Abi, data: required(tx).data })).toMatchObject({ functionName: 'sweep' });
    expect(BigInt(required(tx).gas)).toBe(2_000_000n);
  });

  it('a failed box’s tax joins the claim pot; nothing when the sweep refuses or before graduation (no read at all)', async () => {
    await page({ coins: [], patch: { failed: { cause: 'Deadline', at: NOW - DAY } }, world: { sweep: 2_000_000n } });
    expect(within(await screen.findByRole('region', { name: 'Launch tax' })).getByText('Waits to move into the claim pot. Anyone may move it.')).toBeTruthy();
    cleanup();
    await page({ coins: [], patch: { graduated: true }, world: { sweep: 'NothingToSweep' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('region', { name: 'Launch tax' })).toBeNull();
    cleanup();
    const live = await page({ coins: [], world: { sweep: 9n } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('region', { name: 'Launch tax' })).toBeNull();
    expect(live.rpc.calls.filter((c) => (c.params?.[0] as { to?: string } | undefined)?.to?.toLowerCase() === live.launchRouter.toLowerCase())).toEqual([]);
  });
});

it('gas: a fifth above the estimate, never below the call’s floor, never above the EIP-7825 cap', () => {
  const call = (data: Hex) => ({ to: USDC, data, value: 0n });
  expect(inboxGasLimit(call(`${selector('refreshOrder')}${'0'.repeat(64)}` as Hex), 100_000n)).toBe(5_000_000n);
  expect(inboxGasLimit(call(`${selector('observe')}${'0'.repeat(64)}` as Hex), 10_000_000n)).toBe(12_000_000n);
  expect(inboxGasLimit(call(`${selector('claimInKind')}${'0'.repeat(64)}` as Hex), 20_000_000n)).toBe(24_000_000n);
});
