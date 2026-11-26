import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, parseAbi, toEventSelector, zeroAddress, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { RpcRequestError, WalletContextChangedError, WalletRejectedError, WalletRequestError, type Eip1193Request, type TxReceipt } from '@squarehole/chain/write';
import { TRADE_ABI, TRADE_ERRORS, TradeRefusedError, type TradeCall } from '@squarehole/chain/trade-sepolia';
import { poolManagerAbi } from '../../../../../packages/chain/src/abi/poolManager';
import { launchRouterV2Abi } from '../../../../../packages/chain/src/core/v2/abi-v2';
import { allowanceOf, APPROVAL_GAS_FALLBACK, approvalAmount, approvalGas, balanceOf, FILL_EVENTS, fillOf, inputOf, minedBlock, noncesOf, readTwice, revertReasonOf, sendFailure, settleSend, spendOf, waitForReceipt, type SendTrack } from './trade-run';

const ME = '0x0000000000000000000000000000000000000070' as Address;
const COIN = '0x0000000000000000000000000000000000000060' as Address;
const TOKEN = '0xf000000000000000000000000000000000000020' as Address;
const ROUTER = '0x0000000000000000000000000000000000000030' as Address;
const HELPER = '0x0000000000000000000000000000000000000040' as Address;
const HASH = `0x${'cd'.repeat(32)}` as Hex;
const plan = (side: 'buy' | 'sell', phase: number, p: Address = COIN) => ({ side, phase, p, token: TOKEN, router: ROUTER, deployment: { poolSwapTest: HELPER } }) as Parameters<typeof inputOf>[0];

/** An RPC double that records what it was asked. */
function rpcOf(answer: (method: string, params: readonly unknown[]) => unknown) {
  const asked: string[] = [];
  const rpc: Eip1193Request = async ({ method, params }) => { asked.push(method); return answer(method, (params ?? []) as unknown[]); };
  return { rpc, asked };
}
const receiptJson = (status: '0x1' | '0x0') => ({ transactionHash: HASH, blockHash: HASH, blockNumber: '0x20', status, from: ME, to: HELPER, gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] });

describe('inputOf: what a plan spends and who may pull it', () => {
  it('a window buy pays the router; any other buy and every sale pay PoolSwapTest', () => {
    expect(inputOf(plan('buy', 2))).toEqual({ coin: COIN, spender: ROUTER });
    expect(inputOf(plan('buy', 3))).toEqual({ coin: COIN, spender: HELPER });
    expect(inputOf(plan('buy', 5))).toEqual({ coin: COIN, spender: HELPER });
    expect(inputOf(plan('sell', 2))).toEqual({ coin: TOKEN, spender: HELPER });
    expect(inputOf(plan('sell', 3, zeroAddress))).toEqual({ coin: TOKEN, spender: HELPER });
  });
});

describe('spendOf: what any plan’s own call spends, for its revocation (SH-ALPHA-TEST-COINS)', () => {
  it('a box trade as inputOf; a pair swap its input coin to PoolSwapTest; the faucet’s drip nothing', () => {
    expect(spendOf(plan('buy', 2) as never)).toEqual({ coin: COIN, spender: ROUTER });
    expect(spendOf(plan('sell', 3) as never)).toEqual({ coin: TOKEN, spender: HELPER });
    const revoke = { to: COIN, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args: [HELPER, 0n] }), value: 0n };
    expect(spendOf({ kind: 'pair', revoke, deployment: { poolSwapTest: HELPER } } as never)).toEqual({ coin: COIN, spender: HELPER });
    expect(spendOf({ kind: 'faucet', revoke: null, deployment: { poolSwapTest: HELPER } } as never)).toBeNull();
  });
});

describe('the reads, all through the RPC the box was given', () => {
  it('a native balance and an ERC-20 balance at the block named, never "latest"; an allowance', async () => {
    const blocks: unknown[] = [];
    const { rpc, asked } = rpcOf((method, params) => {
      if (method === 'eth_blockNumber') return '0x20';
      if (method === 'eth_getBalance') { blocks.push(params[1]); expect(params[0]).toBe(ME); return '0x2a'; }
      const call = params[0] as { to: Address; data: Hex };
      if (call.data === encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ME] })) { blocks.push(params[1]); return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: 7n }); }
      if (call.data === encodeFunctionData({ abi: TRADE_ABI, functionName: 'allowance', args: [ME, HELPER] })) return encodeFunctionResult({ abi: TRADE_ABI, functionName: 'allowance', result: 5n });
      throw new Error(`unexpected ${method}`);
    });
    const block = await minedBlock(rpc);
    expect(block).toBe(0x20n);
    expect(await balanceOf(rpc, zeroAddress, ME, block)).toBe(42n);
    expect(await balanceOf(rpc, COIN, ME, 0x1fn)).toBe(7n);
    expect(blocks).toEqual(['0x20', '0x1f']);
    expect(await allowanceOf(rpc, COIN, ME, HELPER)).toBe(5n);
    // Native ETH has no allowance and nothing is read for it.
    expect(await allowanceOf(rpc, zeroAddress, ME, HELPER)).toBe(0n);
    expect(asked).toEqual(['eth_blockNumber', 'eth_getBalance', 'eth_call', 'eth_call']);
  });

  it('a malformed balance is an error, never zero', async () => {
    const { rpc } = rpcOf(() => 'lots');
    await expect(balanceOf(rpc, zeroAddress, ME, 1n)).rejects.toThrow();
  });

  it('the mined and pending nonces', async () => {
    const { rpc } = rpcOf((_method, params) => (params[1] === 'latest' ? '0x3' : '0x4'));
    expect(await noncesOf(rpc, ME)).toEqual({ latest: 3n, pending: 4n });
  });
});

describe('readTwice: a failed read once more, a moment later', () => {
  it('a first failure is read again after the pause; a second failure throws, never an answer', async () => {
    let n = 0;
    const flaky = async () => { n += 1; if (n === 1) throw new Error('a node behind'); return 7n; };
    expect(await readTwice(flaky, { ms: 0 })).toBe(7n);
    expect(n).toBe(2);
    let m = 0;
    await expect(readTwice(async () => { m += 1; throw new Error(`down ${m}`); }, { ms: 0 })).rejects.toThrow('down 2');
    expect(m).toBe(2);
  });
  it('waits its pause before the second read, and reads once only when it answers', async () => {
    const at: number[] = [];
    let n = 0;
    await readTwice(async () => { at.push(Date.now()); n += 1; if (n === 1) throw new Error('lag'); return 1; }, { ms: 50 });
    expect(at).toHaveLength(2);
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(45);
    let once = 0;
    expect(await readTwice(async () => { once += 1; return 'ok'; }, { ms: 0 })).toBe('ok');
    expect(once).toBe(1);
  });
  it('a caller that moved on during the pause gets the first failure, and nothing is read again', async () => {
    let n = 0;
    let live = true;
    const failing = readTwice(async () => { n += 1; throw new Error(`failure ${n}`); }, { ms: 20, live: () => live });
    live = false;
    await expect(failing).rejects.toThrow('failure 1');
    expect(n).toBe(1);
  });
});

describe('fillOf: what a mined trade took, from its receipt’s own events', () => {
  const MANAGER = '0x0000000000000000000000000000000000000050' as Address;
  const HOOK = '0x0000000000000000000000000000000000002AE0' as Address;
  const ETHER = 10n ** 18n;
  const boxKey = (p: Address) => ({ currency0: p, currency1: TOKEN, fee: 10000, tickSpacing: 60, hooks: HOOK }) as const;
  const idOf = (key: ReturnType<typeof boxKey>) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const swapCall = (key: ReturnType<typeof boxKey>, zeroForOne: boolean, amountIn: bigint, value = 0n): TradeCall => ({ to: HELPER, value, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'swap',
    args: [key, { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: 4295128740n }, { takeClaims: false, settleUsingBurn: false }, '0x'] }) });
  const buyCall = (qIn: bigint): TradeCall => ({ to: ROUTER, value: qIn, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'buy', args: [qIn, 1n, ME, 1_000n] }) });
  const log = (address: Address, topics: readonly Hex[], data: Hex) => ({ address, topics, data, logIndex: 0, blockHash: HASH, blockNumber: 0x20n, transactionHash: HASH });
  /** The PoolManager's Swap, as v4 emits it: the swapper's delta (negative: paid in). */
  const swapLog = (id: Hex, amount0: bigint, amount1: bigint, { sender = HELPER, emitter = MANAGER }: { sender?: Address; emitter?: Address } = {}) => log(emitter,
    encodeEventTopics({ abi: FILL_EVENTS, eventName: 'Swap', args: { id, sender } }) as Hex[],
    encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [amount0, amount1, 4295128740n, 1n, 0, 10000]));
  /** The launch router's TaxedBuy, as BoxLaunchRouterV2.buy emits it. */
  const taxedLog = (qIn: bigint, refund: bigint, buyer: Address = ME) => log(ROUTER,
    encodeEventTopics({ abi: FILL_EVENTS, eventName: 'TaxedBuy', args: { buyer, recipient: ME } }) as Hex[],
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [0n, qIn, qIn / 2n, 1_000_001n, refund]));
  const receipt = (...logs: ReturnType<typeof log>[]): TxReceipt => ({ transactionHash: HASH, blockHash: HASH, blockNumber: 0x20n, status: 'success', from: ME, to: HELPER, gasUsed: 21_000n, effectiveGasPrice: 1n, logs } as unknown as TxReceipt);
  const at = { from: ME, manager: MANAGER };

  it('the two events are the contracts’ own: v4’s PoolManager Swap and the launch router’s TaxedBuy, their indexed fields included', () => {
    const own = (abi: Abi, name: string) => abi.find((item): item is AbiEvent => item.type === 'event' && item.name === name);
    for (const [mine, theirs] of [[FILL_EVENTS[0] as AbiEvent, own(poolManagerAbi as Abi, 'Swap')], [FILL_EVENTS[1] as AbiEvent, own(launchRouterV2Abi as Abi, 'TaxedBuy')]] as const) {
      expect(theirs, mine.name).toBeTruthy();
      if (!theirs) continue;
      expect(toEventSelector(mine)).toBe(toEventSelector(theirs));
      expect(mine.inputs.map((input) => [input.type, Boolean(input.indexed)])).toEqual(theirs.inputs.map((input) => [input.type, Boolean(input.indexed)]));
    }
  });

  it('a pool buy: the input side of its one Swap; less than the call offered is a part fill (native ETH paid back in the same transaction)', () => {
    const key = boxKey(zeroAddress);
    const call = swapCall(key, true, ETHER / 100n, ETHER / 100n);
    expect(fillOf(call, receipt(swapLog(idOf(key), -(ETHER / 100n), 5n)), at)).toEqual({ spent: ETHER / 100n, offered: ETHER / 100n });
    expect(fillOf(call, receipt(swapLog(idOf(key), -(ETHER * 3n / 400n), 4n)), at)).toEqual({ spent: ETHER * 3n / 400n, offered: ETHER / 100n });
  });

  it('a sale: the token side (amount1) of its Swap; a pair swap by its own pool key', () => {
    const key = boxKey(COIN);
    expect(fillOf(swapCall(key, false, 1000n * ETHER), receipt(swapLog(idOf(key), 3n, -(400n * ETHER))), at)).toEqual({ spent: 400n * ETHER, offered: 1000n * ETHER });
    const pair = { currency0: COIN, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress } as const;
    const pairId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [COIN, TOKEN, 3000, 60, zeroAddress]));
    expect(fillOf(swapCall(pair as never, true, ETHER), receipt(swapLog(pairId, -ETHER, 2n)), at)).toEqual({ spent: ETHER, offered: ETHER });
  });

  it('a window buy: the router’s TaxedBuy, its qIn less what it paid back (a closing fill)', () => {
    expect(fillOf(buyCall(ETHER / 100n), receipt(taxedLog(ETHER / 100n, 0n)), at)).toEqual({ spent: ETHER / 100n, offered: ETHER / 100n });
    expect(fillOf(buyCall(ETHER / 100n), receipt(taxedLog(ETHER / 100n, ETHER / 250n)), at)).toEqual({ spent: ETHER * 6n / 1000n, offered: ETHER / 100n });
  });

  it('says nothing when the receipt does not: no event, another pool, emitter, sender or buyer, two of them, or more than offered', () => {
    const key = boxKey(zeroAddress);
    const call = swapCall(key, true, ETHER / 100n);
    const id = idOf(key);
    expect(fillOf(call, receipt(), at)).toBeNull();
    expect(fillOf(call, receipt(swapLog(idOf(boxKey(COIN)), -1n, 1n)), at)).toBeNull();
    expect(fillOf(call, receipt(swapLog(id, -1n, 1n, { emitter: COIN })), at)).toBeNull();
    expect(fillOf(call, receipt(swapLog(id, -1n, 1n, { sender: ROUTER })), at)).toBeNull();
    expect(fillOf(call, receipt(swapLog(id, -1n, 1n), swapLog(id, -1n, 1n)), at)).toBeNull();
    expect(fillOf(call, receipt(swapLog(id, -(ETHER / 50n), 1n)), at)).toBeNull();
    expect(fillOf(call, receipt(swapLog(id, 7n, -1n)), at)).toBeNull();
    expect(fillOf(buyCall(ETHER), receipt(taxedLog(ETHER, 0n, TOKEN)), at)).toBeNull();
    expect(fillOf(buyCall(ETHER), receipt(taxedLog(ETHER / 2n, 0n)), at)).toBeNull();
    expect(fillOf(buyCall(ETHER), receipt(taxedLog(ETHER, 0n), taxedLog(ETHER, 0n)), at)).toBeNull();
  });

  it('a drip or an approval spends nothing to fill: null', () => {
    const approve = { to: COIN, value: 0n, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args: [HELPER, 5n] }) };
    expect(fillOf(approve, receipt(), at)).toBeNull();
    expect(fillOf({ to: COIN, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function drip()']), functionName: 'drip' }) }, receipt(), at)).toBeNull();
  });
});

describe('waitForReceipt', () => {
  it('asks until the receipt appears, a failed read included', async () => {
    let n = 0;
    const { rpc } = rpcOf(() => { n += 1; if (n === 1) throw new Error('flaky'); return n < 3 ? null : receiptJson('0x1'); });
    const receipt = await waitForReceipt(rpc, HASH, { sleep: async () => undefined });
    expect(receipt?.status).toBe('success');
    expect(n).toBe(3);
  });
  it('gives up after its time, with null (the box then reconciles by nonce)', async () => {
    let clock = 0;
    const { rpc } = rpcOf(() => null);
    expect(await waitForReceipt(rpc, HASH, { timeoutMs: 10, now: () => clock, sleep: async () => { clock += 6; } })).toBeNull();
  });
});

describe('revertReasonOf: a mined revert, decoded as the trade folder decodes it', () => {
  const call: TradeCall = { to: ROUTER, data: '0x1234', value: 0n };
  const reverting = (data: Hex) => rpcOf((method, params) => {
    expect(method).toBe('eth_call');
    expect(params[1]).toBe('0x20'); // The receipt's own block.
    throw new RpcRequestError('execution reverted', 3, data);
  }).rpc;
  it('the router’s own error and a pool error wrapped by v4', async () => {
    expect(await revertReasonOf(reverting(encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'InsufficientOutput', args: [1n, 2n] })), ME, call, 100_000n, 0x20n)).toBe('insufficient_output');
    const inner = encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'CurveIsClosed', args: [7n] });
    const wrapped = encodeErrorResult({ abi: TRADE_ERRORS, errorName: 'WrappedError', args: [HELPER, '0x575e24b4', inner, '0x'] });
    expect(await revertReasonOf(reverting(wrapped), ME, call, 100_000n, 0x20n)).toBe('curve_closed');
  });
  it('unknown when the call no longer reverts, or reverts with an error the trade folder does not know', async () => {
    expect(await revertReasonOf(rpcOf(() => '0x').rpc, ME, call, 100_000n, 0x20n)).toBe('unknown_revert');
    const other = encodeErrorResult({ abi: parseAbi(['error Nope()']), errorName: 'Nope' });
    expect(await revertReasonOf(reverting(other), ME, call, 100_000n, 0x20n)).toBe('unknown_revert');
  });
});

describe('approvals: their amount and their gas', () => {
  const approve = (amount: bigint): TradeCall => ({ to: COIN, value: 0n, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args: [HELPER, amount] }) });
  it('reads the amount an approve names (zero: a reset or a revocation)', () => {
    expect(approvalAmount(approve(5n))).toBe(5n);
    expect(approvalAmount(approve(0n))).toBe(0n);
    expect(approvalAmount({ to: COIN, value: 0n, data: '0x12345678' })).toBeNull();
  });
  it('sends an approve with its estimate and a third more, at least 100,000, never a trade’s 4M', async () => {
    expect(await approvalGas(rpcOf(() => '0xea60').rpc, ME, approve(5n))).toBe(100_000n); // 60,000 + 20,000 is below the floor
    expect(await approvalGas(rpcOf(() => '0x30d40').rpc, ME, approve(5n))).toBe(200_000n + 66_667n);
    expect(await approvalGas(rpcOf(() => { throw new Error('no estimate'); }).rpc, ME, approve(5n))).toBe(APPROVAL_GAS_FALLBACK);
  });
});

describe('sendFailure: what a failed send means', () => {
  it('nothing sent: the guard, a decline, a wallet that moved, the site’s RPC', () => {
    expect(sendFailure(new TradeRefusedError('stale_read'))).toEqual({ kind: 'not_sent', reason: 'stale_read' });
    expect(sendFailure(new WalletRejectedError())).toEqual({ kind: 'not_sent', reason: 'wallet_rejected' });
    expect(sendFailure(new WalletContextChangedError('chain', 1))).toEqual({ kind: 'not_sent', reason: 'wallet_chain' });
    expect(sendFailure(new WalletContextChangedError('account', 11155111))).toEqual({ kind: 'not_sent', reason: 'wallet_account' });
    expect(sendFailure(new RpcRequestError('timed out', null, undefined))).toEqual({ kind: 'not_sent', reason: 'rpc_failed' });
  });
  it('unclear: the wallet answered with an error after it was asked (reconcile before preparing again)', () => {
    expect(sendFailure(new WalletRequestError('The wallet returned an error: boom'))).toEqual({ kind: 'unclear', reason: 'wallet_error' });
    expect(sendFailure(new Error('anything else'))).toEqual({ kind: 'unclear', reason: 'wallet_error' });
  });
});

describe('settleSend: what became of a send the box did not see settle', () => {
  const QUIET = { reads: 3, ms: 60_000 };
  const track = (patch: Partial<SendTrack> = {}): SendTrack => ({ nonceBefore: 5n, hash: HASH, quietReads: 0, quietSince: null, ...patch });
  /** A chain: the mined and pending nonces, the hash's receipt and its transaction (null: unknown to this RPC). */
  const chainOf = (o: { latest: bigint; pending: bigint; receipt?: '0x1' | null | 'fail'; txNonce?: bigint | null }) => rpcOf((method, params) => {
    if (method === 'eth_getTransactionCount') return hexOf(params[1] === 'pending' ? o.pending : o.latest);
    if (method === 'eth_getTransactionReceipt') { if (o.receipt === 'fail') throw new Error('no answer'); return o.receipt ? receiptJson(o.receipt) : null; }
    if (method === 'eth_getTransactionByHash') return o.txNonce === undefined || o.txNonce === null ? null : { hash: HASH, from: ME, to: HELPER, nonce: hexOf(o.txNonce), input: '0x', value: '0x0', gas: '0x5208', blockNumber: null, blockHash: null };
    throw new Error(`unexpected ${method}`);
  });
  const hexOf = (n: bigint) => `0x${n.toString(16)}`;

  it('reads the nonces first, then the receipt: mined', async () => {
    const { rpc, asked } = chainOf({ latest: 6n, pending: 6n, receipt: '0x1' });
    const outcome = await settleSend(rpc, ME, track(), 0, QUIET);
    expect(outcome.kind).toBe('mined');
    expect(asked).toEqual(['eth_getTransactionCount', 'eth_getTransactionCount', 'eth_getTransactionReceipt']);
  });
  it('replaced once the mined nonce passed the transaction’s own nonce without its receipt, on two looks; waiting before', async () => {
    const taken = chainOf({ latest: 7n, pending: 7n, receipt: null, txNonce: 6n }).rpc;
    const first = await settleSend(taken, ME, track(), 0, QUIET);
    // One look is not enough: a lagging node may answer the receipt a moment late.
    expect(first).toEqual({ kind: 'waiting', track: { ...track(), replacedLooks: 1 } });
    if (first.kind !== 'waiting') throw new Error('settled on one look');
    expect((await settleSend(taken, ME, first.track, 0, QUIET)).kind).toBe('replaced');
    // Another pending transaction before it took the slot the box first saw: this one still waits behind it.
    expect((await settleSend(chainOf({ latest: 6n, pending: 7n, receipt: null, txNonce: 6n }).rpc, ME, track(), 0, QUIET)).kind).toBe('waiting');
  });
  it('a transaction the RPC shows in a block, without a receipt yet, waits', async () => {
    const mined = rpcOf((method, params) => {
      if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? '0x7' : '0x7';
      if (method === 'eth_getTransactionReceipt') return null;
      return { hash: HASH, from: ME, to: HELPER, nonce: '0x6', input: '0x', value: '0x0', gas: '0x5208', blockNumber: '0x20', blockHash: HASH };
    }).rpc;
    expect((await settleSend(mined, ME, track({ replacedLooks: 1 }), 0, QUIET)).kind).toBe('waiting');
  });
  it('a failed receipt read throws (the caller looks again): never mined, never replaced', async () => {
    await expect(settleSend(chainOf({ latest: 7n, pending: 7n, receipt: 'fail', txNonce: 6n }).rpc, ME, track(), 0, QUIET)).rejects.toThrow();
  });
  it('a hash the RPC does not know: replaced only after the quiet period, its slot taken and nothing pending', async () => {
    const { rpc } = chainOf({ latest: 6n, pending: 6n, receipt: null, txNonce: null });
    let state = track();
    for (const at of [0, 30_000]) {
      const outcome = await settleSend(rpc, ME, state, at, QUIET);
      if (outcome.kind !== 'waiting') throw new Error(`settled at ${at}`);
      state = outcome.track;
    }
    expect((await settleSend(rpc, ME, state, 60_000, QUIET)).kind).toBe('replaced');
    // Something pending resets the count.
    const busy = await settleSend(chainOf({ latest: 6n, pending: 7n, receipt: null, txNonce: null }).rpc, ME, state, 61_000, QUIET);
    expect(busy).toEqual({ kind: 'waiting', track: { ...state, quietReads: 0, quietSince: null, replacedLooks: 0 } });
  });
  it('no hash: settled only after the quiet period with nothing pending; sent when the nonce moved on', async () => {
    const unsent = chainOf({ latest: 5n, pending: 5n });
    let state = track({ hash: null });
    for (const at of [0, 20_000]) {
      const outcome = await settleSend(unsent.rpc, ME, state, at, QUIET);
      if (outcome.kind !== 'waiting') throw new Error('settled too soon');
      state = outcome.track;
    }
    // Three reads, but not yet a minute: still waiting.
    expect((await settleSend(unsent.rpc, ME, state, 59_999, QUIET)).kind).toBe('waiting');
    expect(await settleSend(unsent.rpc, ME, { ...state, quietReads: 2 }, 60_000, QUIET)).toEqual({ kind: 'settled', sent: false });
    expect(await settleSend(chainOf({ latest: 6n, pending: 6n }).rpc, ME, { ...state, quietReads: 2 }, 60_000, QUIET)).toEqual({ kind: 'settled', sent: true });
    expect((await settleSend(chainOf({ latest: 5n, pending: 6n }).rpc, ME, { ...state, quietReads: 2 }, 60_000, QUIET)).kind).toBe('waiting');
  });
});
