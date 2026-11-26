import { claimLine } from '../alpha-sepolia/alpha-words';
/**
 * F156 (SH-ALPHA-TEST-COINS): the test-coin page through the coin calls' real reads, plans and guarded send
 * (`readCoinStateSepolia`, `prepareFaucetSepolia`, `preparePairSwapSepolia`, `submitCoinWriteSepolia` and the one
 * checked sender), over a block-pinned RPC double modelled on the coin calls' own (packages/chain/src/trade-sepolia/
 * coin.test.ts `coinFixture`: the same pool storage and v4 replay), and a wallet double that mines what it is asked.
 * Only the wallet context and the data source are mocked; the four coin calls are wrapped to record what they get.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi, toHex, zeroAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import type { Eip1193Request } from '@squarehole/chain/write';
import { preparePairSwapSepolia as preparePair, TRADE_ABI, TRADE_ERRORS, type CoinOptions, type CoinSubmitOptions, type PairSwapOptions } from '@squarehole/chain/trade-sepolia';
import { CODE, MANAGER, POOL, USER } from '../../../../../packages/chain/src/trade-sepolia/test-support';
import { getTickAtSqrtPrice } from '../../../../../packages/box-spec/src/v4-math';
import { simulatePoolSwap } from '../../../../../packages/chain/src/trade-sepolia/pool';
import { poolManagerAbi } from '../../../../../packages/chain/src/abi/poolManager';
import type { ClaimState } from '../alpha-sepolia/alpha-api';
import type { BoxRecord } from '../boxes/box-model';
import type { V2Snapshot, V2Source } from '../core/v2/indexer-v2';
import type { CoinTarget } from './coin-target';
import { COMING_AFTER_SENT_MS, DRIP, QUOTE_DEBOUNCE_MS, TestCoinPage } from './TestCoinPage';
import { QUIET_RETRY_MS } from './one-press';
import { TradeBox } from './TradeBox';
import { clearInFlight, inFlightOf, sendKey } from './trade-inflight';
import { NOT_ON_LIST_LINE, tradeLine } from './trade-words';

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
vi.mock('../data-source', () => ({ useDataSource: () => ({ id: 'local' }) }));
const spies = vi.hoisted(() => ({ state: [] as unknown[], faucet: [] as unknown[], pair: [] as unknown[], submit: [] as unknown[] }));
vi.mock('@squarehole/chain/trade-sepolia', async (original) => {
  const real = await original<typeof import('@squarehole/chain/trade-sepolia')>();
  return {
    ...real,
    readCoinStateSepolia: (options: CoinOptions & { blockNumber: bigint }) => { spies.state.push(options); return real.readCoinStateSepolia(options); },
    prepareFaucetSepolia: (options: CoinOptions) => { spies.faucet.push(options); return real.prepareFaucetSepolia(options); },
    preparePairSwapSepolia: (options: PairSwapOptions) => { spies.pair.push(options); return real.preparePairSwapSepolia(options); },
    submitCoinWriteSepolia: (options: CoinSubmitOptions) => { spies.submit.push(options); return real.submitCoinWriteSepolia(options); },
  };
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  clearInFlight();
  for (const list of Object.values(spies)) list.length = 0;
  wallet.status = 'connected'; wallet.kind = 'injected'; wallet.account = USER; wallet.chainId = 31337;
  wallet.switchChain = async () => undefined;
});

const ETHER = 10n ** 18n;
const Q96 = 1n << 96n;
const NOW = 1_790_000_000n;
const TETH = '0x0000000000000000000000000000000000000011' as Address;
const PAIRS = '0x0000000000000000000000000000000000000012' as Address;
/** The pair coin with a pool in the double: 18 decimals, priced 1:1 against tETH (the coin calls' fixture's pool). */
const NVDA = '0x0000000000000000000000000000000000000060' as Address;
const GOLD = '0x0000000000000000000000000000000000000061' as Address;
const ABI = parseAbi(['function open() view returns (bool)', 'function admitted(address) view returns (bool)',
  'function nextDripAt(address) view returns (uint256)', 'function dailyRemaining() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function drip()', 'function manager() view returns (address)']);
/** The PoolManager's Swap for a PoolSwapTest swap, encoded with its own ABI: the swapper's delta, negative for what it paid in. */
function swapLog(key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, amount0: bigint, amount1: bigint) {
  const event = (poolManagerAbi as Abi).find((item): item is AbiEvent => item.type === 'event' && item.name === 'Swap');
  if (!event) throw new Error('no Swap event');
  const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  return { address: MANAGER, topics: encodeEventTopics({ abi: [event], eventName: 'Swap', args: { id, sender: POOL } } as never) as Hex[],
    data: encodeAbiParameters(event.inputs.filter((input) => !input.indexed), [amount0, amount1, Q96, 1n, 0, 3000]) };
}
const pairRow = (coin: Address, symbol: string) => ({ coin, symbol, decimals: 18, fee: '3000', tickSpacing: 60, hooks: zeroAddress, tickLower: -887220, tickUpper: 887220 });
const recordOf = (pairs = [pairRow(NVDA, 'tNVDA')]) => ({ chainId: 31337, status: 'deployed', teth: { address: TETH, codeHash: keccak256(CODE) },
  pairHelper: { address: PAIRS, codeHash: keccak256(CODE) }, poolSwapTest: POOL, poolManager: MANAGER, poolSwapTestCodeHash: keccak256(CODE), pairs });

interface ChainOptions {
  readonly open?: boolean;
  readonly admitted?: boolean;
  readonly nextDripAt?: bigint;
  readonly dailyRemaining?: bigint;
  /** What a swap leaves approved (a part fill), of its exact approval. */
  readonly left?: bigint;
  readonly pairs?: ReturnType<typeof pairRow>[];
  /** Every read fails (the node does not answer). */
  readonly down?: boolean;
  /** Something of the account's is already pending (a stuck transaction): pending runs one ahead of mined. */
  readonly stuck?: boolean;
  /** The wallet declines the next send. */
  readonly decline?: boolean;
  /** The first block asked for is not there yet (a node behind the one that named it). */
  readonly lagging?: boolean;
  /** The account's SepETH (1 ETH unless said), and the chain's gas price (1 gwei; null: the node does not answer it). */
  readonly sepEth?: bigint;
  readonly gasPrice?: bigint | null;
  /** The wallet's node refuses the next send for its cost, in these words. */
  readonly lacksFunds?: string;
}

/** The chain the page reads (the coin calls' double plus nonces and receipts) and a wallet that mines what it sends. */
function rig(options: ChainOptions = {}) {
  const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [TETH, NVDA, 3000, 60, zeroAddress]));
  const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, 6n]));
  const storage: Record<string, bigint> = { [base]: Q96 | (3000n << 208n), [toHex(BigInt(base) + 3n, { size: 32 })]: 1000n * ETHER };
  for (let word = -58; word <= 57; word++) storage[keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'uint256' }], [BigInt(word), BigInt(base) + 5n]))] = 0n;
  const load = async (slot: Hex) => { const value = storage[slot]; if (value === undefined) throw new Error(`no slot ${slot}`); return value; };
  const chain = {
    open: options.open ?? false, admitted: options.admitted ?? true, nextDripAt: options.nextDripAt ?? 0n, dailyRemaining: options.dailyRemaining ?? 498n * ETHER,
    balances: new Map<string, bigint>([[TETH.toLowerCase(), 50n * ETHER], [NVDA.toLowerCase(), 7n * ETHER], [GOLD.toLowerCase(), 0n]]),
    allowances: new Map<string, bigint>(), nonce: 0n, receipts: new Map<string, '0x1' | '0x0'>(), stuck: options.stuck ?? false, decline: options.decline ?? false,
    /** Each mined swap's events, by hash. */
    logs: new Map<string, ReturnType<typeof swapLog>[]>(),
    /** Sends that reach the wallet while this is set wait for it (the person has not answered yet). */
    walletGate: null as Promise<void> | null, lagging: options.lagging ?? false,
    /** The same for every send but an approval (a browser wallet's second window, SH-ONE-PRESS-TRADE). */
    tradeGate: null as Promise<void> | null,
    /** Runs once an approval is mined (another swap moving the pool meanwhile). */
    onApprove: null as (() => void) | null,
    /** Plans that fail this many times first, as a public RPC's read of a block it does not have yet (item 2). */
    failPlans: 0,
    /** A swap the chain reverts with this error (its call run again at its block says it). */
    revertSwap: null as Hex | null,
    /** The calldata of the swap the chain reverted, whose call run again at its block reverts the same way. */
    revertedData: null as Hex | null,
    /** The chain's head: 0x10, then 0x11 once a send is mined (receipts are at 0x11). */
    head: 0x10n,
    sepEth: options.sepEth ?? ETHER, gasPrice: options.gasPrice === undefined ? 10n ** 9n : options.gasPrice, lacksFunds: options.lacksFunds ?? null as string | null,
  };
  const asked: string[] = [];
  const blocksAsked: unknown[] = [];
  const rpc: Eip1193Request = async (request) => {
    const method = request.method;
    const params = (request.params ?? []) as readonly unknown[];
    asked.push(method);
    if (options.down) throw new Error('the node did not answer');
    if (method === 'eth_chainId') return toHex(31337);
    if (method === 'eth_blockNumber') return toHex(chain.head);
    if (method === 'eth_getBlockByNumber') {
      if (chain.lagging) { chain.lagging = false; return null; }
      return { number: params[0] === 'latest' ? toHex(chain.head) : params[0], hash: `0x${'ab'.repeat(32)}`, timestamp: toHex(NOW), baseFeePerGas: '0x1', transactions: [] };
    }
    // SH-SEND-FEES: the sender's tip read (below the floor, so each send offers 0.01 gwei).
    if (method === 'eth_maxPriorityFeePerGas') return '0x1';
    if (method === 'eth_getCode') return CODE;
    if (method === 'eth_estimateGas') return toHex(476_738n);
    if (method === 'eth_getBalance') return toHex(chain.sepEth);
    if (method === 'eth_gasPrice') {
      if (chain.gasPrice === null) throw new Error('no gas price');
      return toHex(chain.gasPrice);
    }
    if (method === 'eth_getTransactionCount') return toHex(params[1] === 'pending' && chain.stuck ? chain.nonce + 1n : chain.nonce);
    if (method === 'eth_getTransactionReceipt') {
      const status = chain.receipts.get(String(params[0]));
      const logs = (chain.logs.get(String(params[0])) ?? []).map((log, i) => ({ ...log, logIndex: toHex(i), blockHash: `0x${'ab'.repeat(32)}`, blockNumber: '0x11', transactionHash: params[0] }));
      return status ? { transactionHash: params[0], blockHash: `0x${'ab'.repeat(32)}`, blockNumber: '0x11', status, from: USER, to: POOL, gasUsed: '0x5208', effectiveGasPrice: '0x1', logs } : null;
    }
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
    const [call, block] = params as [{ to: Address; data: Hex }, string];
    blocksAsked.push(block);
    const decoded = decodeFunctionData({ abi: [...ABI, ...TRADE_ABI], data: call.data });
    let result: unknown;
    // A node behind the one that named the block, as publicnode answers (SH-ONE-PRESS-TRADE item 2): only plans read the pool.
    if (decoded.functionName === 'extsload' && chain.failPlans > 0) { chain.failPlans -= 1; throw Object.assign(new Error('block not found: 0x10'), { code: -32001 }); }
    if (decoded.functionName === 'extsload') result = toHex(await load(decoded.args[0] as Hex), { size: 32 });
    else if (decoded.functionName === 'swap') {
      // A mined swap's revert, its call run again at its block (trade-run.ts `revertReasonOf`).
      if (block === '0x11' && chain.revertSwap && call.data === chain.revertedData) throw Object.assign(new Error('execution reverted'), { code: 3, data: chain.revertSwap });
      const [, p] = decoded.args as unknown as [unknown, { zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint }];
      const q = await simulatePoolSwap(load, base, p.zeroForOne, -p.amountSpecified, p.sqrtPriceLimitX96, 3000n);
      const d0 = p.zeroForOne ? -q.input : q.output;
      const d1 = p.zeroForOne ? q.output : -q.input;
      result = BigInt.asIntN(256, BigInt.asUintN(128, d0) << 128n | BigInt.asUintN(128, d1));
    } else if (decoded.functionName === 'drip') return '0x';
    else if (decoded.functionName === 'manager') result = MANAGER;
    else if (decoded.functionName === 'balanceOf') result = chain.balances.get(call.to.toLowerCase()) ?? 0n;
    else if (decoded.functionName === 'allowance') result = chain.allowances.get(call.to.toLowerCase()) ?? 0n;
    else if (decoded.functionName === 'open') result = chain.open;
    else if (decoded.functionName === 'admitted') result = chain.admitted;
    else if (decoded.functionName === 'nextDripAt') result = chain.nextDripAt;
    else if (decoded.functionName === 'dailyRemaining') result = chain.dailyRemaining;
    else throw new Error(`unexpected call ${decoded.functionName}`);
    return encodeFunctionResult({ abi: [...ABI, ...TRADE_ABI], functionName: decoded.functionName, result: result as never });
  };
  const sent: { to: Address; data: Hex; gas: Hex }[] = [];
  const walletAsked: string[] = [];
  wallet.signer = {
    walletName: 'Test wallet',
    request: async ({ method, params }) => {
      walletAsked.push(method);
      if (method === 'eth_chainId') return toHex(wallet.chainId ?? 0);
      if (method === 'eth_accounts') return [wallet.account];
      if (method !== 'eth_sendTransaction') throw new Error(`unexpected wallet request ${method}`);
      const tx = (params as { to: Address; data: Hex; gas: Hex }[])[0] as { to: Address; data: Hex; gas: Hex };
      if (chain.walletGate) await chain.walletGate;
      if (chain.tradeGate && decodeFunctionData({ abi: [...ABI, ...TRADE_ABI], data: tx.data }).functionName !== 'approve') await chain.tradeGate;
      if (chain.decline) { chain.decline = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
      if (chain.lacksFunds !== null) { const words = chain.lacksFunds; chain.lacksFunds = null; throw Object.assign(new Error(words), { code: -32000 }); }
      sent.push(tx);
      const decoded = decodeFunctionData({ abi: [...ABI, ...TRADE_ABI], data: tx.data });
      if (decoded.functionName === 'approve') { chain.allowances.set(tx.to.toLowerCase(), decoded.args[1] as bigint); chain.onApprove?.(); }
      else if (decoded.functionName === 'drip') {
        chain.balances.set(TETH.toLowerCase(), (chain.balances.get(TETH.toLowerCase()) ?? 0n) + DRIP);
        chain.nextDripAt = NOW + 86_400n; chain.dailyRemaining -= DRIP;
      }
      const hash = toHex(100 + sent.length, { size: 32 });
      // Reverted: nothing moved, the approval stays.
      if (decoded.functionName === 'swap' && chain.revertSwap) { chain.revertedData = tx.data; chain.nonce += 1n; chain.head = 0x11n; chain.receipts.set(hash, '0x0'); return hash; }
      if (decoded.functionName === 'swap') {
        for (const [coin] of chain.allowances) chain.allowances.set(coin, options.left ?? 0n);
        // What the swap took (its exact input less what it left approved), as the PoolManager emits it.
        const [key, swap] = decoded.args as unknown as [{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, { zeroForOne: boolean; amountSpecified: bigint }];
        const spent = -swap.amountSpecified - (options.left ?? 0n);
        chain.logs.set(hash, [swapLog(key, swap.zeroForOne ? -spent : 5n * ETHER, swap.zeroForOne ? 5n * ETHER : -spent)]);
      }
      chain.nonce += 1n;
      chain.head = 0x11n;
      chain.receipts.set(hash, '0x1');
      return hash;
    },
  };
  const target: CoinTarget = { chainId: 31337, rpc, localDeployment: recordOf(options.pairs), teth: { address: TETH, symbol: 'tETH', decimals: 18 },
    pairs: (options.pairs ?? [pairRow(NVDA, 'tNVDA')]).map((p) => ({ address: p.coin, symbol: p.symbol, decimals: p.decimals })), explorer: () => null };
  /** Another swap lands first: the pool's square-root price moves by `ppm` millionths, its tick with it. */
  const movePool = (ppm: bigint) => {
    const price = (storage[base] as bigint) & ((1n << 160n) - 1n);
    const moved = price * (1_000_000n + ppm) / 1_000_000n;
    storage[base] = moved | (BigInt.asUintN(24, BigInt(getTickAtSqrtPrice(moved))) << 160n) | (3000n << 208n);
  };
  return { chain, rpc, asked, blocksAsked, sent, walletAsked, target, movePool };
}

/** A box page for the adoption test: a bonding tETH box (the trade box reads nothing until an amount is typed). */
const COORDINATOR_OF_BOX = '0x0000000000000000000000000000000000000010' as Address;
const BOX_RECORD = { pairAsset: 'tETH', ticker: 'ATETH', chainId: 31337 } as unknown as BoxRecord;
const BOX_VIEW = (() => {
  const contracts = [COORDINATOR_OF_BOX, ...Array.from({ length: 23 }, () => zeroAddress)];
  return { record: { contracts, codeHashes: contracts.map(() => `0x${'00'.repeat(32)}`), q: TETH, raise: ETHER }, token: '0xf000000000000000000000000000000000000020', decimals: 18,
    gate: { open: true, deadline: NOW + 86_400n, effectiveOpenAt: NOW - 600n }, timestamp: NOW, graduated: false, closedAt: 0n, failed: null } as unknown as V2Snapshot;
})();
const BOX_SOURCE = { network: 'local', rpc: 'http://127.0.0.1:8592', origin: '', manifest: { chainId: 31337, chain: { poolManager: { address: MANAGER } }, releases: [] } } as unknown as V2Source;

function show(target: CoinTarget | { reason: string }, refreshMs?: number, claimState?: ClaimState | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The Claim card above the coins has its own tests (ClaimCard.test.tsx); its claim, where a test needs it, is handed in.
  const element = () => <QueryClientProvider client={client}><TestCoinPage target={target} claim={false} {...(refreshMs === undefined ? {} : { refreshMs })}
    {...(claimState === undefined ? {} : { claimState })} /></QueryClientProvider>;
  const result = render(element());
  return { ...result, again: () => result.rerender(element()) };
}
/** No word on the coins about the earlier ways to join (Access, email, invites, codes); X's sign-in and the claim are F161 (4)'s. */
const expectNeutral = () => expect(page().textContent ?? '').not.toMatch(/access|e-?mail|invite|one-time|code\b/i);
const page = () => screen.getByRole('region', { name: 'Test coins' });
const card = (name: string) => screen.getByRole('region', { name });
const status = (name: string) => within(card(name)).queryByRole('status')?.textContent ?? null;
const enabled = (region: string, name: string | RegExp) => waitFor(() => {
  const button = within(card(region)).getByRole('button', { name }) as HTMLButtonElement;
  if (button.disabled) throw new Error(`${String(name)} is not enabled yet`);
  return button;
}, { timeout: 4_000 });

describe('the wallet only on a press', () => {
  it('without a wallet: one line and the press that opens the wallet window; nothing is read, nothing asked', async () => {
    wallet.status = 'disconnected'; wallet.account = null; wallet.signer = null;
    const r = rig();
    show(r.target);
    expect(within(page()).getByText('Connect a wallet to see your test coins.')).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(r.asked).toEqual([]);
    fireEvent.click(within(page()).getByRole('button', { name: 'Connect wallet' }));
    expect(screen.getByRole('dialog', { name: 'Connect a browser wallet' })).toBeTruthy();
  });

  it('the Sepolia record is still predicted: one line, no wallet, no read', () => {
    show({ reason: 'deployment_predicted' });
    expect(within(page()).getByRole('status').textContent).toBe('Test coins are not live yet.');
    expect(within(page()).queryByRole('button')).toBeNull();
  });
});

/**
 * F166 af2 (the founder hit it live, 2026-11-01): the sender puts the wallet on the faucet's list first and sends its
 * starter SepETH minutes later (or both in one block). No "Get 1 tETH" before the account can pay the drip's gas: the
 * button lights up when both are on the chain, in either order; a line says why before that.
 */
describe('the faucet waits for the starter coins (F166 af2)', () => {
  const QUEUED: ClaimState = { id: '0b6a2f9e-6c1d-4f3a-9b2e-1d2c3b4a5f60', status: 'queued', admitTx: null, sendTx: null, reason: null, at: null };

  it.each(['queued', 'waiting', 'sending'] as const)('%s: on the list, no SepETH yet, a claim under way: no drip and no plan, “on its way”; the button lights up once the SepETH lands', async claimStatus => {
    const r = rig({ admitted: true, sepEth: 0n });
    const view = show(r.target, 60_000, { ...QUEUED, status: claimStatus });
    await waitFor(() => expect(status('Faucet')).toBe(claimLine({ ...QUEUED, status: claimStatus })));
    expect(status('Faucet')).toBe({ queued: 'Claim queued.', waiting: 'Waiting: the faucet is being refilled.', sending: 'Sending your starter coins.' }[claimStatus]);
    expect(within(card('Faucet')).queryByRole('button', { name: /^Get / })).toBeNull();
    expect(spies.faucet).toEqual([]);
    // The sender's SepETH lands: the next read (sooner while the coins are coming) lights the button up.
    r.chain.sepEth = 5n * 10n ** 16n;
    await waitFor(() => expect(within(card('Faucet')).getByRole('button', { name: 'Get 1 tETH' })).toBeTruthy(), { timeout: 8_000 });
    expect(status('Faucet')).toBeNull();
    view.unmount();
  }, shLimit(15_000));

  it('a claim the sender’s receipt says sent: “on its way” for two minutes after the receipt, then the plain line (never forever for another wallet)', async () => {
    const sentAt = (msAgo: number): ClaimState => ({ ...QUEUED, status: 'sent', at: new Date(Date.now() - msAgo).toISOString() });
    const fresh = rig({ admitted: true, sepEth: 0n });
    show(fresh.target, 60_000, sentAt(30_000));
    await waitFor(() => expect(status('Faucet')).toBe(claimLine(sentAt(30_000))));
    cleanup();
    const late = rig({ admitted: true, sepEth: 0n });
    show(late.target, 60_000, sentAt(COMING_AFTER_SENT_MS + 1_000));
    await waitFor(() => expect(status('Faucet')).toBe(tradeLine('gas_funds')));
    expect(within(card('Faucet')).queryByRole('button', { name: /^Get / })).toBeNull();
  });

  it('in the other order too: SepETH first, not on the list yet, a claim under way: “on its way”, not the not-on-the-list line', async () => {
    const r = rig({ admitted: false, sepEth: 5n * 10n ** 16n });
    show(r.target, 60_000, QUEUED);
    await waitFor(() => expect(status('Faucet')).toBe(claimLine(QUEUED)));
    expect(within(card('Faucet')).queryByRole('button', { name: /^Get / })).toBeNull();
  });

  it('on the list, due, too little SepETH and no claim under way: “Needs a little SepETH for gas”, no button', async () => {
    for (const sepEth of [0n, 1_000n]) {
      cleanup();
      const r = rig({ admitted: true, sepEth });
      show(r.target, 60_000, null);
      await waitFor(() => expect(status('Faucet'), String(sepEth)).toBe(tradeLine('gas_funds')));
      expect(tradeLine('gas_funds')).toBe('Needs a little SepETH for gas.');
      expect(within(card('Faucet')).queryByRole('button', { name: /^Get / })).toBeNull();
      expect(spies.faucet).toEqual([]);
    }
  });

  it('a drip the wallet’s node refuses for its cost says the plain line, not the wallet’s error', async () => {
    const r = rig({ lacksFunds: 'insufficient funds for gas * price + value: balance 0, tx cost 1144172000000000' });
    show(r.target);
    fireEvent.click(await enabled('Faucet', 'Get 1 tETH'));
    await waitFor(() => expect(status('Faucet')).toBe(tradeLine('gas_funds')));
    expect(r.sent).toEqual([]);
  });

  it('a wallet error whose words do not say it, while the account cannot pay the gas: the plain line too', async () => {
    const r = rig({ lacksFunds: 'Internal JSON-RPC error.' });
    show(r.target, 300);
    const get = await enabled('Faucet', 'Get 1 tETH');
    // The SepETH is gone by the press (spent in another tab): the wallet says only that it failed.
    r.chain.sepEth = 0n;
    fireEvent.click(get);
    await waitFor(() => expect(status('Faucet')).toBe(tradeLine('gas_funds')), { timeout: 8_000 });
  }, shLimit(15_000));
});

describe('the faucet: what it says before it offers a drip', () => {
  it('a wallet not on the list gets one plain line: no drip, no facts of the faucet’s, no plan', async () => {
    const r = rig({ admitted: false });
    show(r.target);
    await waitFor(() => expect(status('Faucet')).toBe(NOT_ON_LIST_LINE));
    expect(within(card('Faucet')).queryByText('Next drip')).toBeNull();
    expect(within(card('Faucet')).queryByText('Left today')).toBeNull();
    expect(within(card('Faucet')).queryByRole('button', { name: /^Get / })).toBeNull();
    expect(spies.faucet).toEqual([]);
    expect(r.walletAsked).toEqual([]);
    expectNeutral();
    // What one state read costs the site's RPC: the block number, the chain, the block, tETH's code, the faucet's four
    // facts and a balance per coin (tETH and tNVDA here), then the account's SepETH and the gas price (F166 af2): 10
    // requests and one per coin.
    const count: Record<string, number> = {};
    for (const method of r.asked) count[method] = (count[method] ?? 0) + 1;
    expect(count).toEqual({ eth_blockNumber: 1, eth_chainId: 1, eth_getBlockByNumber: 1, eth_getCode: 1, eth_call: 4 + 2, eth_getBalance: 1, eth_gasPrice: 1 });
  });

  it('the balances and the faucet’s facts come from one explicit block, with the site’s RPC', async () => {
    const r = rig();
    show(r.target);
    await waitFor(() => expect(within(card('Faucet')).getByText('Left today')).toBeTruthy());
    const read = spies.state[0] as CoinOptions & { blockNumber: bigint };
    expect(read.blockNumber).toBe(16n);
    expect(read.chainId).toBe(31337);
    expect(read.rpc).toBe(r.target.rpc);
    // Every call the page makes names its block: none reads "latest".
    expect(r.blocksAsked.length).toBeGreaterThanOrEqual(6);
    expect(r.blocksAsked.filter((block) => block !== '0x10')).toEqual([]);
    expect(within(card('Balances')).getByText('tNVDA')).toBeTruthy();
    expect(within(card('Faucet')).getByText('498 tETH')).toBeTruthy();
    expect(within(card('Faucet')).getByText('Now')).toBeTruthy();
  });

  it('a due drip, one press: the drip with the plan’s gas (at least 480,000), the target’s chain and RPC; then the cooldown', async () => {
    const r = rig();
    show(r.target);
    fireEvent.click(await enabled('Faucet', 'Get 1 tETH'));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Drip confirmed'));
    expect(r.sent).toHaveLength(1);
    const [drip] = r.sent as [{ to: Address; data: Hex; gas: Hex }];
    expect(drip.to).toBe(TETH);
    expect(decodeFunctionData({ abi: ABI, data: drip.data }).functionName).toBe('drip');
    // max(480,000, ceil(476,738 × 1.2)) = 572,086, as the coin calls compute it.
    expect(BigInt(drip.gas)).toBe(572_086n);
    const submit = spies.submit[0] as CoinSubmitOptions;
    expect(submit.chainId).toBe(31337);
    expect(submit.rpc).toBe(r.target.rpc);
    expect(submit.gasLimit).toBe(572_086n);
    // Read again after the drip: the next one is a day away, and no drip is offered.
    await waitFor(() => expect(within(card('Faucet')).queryByText('Now')).toBeNull());
    expect(within(card('Faucet')).queryByRole('button', { name: /^Get / })).toBeNull();
    expect(r.walletAsked.filter((method) => method === 'eth_sendTransaction')).toHaveLength(1);
    expectNeutral();
  });

  it('a refusal at the press (the cooldown began after the plan) sends nothing and says so', async () => {
    const r = rig();
    show(r.target);
    const drip = await enabled('Faucet', 'Get 1 tETH');
    // Another device of this wallet dripped meanwhile: the send's guard reads the faucet again and refuses.
    r.chain.nextDripAt = NOW + 600n;
    fireEvent.click(drip);
    await waitFor(() => expect(status('Faucet')).toBe('The next drip is not due yet.'));
    expect(r.walletAsked).not.toContain('eth_sendTransaction');
    expect(r.sent).toEqual([]);
  });

  it('something pending for the account holds the drip, and is looked at again within seconds, not at the next refresh', async () => {
    const r = rig({ stuck: true });
    show(r.target);
    await waitFor(() => expect(status('Faucet')).toBe('An earlier transaction is still under way.'));
    const asked = spies.faucet.length;
    r.chain.stuck = false;
    // Looked at again RECONCILE_MS (4 s) after the refusal, never PLAN_REFRESH_MS (30 s) later: the drip's plan follows.
    await waitFor(() => expect(spies.faucet.length).toBeGreaterThan(asked), { timeout: 8_000 });
    await enabled('Faucet', 'Get 1 tETH');
  }, shLimit(15_000));

  it('the state’s own reason is not hidden by an older line: a declined drip, then the cap used up', async () => {
    const r = rig({ decline: true });
    show(r.target, 300);
    fireEvent.click(await enabled('Faucet', 'Get 1 tETH'));
    await waitFor(() => expect(status('Faucet')).toBe('Declined in your wallet.'));
    r.chain.dailyRemaining = 0n;
    await waitFor(() => expect(status('Faucet')).toBe('Today’s faucet cap is used up.'), { timeout: 4_000 });
  });

  it('a send under way stays as it is when the wallet moves to another network', async () => {
    const r = rig();
    const view = show(r.target);
    const drip = await enabled('Faucet', 'Get 1 tETH');
    let answer: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { answer = resolve; });
    fireEvent.click(drip);
    await waitFor(() => expect(within(card('Faucet')).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy());
    wallet.chainId = 1;
    view.again();
    // What is under way keeps its button; only the idle swap offers the switch.
    expect(within(card('Faucet')).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy();
    expect(within(card('Swap')).getByRole('button', { name: 'Swap' })).toBeTruthy();
    answer();
    await waitFor(() => expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Drip confirmed'));
  });

  it('a wallet on another network: the page and its receipts stay; the idle actions switch the network', async () => {
    const r = rig();
    const view = show(r.target);
    fireEvent.click(await enabled('Faucet', 'Get 1 tETH'));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Drip confirmed'));
    const switched: number[] = [];
    wallet.switchChain = async (chainId) => { switched.push(chainId); };
    wallet.chainId = 1;
    view.again();
    // The facts are the site's reads, on any network; only the sends wait for the right one.
    expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Drip confirmed');
    fireEvent.change(within(card('Swap')).getByRole('textbox', { name: 'Amount in tETH' }), { target: { value: '1' } });
    fireEvent.click(await enabled('Swap', 'Switch network'));
    expect(switched).toEqual([31337]);
    expect(r.walletAsked.filter((method) => method === 'eth_sendTransaction')).toHaveLength(1);
  });

  it('cooling down: when the next drip is due, no button and no line; the cap used up: its line', async () => {
    const r = rig({ nextDripAt: NOW + 3_600n });
    const first = show(r.target);
    await waitFor(() => expect(within(card('Faucet')).getByText('Next drip')).toBeTruthy());
    await waitFor(() => expect(within(card('Faucet')).getByText(/UTC$/)).toBeTruthy());
    expect(within(card('Faucet')).queryByRole('button', { name: /^Get / })).toBeNull();
    expect(status('Faucet')).toBeNull();
    first.unmount();
    const capped = rig({ dailyRemaining: ETHER / 2n });
    show(capped.target);
    await waitFor(() => expect(status('Faucet')).toBe('Today’s faucet cap is used up.'));
    expect(within(card('Faucet')).queryByRole('button', { name: /^Get / })).toBeNull();
  });

  it('the faucet open to all (its switch on) drips for a wallet not on the list', async () => {
    const r = rig({ admitted: false, open: true });
    show(r.target);
    fireEvent.click(await enabled('Faucet', 'Get 1 tETH'));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Drip confirmed'));
  });

  it('a node behind the one that named the block: the read is tried once more, and the state shows', async () => {
    const r = rig({ lagging: true });
    show(r.target);
    await waitFor(() => expect(within(card('Faucet')).getByText('Left today')).toBeTruthy(), { timeout: 4_000 });
    expect(status('Faucet')).toBeNull();
    expect(spies.state.length).toBe(2);
  });

  it('a failed read is said, never shown as zero', async () => {
    const r = rig({ down: true });
    show(r.target);
    // Said after the one retry, a second on.
    await waitFor(() => expect(status('Faucet')).toBe('The chain could not be read. Try again.'), { timeout: 4_000 });
    expect(within(card('Balances')).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(card('Balances')).queryByText('0')).toBeNull();
  });
});

describe('a pair swap, as the trade box’s ERC-20 path', () => {
  it('the coins on offer are the record’s, in its order', async () => {
    const r = rig({ pairs: [pairRow(NVDA, 'tNVDA'), pairRow(GOLD, 'tGOLD')] });
    show(r.target);
    const options = within(card('Swap')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['tNVDA', 'tGOLD']);
  });

  it('one press approves exactly, makes the plan again and swaps; then revokes what a part fill left', async () => {
    const r = rig({ left: ETHER / 4n });
    show(r.target);
    fireEvent.change(within(card('Swap')).getByRole('textbox', { name: 'Amount in tETH' }), { target: { value: '1' } });
    expect(within(card('Swap')).getByText('Can fill in part; no deadline.')).toBeTruthy();
    // Before the press: the plan needs its approval and shows what the swap gets; the whole amount goes in.
    const swap = await enabled('Swap', 'Swap');
    expect(within(card('Swap')).getByText(/^≈ /)).toBeTruthy();
    expect(within(card('Swap')).queryByText(/^Fills ≈/)).toBeNull();
    const plans = spies.pair.length;
    fireEvent.click(swap);
    // The chain takes three quarters, and the row says so in its figures.
    await waitFor(() => expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Swap filled in part: 0.75 of 1 tETH'));
    const approve = decodeFunctionData({ abi: TRADE_ABI, data: (r.sent[0] as { data: Hex }).data });
    expect(approve.functionName).toBe('approve');
    expect(approve.args).toEqual([POOL, ETHER]);
    // One plan made again after the approval, by the press itself.
    expect(spies.pair.length).toBe(plans + 1);
    const row = within(screen.getByRole('list', { name: 'Transactions' })).getByText('Swap filled in part: 0.75 of 1 tETH').closest('li') as HTMLElement;
    expect([row.dataset.fill, row.dataset.spent, row.dataset.offered]).toEqual(['part', (ETHER * 3n / 4n).toString(), ETHER.toString()]);
    const pair = spies.pair.at(-1) as PairSwapOptions;
    expect([pair.input, pair.output, pair.amountIn, pair.chainId, pair.rpc]).toEqual([TETH, NVDA, ETHER, 31337, r.target.rpc]);
    // A quarter of the approval is left: its revocation is offered, then sent as approve(PoolSwapTest, 0).
    fireEvent.click(await enabled('Swap', 'Revoke 0.25 tETH'));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Transactions' }).textContent).toContain('Approval cleared confirmed'));
    expect(r.chain.allowances.get(TETH.toLowerCase())).toBe(0n);
    expect(decodeFunctionData({ abi: TRADE_ABI, data: (r.sent[2] as { data: Hex }).data }).args).toEqual([POOL, 0n]);
    expect(r.walletAsked.filter((method) => method === 'eth_sendTransaction')).toHaveLength(3);
  });

  it('a swap under way when the page goes is followed by the next page opened, a box page: its revocation names the coin and goes through the coin guard', async () => {
    const r = rig({ left: ETHER / 4n });
    const coins = show(r.target);
    fireEvent.change(within(card('Swap')).getByRole('textbox', { name: 'Amount in tETH' }), { target: { value: '1' } });
    // The wallet holds the swap (the press's second request) until the person answers.
    let answer: () => void = () => undefined;
    r.chain.tradeGate = new Promise<void>((resolve) => { answer = resolve; });
    fireEvent.click(await enabled('Swap', 'Swap'));
    await waitFor(() => expect(r.walletAsked.filter((method) => method === 'eth_sendTransaction')).toHaveLength(2));
    await waitFor(() => expect(within(card('Swap')).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy());
    coins.unmount();
    // A box page opens while the wallet still has the swap: the box adopts it and holds its own plans.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TradeBox record={BOX_RECORD} view={BOX_VIEW} source={BOX_SOURCE} disabled={false}
      target={{ chainId: 31337, rpc: r.rpc, coordinator: COORDINATOR_OF_BOX, explorer: () => null }} /></QueryClientProvider>);
    const box = screen.getByRole('region', { name: 'Buy and sell' });
    await waitFor(() => expect(within(box).getByRole('status').textContent).toBe('Confirm or reject it in your wallet.'));
    answer();
    await waitFor(() => expect(r.sent).toHaveLength(2));
    fireEvent.click(within(box).getByRole('button', { name: 'Check again' }));
    // The box names the swap's coin by the swap's own record: the part fill in its figures.
    await waitFor(() => expect(within(box).getByRole('list', { name: 'Transactions' }).textContent).toContain('Swap filled in part: 0.75 of 1 tETH'));
    // What the part fill left: named by the swap's own record, and revoked through the coin calls' guard.
    const revoke = await waitFor(() => within(box).getByRole('button', { name: 'Revoke 0.25 tETH' }));
    const submits = spies.submit.length;
    fireEvent.click(revoke);
    await waitFor(() => expect(within(box).getByRole('list', { name: 'Transactions' }).textContent).toContain('Approval cleared confirmed'));
    expect(spies.submit.length).toBe(submits + 1);
    expect(r.chain.allowances.get(TETH.toLowerCase())).toBe(0n);
    expect(inFlightOf(sendKey(31337, USER))).toBeNull();
  });

  it('a swap the chain fills whole: confirmed with what went in, and nothing left to revoke', async () => {
    const r = rig();
    show(r.target);
    fireEvent.change(within(card('Swap')).getByRole('textbox', { name: 'Amount in tETH' }), { target: { value: '2' } });
    fireEvent.click(await enabled('Swap', 'Swap'));
    const row = (await waitFor(() => within(screen.getByRole('list', { name: 'Transactions' })).getByText('Swap confirmed: 2 tETH'))).closest('li') as HTMLElement;
    // One press, two sends: the exact approval, then the swap.
    expect(r.sent.map((tx) => decodeFunctionData({ abi: TRADE_ABI, data: tx.data }).functionName)).toEqual(['approve', 'swap']);
    expect([row.dataset.fill, row.dataset.spent]).toEqual(['whole', (2n * ETHER).toString()]);
    await waitFor(() => expect((within(card('Swap')).getByRole('textbox', { name: 'Amount in tETH' }) as HTMLInputElement).value).toBe(''));
    expect(within(card('Swap')).queryByRole('button', { name: /^Revoke/ })).toBeNull();
  });

  it('more than the balance gets its line and no plan to send', async () => {
    const r = rig();
    show(r.target);
    fireEvent.change(within(card('Swap')).getByRole('textbox', { name: 'Amount in tETH' }), { target: { value: '51' } });
    await waitFor(() => expect(status('Swap')).toBe('Not enough balance.'));
    expect(r.sent).toEqual([]);
  });
});

describe('the swap card: one press per swap (SH-ONE-PRESS-TRADE)', () => {
  const amountField = () => within(card('Swap')).getByRole('textbox', { name: 'Amount in tETH' });
  const ticks = () => {
    const list = within(card('Swap')).queryByRole('list', { name: 'Progress' });
    return list ? within(list).getAllByRole('listitem').map((item) => [item.dataset.step, item.dataset.state]) : null;
  };
  const sentCalls = (r: ReturnType<typeof rig>) => r.sent.map((tx) => decodeFunctionData({ abi: [...ABI, ...TRADE_ABI], data: tx.data }).functionName);
  const sends = (r: ReturnType<typeof rig>) => r.walletAsked.filter((method) => method === 'eth_sendTransaction').length;
  const rows = () => screen.queryByRole('list', { name: 'Transactions' })?.textContent ?? '';

  it('an approval needed, the wallet Privy made: one press, the approval and the swap, the ticks to done', async () => {
    const r = rig();
    (wallet.signer as { confirmsInPage?: true }).confirmsInPage = true;
    show(r.target);
    fireEvent.change(amountField(), { target: { value: '2' } });
    // Before the press: what the swap gets, and one button; no Approve.
    const swap = await enabled('Swap', 'Swap');
    expect(within(card('Swap')).getByText(/^≈ /)).toBeTruthy();
    expect(within(card('Swap')).queryByRole('button', { name: /^Approve/ })).toBeNull();
    let release: () => void = () => undefined;
    r.chain.tradeGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(swap);
    await waitFor(() => expect(sends(r)).toBe(2));
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'active']]);
    expect(within(card('Swap')).getByRole('button', { name: 'Signing…' })).toBeTruthy();
    release();
    await waitFor(() => expect(rows()).toContain('Swap confirmed: 2 tETH'));
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'done']]);
    expect(sentCalls(r)).toEqual(['approve', 'swap']);
    expect(r.chain.allowances.get(TETH.toLowerCase())).toBe(0n);
  });

  it('no approval needed (it is already exact): one press, one send, no ticks', async () => {
    const r = rig();
    r.chain.allowances.set(TETH.toLowerCase(), 2n * ETHER);
    show(r.target);
    fireEvent.change(amountField(), { target: { value: '2' } });
    fireEvent.click(await enabled('Swap', 'Swap'));
    await waitFor(() => expect(rows()).toContain('Swap confirmed: 2 tETH'));
    expect(sentCalls(r)).toEqual(['swap']);
    expect(ticks()).toBeNull();
  });

  it('the plan made after the approval is past the person’s tolerance: no swap is sent; the new quote shows with its line and its press', async () => {
    const r = rig();
    show(r.target);
    fireEvent.change(amountField(), { target: { value: '2' } });
    const swap = await enabled('Swap', 'Swap');
    const shown = within(card('Swap')).getByText(/^≈ /).textContent;
    r.chain.onApprove = () => r.movePool(-30_000n);
    fireEvent.click(swap);
    await waitFor(() => expect(status('Swap')).toBe('Price moved over your 2% tolerance. Check the new quote.'));
    expect(sentCalls(r)).toEqual(['approve']);
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'stopped']]);
    const again = await enabled('Swap', 'Swap');
    expect(within(card('Swap')).getByText(/^≈ /).textContent).not.toBe(shown);
    fireEvent.click(again);
    await waitFor(() => expect(rows()).toContain('Swap confirmed: 2 tETH'));
    expect(sentCalls(r)).toEqual(['approve', 'swap']);
  });

  it('af1: the sent swap carries the pressed quote\'s price limit, where the plan made after the approval would have had a looser one', async () => {
    const r = rig();
    show(r.target);
    fireEvent.change(amountField(), { target: { value: '2' } });
    // Another swap moves the price against this one (0.3% of its square root) while the approval is mined.
    r.chain.onApprove = () => r.movePool(-3_000n);
    fireEvent.click(await enabled('Swap', 'Swap'));
    await waitFor(() => expect(rows()).toContain('Swap confirmed: 2 tETH'));
    const pressed = (spies.submit[0] as CoinSubmitOptions).plan;
    const sent = decodeFunctionData({ abi: TRADE_ABI, data: (r.sent[1] as { data: Hex }).data });
    if (sent.functionName !== 'swap') throw new Error('swap expected');
    expect(sent.args[1].sqrtPriceLimitX96).toBe(pressed.priceLimitX96);
    const own = (spies.pair.at(-1) as PairSwapOptions);
    expect(own.floor).toEqual({ sqrtPriceLimitX96: pressed.priceLimitX96, minimumOutput: null });
    // Without the bound, the plan at the moved price would carry a lower (looser) limit.
    const loose = await preparePair({ ...own, floor: undefined });
    if (!loose.ok) throw new Error(loose.reason);
    expect(loose.plan.priceLimitX96 as bigint).toBeLessThan(pressed.priceLimitX96 as bigint);
  });

  it('a browser wallet: one press; the wallet asks twice, the second time by itself once the approval is mined', async () => {
    const r = rig();
    show(r.target);
    fireEvent.change(amountField(), { target: { value: '2' } });
    let confirmApproval: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirmApproval = resolve; });
    fireEvent.click(await enabled('Swap', 'Swap'));
    await waitFor(() => expect(sends(r)).toBe(1));
    expect(within(card('Swap')).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy();
    expect(ticks()).toEqual([['approve', 'active'], ['trade', 'waiting']]);
    let confirmSwap: () => void = () => undefined;
    r.chain.walletGate = new Promise<void>((resolve) => { confirmSwap = resolve; });
    confirmApproval();
    await waitFor(() => expect(sends(r)).toBe(2));
    expect(within(card('Swap')).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy();
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'active']]);
    confirmSwap();
    await waitFor(() => expect(rows()).toContain('Swap confirmed: 2 tETH'));
    expect(sentCalls(r)).toEqual(['approve', 'swap']);
  });

  it('a swap that lands after the price passed its limit: the decoded revert says the tolerance and what to do; the approval is offered back', async () => {
    const r = rig();
    r.chain.revertSwap = encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'PriceLimitAlreadyExceeded', args: [2n, 1n] });
    show(r.target);
    fireEvent.change(amountField(), { target: { value: '2' } });
    fireEvent.click(await enabled('Swap', 'Swap'));
    await waitFor(() => expect(status('Swap')).toBe('Price moved over your 2% tolerance. Raise it or trade less.'));
    expect(rows()).toContain('Swap reverted: Price already past your limit.');
    expect(ticks()).toEqual([['approve', 'done'], ['trade', 'stopped']]);
    expect(await enabled('Swap', 'Revoke 2 tETH')).toBeTruthy();
  });

  it('a swap quote that fails for a moment is made again quietly; two failures in a row are said', async () => {
    vi.useFakeTimers();
    const r = rig();
    r.chain.failPlans = 1;
    const view = show(r.target);
    const seen: string[] = [];
    const observer = new MutationObserver(() => { const shown = status('Swap'); if (shown) seen.push(shown); });
    observer.observe(card('Swap'), { subtree: true, childList: true, characterData: true });
    const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    try {
      await tick(0);
      fireEvent.change(amountField(), { target: { value: '2' } });
      await tick(QUOTE_DEBOUNCE_MS);
      expect(spies.pair).toHaveLength(1);
      await tick(QUIET_RETRY_MS - 1);
      expect(spies.pair).toHaveLength(1); expect(status('Swap')).toBeNull();
      await tick(1);
      expect(within(card('Swap')).getByText(/^≈ /)).toBeTruthy();
      observer.disconnect();
      expect(seen).toEqual([]);
      expect(spies.pair).toHaveLength(2);
      // Two in a row: still quiet until the retry, then the line.
      r.chain.failPlans = 2;
      fireEvent.change(amountField(), { target: { value: '3' } });
      await tick(QUOTE_DEBOUNCE_MS);
      expect(spies.pair).toHaveLength(3);
      await tick(QUIET_RETRY_MS - 1);
      expect(spies.pair).toHaveLength(3); expect(status('Swap')).toBeNull();
      await tick(1);
      expect(status('Swap')).toBe('The chain could not be read. Try again.');
      expect(spies.pair).toHaveLength(4);
    } finally { observer.disconnect(); view.unmount(); vi.useRealTimers(); }
  });
});

describe('SH-258 round 4: the faucet on BNB Chain testnet (its rendered lines)', () => {
  /** The page and its words as the BNB build loads them (`SH_TESTNET=bnb`), over the same rig. */
  async function showBnb(target: CoinTarget, refreshMs?: number) {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const [{ TestCoinPage: Page }, words] = await Promise.all([import('./TestCoinPage'), import('./trade-words')]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Page target={target} claim={false} {...(refreshMs === undefined ? {} : { refreshMs })} /></QueryClientProvider>);
    return words;
  }
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('a due drip above the price ceiling: no drip button, and the line says the price, never "needs more"', async () => {
    const r = rig({ gasPrice: 6_000_000_000n });
    const words = await showBnb(r.target);
    await waitFor(() => expect(status('Faucet')).toBe(words.tradeLine('gas_price_high')));
    const button = within(card('Faucet')).queryByRole('button', { name: /^Get / }) as HTMLButtonElement | null;
    expect(button === null || button.disabled).toBe(true);
    expect(r.sent).toEqual([]);
  });

  it('a wallet error while the account cannot pay: the recorded line stays, never replaced by a funds diagnosis', async () => {
    const r = rig({ lacksFunds: 'Internal JSON-RPC error.' });
    const words = await showBnb(r.target, 300);
    const get = await enabled('Faucet', 'Get 1 tETH');
    r.chain.sepEth = 0n;
    fireEvent.click(get);
    await waitFor(() => expect(card('Faucet').textContent ?? '').toContain(words.tradeLine('wallet_error')), { timeout: 8_000 });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(card('Faucet').textContent ?? '').toContain(words.tradeLine('wallet_error'));
  }, shLimit(15_000));

  it('a send that reached the wallet keeps its recorded line when the price then cannot be read: never "nothing was sent"', async () => {
    const r = rig({ lacksFunds: 'Internal JSON-RPC error.' });
    const words = await showBnb(r.target, 300);
    fireEvent.click(await enabled('Faucet', 'Get 1 tETH'));
    await waitFor(() => expect(card('Faucet').textContent ?? '').toContain(words.tradeLine('wallet_error')));
    r.chain.gasPrice = null;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(card('Faucet').textContent ?? '').toContain(words.tradeLine('wallet_error'));
    expect(card('Faucet').textContent ?? '').not.toContain(words.tradeLine('gas_price_unread'));
    expect(r.walletAsked).toContain('eth_sendTransaction');
  }, shLimit(15_000));
});
