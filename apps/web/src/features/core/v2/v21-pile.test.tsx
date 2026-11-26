/**
 * SH-V21-FE12 on the coin pile panel (v2.1 step 3): the fixed leave-behind applied to every quote as `quoteRedeem`
 * applies it (two floors; the whole balance for the whole supply), and, for a pile its fees go to, the fees waiting in
 * the box and moved in so far. Real panel and readers; only the RPC answers, the wallet and the listing book are doubles.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { pileVaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { AppProviders } from '../../../app-providers';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { CoinPileV2 } from './CoinPileV2';
import { parseSnapshotV2 } from './indexer-v2';
import { perCoin, quoteOf } from './m3-data';
import { m3RpcFixture } from './test-support/m3-rpc';
import { A, ETH, H, publishedPile, type PileOptions } from './test-support/m3-published';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';

const wallet = vi.hoisted(() => ({ account: '' as string | null, status: 'connected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
vi.mock('../../create/v2/indexer-listings', async (original) => ({ ...await original<object>(), loadListingsV2: async () => [] }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
type Tx = { from: Address; to: Address; data: Hex; value: Hex };
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));
function connect() {
  wallet.account = A; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  let count = 0;
  wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_sendTransaction' ? H(80 + ++count) : [wallet.account]);
}

describe('the coin pile in v2.1', () => {
  async function rig(options: PileOptions) {
    connect();
    const published = await publishedPile(options);
    const view = parseSnapshotV2(published.body, published.source);
    const money = required(view.m3?.pileMoney);
    const rpc = m3RpcFixture({ pile: { asset: published.asset, seeder: view.record.creator, seed: published.seed, balance: required(money.balance), supply: money.supply, leaveBehindBps: BigInt(options.leaveBehindBps ?? 0) }, coinsT: 10n * ETH, allowanceT: 10n * ETH });
    vi.stubGlobal('fetch', rpcFetch(rpc.request));
    render(<AppProviders><MemoryRouter><CoinPileV2 view={view} source={published.source} ticker="HOARD" disabled={false} /></MemoryRouter></AppProviders>);
    return { view };
  }
  const panel = () => screen.getByRole('region', { name: 'Coin pile' });
  const figure = (label: string) => within(panel()).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

  it('quotes as quoteRedeem does: two floors with the leave-behind, the whole balance for the whole supply', () => {
    const money = { balance: 1_000_000_000_000_000_007n, supply: 3n * ETH };
    expect(quoteOf(money, ETH, 500n)).toBe(((money.balance * ETH) / money.supply) * 9_500n / 10_000n);
    expect(quoteOf(money, money.supply, 500n)).toBe(money.balance);
    expect(quoteOf(money, ETH, 0n)).toBe(quoteOf(money, ETH));
    expect(quoteOf(money, ETH)).toBe((money.balance * ETH) / money.supply);
    expect(perCoin(money, 500n)).toBe(((money.balance * ETH) / money.supply) * 9_500n / 10_000n);
    expect(quoteOf(money, money.supply + 1n, 500n)).toBeNull();
  });

  it('shows the 5% leave-behind, the fees waiting and moved in, and quotes 95% of the share as the minimum', async () => {
    await rig({ leaveBehindBps: 500, pileFees: { pendingP: 3n * ETH, movedP: ETH / 2n } });
    expect(figure('Leave behind')).toBe('5%');
    expect(figure('Fees waiting')).toBe('3 ETH');
    expect(figure('Fees moved in')).toBe('0.5 ETH');
    // SH-ALCHEMIST-LESS-TEXT: behind the closed Pile details, with the seed, the coins out and the leave-behind; in view only what a coin gets.
    for (const label of ['Fees waiting', 'Fees moved in', 'Leave behind', 'Seed', 'HOARD out']) expect(within(panel()).getByText(label, { selector: 'dt' }).closest('[hidden]'), label).not.toBeNull();
    expect(within(panel()).getByText('Per HOARD', { selector: 'dt' }).closest('[hidden]')).toBeNull();
    expect(figure('Per HOARD')).toBe('0.00095 ETH');
    fireEvent.change(within(panel()).getByRole('textbox', { name: 'HOARD to redeem' }), { target: { value: '3' } });
    expect(figure('You get')).toBe('0.00285 ETH'); expect(figure('Minimum')).toBe('0.00285 ETH');
    expect(within(panel()).getByText(/each hand-in pays 95% of its share/)).toBeTruthy();
    expect(within(panel()).getByText(/fees chosen To the pile wait in the box until graduation/)).toBeTruthy();
    expect(appCopyFraming(renderedCopy(document.body))).toEqual([]);
  });

  it('a pile its fees do not go to shows no fee rows, and 0% as its leave-behind', async () => {
    await rig({});
    expect(figure('Leave behind')).toBe('0%');
    expect(within(panel()).queryByText('Fees waiting')).toBeNull();
    expect(within(panel()).getByText(/no fee choice adds to it/)).toBeTruthy();
  });

  it('V21-SITE-01: on a 5% pile the quote is quoteRedeem exactly, and a partial redemption reaches the wallet with it as the minimum', async () => {
    // The review's case: B = 1e18, S = 1000, tIn = 100 at 500 bps pays 95e15; the whole supply takes all of B.
    const money = { balance: 10n ** 18n, supply: 1000n };
    expect(quoteOf(money, 100n, 500n)).toBe(95_000_000_000_000_000n);
    expect(quoteOf(money, 1000n, 500n)).toBe(10n ** 18n);
    const { view } = await rig({ leaveBehindBps: 500, balance: money.balance, supply: money.supply });
    const input = within(panel()).getByRole('textbox', { name: 'HOARD to redeem' });
    fireEvent.change(input, { target: { value: '0.0000000000000001' } });
    expect(figure('You get')).toBe('0.095 ETH'); expect(figure('Minimum')).toBe('0.095 ETH');
    fireEvent.click(screen.getByRole('button', { name: 'Redeem' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm transaction' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const tx = required(sends()[0]);
    expect(tx.to.toLowerCase()).toBe(required(view.claimRow?.contracts.vault).toLowerCase());
    expect(decodeFunctionData({ abi: pileVaultV2Abi, data: tx.data })).toMatchObject({ functionName: 'redeem', args: [100n, 95_000_000_000_000_000n, A] });
    expect(await within(panel()).findByText('Confirmed. Reading the updated box…')).toBeTruthy();
  });

  it('refuses a published leave-behind that is not the one the spec fixes', async () => {
    const published = await publishedPile({ leaveBehindBps: 500 });
    const body = published.body as unknown as { money: { m3: { pile: Record<string, unknown> } } };
    expect(parseSnapshotV2(published.body, published.source).m3?.pileMoney).toBeTruthy();
    const tampered = { ...published.body, money: { ...body.money, m3: { ...body.money.m3, pile: { ...body.money.m3.pile, leaveBehindBps: '0' } } } };
    expect(() => parseSnapshotV2(tampered, published.source)).toThrow(/leave-behind/);
  });
});
