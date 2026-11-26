import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, erc20Abi, parseAbiItem, toFunctionSelector, type Abi, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { boxCollectionAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { WalletClaimsIndexV2 } from '../../../src/core/v2/claims-index-v2';
import { applyV2Block, type LiveStateV2 } from '../../../src/core/v2/views-v2';
import { decodeV2Logs, routeV2 } from '../../../src/core/v2/events-v2';
import { coordinatorV2Abi, receiverV2Abi, holderLedgerV2Abi, hookV2Abi, itemLedgerV2Abi, receiverItemsV2Abi, vaultItemsV2Abi } from '../../../src/core/v2/chain-v2';
import { m2Fixture, A, B, H, logM2 } from '../../../src/core/v2/m2-fixture.test-support';
import { readCreatorClaimV2 } from '../../../src/core/v2/claims-reads-v2';
import { ClaimsGatewayV2 } from '../../../src/core/v2/claims-gateway-v2';
import { readAllWalletClaimsV2 } from '../../../../chain/src/core/v2/claims-reader';
import type { CoreGatewayOptions } from '../../../src/core/core-gateway';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { m3Fixture, required } from '../../../src/core/v2/m3-fixture.test-support';

const HUGE = 2n ** 120n + 7n;
const header = (number = 100n, hash = H(100)) => ({ number, hash, parentHash: H(99), timestamp: 1000n });
const abis = [erc20Abi, boxCollectionAbi, poolManagerAbi, coordinatorV2Abi, receiverV2Abi, holderLedgerV2Abi, hookV2Abi, itemLedgerV2Abi, receiverItemsV2Abi, vaultItemsV2Abi] as const;
const funded = parseAbiItem('event HolderBatchFunded(uint256 indexed batchId,uint256 netP)');
const settled = parseAbiItem('event BatchSettled(uint256 indexed batchId,uint256 fundingP,uint256 holderP,uint256 residueP)');
const creatorPaid = parseAbiItem('event CreatorClaimed(address indexed payee,address indexed asset,address to,uint256 amount)');
const wrapped = parseAbiItem('error WrappedError(address target,bytes4 selector,bytes reason,bytes details)');
const refusal = (target: Address, native: boolean) => Object.assign(new Error('execution reverted'), { cause: { data: encodeErrorResult({ abi: [wrapped], errorName: 'WrappedError', args: [target, native ? '0x00000000' : '0xa9059cbb', '0x', toFunctionSelector(native ? 'NativeTransferFailed()' : 'ERC20TransferFailed()')] }) } });
const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
const zero = `0x${'0'.repeat(40)}` as Address;

const tokenP = '0x0000000000000000000000000000000000001234' as Address;

function setup(price = zero, withReceipt = false) {
  const baseHolder = m2Fixture(false);
  const holder = { ...baseHolder, row: { ...baseHolder.row, q: price } }; const item = m3Fixture();
  const holderLogs = Array.from({ length: 15 }, (_, i) => BigInt(i + 1)).flatMap((batchId, i) => [
    logM2(funded, holder.at(5), { batchId, netP: HUGE * 3n }, 2 * i, 100n, H(100)),
    logM2(settled, holder.at(17), { batchId, fundingP: HUGE * 3n, holderP: HUGE * 3n, residueP: 0n }, 2 * i + 1, 100n, H(100)),
  ]);
  if (withReceipt) holderLogs.push(logM2(creatorPaid, holder.at(5), { payee: A, asset: price, to: B, amount: 23n }, 60, 100n, H(100)));
  // Own item 70: discovery comes from collection logs, with no 64-owner scan.
  const itemRow = { ...item.row, spec: { ...item.spec, n: 100 } };
  const itemLogs = [logM2(transfer, item.at(4), { from: zero, to: A, tokenId: 70n }, 40, 100n, H(100))];
  const state = (f: typeof holder | typeof item, logs: typeof holderLogs, row = f.row) => applyV2Block(undefined, header(), decodeV2Logs(logs, routeV2(f.release, f.manifest, [], [f.record])), row).state;
  const holderState = state(holder, holderLogs);
  const itemState = state(item, itemLogs, itemRow);
  let head = header();
  const entries = new Map([
    [holder.at(1).toLowerCase(), { row: holder.row, states: [holderState] as LiveStateV2[], verified: true, repairing: false }],
    [item.at(1).toLowerCase(), { row: itemRow, states: [itemState] as LiveStateV2[], verified: true, repairing: false }],
  ]);
  const source = { chainId: holder.row.chainId, boxesV2: entries, head: () => head, hashAt: (n: bigint) => n === 100n ? H(100) : n === head.number ? head.hash : undefined };
  const answers = new Map<string, unknown>();
  const set = (to: Address, fn: string, value: unknown) => answers.set(`${to.toLowerCase()}:${fn}`, value);
  for (const f of [holder, item]) {
    set(f.at(0), 'failed', false); set(f.at(0), 'graduated', true);
    set(f.at(5), 'creatorPayee', B); set(f.at(5), 'creatorOwed', [0n, 0n]);
    set(f.at(1), 'balanceOf', 0n); set(f.at(1), 'allowance', 0n);
  }
  set(holder.at(2), 'tradeBatch', { tradeUnits: 1n, protocolUnits: 0n, netP: HUGE * 3n, closed: true });
  set(holder.at(5), 'holderBatchClosed', true); set(holder.at(5), 'holderBatchPaid', HUGE * 3n);
  set(holder.at(17), 'batchState', [true, 2n, 2n, 0n]); set(holder.at(17), 'claimable', HUGE);
  set(item.at(16), 'fundingCursor', 1n); set(item.at(16), 'lifecycleCursor', 1n);
  set(item.at(5), 'itemFundingCount', 1n); set(item.at(3), 'itemLifecycleCount', 1n);
  set(item.row.poolManager, 'balanceOf', HUGE * 3n);
  set(item.at(16), 'itemCredit', [HUGE, 3n]); set(item.at(4), 'ownerOf', A);
  const callAt = vi.fn(async (to: Address, data: Hex, hash: Hex) => {
    expect(hash).toBe(H(100));
    let abi: Abi | undefined; let fn = ''; let args: readonly unknown[] | undefined;
    for (const candidate of abis) {
      try { const decoded = decodeFunctionData({ abi: candidate, data }); abi = candidate; fn = decoded.functionName; args = decoded.args; break; } catch { /* try next ABI */ }
    }
    if (!abi) throw new Error('unknown selector');
    const answer = answers.get(`${to.toLowerCase()}:${fn}`);
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`unscripted ${fn}`);
    const result = typeof answer === 'function' ? answer(args) : answer;
    return encodeFunctionResult({ abi, functionName: fn, result });
  });
  const callFromAt = vi.fn(async (from: Address, to: Address, data: Hex, hash: Hex) => {
    expect(from).toBe(A.toLowerCase()); expect(hash).toBe(H(100));
    if (to.toLowerCase() === holder.at(17).toLowerCase()) return encodeFunctionResult({ abi: holderLedgerV2Abi, functionName: 'claim', result: HUGE });
    if (to.toLowerCase() === item.at(16).toLowerCase()) return encodeFunctionResult({ abi: itemLedgerV2Abi, functionName: 'claim', result: HUGE + 3n });
    const decoded = decodeFunctionData({ abi: receiverV2Abi, data });
    expect(decoded.functionName).toBe('claimCreator'); expect(decoded.args?.map(String).map(a => a.toLowerCase())).toEqual([holder.row.q, A.toLowerCase()]);
    const stored = answers.get(`${to.toLowerCase()}:creatorOwed`) as readonly [bigint, bigint];
    const simulated = answers.get(`${to.toLowerCase()}:claimCreator`) as bigint | Error | undefined;
    if (simulated instanceof Error) throw simulated;
    return encodeFunctionResult({ abi: receiverV2Abi, functionName: 'claimCreator', result: simulated ?? stored[0] + stored[1] });
  });
  const creatorEntitlementAt = vi.fn(async (wallet: Address, receiver: Address, asset: Address, hash: Hex) => {
    expect(wallet).toBe(A.toLowerCase()); expect(hash).toBe(H(100)); expect(asset).toBe(holder.row.q);
    const amount = answers.get(`${receiver.toLowerCase()}:entitlement`);
    if (amount instanceof Error) throw amount;
    if (typeof amount !== 'bigint') throw new Error('unscripted entitlement');
    return amount;
  });
  const reader = { callAt, callFromAt, creatorEntitlementAt, headerByNumber: vi.fn(async (n: bigint) => ({ ...header(n), hash: source.hashAt(n) ?? H(999) })) };
  const index = new WalletClaimsIndexV2(source, reader);
  const all = async () => {
    const rows = []; let after: string | null = null;
    do { const page = await index.page(A, { limit: 4, after }); rows.push(...page.items); after = page.next; } while (after);
    return rows;
  };
  return { holder, item, entries, source, reader, index, set, all, moveHead: (h: ReturnType<typeof header>) => { head = h; } };
}

describe('CLAIMS-01 complete wallet pages', () => {
  it('finds every holder batch and owned item across boxes, preserving exact raw amounts', async () => {
    const f = setup(); const rows = await f.all();
    expect(rows.filter(r => r.kind === 'holder')).toHaveLength(15);
    expect(rows.find(r => r.kind === 'holder')).toMatchObject({ status: 'claimable', amountP: String(HUGE), roleAddress: f.holder.at(17).toLowerCase(), asOf: { block: '100', hash: H(100) } });
    expect(rows.find(r => r.kind === 'item')).toMatchObject({ itemId: '70', amountP: String(HUGE + 3n), outsideP: String(HUGE), stashP: '3', roleAddress: f.item.at(16).toLowerCase() });
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length);
    expect(rows.every(r => r.wallet === A.toLowerCase())).toBe(true);
  });

  it('uses the current payee and live quote, including fixed no-buyer remainder and late money', async () => {
    const f = setup();
    f.set(f.holder.at(5), 'creatorPayee', A); f.set(f.holder.at(5), 'creatorOwed', [HUGE, 0n]);
    f.set(f.item.at(0), 'failed', true); f.set(f.item.at(0), 'graduated', false);
    f.set(f.item.at(1), 'balanceOf', 7n); f.set(f.item.at(1), 'allowance', 2n);
    f.set(f.item.at(0), 'claimState', [HUGE, 9n]); f.set(f.item.at(0), 'quoteClaim', HUGE * 7n / 9n);
    f.set(f.item.at(16), 'itemCredit', [0n, 0n]);
    const rows = await f.all();
    expect(rows.find(r => r.kind === 'creator')).toMatchObject({ amountP: String(HUGE), roleAddress: f.holder.at(5).toLowerCase() });
    expect(rows.find(r => r.kind === 'failure')).toMatchObject({ coinsT: '7', allowanceT: '2', amountP: String(HUGE * 7n / 9n) });
    const entry = required(f.entries.get(f.item.at(1).toLowerCase()));
    f.entries.set(f.item.at(1).toLowerCase(), { ...entry, row: { ...entry.row, creator: A } });
    f.set(f.item.at(1), 'balanceOf', 0n); f.set(f.item.at(0), 'claimState', [HUGE + 19n, 0n]);
    f.set(f.item.at(0), 'quoteClaim', 101n);
    expect((await f.all()).find(r => r.kind === 'no_buyer')).toMatchObject({ amountP: '101', coinsT: '0' });
    f.set(f.holder.at(5), 'creatorPayee', B);
    expect((await f.all()).some(r => r.kind === 'creator')).toBe(false);
  });

  it('does not mistake zero balances for read failures or omit unsynced item credit', async () => {
    const f = setup(); f.set(f.item.at(16), 'fundingCursor', 0n);
    expect((await f.all()).find(r => r.kind === 'item')).toMatchObject({ status: 'pending', amountP: null });
    f.set(f.holder.at(17), 'claimable', new Error('RPC timeout'));
    await expect(f.all()).rejects.toThrow();
  });

  it('continues through empty pages and holds the original hash across advancing heads', async () => {
    const f = setup(); f.set(f.holder.at(17), 'claimable', 0n);
    const first = await f.index.page(A, { limit: 1 });
    f.moveHead(header(101n, H(101)));
    const second = await f.index.page(A, { limit: 1, after: first.next });
    expect(second.asOf).toEqual(first.asOf);
    expect(first.next).not.toBeNull();
    const rows = [...first.items, ...second.items]; let after = second.next;
    do { const page = await f.index.page(A, { limit: 2, after }); rows.push(...page.items); after = page.next; } while (after);
    expect(rows.some(r => r.kind === 'item')).toBe(true);
  });

  it('invalidates pages on reorg, repair, changed inventory, and cross-wallet cursor reuse', async () => {
    const f = setup(); const first = await f.index.page(A, { limit: 1 });
    await expect(f.index.page(B, { limit: 1, after: first.next })).rejects.toThrow(/cursor/i);
    f.reader.headerByNumber.mockResolvedValueOnce(header(100n, H(999)));
    await expect(f.index.page(A, { limit: 1, after: first.next })).rejects.toThrow(/canonical|reorg/i);
    required(f.entries.values().next().value).repairing = true;
    await expect(f.index.page(A)).rejects.toThrow(/repair|unavailable/i);
  });

  it('quotes lazy creator money from the actual call, even when creatorOwed is still zero', async () => {
    const f = setup();
    f.set(f.holder.at(5), 'creatorPayee', A); f.set(f.holder.at(5), 'claimCreator', HUGE);
    expect((await f.all()).find(r => r.kind === 'creator')).toMatchObject({ amountP: String(HUGE), payout: 'available' });
  });

  it.each([true, false])('AF1 keeps a refused creator claim and every other box/receipt through the gateway (native=%s)', async native => {
    const f = setup(native ? zero : tokenP, true);
    const receiver = f.holder.at(5);
    f.set(receiver, 'creatorPayee', A);
    f.set(receiver, 'claimCreator', refusal(native ? A : f.holder.row.q, native));
    f.set(receiver, 'entitlement', HUGE);
    const entry = required(f.entries.get(f.holder.at(1).toLowerCase()));
    const options = { source: { chainId: entry.row.chainId, health: () => ({ following: true, reason: null, history: null }) }, port: 5391, host: '127.0.0.1' } as unknown as CoreGatewayOptions;
    const gateway = new ClaimsGatewayV2(options, f.index);
    const fetcher = async (input: string | URL | Request) => {
      const response = { status: 0, body: '', writeHead(status: number) { this.status = status; }, end(body = '') { this.body = body; } };
      const url = new URL(String(input));
      await gateway.route({ url: url.pathname + url.search, method: 'GET' } as IncomingMessage, response as unknown as ServerResponse);
      return new Response(response.body, { status: response.status });
    };
    const page = await readAllWalletClaimsV2({ baseUrl: 'https://index.example', chainId: entry.row.chainId, wallet: A, limit: 4, fetch: fetcher });
    expect(page.items.filter(r => r.kind === 'holder')).toHaveLength(15);
    expect(page.items.find(r => r.kind === 'item')).toMatchObject({ itemId: '70', amountP: String(HUGE + 3n) });
    expect(page.items.find(r => r.kind === 'creator' && r.status === 'claimable')).toMatchObject({ amountP: String(HUGE), payout: 'unavailable', asset: entry.row.q });
    expect(page.items.find(r => r.status === 'claimed')).toMatchObject({ kind: 'creator', amountP: '23', payment: { to: B.toLowerCase() } });
  });

  it('AF1 uses the independently settled bounded entitlement, including zero', async () => {
    const f = setup(tokenP); const receiver = f.holder.at(5);
    f.set(receiver, 'creatorPayee', A); f.set(receiver, 'creatorOwed', [0n, 0n]);
    f.set(receiver, 'claimCreator', refusal(f.holder.row.q, false));
    const cap = 4n * ((1n << 127n) - 1n);
    f.set(receiver, 'entitlement', cap);
    expect(await readCreatorClaimV2(f.reader, f.holder.row, A.toLowerCase() as Address, H(100))).toEqual({ amountP: cap, payout: 'unavailable' });
    f.set(receiver, 'entitlement', 0n);
    expect(await readCreatorClaimV2(f.reader, f.holder.row, A.toLowerCase() as Address, H(100))).toBeNull();
  });

  it.each([
    new Error('RPC timeout'),
    Object.assign(new Error('not canonical'), { code: -32000 }),
    Object.assign(new Error('unknown execution revert'), { code: 3, data: '0x12345678' }),
    Object.assign(new Error('not payee'), { data: encodeErrorResult({ abi: receiverV2Abi, errorName: 'NotPayee', args: [A] }) }),
    refusal(B, false),
  ])('AF1 does not conceal infrastructure or unrelated contract errors: %s', async error => {
    const f = setup(tokenP); f.set(f.holder.at(5), 'creatorPayee', A);
    f.set(f.holder.at(5), 'claimCreator', error);
    await expect(f.all()).rejects.toThrow(error.message);
    expect(f.reader.creatorEntitlementAt).not.toHaveBeenCalled();
  });

  it('AF1 keeps an unavailable canonical quote explicit instead of using stale creatorOwed', async () => {
    const f = setup(tokenP); const receiver = f.holder.at(5);
    f.set(receiver, 'creatorPayee', A); f.set(receiver, 'creatorOwed', [17n, 0n]);
    f.set(receiver, 'claimCreator', refusal(f.holder.row.q, false));
    f.set(receiver, 'entitlement', new Error('quote block no longer canonical'));
    await expect(f.all()).rejects.toThrow('quote block no longer canonical');
  });

  it('retains zero-P hand-ins and propagates retired or unknown quote errors', async () => {
    const f = setup();
    f.set(f.holder.at(0), 'failed', true); f.set(f.holder.at(0), 'graduated', false);
    f.set(f.holder.at(1), 'balanceOf', 1n); f.set(f.holder.at(0), 'claimState', [0n, 1n]);
    f.set(f.holder.at(0), 'quoteClaim', 0n);
    expect((await f.all()).find(r => r.kind === 'failure')).toMatchObject({ coinsT: '1', amountP: '0' });
    const swept = Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: [parseAbiItem('error Error(string)')], errorName: 'Error', args: ['ClaimsSwept'] }) });
    f.set(f.holder.at(0), 'quoteClaim', swept);
    await expect(f.all()).rejects.toBe(swept);
    f.set(f.holder.at(0), 'quoteClaim', new Error('RPC timeout'));
    await expect(f.all()).rejects.toThrow('RPC timeout');
  });

  it('rejects a reorg that lands during contract reads and a newly admitted box mid-pagination', async () => {
    const f = setup();
    f.reader.headerByNumber.mockResolvedValueOnce(header()).mockResolvedValueOnce(header(100n, H(999)));
    await expect(f.index.page(A)).rejects.toThrow(/reorg/i);
    const first = await f.index.page(A, { limit: 1 });
    f.entries.delete(f.item.at(1).toLowerCase());
    await expect(f.index.page(A, { after: first.next })).rejects.toThrow(/inventory|cursor/i);
  });
});
