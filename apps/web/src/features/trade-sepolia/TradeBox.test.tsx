/**
 * F156 (SH-ALPHA-TRADE-BOX): the trade box through its real plan and send (the trade folder's `prepareTradeSepolia`
 * and `submitTradeWriteSepolia`, their guard and the one checked sender), over the trade calls' own block-pinned RPC
 * double (packages/chain/src/trade-sepolia/test-support.ts) and a wallet double that records what it is asked. Only
 * the wallet context is mocked; the two trade calls are wrapped to record the chain id and the RPC they are given.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, toHex, zeroAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import type { Eip1193Request } from '@squarehole/chain/write';
import { prepareTradeSepolia, TRADE_ABI, TRADE_ERRORS, type TradeOptions } from '@squarehole/chain/trade-sepolia';
import type { TradeSubmitOptions } from '@squarehole/chain/trade-sepolia';
import { COIN, COORDINATOR, fixture, LOCAL, MANAGER, POOL, ROUTER, TOKEN, USER } from '../../../../../packages/chain/src/trade-sepolia/test-support';
import { getTickAtSqrtPrice } from '../../../../../packages/box-spec/src/v4-math';
import { poolManagerAbi } from '../../../../../packages/chain/src/abi/poolManager';
import { launchRouterV2Abi } from '../../../../../packages/chain/src/core/v2/abi-v2';
import type { BoxRecord } from '../boxes/box-model';
import type { V2Snapshot, V2Source } from '../core/v2/indexer-v2';
import type { TradeTarget } from './trade-target';
import { TradeBox } from './TradeBox';
import { TestCoinPage } from './TestCoinPage';
import { clearInFlight, inFlightOf, sendKey } from './trade-inflight';

const wallet = vi.hoisted(() => ({
  status: 'connected' as 'connected' | 'disconnected', kind: 'injected' as 'injected' | 'demo', account: '0x0000000000000000000000000000000000000070' as string | null,
  chainId: 31337 as number | null, defaultDialog: 'browser' as const,
  signer: { request: (async () => null) as (args: { method: string; params?: unknown[] }) => Promise<unknown>, walletName: 'Test wallet' } as { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; walletName: string } | null,
  switchChain: (async () => undefined) as (chainId: number) => Promise<void>,
}));
vi.mock('../wallet', async () => {
  const React = await import('react');
  return {
    useWallet: () => wallet,
    BrowserWalletDialog: ({ open }: { open: boolean }) => (open ? React.createElement('div', { role: 'dialog', 'aria-label': 'Connect a browser wallet' }) : null),
  };
});
// The test-coin page reads the site's data source (it is mounted here once, to adopt a box trade).
vi.mock('../data-source', () => ({ useDataSource: () => ({ id: 'local' }) }));
const spies = vi.hoisted(() => ({ prepare: [] as unknown[], submit: [] as unknown[] }));
vi.mock('@squarehole/chain/trade-sepolia', async (original) => {
  const real = await original<typeof import('@squarehole/chain/trade-sepolia')>();
  return {
    ...real,
    prepareTradeSepolia: (options: TradeOptions) => { spies.prepare.push(options); return real.prepareTradeSepolia(options); },
    submitTradeWriteSepolia: (options: TradeSubmitOptions) => { spies.submit.push(options); return real.submitTradeWriteSepolia(options); },
  };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  // Every test is a fresh visit: no send left under way from the one before (trade-inflight.ts).
  clearInFlight();
  spies.prepare.length = 0; spies.submit.length = 0;
  wallet.status = 'connected'; wallet.kind = 'injected'; wallet.account = USER; wallet.chainId = 31337;
});

const ETHER = 10n ** 18n;
/** The fixture's block time: the plan block of every quote (test-support.ts `fixture`, `timestamp`). */
const NOW = 1_790_000_000n;
type Tx = { from: Address; to: Address; data: Hex; value: Hex; gas: Hex; chainId: Hex };
const hashOf = (n: number) => toHex(n, { size: 32 });

/** One log of a contract's event, encoded with that contract's own ABI (as the chain would emit it). */
function eventLog(abi: Abi, address: Address, eventName: string, args: Record<string, unknown>) {
  const event = abi.find((item): item is AbiEvent => item.type === 'event' && item.name === eventName);
  if (!event) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[];
  const data = encodeAbiParameters(event.inputs.filter((input) => !input.indexed), event.inputs.filter((input) => !input.indexed).map((input) => args[input.name ?? '']));
  return { address, topics, data };
}
const poolIdOf = (key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));

interface RigOptions {
  /** The hook's phase: 2 Window, 3 Bonding, 4 Closed, 5 Graduated. */
  readonly phase?: number;
  /** The price coin: native ETH (the zero address) or the ERC-20 test coin. */
  readonly p?: Address;
  readonly allowance?: bigint;
  /** What the wallet leaves approved after a trade (a part fill), and whether the trade's receipt reverts. */
  readonly left?: bigint;
  readonly revert?: Hex;
  readonly balance?: bigint;
  /**
   * The wallet's answer to a send: a hash (default), a decline, an unclear error after the transaction went out, an
   * unclear error before it did, or a speed-up (the wallet answers one hash and the chain mines another at its nonce).
   */
  readonly send?: 'hash' | 'decline' | 'unclear' | 'unclear-unsent' | 'speed-up';
  /** Receipts appear only once the test releases them (a slow chain). */
  readonly hold?: boolean;
  /** Something of this account's is already pending before the test starts (a stuck transaction). */
  readonly stuck?: boolean;
  /** This many receipt reads fail before they answer. */
  readonly failReceipts?: number;
  /** The wallet holds every send until the test opens this gate. */
  readonly gate?: Promise<void>;
  /** The account's nonces cannot be read from the given read on (the read before a send is the first after a quote). */
  readonly failNoncesFrom?: number;
  /** What a pool trade takes of its native input (the rest comes back in the same transaction); all of it by default. */
  readonly filled?: bigint;
  /** What the launch router pays back of a window buy's qIn (a closing fill); nothing by default. */
  readonly refund?: bigint;
  /** The trade's receipt holds none of its events (what it filled is not said). */
  readonly noEvents?: boolean;
  /** The block a plan reads as the latest (prepareTradeSepolia's own); the mined block named first is always 0x10. */
  readonly planBlock?: bigint;
  /** The account's balance of what it pays in, by the block asked (hex). */
  readonly balanceAt?: (block: string) => bigint;
  /** These balance reads fail (counted from 1, in the order asked). */
  readonly failBalance?: readonly number[];
  /** This many plans fail first, at their pool read, as a public RPC's node without the named block (SH-ONE-PRESS-TRADE). */
  readonly failPlans?: number;
}

/** The chain the box reads (the trade calls' double plus balances, nonces and receipts) and a wallet that mines what it sends. */
function rig(options: RigOptions = {}) {
  const f = fixture({ phase: options.phase ?? 3, p: options.p ?? zeroAddress, allowance: options.allowance ?? 0n, timestamp: NOW } as Parameters<typeof fixture>[0]);
  // `nonce`: the account's mined transactions; `pending`: those sent, mined or not.
  const chain = { nonce: 0n, pending: options.stuck ? 1n : 0n, receipts: new Map<string, '0x1' | '0x0'>(), held: new Map<string, '0x1' | '0x0'>(),
    /** Each mined trade's events (the PoolManager's Swap, the router's TaxedBuy), by hash. */
    logs: new Map<string, ReturnType<typeof eventLog>[]>(),
    /** The block each balance read named, in order. */
    balanceBlocks: [] as string[],
    txs: new Map<string, bigint>(), failReceipts: options.failReceipts ?? 0, revertCall: null as { data: Hex } | null, send: options.send ?? 'hash',
    /** Receipt reads that start while this is set wait for it (a slow node mid-look); `blockedReceipts` counts them. */
    receiptGate: null as Promise<void> | null, blockedReceipts: 0,
    /** Sends that reach the wallet while this is set wait for it (the person has not answered yet). */
    walletGate: null as Promise<void> | null,
    /** The same for every send but an approval (a browser wallet's second window, SH-ONE-PRESS-TRADE). */
    tradeGate: null as Promise<void> | null,
    /** Runs once an approval is mined (another trade moving the pool meanwhile). */
    onApprove: null as (() => void) | null,
    failPlans: options.failPlans ?? 0,
    /** The chain's head: 0x10, then 0x11 once a send is mined (receipts are at 0x11). */
    head: 0x10n,
    /** This many reads of the latest block come from a node still at 0x10 (behind a mined send's 0x11). */
    lagPlans: 0,
    /** The next nonce read shows one transaction pending (a node that has a mined send in its pool only). */
    pendingOnce: false };
  const asked: string[] = [];
  let nonceReads = 0;
  let balanceReads = 0;
  /** A balance read at `block`: counted, recorded, failed when the test says so. */
  const balanceRead = (block: unknown, fallback: bigint): bigint => {
    balanceReads += 1;
    chain.balanceBlocks.push(String(block));
    if (options.failBalance?.includes(balanceReads)) throw new Error('the node did not answer');
    return options.balanceAt ? options.balanceAt(String(block)) : options.balance ?? fallback;
  };
  const rpc: Eip1193Request = async (request) => {
    const method = request.method;
    const params = (request.params ?? []) as readonly unknown[];
    asked.push(method);
    if (method === 'eth_blockNumber') return toHex(chain.head);
    if (method === 'eth_getBlockByNumber') {
      const lagging = params[0] === 'latest' && chain.lagPlans > 0;
      if (lagging) chain.lagPlans -= 1;
      const number = options.planBlock ?? (params[0] === 'latest' ? (lagging ? 0x10n : chain.head) : BigInt(String(params[0])));
      return { number: toHex(number), hash: `0x${'ab'.repeat(32)}`, timestamp: toHex(NOW), baseFeePerGas: '0x1', transactions: [] };
    }
    if (method === 'eth_getBalance') return toHex(balanceRead(params[1], 100n * ETHER));
    if (method === 'eth_getTransactionCount') {
      nonceReads += 1;
      if (options.failNoncesFrom !== undefined && nonceReads >= options.failNoncesFrom) throw new Error('the node did not answer');
      if (params[1] === 'pending' && chain.pendingOnce) { chain.pendingOnce = false; return toHex(chain.nonce + 1n); }
      return toHex(params[1] === 'pending' ? chain.pending : chain.nonce);
    }
    if (method === 'eth_getTransactionByHash') {
      const nonce = chain.txs.get(String(params[0]));
      return nonce === undefined ? null : { hash: params[0], from: USER, to: POOL, nonce: toHex(nonce), input: '0x', value: '0x0', gas: '0x5208', blockNumber: null, blockHash: null };
    }
    if (method === 'eth_getTransactionReceipt') {
      const slow = chain.receiptGate;
      if (slow) { chain.blockedReceipts += 1; await slow; }
      if (chain.failReceipts > 0) { chain.failReceipts -= 1; throw new Error('the node did not answer'); }
      const status = chain.receipts.get(String(params[0]));
      const logs = status === '0x1' ? (chain.logs.get(String(params[0])) ?? []).map((log, i) => ({ ...log, logIndex: toHex(i), blockHash: hashOf(9), blockNumber: '0x11', transactionHash: params[0] })) : [];
      return status ? { transactionHash: params[0], blockHash: hashOf(9), blockNumber: '0x11', status, from: USER, to: POOL, gasUsed: '0x5208', effectiveGasPrice: '0x1', logs } : null;
    }
    if (method === 'eth_call') {
      const call = params[0] as { to: Address; data: Hex };
      if (call.data.startsWith(encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [USER] }).slice(0, 10))) {
        return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: balanceRead(params[1], 1_000_000n * ETHER) });
      }
      // A mined revert, run again at its block: the contract's error, as a node returns it.
      if (params[1] === '0x11' && chain.revertCall && call.data === chain.revertCall.data && options.revert) throw Object.assign(new Error('execution reverted'), { code: 3, data: options.revert });
      // A node behind the one that named the block, as publicnode answers: only a plan reads the pool's storage.
      if (chain.failPlans > 0 && decodeFunctionData({ abi: TRADE_ABI, data: call.data }).functionName === 'extsload') { chain.failPlans -= 1; throw Object.assign(new Error('block not found: 0x10'), { code: -32001 }); }
    }
    return f.rpc(request);
  };
  const sent: Tx[] = [];
  const walletAsked: string[] = [];
  wallet.signer = {
    walletName: 'Test wallet',
    request: async ({ method, params }) => {
      walletAsked.push(method);
      if (method === 'eth_chainId') return toHex(wallet.chainId ?? 0);
      if (method === 'eth_accounts') return [wallet.account];
      if (method !== 'eth_sendTransaction') throw new Error(`unexpected wallet request ${method}`);
      const tx = (params as Tx[])[0] as Tx;
      const approving = (() => { try { return decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName === 'approve'; } catch { return false; } })();
      await options.gate;
      if (chain.walletGate) await chain.walletGate;
      if (!approving && chain.tradeGate) await chain.tradeGate;
      if (chain.send === 'decline') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      if (chain.send === 'unclear-unsent') { chain.send = 'hash'; throw new Error('the wallet lost the request'); }
      sent.push(tx);
      const nonce = chain.pending;
      chain.pending += 1n;
      if (!options.hold) { chain.nonce = chain.pending; chain.head = 0x11n; }
      const decoded = tx.to.toLowerCase() === (options.p ?? zeroAddress).toLowerCase() || tx.to.toLowerCase() === TOKEN.toLowerCase()
        ? decodeFunctionData({ abi: TRADE_ABI, data: tx.data }) : null;
      const isTrade = decoded?.functionName !== 'approve';
      if (decoded?.functionName === 'approve') { f.state.allowance = decoded.args[1] as bigint; chain.onApprove?.(); }
      else f.state.allowance = options.left ?? 0n;
      const hash = hashOf(100 + sent.length);
      chain.txs.set(hash, nonce);
      // What the trade took, as its contracts emit it: the PoolManager's Swap for PoolSwapTest (the swapper's delta,
      // negative for what it paid in), the launch router's TaxedBuy for a window buy.
      const trade = isTrade && !options.noEvents ? decodeFunctionData({ abi: TRADE_ABI, data: tx.data }) : null;
      if (trade?.functionName === 'swap') {
        const [key, swap] = trade.args;
        const offered = -swap.amountSpecified;
        const native = swap.zeroForOne && key.currency0 === zeroAddress;
        const spent = native ? (options.filled ?? offered) : offered - (options.left ?? 0n);
        chain.logs.set(hash, [eventLog(poolManagerAbi as Abi, MANAGER, 'Swap', { id: poolIdOf(key), sender: POOL,
          amount0: swap.zeroForOne ? -spent : 1_000_001n, amount1: swap.zeroForOne ? 1_000_001n : -spent, sqrtPriceX96: 4295128740n, liquidity: 1n, tick: 0, fee: 10000 })]);
      } else if (trade?.functionName === 'buy') {
        const [qIn] = trade.args;
        chain.logs.set(hash, [eventLog(launchRouterV2Abi as Abi, ROUTER, 'TaxedBuy', { buyer: USER, recipient: USER, step: 0n, qIn, tax: qIn / 2n, tokensOut: 1_000_001n, refund: options.refund ?? 0n })]);
      }
      if (isTrade && options.revert) chain.revertCall = { data: tx.data };
      // A speed-up: the chain mines the wallet's replacement at the same nonce, never this hash.
      if (chain.send === 'speed-up') { chain.send = 'hash'; chain.receipts.set(hashOf(900), '0x1'); return hash; }
      (options.hold ? chain.held : chain.receipts).set(hash, isTrade && options.revert ? '0x0' : '0x1');
      if (chain.send === 'unclear') { chain.send = 'hash'; throw new Error('transport closed'); }
      return hash;
    },
  };
  const target: TradeTarget = { chainId: 31337, rpc, coordinator: COORDINATOR, localDeployment: LOCAL, explorer: () => null };
  /** The held receipts appear (the chain mined them). */
  const release = () => { for (const [hash, status] of chain.held) chain.receipts.set(hash, status); chain.held.clear(); chain.nonce = chain.pending; chain.head = 0x11n; };
  return { f, chain, rpc, asked, sent, walletAsked, target, release };
}

const OPEN = NOW - 5n;
function viewOf(patch: Partial<V2Snapshot> = {}, p: Address = zeroAddress): V2Snapshot {
  const contracts = [COORDINATOR, ...Array.from({ length: 23 }, () => zeroAddress)];
  return { record: { contracts, codeHashes: contracts.map(() => `0x${'00'.repeat(32)}`), q: p, raise: ETHER }, token: TOKEN, decimals: 18,
    gate: { open: true, deadline: NOW + 86_400n, effectiveOpenAt: OPEN }, timestamp: NOW, graduated: false, closedAt: 0n, failed: null, ...patch } as unknown as V2Snapshot;
}
const recordOf = (p: Address): BoxRecord => ({ pairAsset: p === zeroAddress ? 'ETH' : 'tETH', ticker: 'ATETH', chainId: 31337 }) as unknown as BoxRecord;
const SOURCE = { network: 'local', rpc: 'http://127.0.0.1:8592', origin: '', manifest: { chainId: 31337, chain: { poolManager: { address: LOCAL.poolManager } }, releases: [] } } as unknown as V2Source;

function show(target: TradeTarget | { reason: string }, options: { p?: Address; view?: Partial<V2Snapshot>; disabled?: boolean; receiptTimeoutMs?: number; quiet?: { reads: number; ms: number } } = {}) {
  const p = options.p ?? zeroAddress;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let state = { disabled: options.disabled ?? false, view: options.view ?? {} };
  const element = () => <QueryClientProvider client={client}><TradeBox record={recordOf(p)} view={viewOf(state.view, p)} source={SOURCE} disabled={state.disabled} target={target} {...(options.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: options.receiptTimeoutMs })} {...(options.quiet ? { quiet: options.quiet } : {})} /></QueryClientProvider>;
  const result = render(element());
  return { ...result, client,
    setDisabled: (disabled: boolean) => { state = { ...state, disabled }; result.rerender(element()); },
    setView: (view: Partial<V2Snapshot>) => { state = { ...state, view }; result.rerender(element()); } };
}
const box = () => screen.getByRole('region', { name: 'Buy and sell' });
const amount = () => within(box()).getByRole('textbox', { name: /^Amount in / });
/** The box's button with this name, once it can be pressed (a quote or a mined step may still be on its way). */
const go = (name: string | RegExp) => waitFor(() => {
  const button = within(box()).getByRole('button', { name }) as HTMLButtonElement;
  if (button.disabled) throw new Error(`${String(name)} is not enabled yet`);
  return button;
}, { timeout: 4_000 });
const type = (text: string) => fireEvent.change(amount(), { target: { value: text } });
const line = () => within(box()).queryByRole('status')?.textContent ?? null;
const text = () => box().textContent ?? '';
const isDisabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;

describe('phases without trading: one line, no field', () => {
  it('Upcoming names its open; a full curve before graduate() and a closed box say why', () => {
    const { target } = rig();
    const upcoming = show(target, { view: { timestamp: OPEN - 60n } });
    expect(text()).toMatch(/^Buy and sellOpens \d+ \w+, \d\d:\d\d UTC\.$/);
    expect(within(box()).queryByRole('textbox')).toBeNull();
    upcoming.unmount();
    show(target, { view: { closedAt: NOW - 1n } });
    expect(text()).toContain('Full. Trading resumes after graduation.');
    expect(within(box()).queryByRole('button')).toBeNull();
    cleanup();
    show(target, { view: { failed: { cause: 'Deadline', at: NOW } } });
    expect(text()).toContain('Closed. No more trading.');
  });
  it('a chain the box does not trade on says so', () => {
    show({ reason: 'chain_not_allowed' });
    expect(text()).toContain('No trading on this network.');
    expect(within(box()).queryByRole('textbox')).toBeNull();
  });
});

describe('the wallet only on a press', () => {
  it('with no wallet, typing reads nothing from the chain and asks no wallet; the press opens the wallet window', async () => {
    const r = rig();
    wallet.status = 'disconnected'; wallet.account = null;
    show(r.target);
    type('0.5');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(r.asked).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(await go('Buy'));
    expect(screen.getByRole('dialog', { name: 'Connect a browser wallet' })).toBeTruthy();
    expect(r.walletAsked).toEqual([]);
    expect(spies.prepare).toEqual([]);
  });

  it('a stale or unverified read: no quote, no send, one line', async () => {
    const r = rig();
    const view = show(r.target, { disabled: true });
    type('0.5');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(r.asked).toEqual([]);
    expect(isDisabled(within(box()).getByRole('button', { name: 'Buy' }))).toBe(true);
    expect(text()).toContain('Waits for a current verified read.');
    // Current again: the quote comes.
    view.setDisabled(false);
    expect(await within(box()).findByText(/^≈ /)).toBeTruthy();
    expect(isDisabled(within(box()).getByRole('button', { name: 'Buy' }))).toBe(false);
  });
});

describe('a bonding buy with ETH: the pool, its warning, one press, one wallet request', () => {
  it.each([2, 3])('SH-194: phase %i shows the raise-end line and keeps the pool’s no-deadline notice', async phase => {
    const r = rig({ phase });
    show(r.target);
    type('5');
    const line = (await within(box()).findByText(/^Quote: about/)).textContent;
    expect(line).toMatch(/^Quote: about [\d.]+ ETH fills the raise; the box can graduate\.$/);
    expect(line).not.toMatch(/at least|stays with you|remains|This buy fills/);
    expect(line).not.toMatch(/\d\.\d{5}/);
    expect(text()).not.toContain('Fills ≈');
    expect(box().querySelector('.sh-trade-box__warning')?.textContent ?? null).toBe(phase === 3 ? 'No deadline.' : null);
    expect(within(box()).getByRole('button', { name: 'Details: Buy and sell' }).getAttribute('aria-expanded')).toBe('false');
    if (phase === 3) {
      const notice = within(box()).getByText('No deadline.');
      expect(notice.closest('[hidden], details')).toBeNull();
    } else {
      expect(within(box()).queryByText('No deadline.')).toBeNull();
    }
    expect(r.walletAsked).toEqual([]);
  });

  it('sends exactly the plan’s call with the build target’s chain id and the site’s RPC', async () => {
    const r = rig();
    show(r.target);
    type('0.01');
    expect(await within(box()).findByText(/^≈ /)).toBeTruthy();
    expect(text()).toContain('Can fill in part; no deadline.');
    expect(text()).toContain('Pool fee1%');
    expect(text()).not.toContain('Launch tax');
    fireEvent.click(await go('Buy'));
    // The whole amount went in: the row says what it took.
    await within(box()).findByText('Buy confirmed: 0.01 ETH');
    expect(r.sent).toHaveLength(1);
    const [tx] = r.sent as [Tx];
    const prepared = spies.prepare.at(-1) as TradeOptions;
    expect(prepared).toMatchObject({ chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: ETHER / 100n, toleranceBps: 200n, localDeployment: LOCAL });
    expect(prepared.rpc).toBe(r.target.rpc);
    const submitted = spies.submit[0] as TradeSubmitOptions;
    expect(submitted.chainId).toBe(31337);
    expect(submitted.rpc).toBe(r.target.rpc);
    expect(submitted.call).toBe(submitted.plan.call);
    expect(tx.to.toLowerCase()).toBe(POOL.toLowerCase());
    expect(BigInt(tx.value)).toBe(ETHER / 100n);
    expect(tx.data).toBe(submitted.plan.call?.data);
    expect(BigInt(tx.gas)).toBe(submitted.plan.gasLimit);
    expect(tx.chainId).toBe('0x7a69');
    // The wallet was asked only to send (and checked for its chain and account right before): never on typing.
    expect(r.walletAsked).toEqual(['eth_chainId', 'eth_accounts', 'eth_sendTransaction']);
    // The amount is cleared after a confirmed trade; the receipt stays with its hash.
    expect((amount() as HTMLInputElement).value).toBe('');
    expect(within(box()).getByRole('list', { name: 'Transactions' }).textContent).toContain(`Buy confirmed: 0.01 ETH${hashOf(101).slice(0, 6)}`);
  });

  it('the quote expects the whole amount, the chain takes part: the row says so with the receipt’s figures, the rest paid back in ETH, nothing to revoke', async () => {
    const amountIn = ETHER / 100n;
    const r = rig({ filled: amountIn * 3n / 4n });
    show(r.target);
    type('0.01');
    expect(await within(box()).findByText(/^≈ /)).toBeTruthy();
    // The plan expects all of it to go in: no part-fill figure before the press.
    expect(text()).not.toContain('Fills ≈');
    fireEvent.click(await go('Buy'));
    const row = (await within(box()).findByText('Buy filled in part: 0.0075 of 0.01 ETH')).closest('li') as HTMLElement;
    // The receipt's own amounts, kept in the row as decimal strings.
    expect([row.dataset.fill, row.dataset.spent, row.dataset.offered]).toEqual(['part', (amountIn * 3n / 4n).toString(), amountIn.toString()]);
    // Native ETH has no approval to revoke: the box is ready for the next amount.
    expect(within(box()).queryByRole('button', { name: /^Revoke/ })).toBeNull();
    expect((amount() as HTMLInputElement).value).toBe('');
  });

  it('SH-274: a mined trade reads the page\'s wallet reads again: the shop\'s coin and the claims list (no reload needed)', async () => {
    const r = rig({ noEvents: true });
    const { client } = show(r.target);
    const coins = ['v2-shop-coins', 'local', 31337, TOKEN.toLowerCase(), null, null];
    const claims = ['v2-wallet-claims', 31337, '', null];
    client.setQueryData(coins, { balance: 0n, allowance: 0n });
    client.setQueryData(claims, []);
    expect([client.getQueryState(coins)?.isInvalidated, client.getQueryState(claims)?.isInvalidated]).toEqual([false, false]);
    type('0.01');
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed');
    await waitFor(() => expect([client.getQueryState(coins)?.isInvalidated, client.getQueryState(claims)?.isInvalidated]).toEqual([true, true]));
  });

  it('a receipt without the trade’s events: confirmed, with no figure claimed either way', async () => {
    const r = rig({ noEvents: true });
    show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    const row = (await within(box()).findByText('Buy confirmed')).closest('li') as HTMLElement;
    expect([row.dataset.fill, row.dataset.spent]).toEqual([undefined, undefined]);
  });
});

describe('the balance the box shows and checks: read at one named block, the plan’s own once there is one', () => {
  it('the plan’s block decides: a balance enough at the block named first, short at the plan’s, is short; the shown balance is the plan block’s', async () => {
    // The mined block named first (0x10) holds plenty; the block the plan is made at (0x12) holds less than the amount.
    const r = rig({ planBlock: 0x12n, balanceAt: (block) => (block === '0x12' ? ETHER / 200n : 100n * ETHER) });
    show(r.target);
    await waitFor(() => expect(text()).toContain('Balance 100 ETH'));
    expect(within(box()).queryByRole('link', { name: 'Test coins' })).toBeNull();
    type('0.01');
    await waitFor(() => expect(line()).toBe('Not enough balance.'));
    // SH-274: the line is followed by the way to the test coins, under the navigation's own label.
    const link = within(box()).getByRole('link', { name: 'Test coins' });
    expect(link.getAttribute('href')).toBe('/test-coins');
    expect(text()).toContain('Balance 0.005 ETH');
    expect(text()).not.toContain('Balance 100 ETH');
    // The plan was made (the named block passed), then refused at its own block: nothing to press.
    expect(spies.prepare).toHaveLength(1);
    expect(isDisabled(within(box()).getByRole('button', { name: 'Buy' }))).toBe(true);
    // Every balance read named its block; none read "latest".
    expect(r.chain.balanceBlocks).toEqual(['0x10', '0x10', '0x12']);
  });

  it('a new amount keeps the newest balance on show while its quote is prepared: never back to an older block’s', async () => {
    const r = rig({ planBlock: 0x12n, balanceAt: (block) => (block === '0x12' ? 50n * ETHER : 100n * ETHER) });
    show(r.target);
    await waitFor(() => expect(text()).toContain('Balance 100 ETH'));
    type('0.01');
    expect(await within(box()).findByText(/^≈ /)).toBeTruthy();
    expect(text()).toContain('Balance 50 ETH');
    // Every balance the box shows from here on.
    const shown: string[] = [];
    const observer = new MutationObserver(() => { const figure = /Balance [\d.,]+ ETH/.exec(text())?.[0]; if (figure) shown.push(figure); });
    observer.observe(box(), { subtree: true, childList: true, characterData: true });
    type('0.02');
    await waitFor(() => expect(spies.prepare).toHaveLength(2));
    expect(await within(box()).findByText(/^≈ /)).toBeTruthy();
    observer.disconnect();
    expect(text()).toContain('Balance 50 ETH');
    expect(shown.filter((figure) => figure !== 'Balance 50 ETH')).toEqual([]);
  });

  it('a quote shows the balance of its plan’s block, beside the plan’s figures', async () => {
    const r = rig({ planBlock: 0x12n, balanceAt: (block) => (block === '0x12' ? 50n * ETHER : 100n * ETHER) });
    show(r.target);
    await waitFor(() => expect(text()).toContain('Balance 100 ETH'));
    type('0.01');
    expect(await within(box()).findByText(/^≈ /)).toBeTruthy();
    expect(text()).toContain('Balance 50 ETH');
    expect(isDisabled(await go('Buy'))).toBe(false);
  });
});

describe('a read that fails once is tried again a moment later, at the same block', () => {
  /** Every line the box shows meanwhile. */
  const watchLines = () => {
    const seen: string[] = [];
    const observer = new MutationObserver(() => { const shown = line(); if (shown) seen.push(shown); });
    observer.observe(box(), { subtree: true, childList: true, characterData: true });
    return { seen, stop: () => observer.disconnect() };
  };

  it('the balance on its own: shown after the second try, at the block the first one named', async () => {
    const r = rig({ failBalance: [1] });
    show(r.target);
    await waitFor(() => expect(text()).toContain('Balance 100 ETH'), { timeout: 4_000 });
    expect(r.chain.balanceBlocks).toEqual(['0x10', '0x10']);
    expect(line()).toBeNull();
  });

  it('the quote’s read: the plan follows the second try, and the failure is never said', async () => {
    const r = rig({ failBalance: [2] });
    show(r.target);
    await waitFor(() => expect(text()).toContain('Balance 100 ETH'));
    const lines = watchLines();
    type('0.01');
    expect(await within(box()).findByText(/^≈ /, undefined, { timeout: 4_000 })).toBeTruthy();
    lines.stop();
    expect(lines.seen).toEqual([]);
    expect(r.chain.balanceBlocks).toEqual(['0x10', '0x10', '0x10']);
    expect(spies.prepare).toHaveLength(1);
  });

  it('a node that stays down: its line after the second try, and no balance at all, never zero', async () => {
    const r = rig({ failBalance: [1, 2, 3, 4, 5, 6] });
    show(r.target);
    type('0.01');
    await waitFor(() => expect(line()).toBe('The chain could not be read. Try again.'), { timeout: 4_000 });
    expect(text()).not.toContain('Balance');
    expect(spies.prepare).toEqual([]);
  });
});

describe('a window buy (F157 Q1): the launch tax in large type, through the router', () => {
  it('shows the current step’s tax and its end, and sends the router’s buy', async () => {
    const r = rig({ phase: 2 });
    show(r.target);
    type('0.01');
    expect(await within(box()).findByText(/^≈ /)).toBeTruthy();
    const tax = within(box()).getByText('93.20%');
    expect(tax.tagName).toBe('STRONG');
    expect(text()).toMatch(/Launch tax93\.20%until \d\d:\d\d:\d\d UTC/);
    expect(text()).not.toContain('Can fill in part');
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 ETH');
    const [tx] = r.sent as [Tx];
    expect(tx.to.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName).toBe('buy');
  });

  it('a window buy the curve’s end cut short: the router paid the rest back, and the row says it filled in part', async () => {
    const r = rig({ phase: 2, refund: ETHER / 250n });
    show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    const row = (await within(box()).findByText('Buy filled in part: 0.006 of 0.01 ETH')).closest('li') as HTMLElement;
    expect([row.dataset.spent, row.dataset.offered]).toEqual([(ETHER * 6n / 1000n).toString(), (ETHER / 100n).toString()]);
  });

  it('a reverted receipt shows the router’s reason as its line: below the minimum, said with the tolerance and what to do (SH-ONE-PRESS-TRADE)', async () => {
    const r = rig({ phase: 2, revert: encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'InsufficientOutput', args: [1n, 2n] }) });
    show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('Price moved over your 2% tolerance. Raise it or trade less.'));
    expect(within(box()).getByRole('list', { name: 'Transactions' }).textContent).toContain('Buy reverted: Price moved: below your minimum.');
  });
});

describe('an ERC-20 price coin: one press (the exact approval, a new plan, the trade), then the revocation of what is left', () => {
  it('one press approves exactly, makes the plan again and buys; then revokes the part a part fill left', async () => {
    const amountIn = ETHER / 100n;
    const r = rig({ p: COIN, left: amountIn / 4n });
    show(r.target, { p: COIN });
    type('0.01');
    // Before the press: the plan needs its approval, and shows what the buy gets all the same.
    const buy = await go('Buy');
    expect(within(box()).getByText(/^≈ /)).toBeTruthy();
    const before = spies.prepare.length;
    fireEvent.click(buy);
    // The chain took less: the row says so with the receipt's figures, and offers the revocation of the rest.
    await within(box()).findByText('Buy filled in part: 0.0075 of 0.01 tETH');
    const [approval] = r.sent as [Tx];
    expect(approval.to.toLowerCase()).toBe(COIN.toLowerCase());
    expect(decodeFunctionData({ abi: TRADE_ABI, data: approval.data }).args).toEqual([POOL, amountIn]);
    // An approve gets its own estimate, not a trade's 4M floor.
    expect(BigInt(approval.gas)).toBeLessThan(4_000_000n);
    // A new plan after the approval, at the block after it: the press's own, with nothing typed or pressed again.
    expect(spies.prepare.length).toBe(before + 1);
    expect((spies.submit[1] as TradeSubmitOptions).plan).not.toBe((spies.submit[0] as TradeSubmitOptions).plan);
    expect((spies.submit[1] as TradeSubmitOptions).plan.reason).toBeNull();
    fireEvent.click(await go('Revoke 0.0025 tETH'));
    await within(box()).findByText('Approval cleared confirmed');
    const revoke = r.sent[2] as Tx;
    expect(decodeFunctionData({ abi: TRADE_ABI, data: revoke.data }).args).toEqual([POOL, 0n]);
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve', 'swap', 'approve']);
  });

  it('a box trade under way when the box goes is followed on the test-coin page: generic words, its revocation through the trade guard (SH-ALPHA-TEST-COINS)', async () => {
    const amountIn = ETHER / 100n;
    const r = rig({ p: COIN, left: amountIn / 4n });
    const first = show(r.target, { p: COIN });
    type('0.01');
    // The wallet holds the buy (the press's second request) until the person answers.
    let confirm: () => void = () => undefined;
    r.chain.tradeGate = new Promise<void>((resolve) => { confirm = resolve; });
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(r.walletAsked.filter((method) => method === 'eth_sendTransaction')).toHaveLength(2));
    await waitFor(() => expect(within(box()).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy());
    first.unmount();
    // The test-coin page opens while the wallet still has the buy: its one send engine adopts it.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TestCoinPage target={{ chainId: 31337, rpc: r.rpc, localDeployment: undefined,
      teth: { address: COIN, symbol: 'tETH', decimals: 18 }, pairs: [{ address: TOKEN, symbol: 'tNVDA', decimals: 18 }], explorer: () => null }} /></QueryClientProvider>);
    const swap = screen.getByRole('region', { name: 'Swap' });
    await waitFor(() => expect(within(swap).getByRole('status').textContent).toBe('Confirm or reject it in your wallet.'));
    confirm();
    await waitFor(() => expect(r.sent).toHaveLength(2));
    fireEvent.click(within(swap).getByRole('button', { name: 'Check again' }));
    // A part fill, said as one; the coin page knows no figure for a box's coin, so the row has none either.
    await waitFor(() => expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Buy filled in part0x'));
    // The coin page knows no figure for a box's coin: the revocation without one, sent through the trade calls' guard.
    const revoke = await waitFor(() => within(swap).getByRole('button', { name: 'Revoke approval' }));
    const submits = spies.submit.length;
    fireEvent.click(revoke);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Approval cleared confirmed'));
    expect(spies.submit.length).toBe(submits + 1);
    expect(decodeFunctionData({ abi: TRADE_ABI, data: (r.sent[2] as Tx).data }).args).toEqual([POOL, 0n]);
    expect(inFlightOf(sendKey(31337, USER))).toBeNull();
  });

  it('a buy that fills the curve keeps its revocation and receipts under the Full line', async () => {
    const amountIn = ETHER / 100n;
    const r = rig({ p: COIN, left: amountIn / 2n });
    const view = show(r.target, { p: COIN });
    type('0.01');
    fireEvent.click(await go('Buy'));
    await go('Revoke 0.005 tETH');
    // The page's next snapshot has the curve full: trading closes, the revocation stays on offer.
    view.setView({ closedAt: NOW });
    expect(text()).toContain('Full. Trading resumes after graduation.');
    expect(within(box()).queryByRole('textbox')).toBeNull();
    fireEvent.click(await go('Revoke 0.005 tETH'));
    await within(box()).findByText('Approval cleared confirmed');
    expect(within(box()).queryByRole('button')).toBeNull();
    expect(within(box()).getByRole('list', { name: 'Transactions' }).textContent).toContain('Buy filled in part: 0.005 of 0.01 tETH');
  });

  it('an approval of another amount is reset to zero first, then the exact amount, then the buy: still one press', async () => {
    const r = rig({ p: COIN, allowance: 5n });
    show(r.target, { p: COIN });
    type('0.01');
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 tETH');
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data })).map((call) => [call.functionName, call.args[1]]))
      .toEqual([['approve', 0n], ['approve', ETHER / 100n], ['swap', expect.anything()]]);
    // A plan after each mined approval: the reset's, still needing the exact one, then the buy's.
    expect(spies.submit.map((options) => (options as TradeSubmitOptions).plan.reason)).toEqual(['approval_required', 'approval_required', null]);
  });

  it('a sale: one press approves the box token exactly, to PoolSwapTest, then sells', async () => {
    const r = rig();
    show(r.target);
    fireEvent.click(within(box()).getByRole('radio', { name: 'Sell' }));
    type('1000');
    fireEvent.click(await go('Sell'));
    // Sold whole: the row says what went in, in the box token's short figure.
    const row = (await within(box()).findByText('Sale confirmed: 1K ATETH')).closest('li') as HTMLElement;
    const [approval] = r.sent as [Tx];
    expect(approval.to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(decodeFunctionData({ abi: TRADE_ABI, data: approval.data }).args).toEqual([POOL, 1000n * ETHER]);
    expect([row.dataset.fill, row.dataset.spent]).toEqual(['whole', (1000n * ETHER).toString()]);
  });
});

/** The press's ticks, as [step, state] (Steps.tsx), or null when the box shows none. */
const ticks = () => {
  const list = within(box()).queryByRole('list', { name: 'Progress' });
  return list ? within(list).getAllByRole('listitem').map((item) => [item.dataset.step, item.dataset.state]) : null;
};
/** Every label the box's main button shows from now on. */
const watchLabels = () => {
  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    const label = box().querySelector('.sh-trade-box__go')?.textContent ?? '';
    if (label && seen.at(-1) !== label) seen.push(label);
  });
  observer.observe(box(), { subtree: true, childList: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
};
/** Moves the fixture pool's price by `ppm` millionths of its square root (another trade landing first), its tick with it. */
function movePool(f: ReturnType<typeof rig>['f'], ppm: bigint) {
  const word = f.storage[f.base] as bigint;
  const spot = word & ((1n << 160n) - 1n);
  const moved = spot * (1_000_000n + ppm) / 1_000_000n;
  f.storage[f.base] = moved | (BigInt.asUintN(24, BigInt(getTickAtSqrtPrice(moved))) << 160n) | (10000n << 208n);
}
const sends = (r: ReturnType<typeof rig>) => r.walletAsked.filter((method) => method === 'eth_sendTransaction').length;

describe('one press per trade (SH-ONE-PRESS-TRADE)', () => {
  it('an approval needed, the wallet Privy made: one press, two sends, no window; the ticks follow it to done', async () => {
    const r = rig({ p: COIN });
    (wallet.signer as { confirmsInPage?: true }).confirmsInPage = true;
    show(r.target, { p: COIN });
    type('0.01');
    const buy = await go('Buy');
    expect(ticks()).toBeNull();
    // The trade is held a moment, to see the press mid-way: the approval done, the buy under way.
    let release: () => void = () => undefined;
    r.chain.tradeGate = new Promise<void>((resolve) => { release = resolve; });
    const labels = watchLabels();
    fireEvent.click(buy);
    await waitFor(() => expect(sends(r)).toBe(2));
    await waitFor(() => expect(ticks()).toEqual([['approve', 'done'], ['trade', 'active']]));
    expect(within(box()).getByRole('button', { name: 'Signing…' })).toBeTruthy();
    release();
    await within(box()).findByText('Buy confirmed: 0.01 tETH');
    labels.stop();
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'done']]);
    // One press: the approval and the buy, with the made wallet's own label; never an "Approve" button, and nothing
    // asked of the wallet but the sends and their checks.
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve', 'swap']);
    expect(labels.seen).toContain('Signing…');
    expect(labels.seen.filter((label) => /^Approve|^Reset/.test(label))).toEqual([]);
    expect([...new Set(r.walletAsked)].sort()).toEqual(['eth_accounts', 'eth_chainId', 'eth_sendTransaction']);
    // The ticks stay until the next amount.
    type('0.02');
    expect(ticks()).toBeNull();
  });

  it('the plan made again after the approval fails for a moment: the press checks the price again quietly and goes on', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    // The node the press asks right after the approval lacks the block another just named (publicnode's -32001).
    r.chain.onApprove = () => { r.chain.failPlans = 1; };
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(within(box()).getByRole('button', { name: 'Checking the price…' })).toBeTruthy());
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'active']]);
    expect(line()).toBeNull();
    await within(box()).findByText('Buy confirmed: 0.01 tETH', undefined, { timeout: 6_000 });
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve', 'swap']);
  });

  it('no approval needed (it is already exact): one press, one send, no ticks', async () => {
    const amountIn = ETHER / 100n;
    const r = rig({ p: COIN, allowance: amountIn });
    show(r.target, { p: COIN });
    type('0.01');
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 tETH');
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['swap']);
    expect(ticks()).toBeNull();
  });

  it('the plan made after the approval is past the person’s tolerance: no buy is sent; the new quote shows with its line and its own press', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    const buy = await go('Buy');
    const shown = within(box()).getByText(/^≈ /).textContent;
    // Another buyer lands right after the approval: the pool's price is 6% lower when the press makes its plan again.
    r.chain.onApprove = () => movePool(r.f, -30_000n);
    fireEvent.click(buy);
    await waitFor(() => expect(line()).toBe('Price moved over your 2% tolerance. Check the new quote.'));
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve']);
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'stopped']]);
    // The new quote, lower, with its own press: that press sends the buy the person now sees, and only that.
    const again = await go('Buy');
    const now = within(box()).getByText(/^≈ /).textContent;
    expect(now).not.toBe(shown);
    fireEvent.click(again);
    await within(box()).findByText('Buy confirmed: 0.01 tETH');
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve', 'swap']);
    const sentPlan = (spies.submit.at(-1) as TradeSubmitOptions).plan;
    expect(sentPlan.reason).toBeNull();
    expect(ticks()).toBeNull();
  });

  it('a move within the tolerance does not stop the press', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    // A smaller move (0.5% of the square root: about 1% of the price) stays within 2%.
    r.chain.onApprove = () => movePool(r.f, -5_000n);
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 tETH');
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve', 'swap']);
  });

  it('a browser wallet: one press, and the wallet asks twice; the second request comes by itself once the approval is mined', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    let confirmApproval: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirmApproval = resolve; });
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(sends(r)).toBe(1));
    expect(within(box()).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy();
    expect(ticks()).toEqual([['approve', 'active'], ['trade', 'waiting']]);
    // The person confirms the approval in the wallet; the box asks for nothing more of the page.
    let confirmBuy: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirmBuy = resolve; });
    confirmApproval();
    await waitFor(() => expect(sends(r)).toBe(2));
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'active']]);
    expect(within(box()).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy();
    confirmBuy();
    await within(box()).findByText('Buy confirmed: 0.01 tETH');
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'done']]);
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve', 'swap']);
  });

  it('the in-flight rule: a press holds the account’s one slot; a box opened meanwhile follows its send, and a press whose box has gone sends no trade', async () => {
    const r = rig({ p: COIN });
    const first = show(r.target, { p: COIN });
    type('0.01');
    let confirm: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirm = resolve; });
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(inFlightOf(sendKey(31337, USER))?.asking).toBe(true));
    first.unmount();
    // The box is opened again while the wallet still has the approval: it follows that send and prepares nothing.
    show(r.target, { p: COIN });
    await waitFor(() => expect(line()).toBe('Confirm or reject it in your wallet.'));
    const prepared = spies.prepare.length;
    type('0.01');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(spies.prepare.length).toBe(prepared);
    confirm();
    await waitFor(() => expect(r.sent).toHaveLength(1));
    fireEvent.click(await go('Check again'));
    await waitFor(() => expect(within(box()).getByRole('list', { name: 'Transactions' }).textContent).toContain('Approval confirmed'));
    // The gone box's press stopped there: no buy was sent that this box did not show. Its own quote now needs no
    // approval, and its press sends the buy alone.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve']);
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 tETH');
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve', 'swap']);
    expect(inFlightOf(sendKey(31337, USER))).toBeNull();
  });

  it('a buy that lands after the price passed its limit: the decoded revert says the tolerance and what to do', async () => {
    const amountIn = ETHER / 100n;
    const r = rig({ p: COIN, left: amountIn, revert: encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'PriceLimitAlreadyExceeded', args: [2n, 1n] }) });
    show(r.target, { p: COIN });
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('Price moved over your 2% tolerance. Raise it or trade less.'));
    expect(within(box()).getByRole('list', { name: 'Transactions' }).textContent).toContain('Buy reverted: Price already past your limit.');
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'stopped']]);
    // What the reverted buy left approved is offered back, as after any trade.
    expect(await go('Revoke 0.01 tETH')).toBeTruthy();
  });

  it('a plan that fails for a moment (a read the RPC did not answer) is made again quietly: the quote shows, no line was said', async () => {
    const r = rig({ failPlans: 1 });
    show(r.target);
    const seen: string[] = [];
    const observer = new MutationObserver(() => { const shown = line(); if (shown) seen.push(shown); });
    observer.observe(box(), { subtree: true, childList: true, characterData: true });
    type('0.01');
    expect(await within(box()).findByText(/^≈ /, undefined, { timeout: 6_000 })).toBeTruthy();
    observer.disconnect();
    expect(seen).toEqual([]);
    expect(r.chain.failPlans).toBe(0);
    expect(spies.prepare).toHaveLength(2);
  });

  it('two plans failing in a row: the second failure is said', async () => {
    const r = rig({ failPlans: 2 });
    show(r.target);
    type('0.01');
    await waitFor(() => expect(line()).toBe('The chain could not be read. Try again.'), { timeout: 6_000 });
    expect(spies.prepare).toHaveLength(2);
    expect(isDisabled(within(box()).getByRole('button', { name: 'Buy' }))).toBe(true);
  });
});

describe('af1: what the press keeps to, and where it stops (review wf_a701d0c3-b4d)', () => {
  const calls = (r: ReturnType<typeof rig>) => r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }));
  const swapLimit = (tx: Tx) => { const d = decodeFunctionData({ abi: TRADE_ABI, data: tx.data }); if (d.functionName !== 'swap') throw new Error('swap'); return d.args[1].sqrtPriceLimitX96; };
  const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

  it('the sent buy carries the pressed quote\'s price limit, where the plan made after the approval would have had a looser one', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    // Another buyer moves the price against this one, within the tolerance, while its approval is mined.
    r.chain.onApprove = () => movePool(r.f, -4_000n);
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 tETH');
    const pressed = (spies.submit[0] as TradeSubmitOptions).plan;
    expect(pressed.reason).toBe('approval_required');
    const sentLimit = swapLimit(r.sent[1] as Tx);
    expect(sentLimit).toBe(pressed.priceLimitX96);
    // The same plan made without the pressed bound, at the moved price: its own limit is lower, so looser for a buy.
    const own = await prepareTradeSepolia({ rpc: r.target.rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: 'buy', amountIn: ETHER / 100n, localDeployment: LOCAL });
    if (!own.ok) throw new Error(own.reason);
    expect(own.plan.priceLimitX96 as bigint).toBeLessThan(sentLimit);
  });

  it('the launch window ends while the approval is mined: no second approval, no pool trade; the new quote with its line', async () => {
    const r = rig({ phase: 2, p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    r.chain.onApprove = () => { r.f.state.phase = 3; };
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('The trade changed meanwhile. Check the new quote.'));
    await wait(300);
    // One send only: the approval to the launch router the person pressed for.
    expect(calls(r).map((c) => [c.functionName, c.args[0]])).toEqual([['approve', ROUTER]]);
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'stopped']]);
    // The new quote is the pool's: its warning shows, and its own press would send it.
    expect(text()).toContain('Can fill in part; no deadline.');
  });

  it('a node behind the approval\'s block: the plan is asked for again, never a second approval; then the buy', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    r.chain.onApprove = () => { r.chain.lagPlans = 1; };
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 tETH', undefined, { timeout: 6_000 });
    expect(calls(r).map((c) => c.functionName)).toEqual(['approve', 'swap']);
  });

  it('a node that stays behind: the press stops with its line after a few tries, no second approval and no buy', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    r.chain.onApprove = () => { r.chain.lagPlans = 99; };
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('The chain has not caught up yet. Press again.'), { timeout: 12_000 });
    expect(calls(r).map((c) => c.functionName)).toEqual(['approve']);
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'stopped']]);
    r.chain.lagPlans = 0;
  }, shLimit(16_000));

  it('a node showing the mined approval still pending: asked again once, then the buy', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    r.chain.onApprove = () => { r.chain.pendingOnce = true; };
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 tETH', undefined, { timeout: 6_000 });
    expect(line()).toBeNull();
  });

  it('the approval changed from outside after the exact one was mined: no further approval, the press stops', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    r.chain.onApprove = () => { r.f.state.allowance = 7n; };
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('The approval changed. Press again.'));
    await wait(300);
    expect(calls(r).map((c) => [c.functionName, c.args[1]])).toEqual([['approve', ETHER / 100n]]);
  });

  it('the plan made again fails twice: the press stops with its line and sends no buy', async () => {
    const r = rig({ p: COIN });
    show(r.target, { p: COIN });
    type('0.01');
    r.chain.onApprove = () => { r.chain.failPlans = 2; };
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('The chain could not be read. Try again.'), { timeout: 6_000 });
    expect(calls(r).map((c) => c.functionName)).toEqual(['approve']);
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'stopped']]);
  });

  it('the box\'s read goes stale during the press and stays so: no buy, a line that says why', async () => {
    const r = rig({ p: COIN });
    const view = show(r.target, { p: COIN });
    type('0.01');
    let confirm: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirm = resolve; });
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(sends(r)).toBe(1));
    view.setDisabled(true);
    r.chain.walletGate = null;
    confirm();
    // The press waits for the read (READ_WAIT_MS, 5 s), then stops; while stale the box shows its own line only.
    await waitFor(() => expect(ticks()).toEqual([['approve', 'done'], ['trade', 'stopped']]), { timeout: 9_000 });
    expect(text()).toContain('Waits for a current verified read.');
    expect(calls(r).map((c) => c.functionName)).toEqual(['approve']);
    view.setDisabled(false);
    expect(line()).toBe('The page is reading the box again. Press again.');
  }, shLimit(14_000));

  it('the box\'s read is current again within moments: the press goes on to its buy', async () => {
    const r = rig({ p: COIN });
    const view = show(r.target, { p: COIN });
    type('0.01');
    let confirm: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirm = resolve; });
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(sends(r)).toBe(1));
    view.setDisabled(true);
    r.chain.walletGate = null;
    confirm();
    await wait(1_000);
    view.setDisabled(false);
    await within(box()).findByText('Buy confirmed: 0.01 tETH', undefined, { timeout: 6_000 });
  }, shLimit(12_000));

  it('the wallet changes account during the press: no buy from the new account, the line says so', async () => {
    const r = rig({ p: COIN });
    const view = show(r.target, { p: COIN });
    type('0.01');
    let confirm: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirm = resolve; });
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(sends(r)).toBe(1));
    wallet.account = '0x0000000000000000000000000000000000000071';
    view.setDisabled(false);
    r.chain.walletGate = null;
    confirm();
    await waitFor(() => expect(line()).toBe('Your wallet account changed.'));
    await wait(300);
    expect(calls(r).map((c) => c.functionName)).toEqual(['approve']);
  });

  it('an approval whose receipt comes late: its tick waits, not stopped, and turns done when the chain shows it', async () => {
    const r = rig({ p: COIN, hold: true });
    show(r.target, { p: COIN, receiptTimeoutMs: 50 });
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('Not confirmed yet. Check your wallet.'), { timeout: 4_000 });
    expect(ticks()).toEqual([['approve', 'active'], ['trade', 'waiting']]);
    r.release();
    fireEvent.click(await go('Check again'));
    await waitFor(() => expect(ticks()).toEqual([['approve', 'done'], ['trade', 'waiting']]));
    expect(calls(r).map((c) => c.functionName)).toEqual(['approve']);
  });
});

describe('what stops a trade, each as its one line', () => {
  it('a decline sends nothing and prepares a new plan (a plan is single-use)', async () => {
    const r = rig({ send: 'decline' });
    show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('Declined in your wallet.'));
    expect(r.sent).toEqual([]);
    const before = spies.prepare.length;
    await waitFor(() => expect(spies.prepare.length).toBeGreaterThan(before));
    r.chain.send = 'hash';
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 ETH');
    // The second send is a new plan's, never the declined one again.
    expect((spies.submit[1] as TradeSubmitOptions).plan).not.toBe((spies.submit[0] as TradeSubmitOptions).plan);
  });

  it('an unclear wallet error after the transaction went out: no new plan until the account’s nonce settles it', async () => {
    const r = rig({ send: 'unclear' });
    show(r.target, { quiet: { reads: 2, ms: 0 } });
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('Your wallet returned an error. Check it before trying again.'));
    const prepared = spies.prepare.length;
    // Unsettled: no new plan, however long it waits for the person.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    expect(spies.prepare.length).toBe(prepared);
    // One look is not enough to settle a send without a hash: the quiet period holds it.
    fireEvent.click(await go('Check again'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(within(box()).getByRole('button', { name: 'Check again' })).toBeTruthy();
    fireEvent.click(await go('Check again'));
    // The nonce moved on and nothing is pending: it went out. Only now a new plan, and the box is free again.
    await waitFor(() => expect(line()).toBe('A transaction went out. See your wallet.'));
    await waitFor(() => expect(spies.prepare.length).toBeGreaterThan(prepared));
    expect(isDisabled(await go('Buy'))).toBe(false);
    expect(r.sent).toHaveLength(1);
  });

  it('an unclear wallet error before anything went out: Check again right away keeps the box held for the quiet period', async () => {
    const r = rig({ send: 'unclear-unsent' });
    show(r.target, { quiet: { reads: 3, ms: 0 } });
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('Your wallet returned an error. Check it before trying again.'));
    const prepared = spies.prepare.length;
    for (const look of [1, 2]) {
      fireEvent.click(await go('Check again'));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
      expect(within(box()).getByRole('button', { name: 'Check again' }), `look ${look}`).toBeTruthy();
      expect(spies.prepare.length).toBe(prepared);
    }
    fireEvent.click(await go('Check again'));
    await waitFor(() => expect(line()).toBe('Nothing was sent. Try again.'));
    await waitFor(() => expect(spies.prepare.length).toBeGreaterThan(prepared));
    expect(r.sent).toEqual([]);
  });

  it('two presses of Check again at once make one look', async () => {
    const r = rig({ send: 'unclear-unsent' });
    show(r.target, { quiet: { reads: 5, ms: 0 } });
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('Your wallet returned an error. Check it before trying again.'));
    const before = r.asked.filter((method) => method === 'eth_getTransactionCount').length;
    const button = await go('Check again');
    fireEvent.click(button); fireEvent.click(button);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    // One look reads the two nonces (mined and pending) once.
    expect(r.asked.filter((method) => method === 'eth_getTransactionCount').length - before).toBe(2);
  });

  it('a failed receipt read is read again, never taken for a replaced transaction', async () => {
    const r = rig({ failReceipts: 2 });
    show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    await within(box()).findByText('Buy confirmed: 0.01 ETH', undefined, { timeout: 6_000 });
    expect(line()).toBeNull();
  });

  it('a speed-up in the wallet (another hash mined at the nonce) is a replacement, said as its line', async () => {
    const r = rig({ send: 'speed-up' });
    show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('Replaced or cancelled in your wallet.'), { timeout: 4_000 });
    expect(within(box()).getByRole('list', { name: 'Transactions' }).textContent).toContain('Buy replaced');
    expect(isDisabled(await go('Buy'))).toBe(false);
  });

  it('the account’s nonces unread before a send: the wallet is not asked (fail closed)', async () => {
    // A quote reads the nonces twice (mined, pending); the third read is the one before the send.
    const r = rig({ failNoncesFrom: 3 });
    show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(line()).toBe('The chain could not be read. Try again.'));
    expect(r.walletAsked).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it('something already pending for the account holds the plan until it clears', async () => {
    const r = rig({ stuck: true });
    show(r.target);
    type('0.01');
    await waitFor(() => expect(line()).toBe('An earlier transaction is still under way.'));
    expect(spies.prepare).toEqual([]);
    expect(isDisabled(within(box()).getByRole('button', { name: 'Buy' }))).toBe(true);
    // It is mined: the next look (a few seconds on) prepares the plan.
    r.chain.nonce = r.chain.pending;
    await waitFor(() => expect(spies.prepare.length).toBe(1), { timeout: 8_000 });
    expect(isDisabled(await go('Buy'))).toBe(false);
  }, shLimit(12_000));

  it('a send survives the box going away: the next box opened follows it and holds new plans', async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const r = rig({ gate });
    const first = show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(within(box()).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy());
    first.unmount();
    // The page is opened again while the wallet still has the request.
    show(r.target);
    await waitFor(() => expect(line()).toBe('Confirm or reject it in your wallet.'));
    const prepared = spies.prepare.length;
    type('0.02');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(spies.prepare.length).toBe(prepared);
    // The person confirms in the wallet: the first box (gone) hands the hash on; this box follows it to its receipt.
    open();
    await waitFor(() => expect(r.sent).toHaveLength(1));
    fireEvent.click(await go('Check again'));
    await waitFor(() => expect(within(box()).getByRole('list', { name: 'Transactions' }).textContent).toContain('Buy confirmed: 0.01 ETH'));
    // Settled: the slot is free, the amount cleared as after any confirmed trade, and a new amount gets a new plan.
    expect((amount() as HTMLInputElement).value).toBe('');
    type('0.02');
    await waitFor(() => expect(spies.prepare.length).toBeGreaterThan(prepared));
    expect(r.sent).toHaveLength(1);
  });

  it('a box gone mid-look touches nothing: the next box’s later send keeps the account’s slot', async () => {
    const r = rig({ hold: true });
    const first = show(r.target);
    type('0.01');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(within(box()).getByRole('button', { name: 'Waiting for the chain…' })).toBeTruthy());
    // The first box's next look stops at its receipt read (a slow node); reads after it pass. Then the chain mines the
    // buy and the first box goes away mid-look.
    let answer: () => void = () => undefined;
    r.chain.receiptGate = new Promise<void>((resolve) => { answer = resolve; });
    await waitFor(() => expect(r.chain.blockedReceipts).toBe(1), { timeout: 4_000 });
    r.chain.receiptGate = null;
    r.release();
    first.unmount();
    // The next box opened settles the buy, then sends another, which the wallet holds.
    show(r.target);
    fireEvent.click(await go('Check again'));
    await within(box()).findByText('Buy confirmed: 0.01 ETH');
    let confirm: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirm = resolve; });
    type('0.02');
    fireEvent.click(await go('Buy'));
    await waitFor(() => expect(within(box()).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy());
    const later = inFlightOf(sendKey(31337, USER));
    expect(later?.asking).toBe(true);
    // The gone box's look comes back with the first buy's receipt: it neither settles nor frees anything.
    answer();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(inFlightOf(sendKey(31337, USER))).toBe(later);
    // The later send goes on in this box to its own receipt, and only then frees the slot.
    confirm();
    await waitFor(() => expect(r.sent).toHaveLength(2));
    r.release();
    await waitFor(() => expect(within(box()).getAllByText(/^Buy confirmed: 0\.0[12] ETH$/)).toHaveLength(2), { timeout: 4_000 });
    expect(inFlightOf(sendKey(31337, USER))).toBeNull();
  });

  it('a receipt that does not come: the box says so and waits for it (by hash, then by nonce) before a new plan', async () => {
    const r = rig({ hold: true });
    show(r.target, { receiptTimeoutMs: 50 });
    type('0.01');
    fireEvent.click(await go('Buy'));
    // The receipt is asked for once more after the 50 ms limit (its poll is 1.5 s), then the box says so.
    await waitFor(() => expect(line()).toBe('Not confirmed yet. Check your wallet.'), { timeout: 4_000 });
    const prepared = spies.prepare.length;
    // The hash is known and still pending (the mined nonce has not moved on): Check again keeps waiting, no new plan.
    fireEvent.click(await go('Check again'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(within(box()).getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(spies.prepare.length).toBe(prepared);
    // Mined after all: its receipt settles it.
    r.release();
    fireEvent.click(await go('Check again'));
    await within(box()).findByText('Buy confirmed: 0.01 ETH');
    expect(r.sent).toHaveLength(1);
  });

  it('a wallet on another network: Switch network, and nothing is sent', async () => {
    const r = rig();
    wallet.chainId = 1;
    const switched: number[] = [];
    wallet.switchChain = async (chainId) => { switched.push(chainId); };
    show(r.target);
    type('0.01');
    fireEvent.click(await go('Switch network'));
    expect(switched).toEqual([31337]);
    expect(r.sent).toEqual([]);
  });

  it('a plan the chain refuses (a full curve) shows its reason', async () => {
    const r = rig({ phase: 4 });
    show(r.target);
    type('0.01');
    await waitFor(() => expect(line()).toBe('Full. Trading resumes after graduation.'));
    expect(isDisabled(within(box()).getByRole('button', { name: 'Buy' }))).toBe(true);
  });

  it('more than the balance: no plan, one line', async () => {
    const r = rig({ balance: ETHER / 1000n });
    show(r.target);
    type('0.01');
    await waitFor(() => expect(line()).toBe('Not enough balance.'));
    expect(spies.prepare).toEqual([]);
  });

  it('typing that is not an amount', async () => {
    const r = rig();
    show(r.target);
    type('abc');
    expect(line()).toBe('Enter a number.');
    type('0.0000000000000000001');
    expect(line()).toBe('Too many decimals for this coin.');
    // Only the balance, at a mined block named first.
    await waitFor(() => expect(r.asked).toEqual(['eth_blockNumber', 'eth_getBalance']));
    expect(r.chain.balanceBlocks).toEqual(['0x10']);
  });
});
