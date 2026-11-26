/**
 * The coin pile panel (M3-53; S5; R43-M3D/M3E): seed coin and amount, per-coin share, redemption only after
 * graduation with an exact minimum out, the seed's return after failure and the one no-rescue line. Real panel, M3-52
 * readers over a viem client and the shared sender; only the RPC answers, the wallet and the listing book are doubles.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { decodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { NotSendableError } from '@squarehole/chain/write';
import { AppProviders } from '../../../app-providers';
import { pileVaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { CoinPileV2 } from './CoinPileV2';
import { parseSnapshotV2 } from './indexer-v2';
import * as m3 from './m3-actions';
import { m3RpcFixture } from './test-support/m3-rpc';
import { A, ETH, H, publishedPile, type PileOptions } from './test-support/m3-published';
import { rpcFetch } from './test-support/rpc-fetch';
import { required } from './test-support/required';

const USDC = '0x00000000000000000000000000000000000005dc' as Address;
const wallet = vi.hoisted(() => ({ account: '' as string | null, status: 'connected', chainId: 31337, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
vi.mock('../../create/v2/indexer-listings', async (original) => ({ ...await original<object>(),
  loadListingsV2: async () => [{ id: 2, token: USDC, decimals: 6, class: 3, kind: 1, raise: 15_986_524_323n, symbol: 'USDC', name: 'USDC', powers: [] }] }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const original = m3.m3ActionIO;

async function rig(options: PileOptions = {}, extra: { refuse?: boolean; allowanceT?: bigint } = {}) {
  wallet.account = A; wallet.status = 'connected'; wallet.chainId = 31337; wallet.kind = 'injected';
  wallet.signer.request.mockReset();
  // The test wallet signs nothing: it answers a fresh hash per send.
  let count = 0;
  wallet.signer.request.mockImplementation(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_sendTransaction' ? H(80 + ++count) : [wallet.account]);
  const published = await publishedPile(options);
  const view = parseSnapshotV2(published.body, published.source);
  const money = view.m3?.pileMoney;
  const chain = { allowanceT: extra.allowanceT ?? 0n };
  const rpc = m3RpcFixture({ pile: { asset: published.asset, seeder: view.record.creator, seed: published.seed, balance: money?.balance ?? 0n, supply: money?.supply ?? 0n }, coinsT: 10n * ETH,
    get allowanceT() { return chain.allowanceT; } });
  vi.stubGlobal('fetch', rpcFetch(rpc.request));
  // With `refuse`, the shared sender's guard refuses the call before the wallet (as for any call it does not admit).
  if (extra.refuse) vi.spyOn(m3, 'm3ActionIO').mockImplementation((s, v, r) => ({ ...original(s, v, r), submit: (async () => {
    throw new NotSendableError('v2 action must target its prepared box role');
  }) as m3.M3ActionIO['submit'] }));
  render(<AppProviders><MemoryRouter><CoinPileV2 view={view} source={published.source} ticker="HOARD" disabled={false} /></MemoryRouter></AppProviders>);
  return { view, chain, pile: required(view.claimRow?.contracts.vault) };
}
const panel = () => screen.getByRole('region', { name: 'Coin pile' });
const figure = (label: string) => within(panel()).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
const confirmGroup = () => screen.getByRole('group', { name: 'Confirm transaction' });
type Tx = { from: Address; to: Address; data: Hex; value: Hex };
/** Every transaction the wallet was asked to send, in order. */
const sends = (): Tx[] => wallet.signer.request.mock.calls.map(([call]) => call as { method: string; params?: readonly Tx[] })
  .filter((call) => call.method === 'eth_sendTransaction').map((call) => required(call.params?.[0]));
/** The `n`-th send went from the caller to `to` with zero value. */
const sentTo = (n: number, to: Address) => { const tx = required(sends()[n]); expect(tx.to).toBe(to); expect(tx.from).toBe(A); expect(tx.value).toBe('0x0'); return tx; };

it('M353-PILE: after graduation shows the live balance, the seed, the share per coin and the no-rescue line, read without the wallet', async () => {
  await rig();
  expect(within(panel()).getByText('1000.00000000000000002 ETH')).toBeTruthy();
  expect(within(panel()).getByText('Redeem open')).toBeTruthy();
  expect(figure('Seed')).toBe('1000 ETH');
  expect(figure('Per HOARD')).toBe('0.001 ETH');
  expect(figure('HOARD out')).toBe('1000000 HOARD');
  expect(within(panel()).getByText('Coins sent to the pile by mistake cannot be recovered.')).toBeTruthy();
  expect(wallet.signer.request).not.toHaveBeenCalled();
});

it('M353-PILE: the quote and its exact minimum follow the typed coins; nothing above 18 decimals or the supply', async () => {
  await rig();
  const input = within(panel()).getByRole('textbox', { name: 'HOARD to redeem' });
  fireEvent.change(input, { target: { value: '3' } });
  expect(figure('You get')).toBe('0.003 ETH'); expect(figure('Minimum')).toBe('0.003 ETH');
  expect((screen.getByRole('button', { name: 'Redeem' }) as HTMLButtonElement).disabled).toBe(false);
  for (const bad of ['1.0000000000000000001', '1e3', '-1', '2000000']) {
    fireEvent.change(input, { target: { value: bad } });
    expect(within(panel()).queryByText('You get')).toBeNull();
    expect((screen.getByRole('button', { name: 'Redeem' }) as HTMLButtonElement).disabled).toBe(true);
  }
});

it.each<[string, PileOptions, string]>([
  ['before graduation', { graduated: false }, 'After graduation'],
  ['before the seed arrives', { graduated: false, loaded: false }, 'Seed waiting'],
  ['after failure', { failed: true }, 'Closed'],
])('M353-PILE: no redemption %s (%s)', async (_name, options, chip) => {
  await rig(options);
  expect(within(panel()).getByText(chip)).toBeTruthy();
  expect(within(panel()).queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Redeem' })).toBeNull();
});

it('M353-PILE: redeem is approve(pile, coins) on the box coin, then redeem(coins, exact quote, wallet) on the pile; both reach the wallet', async () => {
  const r = await rig();
  fireEvent.change(within(panel()).getByRole('textbox', { name: 'HOARD to redeem' }), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve coins' }));
  expect(confirmGroup().textContent).toContain('Approve exactly 3 HOARD for the pile?');
  await act(async () => fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Confirm' })));
  expect(await within(panel()).findByText('Approval confirmed. Redeem in a separate transaction.')).toBeTruthy();
  expect(sends()).toHaveLength(1);
  expect(decodeFunctionData({ abi: erc20Abi, data: sentTo(0, r.view.token).data })).toMatchObject({ functionName: 'approve', args: [r.pile, 3n * ETH] });
  r.chain.allowanceT = 3n * ETH;
  fireEvent.click(screen.getByRole('button', { name: 'Redeem' }));
  expect(confirmGroup().textContent).toContain('Redeem 3 HOARD for 0.003 ETH, minimum 0.003 ETH?');
  await act(async () => fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Confirm' })));
  expect(await within(panel()).findByText('Confirmed. Reading the updated box…')).toBeTruthy();
  expect(sends()).toHaveLength(2);
  expect(decodeFunctionData({ abi: pileVaultV2Abi, data: sentTo(1, r.pile).data })).toMatchObject({ functionName: 'redeem', args: [3n * ETH, 3n * ETH / 1000n, A] });
});

it('M353-PILE: a redemption without the approval stops before any send; a guard refusal sends nothing and says so', async () => {
  await rig({}, { refuse: true });
  fireEvent.change(within(panel()).getByRole('textbox', { name: 'HOARD to redeem' }), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Redeem' }));
  await act(async () => fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Confirm' })));
  expect(await within(panel()).findByText('Approve these coins first')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve coins' }));
  await act(async () => fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Confirm' })));
  expect(await within(panel()).findByText('Not sent. Nothing reached your wallet.')).toBeTruthy();
  expect(sends()).toHaveLength(0);
  expect(within(panel()).queryByText(/cannot send/)).toBeNull();
});

it('M353-PILE: after failure the recorded seed is due, and Return seed reaches the wallet as returnSeed() to the pile', async () => {
  const r = await rig({ failed: true });
  expect(figure('Seed return')).toBe('1000 ETH due');
  fireEvent.click(screen.getByRole('button', { name: 'Return seed' }));
  expect(confirmGroup().textContent).toContain('Send the seed, 1000 ETH, back to its seeder?');
  expect(confirmGroup().textContent).toContain(`To ${r.view.record.creator}`);
  await act(async () => fireEvent.click(within(confirmGroup()).getByRole('button', { name: 'Confirm' })));
  expect(await within(panel()).findByText('Confirmed. Reading the updated box…')).toBeTruthy();
  expect(sends()).toHaveLength(1);
  expect(decodeFunctionData({ abi: pileVaultV2Abi, data: sentTo(0, r.pile).data })).toMatchObject({ functionName: 'returnSeed' });
});

it.each<[PileOptions, string]>([
  [{ failed: true, returned: true }, 'Returned 1000 ETH'],
  [{ failed: true, loaded: false }, 'None loaded'],
])('M353-PILE: a seed already returned, or never loaded, has no Return seed (%o)', async (options, text) => {
  await rig(options);
  expect(figure('Seed return')).toBe(text);
  expect(screen.queryByRole('button', { name: 'Return seed' })).toBeNull();
});

it('M353-PILE: a 6-decimal seed coin is named and shown from its listing, exactly', async () => {
  await rig({ asset: USDC, seed: 1_000_000_000n, balance: 1_000_000_007n, supply: 3n * ETH });
  expect(await within(panel()).findByText('1000.000007 USDC')).toBeTruthy();
  expect(figure('Seed')).toBe('1000 USDC');
  expect(figure('Per HOARD')).toBe('333.333335 USDC');
});

it('M353-PILE: a zero-supply read shows no balance and no share, never zero', async () => {
  await rig({ balance: null, supply: 0n, graduated: false });
  expect(within(panel()).getByText('— ETH')).toBeTruthy();
  expect(figure('Per HOARD')).toBe('—');
});

it('M353-COPY: one visible sentence; the rest is behind Details; the wording rule passes', async () => {
  await rig({ failed: true });
  expect(appCopyFraming(renderedCopy(panel()))).toEqual([]);
  // SH-ALCHEMIST-LESS-TEXT: Pile details is the shared Details button, closed, its panel hidden until pressed.
  const button = within(panel()).getByRole('button', { name: 'Pile details' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  const details = required(document.getElementById(required(button.getAttribute('aria-controls'))));
  expect(details.hidden).toBe(true);
  expect(details.textContent).toMatch(/only the recorded seed goes back to the creator/);
  const sentences = Array.from(panel().querySelectorAll('p')).filter((p) => !p.closest('[hidden]') && /[a-z]{3,}\s[a-z]/i.test(p.textContent ?? ''));
  expect(sentences.map((p) => p.textContent)).toEqual(['Coins sent to the pile by mistake cannot be recovered.']);
  // A failed box keeps in view what the seeder acts on: the seed return and its button; the other figures are in the panel.
  expect(details.contains(within(panel()).getByText('Seed return', { selector: 'dt' }))).toBe(false);
  expect(details.contains(within(panel()).getByRole('button', { name: 'Return seed' }))).toBe(false);
  for (const label of ['Seed', 'HOARD out', 'Leave behind']) expect(details.contains(within(panel()).getByText(label, { selector: 'dt' })), label).toBe(true);
  expect(Array.from(panel().querySelectorAll('dt')).filter((dt) => !dt.closest('[hidden]')).map((dt) => dt.textContent)).toEqual(['Per HOARD', 'Seed return']);
});
