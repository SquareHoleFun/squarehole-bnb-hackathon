/**
 * F156 (SH-ALPHA-TRADE-BOX): the trade box's chain work, apart from its React state: reads (balance, allowance,
 * nonces, receipts), the gas an approval sends with, why a mined transaction reverted, what a mined trade filled, and
 * what a failed send means. Every read goes through the target's RPC (the site's, never the wallet's); every amount
 * stays bigint. Sending is the trade folder's guarded `submitTradeWriteSepolia` alone (TradeBox.tsx); nothing here asks
 * a wallet for anything.
 */
import { createChainReader, InsufficientGasFundsError, NetworkPriceError, RpcRequestError, WalletContextChangedError, WalletRejectedError, WalletRequestError, type Eip1193Request, type TxReceipt } from '@squarehole/chain/write';
import { decodeTradeRevert, TradeRefusedError, TRADE_ABI, type CoinPlan, type TradeCall, type TradePlan } from '@squarehole/chain/trade-sepolia';
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';

/** What a plan spends and who may pull it: P on a buy (to the router in the window, PoolSwapTest after), T on a sale. */
export interface TradeInput {
  /** The coin paid in; the zero address for native ETH. */
  readonly coin: Address;
  readonly spender: Address;
}

export function inputOf(plan: Pick<TradePlan, 'side' | 'phase' | 'p' | 'token' | 'router' | 'deployment'>): TradeInput {
  const windowBuy = plan.side === 'buy' && plan.phase === 2;
  return { coin: plan.side === 'buy' ? plan.p : plan.token, spender: windowBuy ? plan.router : plan.deployment.poolSwapTest };
}

/**
 * What any plan's own call spends, for its revocation: a box trade's input (above); a pair swap's input coin, which its
 * revocation names, to PoolSwapTest. Null for the faucet's drip, which spends nothing.
 */
export function spendOf(plan: TradePlan | CoinPlan): TradeInput | null {
  if (!('kind' in plan)) return inputOf(plan);
  return plan.kind === 'pair' && plan.revoke ? { coin: plan.revoke.to, spender: plan.deployment.poolSwapTest } : null;
}

const quantityOf = (value: unknown, what: string): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new RpcRequestError(`${what} is not a quantity`, null, undefined);
  return BigInt(value);
};

/**
 * The account's balance of `coin` (native ETH for the zero address) at `block`, a mined block the caller named (the
 * box's quote names its plan's): never "latest", so a balance, the check made with it and the quote it stands beside
 * describe one block.
 */
export async function balanceOf(rpc: Eip1193Request, coin: Address, account: Address, block: bigint): Promise<bigint> {
  if (coin === zeroAddress) return quantityOf(await rpc({ method: 'eth_getBalance', params: [account, toHex(block)] }), 'eth_getBalance');
  const data = await createChainReader(rpc).call({ to: coin, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [account] }) }, block);
  return decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data });
}

/** The latest mined block's number, for reads that name their block. */
export const minedBlock = (rpc: Eip1193Request): Promise<bigint> => createChainReader(rpc).blockNumber();

/** How long a failed read waits before it is tried once more. */
export const READ_RETRY_MS = 1_000;

/**
 * A read tried once more, `ms` later, when it fails: a public RPC spreads its requests over nodes, and one may lag
 * behind the block another just named, or miss a request. The second failure throws, as does the first when `live`
 * says meanwhile that its caller has moved on (an effect cleaned up, a newer plan begun). A failure is never an answer.
 */
export async function readTwice<T>(read: () => Promise<T>, { ms = READ_RETRY_MS, live = () => true }: { readonly ms?: number; readonly live?: () => boolean } = {}): Promise<T> {
  try {
    return await read();
  } catch (error) {
    await pause(ms);
    if (!live()) throw error;
    return read();
  }
}

/** How much of `coin` `spender` may still pull from `owner`, at the latest block (zero for native ETH). */
export async function allowanceOf(rpc: Eip1193Request, coin: Address, owner: Address, spender: Address): Promise<bigint> {
  if (coin === zeroAddress) return 0n;
  const data = await createChainReader(rpc).call({ to: coin, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'allowance', args: [owner, spender] }) }, 'latest');
  return decodeFunctionResult({ abi: TRADE_ABI, functionName: 'allowance', data });
}

/** The account's mined and pending transaction counts, to tell whether a send the wallet did not answer went out. */
export async function noncesOf(rpc: Eip1193Request, account: Address): Promise<{ readonly latest: bigint; readonly pending: bigint }> {
  const reader = createChainReader(rpc);
  const [latest, pending] = await Promise.all([reader.getTransactionCount(account, 'latest'), reader.getTransactionCount(account, 'pending')]);
  return { latest, pending };
}

/** An exact approval or a revocation is a plain ERC-20 approve: its own estimate and a third more, never a trade's 4M. */
export const APPROVAL_GAS_FALLBACK = 100_000n;
export async function approvalGas(rpc: Eip1193Request, from: Address, call: TradeCall): Promise<bigint> {
  try {
    const estimate = await createChainReader(rpc).estimateGas({ from, to: call.to, data: call.data, value: call.value });
    const padded = estimate + (estimate + 2n) / 3n;
    return padded > APPROVAL_GAS_FALLBACK ? padded : APPROVAL_GAS_FALLBACK;
  } catch {
    return APPROVAL_GAS_FALLBACK;
  }
}

/** The amount an approve call names (zero for a revocation or a reset); null when the call is not an approve. */
export function approvalAmount(call: TradeCall): bigint | null {
  try {
    const decoded = decodeFunctionData({ abi: TRADE_ABI, data: call.data });
    return decoded.functionName === 'approve' ? (decoded.args[1] as bigint) : null;
  } catch {
    return null;
  }
}

export interface ReceiptWait {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}
function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * The mined receipt of `hash`, read with the site's RPC until it appears; null once `timeoutMs` passes (the box then
 * says to check the wallet, and reconciles by nonce before it prepares again) or the wait is aborted. A failed read is
 * retried, never taken for an answer.
 */
export async function waitForReceipt(rpc: Eip1193Request, hash: Hex, options: ReceiptWait = {}): Promise<TxReceipt | null> {
  const reader = createChainReader(rpc);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  const until = now() + (options.timeoutMs ?? 300_000);
  for (;;) {
    if (options.signal?.aborted) return null;
    try {
      const receipt = await reader.getReceipt(hash);
      if (receipt) return receipt;
    } catch { /* A failed read is not a receipt: ask again. */ }
    if (now() >= until) return null;
    await sleep(options.intervalMs ?? 1_500);
  }
}

/**
 * Why a mined transaction reverted, by running the same call again against the state of its own block, and decoding
 * the revert as the trade folder does (WrappedError unwrapped). `unknown_revert` when the call no longer reverts or
 * reverts without a known reason. Only a likely reason: the block's state after it, not the exact moment before it.
 */
export async function revertReasonOf(rpc: Eip1193Request, from: Address, call: TradeCall, gas: bigint, block: bigint): Promise<string> {
  try {
    await createChainReader(rpc).call({ from, to: call.to, data: call.data, value: call.value, gas }, block);
    return 'unknown_revert';
  } catch (error) {
    return decodeTradeRevert(error);
  }
}

/** The two events a fill is read from (trade-run.test.ts pins them to the contracts' own ABIs). */
export const FILL_EVENTS = parseAbi([
  // v4's PoolManager (IPoolManager): the swapper's own delta, negative for what it pays in, before any hook delta.
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  // The box's launch router (IBoxLaunchRouter): a window buy, with what went back to the buyer (a closing fill, D1).
  'event TaxedBuy(address indexed buyer, address indexed recipient, uint256 step, uint256 qIn, uint256 tax, uint256 tokensOut, uint256 refund)',
]);

/** What a mined trade or swap took of what its call offered, read from its receipt's own events. */
export interface Fill {
  /** What the input coin left the wallet for; native ETH the trade did not take came back in the same transaction. */
  readonly spent: bigint;
  /** What the call offered: a swap's exact input, a window buy's qIn. */
  readonly offered: bigint;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const poolIdOf = (key: { readonly currency0: Address; readonly currency1: Address; readonly fee: number; readonly tickSpacing: number; readonly hooks: Address }): Hex => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));

/**
 * The fill of a plan's own call, from its mined receipt (`from`: the account that sent it; `manager`: the plan's
 * PoolManager). A swap through PoolSwapTest (a box's pool trade, a pair swap): the input side of the pool's one Swap event
 * for that call, which is what left the wallet, since PoolSwapTest pays back in the same transaction any native ETH the
 * pool did not take, and neither pool returns a hook delta (the box's hook returns none; the plan's own simulation
 * equals the pool's bare math, or no plan is made). A window buy: the router's one TaxedBuy for the account, its qIn
 * less its refund. Null for any other call (a drip, an approval), and when the receipt holds no such single event within
 * what the call offered: then nothing is said either way.
 */
export function fillOf(call: TradeCall, receipt: TxReceipt, { from, manager }: { readonly from: Address; readonly manager: Address }): Fill | null {
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: TRADE_ABI, data: call.data });
    } catch {
      return null;
    }
  })();
  if (!decoded) return null;
  const events = (emitter: Address) => receipt.logs.flatMap((log) => {
    if (!sameAddress(log.address, emitter)) return [];
    try {
      return [decodeEventLog({ abi: FILL_EVENTS, data: log.data, topics: log.topics as [Hex, ...Hex[]] })];
    } catch {
      return [];
    }
  });
  if (decoded.functionName === 'swap') {
    const [key, params] = decoded.args;
    if (params.amountSpecified >= 0n) return null;
    const offered = -params.amountSpecified;
    const id = poolIdOf(key).toLowerCase();
    const swaps = events(manager).flatMap((event) => (event.eventName === 'Swap' && event.args.id.toLowerCase() === id && sameAddress(event.args.sender, call.to) ? [event.args] : []));
    const [swap] = swaps;
    if (!swap || swaps.length !== 1) return null;
    const spent = -(params.zeroForOne ? swap.amount0 : swap.amount1);
    return spent >= 0n && spent <= offered ? { spent, offered } : null;
  }
  if (decoded.functionName === 'buy') {
    const [qIn] = decoded.args;
    const buys = events(call.to).flatMap((event) => (event.eventName === 'TaxedBuy' && sameAddress(event.args.buyer, from) ? [event.args] : []));
    const [buy] = buys;
    if (!buy || buys.length !== 1 || buy.qIn !== qIn || buy.refund > qIn) return null;
    return { spent: qIn - buy.refund, offered: qIn };
  }
  return null;
}

/** What the box knows of a send whose outcome it has not seen yet. */
export interface SendTrack {
  /** The account's pending nonce before the wallet was asked (the slot this send takes or follows); null: unread. */
  readonly nonceBefore: bigint | null;
  /** The transaction's hash, once the wallet gave one. */
  readonly hash: Hex | null;
  /** Consecutive reads that found nothing pending for the account, and when the first of them was (wall clock, ms). */
  readonly quietReads: number;
  readonly quietSince: number | null;
  /** Consecutive looks that found the transaction's nonce taken without its receipt (replaced takes two). */
  readonly replacedLooks?: number;
}

export type Settlement =
  | { readonly kind: 'mined'; readonly receipt: TxReceipt }
  /** Its nonce went to another transaction: sped up or cancelled in the wallet. */
  | { readonly kind: 'replaced' }
  /** No hash: nothing pending for long enough; `sent` when the account's nonce moved on meanwhile. */
  | { readonly kind: 'settled'; readonly sent: boolean }
  | { readonly kind: 'waiting'; readonly track: SendTrack };

/** "Nothing is pending" must hold this many reads and this long before a send without a receipt counts as settled. */
export const QUIET_READS = 3;
export const QUIET_MS = 60_000;

/**
 * One look at a send whose outcome the box has not seen, with the site's RPC. The nonces are read first, so a
 * transaction mined after that read still has its receipt at the next look and never looks replaced. A failed read
 * throws (the caller looks again), never counts as "no receipt". With a hash: its receipt; or, once the account's
 * mined nonce has passed the transaction's own nonce without it, replaced; while the RPC does not know the
 * transaction, replaced only after a quiet period with its slot taken. A transaction the RPC shows in a block, or one
 * replaced on a single look, waits (a lagging node may not have the receipt yet). Without a hash (the wallet's answer was
 * unclear): settled only after a quiet period with nothing pending, the site's RPC being slower to see a transaction
 * than the wallet's own node.
 */
export async function settleSend(rpc: Eip1193Request, from: Address, track: SendTrack, now: number = Date.now(),
  quiet: { readonly reads: number; readonly ms: number } = { reads: QUIET_READS, ms: QUIET_MS }): Promise<Settlement> {
  const reader = createChainReader(rpc);
  const nonces = await noncesOf(rpc, from);
  const busy: Settlement = { kind: 'waiting', track: { ...track, quietReads: 0, quietSince: null, replacedLooks: 0 } };
  const quietly = (outcome: () => Settlement): Settlement => {
    const since = track.quietSince ?? now;
    const reads = track.quietReads + 1;
    return reads >= quiet.reads && now - since >= quiet.ms ? outcome() : { kind: 'waiting', track: { ...track, quietReads: reads, quietSince: since } };
  };
  const moved = track.nonceBefore !== null && nonces.latest > track.nonceBefore;
  if (track.hash) {
    const receipt = await reader.getReceipt(track.hash);
    if (receipt) return { kind: 'mined', receipt };
    const sent = await reader.getTransaction(track.hash);
    if (sent) {
      if (sent.blockNumber !== null || nonces.latest <= sent.nonce) return busy;
      const looks = (track.replacedLooks ?? 0) + 1;
      return looks >= 2 ? { kind: 'replaced' } : { kind: 'waiting', track: { ...track, quietReads: 0, quietSince: null, replacedLooks: looks } };
    }
    return moved && nonces.pending === nonces.latest ? quietly(() => ({ kind: 'replaced' })) : busy;
  }
  if (nonces.pending > nonces.latest) return busy;
  return quietly(() => ({ kind: 'settled', sent: moved }));
}

export type SendFailure =
  /** Nothing was sent: the guard refused, the wallet declined, or it moved to another chain or account first. */
  | { readonly kind: 'not_sent'; readonly reason: string }
  /** The wallet answered with an error after the request went to it: it may have sent it. Reconcile before preparing. */
  | { readonly kind: 'unclear'; readonly reason: string };

/** What a failed `submitTradeWriteSepolia` means for the next step. */
/** A wallet's or node's words for a transaction its account cannot pay: geth and Anvil's, viem's (Privy's wallet). */
const LACKS_FUNDS = /insufficient funds|exceeds the balance of the account|insufficient balance for/i;

export function sendFailure(error: unknown): SendFailure {
  if (error instanceof TradeRefusedError) return { kind: 'not_sent', reason: error.reason };
  if (error instanceof WalletRejectedError) return { kind: 'not_sent', reason: 'wallet_rejected' };
  if (error instanceof WalletContextChangedError) return { kind: 'not_sent', reason: error.change === 'chain' ? 'wallet_chain' : 'wallet_account' };
  // The guard's own reads (chain id, blocks, phase, helper code) come before the wallet is asked.
  if (error instanceof RpcRequestError) return { kind: 'not_sent', reason: 'rpc_failed' };
  // F166 af2: the node (or the wallet before it) refused the transaction for its cost: nothing is in the pool, and the
  // plain line says what helps.
  // SH-SEND-FEES: the executor's own check (balance under gasLimit × maxFeePerGas + value), before the wallet is asked.
  if (error instanceof InsufficientGasFundsError) return { kind: 'not_sent', reason: 'gas_funds' };
  // SH-258 round 3: the chain's price, said as itself (no usable price, above the ceiling, risen since the fee was set).
  if (error instanceof NetworkPriceError) return { kind: 'not_sent', reason: error.kind === 'no_price' ? 'gas_price_unread' : error.kind === 'above_ceiling' ? 'gas_price_high' : 'gas_price_rose' };
  if (error instanceof WalletRequestError && LACKS_FUNDS.test(error.message)) return { kind: 'not_sent', reason: 'gas_funds' };
  if (error instanceof WalletRequestError) return { kind: 'unclear', reason: 'wallet_error' };
  return { kind: 'unclear', reason: 'wallet_error' };
}
