import { rememberVaultMove, PENDING_VAULT_MOVES_KEY, resetPendingVaultMovesForTests, pendingVaultMoveLine, type PendingVaultMoveV2 } from './vault-operations';
/**
 * SH-TA-33: the vault items' calls through the real shared sender (`submitWrite` and its v2 guard). The chain reads are a
 * double (`VaultItemsIO`); the tests read the exact transactions the wallet was asked to send, and pin what is refused
 * before the wallet is asked anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { WaitForTransactionReceiptTimeoutError, decodeFunctionData, encodeErrorResult, encodeFunctionResult, erc20Abi, getAddress, maxUint256, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { NotSendableError, PreSendRefusalError, WalletRejectedError, preSendRefusalText, submitWrite } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { vaultV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import type { ItemsHistory } from './m3-data';
import { A, B, ETH, H, publishedItems, publishedPile } from './test-support/m3-published';
import { required } from './test-support/required';
import type { RpcCall } from './test-support/m2-rpc';
import { rpcFetch } from './test-support/rpc-fetch';
import { nodeUnavailable, revertWith, vaultRpcFetch } from './test-support/vault-rpc';
import { bagHoldersItem, rentFreeItem, threeDFixtureItem } from './test-support/item-models';
import { rawCidV1, sha256Hex } from '@squarehole/artwork';
import {
  DEADLINE_SECONDS, FLOOR_READS, FLOOR_WAIT_MS, REFRESH_LINE, VAULT_PAGE, feeOf, insideCandidates, mineCandidates, modelUrlV2, readItemsV2, returnLimit, sendPutBackV2, sendTakeOutV2, takeLimit,
  approvalThenRefusal, vaultErrorText, vaultItemsIO, vaultRolesOf, vaultTargetV2, type VaultCoinsV2, type VaultItemV2, type VaultItemsIO, type VaultQuoteV2, type VaultStepV2,
} from './vault-items';
import { ITEM_NOT_REVEALED, REASON_FALLBACK, REASON_WORDS } from './reveal-words';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

type Tx = { from: Address; to: Address; data: Hex; value: Hex; gas: Hex; chainId: Hex };
let wallet: Mock<Eip1193Request>;
beforeEach(() => { resetPendingVaultMovesForTests(); localStorage.clear(); wallet = vi.fn<Eip1193Request>(async ({ method }) => method === 'eth_chainId' ? '0x7a69' : method === 'eth_sendTransaction' ? H(77) : [A]); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sends = (): Tx[] => wallet.mock.calls.filter(([call]) => call.method === 'eth_sendTransaction').map(([call]) => (call.params as readonly Tx[])[0] as Tx);

const NOW = 1_800_000_000n;
const TAKE = 250_000_000n * ETH + 7n; // above the safe integer range, kept bigint end to end
const BACK = 240_000_000n * ETH + 3n;
const quote = (patch: Partial<VaultQuoteV2> = {}): VaultQuoteV2 => ({ takeT: TAKE, returnT: BACK, inside: 2n, pickFeeBps: 100n, returnFeeBps: 100n, lastItem: false, ...patch });

async function box(patch: Partial<V2Snapshot> = {}, known?: NonNullable<Parameters<typeof publishedItems>[0]>['known']) {
  const { body, source } = await publishedItems(known ? { known } : {});
  const parsed = parseSnapshotV2(body, source);
  // The synthetic publication's creation gate is closed; the vault actions need it open, as on a loaded box.
  const view = { ...parsed, gate: { ...parsed.gate, open: true }, ...patch };
  const roles = required(vaultRolesOf(view));
  return { view, source, roles };
}

interface Double {
  readonly item?: Partial<VaultItemV2>; readonly quote?: Partial<VaultQuoteV2>; readonly balance?: bigint; readonly allowance?: bigint; readonly approved?: boolean;
  /** SH-235: the coin reads as a node answers them (the block asked for at least, and the read's own block). */
  readonly coins?: (atLeast: bigint) => VaultCoinsV2;
}
function io(d: Double = {}): VaultItemsIO {
  let approved = d.approved ?? false;
  return {
    head: async (floor = 0n) => floor > 9n ? floor : 9n, counts: async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending: 0n }), balanceOf: async () => 0n,
    feeReader: TEST_FEE_READER, chainId: async () => 31337, request: wallet,
    simulate: vi.fn(async () => undefined), estimate: async () => 200_000n, submit: submitWrite,
    receiptOnce: async () => null,
    receipt: async (hash) => { approved = true; return { transactionHash: hash, blockNumber: 9n, blockHash: H(9), status: 'success' as const }; },
    quote: async () => quote(d.quote),
    item: async (id) => ({ id, owner: A, onShelf: true, outside: false, revealed: true, imageHash: H(5), modelHash: null, ...d.item }),
    coins: async (_account, atLeast = 0n) => d.coins?.(atLeast) ?? ({ balance: d.balance ?? 2n * TAKE, allowance: d.allowance ?? 0n, block: atLeast > 9n ? atLeast : 9n }),
    itemApproved: async () => approved,
    now: async () => NOW,
  };
}

describe('SH-TA-33 vault roles and figures', () => {
  it('an every-item box has a vault and a collection; a coin pile has none to list', async () => {
    const { view, roles } = await box();
    expect(roles).toMatchObject({ tickets: null, n: view.spec.n, firstId: view.spec.firstId });
    expect(roles.vault).not.toBe(roles.collection);
    const pile = await publishedPile();
    expect(vaultRolesOf(parseSnapshotV2(pile.body, pile.source))).toBeNull();
  });
  it('fees round up like VaultViews.fee; the limits move at most 1% and stay bigint', () => {
    expect(feeOf(10_001n, 100n)).toBe(101n);
    expect(feeOf(10_000n, 100n)).toBe(100n);
    expect(feeOf(5n, 0n)).toBe(0n);
    expect(feeOf(maxUint256 / 10_000n, 100n)).toBe((maxUint256 / 10_000n) / 100n + 1n);
    expect(takeLimit(TAKE)).toBe(TAKE + TAKE / 100n);
    expect(returnLimit(BACK)).toBe(BACK - BACK / 100n);
  });
});

describe('SH-TA-33 what one item brings back, read from the vault (XR-SH-TA-33 F2)', () => {
  // The vault double over JSON-RPC: 9 items inside, 900 raw T in circulation, 1% fees. quoteReturn(1) answers per case.
  const refusal = (errorName: 'InvalidQuantity' | 'ReturnBelowUnit', args: readonly [bigint, bigint]) =>
    Object.assign(new Error('execution reverted'), { code: 3, data: encodeErrorResult({ abi: vaultV2Abi, errorName, args }) });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /** Stubs fetch with the vault's answers; `hang` holds quoteReturn until viem's own 10 s request timeout aborts it. */
  function vaultRpc(quoteReturn: () => bigint, { outside = 0n, active = 900n, hang = false } = {}) {
    const asked: string[] = [];
    const timedOut = { aborted: false };
    let heard: () => void = () => undefined;
    const quoteReturnSent = new Promise<void>((done) => { heard = done; });
    const answers: Record<string, () => unknown> = {
      inside: () => 9n, pickFeeBps: () => 100n, returnFeeBps: () => 100n, quoteWithdraw: () => 101n, quoteReturn, outside: () => outside, activeSupply: () => active,
    };
    const answer = rpcFetch(async ({ method, params }: RpcCall) => {
      if (method === 'eth_chainId') return '0x7a69';
      const { functionName } = decodeFunctionData({ abi: vaultV2Abi, data: (params?.[0] as { data: Hex }).data });
      asked.push(functionName);
      return encodeFunctionResult({ abi: vaultV2Abi, functionName, result: required(answers[functionName])() } as never);
    });
    vi.stubGlobal('fetch', (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as RpcCall;
      const call = body.method === 'eth_call' ? decodeFunctionData({ abi: vaultV2Abi, data: (body.params?.[0] as { data: Hex }).data }).functionName : null;
      if (call === 'quoteReturn') heard();
      if (call === 'quoteReturn' && hang) {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => {
          timedOut.aborted = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        }));
      }
      return answer(url, init);
    }) as typeof fetch);
    return { asked, quoteReturnSent, timedOut };
  }
  const read = async () => { const { view, source } = await box(); return vaultItemsIO(source, view, wallet); };

  it('an unanswered quote (the RPC times out) stays unread: null, never a calculated amount', async () => {
    const reader = await read();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rpc = vaultRpc(() => 120n, { hang: true });
    const pending = reader.quote();
    await rpc.quoteReturnSent;
    expect(rpc.timedOut.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    const q = await pending;
    expect(rpc.timedOut.aborted, 'viem’s own request timeout ended the read').toBe(true);
    expect(q.returnT).toBeNull();
    expect(q.takeT).toBe(101n + feeOf(101n, 100n));
    expect(rpc.asked).not.toContain('activeSupply');
  });
  it.each<[string, () => bigint, { outside?: bigint }]>([
    ['another refusal (ReturnBelowUnit)', () => { throw refusal('ReturnBelowUnit', [0n, 1n]); }, {}],
    ['a revert without a reason', () => { throw Object.assign(new Error('execution reverted'), { code: 3 }); }, {}],
    ['InvalidQuantity(1, 0) while the vault counts an item outside', () => { throw refusal('InvalidQuantity', [1n, 0n]); }, { outside: 1n }],
  ])('%s stays unread: null, and the put-back refuses', async (_name, quoteReturn, state) => {
    const reader = await read();
    vaultRpc(quoteReturn, state);
    expect((await reader.quote()).returnT).toBeNull();
  });
  it('the vault’s refusal while no item is out, InvalidQuantity(1, 0): one item brings back activeSupply / inside less the fee', async () => {
    const reader = await read();
    const rpc = vaultRpc(() => { throw refusal('InvalidQuantity', [1n, 0n]); });
    const q = await reader.quote();
    expect(q.returnT).toBe(900n / 9n - feeOf(900n / 9n, 100n));
    expect(q.returnT).toBe(99n);
    expect(rpc.asked).toEqual(expect.arrayContaining(['quoteReturn', 'outside', 'activeSupply']));
  });
  it('that refusal with less than one unit per item (nothing in circulation) stays unread, as the vault refuses it too', async () => {
    const reader = await read();
    vaultRpc(() => { throw refusal('InvalidQuantity', [1n, 0n]); }, { active: 0n });
    expect((await reader.quote()).returnT).toBeNull();
  });
  it('an answered quote is the vault’s own, less the fee', async () => {
    const reader = await read();
    vaultRpc(() => 120n);
    expect((await reader.quote()).returnT).toBe(120n - feeOf(120n, 100n));
  });
});

describe('SH-TA-33 one item, read from the vault and the collection (XR-SH-TA-33-R2 F3)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const ZERO = `0x${'0'.repeat(64)}` as Hex;
  /** The real item reader over the JSON-RPC double: item 1 outside (or inside) the vault; `owner` answers ownerOf alone. */
  async function reader(owner: (id: bigint) => unknown, outside = true) {
    const { view, source } = await box();
    const rpc = vaultRpcFetch({
      getApproved: () => A, isApprovedForAll: () => true,
      ownerOf: ([id]) => owner(id as bigint), isOnShelf: () => !outside, isOutside: () => outside, traitsOf: () => [true, 0n, H(5), ZERO],
    });
    vi.stubGlobal('fetch', rpc.fetch);
    return { io: vaultItemsIO(source, view, wallet), rpc, view, source };
  }

  it.each<[string, () => unknown]>([
    ['the node did not answer', () => { throw nodeUnavailable(); }],
    ['a revert without a reason', () => { throw revertWith(); }],
  ])('an outside item whose owner is unread (%s) fails its read: counted unavailable, never absent', async (_name, fail) => {
    const { io, rpc, view, source } = await reader(fail);
    const error = await io.item(1n).catch((e: unknown) => e);
    expect(vaultErrorText(error)).toBe('Item #1 unavailable. Refresh and try again.');
    expect(rpc.asked.map((read) => read.name)).toEqual(expect.arrayContaining(['ownerOf', 'isOnShelf', 'isOutside', 'traitsOf']));
    expect(await readItemsV2(io, [1n])).toEqual({ items: [], failed: 1 });
    // Put back stops at the same read, before the wallet is asked to send anything.
    await expect(sendPutBackV2(source, view, A, 1n, BACK, io)).rejects.toThrow('Item #1 unavailable');
    expect(sends()).toHaveLength(0);
  });
  it('an outside item with its owner read is that owner’s', async () => {
    const { io } = await reader(() => A);
    expect(await io.item(1n)).toEqual({ id: 1n, owner: A, onShelf: false, outside: true, revealed: true, imageHash: H(5), modelHash: null });
    expect(await readItemsV2(io, [1n])).toMatchObject({ failed: 0 });
  });
  it('no owner is expected for an item in the vault, or for an id the collection does not hold (ERC721NonexistentToken)', async () => {
    const inside = await reader(() => { throw nodeUnavailable(); }, false);
    expect(await inside.io.item(2n)).toMatchObject({ id: 2n, owner: null, onShelf: true, outside: false });
    const missing = await reader((id) => { throw revertWith(encodeErrorResult({ abi: boxCollectionAbi, errorName: 'ERC721NonexistentToken', args: [id] })); });
    expect(await missing.io.item(1n)).toMatchObject({ id: 1n, owner: null, outside: true });
    // Another id's refusal is not this one's absence.
    const other = await reader(() => { throw revertWith(encodeErrorResult({ abi: boxCollectionAbi, errorName: 'ERC721NonexistentToken', args: [9n] })); });
    expect(await other.io.item(1n).catch((e: unknown) => vaultErrorText(e))).toBe('Item #1 unavailable. Refresh and try again.');
  });
});

describe('T06 a revealed item’s 3D model: the hash traitsOf commits, and where it is asked for', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const ZERO = `0x${'0'.repeat(64)}` as Hex;
  const rent = rentFreeItem(); const bags = bagHoldersItem(); const create = threeDFixtureItem(1);
  /** The real item reader over the JSON-RPC double, with traitsOf answering (revealed, traits, image, model). */
  async function itemWith(traits: readonly [boolean, bigint, Hex, Hex]) {
    const { view, source } = await box();
    const rpc = vaultRpcFetch({ ownerOf: () => A, isOnShelf: () => true, isOutside: () => false, traitsOf: () => traits });
    vi.stubGlobal('fetch', rpc.fetch);
    return vaultItemsIO(source, view, wallet).item(1n);
  }

  it.each([['Rent Free #1', rent], ['Bag Holders #1', bags], ['Create’s 3D fixture #1 (T01)', create]])('keeps %s’s nonzero model hash, read with its picture’s', async (_name, art) => {
    const item = await itemWith([true, 1n, art.pictureSha256, art.modelSha256]);
    expect(item).toMatchObject({ revealed: true, imageHash: art.pictureSha256, modelHash: art.modelSha256 });
    // The committed hash is the GLB's whole-file SHA-256, the one loadItemModel checks the bytes against.
    expect(art.modelSha256).toBe(`0x${sha256Hex(art.model).replace(/^0x/, '')}`);
  });
  it('a 2D item (a zero model hash) and an unrevealed item have none: no model is ever asked for them', async () => {
    expect((await itemWith([true, 1n, rent.pictureSha256, ZERO])).modelHash).toBeNull();
    // Hidden art: the chain stores no hash before the reveal; even a nonzero one is never used while unrevealed.
    expect(await itemWith([false, 0n, ZERO, rent.modelSha256])).toMatchObject({ revealed: false, imageHash: null, modelHash: null });
  });
  it('modelUrlV2: the source’s first gateway only (XR-ITEM-3D-V2 F3), by the raw CIDv1 of the hash (BoxCollectionV2’s animation_url); none without a hash or a gateway', () => {
    const cid = rawCidV1(rent.modelSha256);
    expect(cid).toMatch(/^bafkrei[a-z2-7]{52}$/);
    expect(modelUrlV2(rent.modelSha256, ['https://api.squarehole.fun', 'http://127.0.0.1:8595'])).toBe(`https://api.squarehole.fun/ipfs/${cid}`);
    expect(modelUrlV2(rent.modelSha256, ['http://127.0.0.1:8595'])).toBe(`http://127.0.0.1:8595/ipfs/${cid}`);
    expect(modelUrlV2(null, ['https://api.squarehole.fun'])).toBeNull();
    expect(modelUrlV2(rent.modelSha256, [])).toBeNull();
  });
});

describe('SH-TA-33 which items are read', () => {
  const history = (known: Record<string, boolean>, owners?: Record<string, Address | null>): ItemsHistory => ({
    policies: { buyers: 1, sellers: 2 }, outsideIndex: 0n, paidPerItem: 0n, fundedP: 0n, retainedBurnP: 0n, flushedP: 0n, fundingCursor: 0n, lifecycleCursor: 0n,
    known: Object.entries(known).map(([id, inside], i) => ({ id: BigInt(id), inside, sequence: BigInt(i) })), ...(owners ? { owners } : {}), openDraws: 0, noticesFailed: 0n,
  });
  const roles = { vault: A, collection: B, tickets: null, firstId: 1n, n: 30 };
  it('without tickets: every id the history does not place outside, paged', () => {
    const page0 = insideCandidates(roles, history({ '1': false, '2': true, '5': false }), 0);
    expect(page0.ids).toEqual([2n, 3n, 4n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n]);
    expect(page0.pages).toBe(Math.ceil(28 / VAULT_PAGE));
    expect(insideCandidates(roles, history({ '1': false, '5': false }), 2).ids).toEqual([27n, 28n, 29n, 30n]);
    expect(insideCandidates(roles, null, 0).ids[0]).toBe(1n);
  });
  it('with the draw add-on: only the items that left and came back (the rest stay hidden for draws)', () => {
    const drawn = { ...roles, tickets: A };
    expect(insideCandidates(drawn, history({ '9': true, '4': true, '7': false }), 0)).toEqual({ ids: [4n, 9n], pages: 1 });
  });
  it('the wallet’s own: outside with this owner, this visit’s takes first, every one of them (SH-235: no cap of 24)', () => {
    const took = (id: bigint, block = 9n) => ({ id, inside: false, account: A, block });
    expect(mineCandidates(history({ '1': false, '2': false, '3': true }, { '1': A, '2': B, '3': null }), A, [took(7n)])).toEqual([7n, 1n]);
    expect(mineCandidates(history({ '1': false, '2': false }), A)).toEqual([1n, 2n]);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(i + 1), false]));
    expect(mineCandidates(history(many), A)).toHaveLength(40);
    expect(mineCandidates(null, A, [took(3n, 10n), took(3n)])).toEqual([3n]);
  });
  it('a failed item read is counted apart, never dropped as an absent item (XR-SH-TA-33 F3)', async () => {
    const reader = { item: async (id: bigint): Promise<VaultItemV2> => {
      if (id === 2n) throw new Error('The request took too long to respond.');
      return { id, owner: null, onShelf: true, outside: false, revealed: true, imageHash: null, modelHash: null };
    } };
    const reads = await readItemsV2(reader, [1n, 2n, 3n]);
    expect(reads.items.map((item) => item.id)).toEqual([1n, 3n]);
    expect(reads.failed).toBe(1);
    expect(await readItemsV2(reader, [])).toEqual({ items: [], failed: 0 });
  });
});

describe('SH-TA-33 take one out', () => {
  it('approves exactly the limit to the vault, then withdraw(id, limit, now + 20 min): two confirmations, zero value', async () => {
    const { view, source, roles } = await box();
    const steps: VaultStepV2[] = [];
    const result = await sendTakeOutV2(source, view, A, 3n, TAKE, io(), (step) => steps.push(step));
    expect(steps).toEqual(['checking', 'approve', 'checking', 'confirming', 'checking', 'checking', 'withdraw', 'checking', 'confirming', 'checking']);
    expect(result.approval).not.toBeNull();
    const [approve, withdraw] = sends();
    expect(sends()).toHaveLength(2);
    expect(approve?.to).toBe(view.token);
    expect(decodeFunctionData({ abi: erc20Abi, data: required(approve).data })).toMatchObject({ functionName: 'approve', args: [roles.vault, takeLimit(TAKE)] });
    expect(withdraw?.to).toBe(roles.vault);
    expect(decodeFunctionData({ abi: vaultV2Abi, data: required(withdraw).data })).toMatchObject({ functionName: 'withdraw', args: [3n, takeLimit(TAKE), NOW + DEADLINE_SECONDS] });
    for (const tx of sends()) { expect(tx.from).toBe(A); expect(tx.value).toBe('0x0'); expect(tx.chainId).toBe('0x7a69'); }
  });
  it('SH-258 round 4: two takes of one item at once (two wrappers, one store): one withdraw, the second refused by the pending move', async () => {
    const { view, source } = await box();
    const results = await Promise.allSettled([
      sendTakeOutV2(source, view, A, 3n, TAKE, io({ allowance: takeLimit(TAKE) }), () => undefined),
      sendTakeOutV2(source, view, A, 3n, TAKE, io({ allowance: takeLimit(TAKE) }), () => undefined),
    ]);
    expect(sends()).toHaveLength(1);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
  it('SH-258 round 4: an approval confirmed, then the withdrawal refused before the wallet: on chain 97 the line says both; elsewhere the earlier line', async () => {
    const { view, source } = await box();
    const d = io(); let estimates = 0;
    const double = { ...d, estimate: async () => (++estimates === 1 ? 200_000n : 20_000_000n) };
    // This fixture's chain (31337) keeps the earlier line (parity): the approval went out, the withdrawal did not.
    await expect(sendTakeOutV2(source, view, A, 3n, TAKE, double, () => undefined)).rejects.toThrow(REASON_FALLBACK);
    expect(sends()).toHaveLength(1);
    // On chain 97 the executor's refusal is named, with the confirmed approval.
    const refusal = preSendRefusalText(new PreSendRefusalError('The gas estimate plus its safety margin does not fit in one transaction (16,777,216 gas); nothing was sent.', 97));
    const line = approvalThenRefusal(true, refusal ?? '');
    expect(line).toBe('Approval confirmed. The withdrawal was not sent: the gas estimate plus its safety margin does not fit in one transaction (16,777,216 gas).');
    expect(vaultErrorText(new Error(line))).toBe(line);
    expect(approvalThenRefusal(false, 'The network gave no usable gas price; nothing was sent. Try again.')).toBe('Approval confirmed. The return was not sent: the network gave no usable gas price. Try again.');
  });
  it('skips the approval when the allowance already covers the limit: one confirmation', async () => {
    const { view, source, roles } = await box();
    const steps: VaultStepV2[] = [];
    const result = await sendTakeOutV2(source, view, A, 3n, TAKE, io({ allowance: takeLimit(TAKE) }), (step) => steps.push(step));
    expect(steps).toEqual(['checking', 'checking', 'withdraw', 'checking', 'confirming', 'checking']); expect(result.approval).toBeNull();
    expect(sends().map((tx) => tx.to)).toEqual([roles.vault]);
  });
  it.each<[string, Double, Partial<V2Snapshot>, RegExp]>([
    ['a price above the 1% limit', { quote: { takeT: takeLimit(TAKE) + 1n } }, {}, /^The price changed\. Refresh and try again\.$/],
    // SH-235: an unread price and an unrevealed item say what is true (the lines pinned before: price changed, no longer in the vault).
    ['an unread price', { quote: { takeT: null } }, {}, /^Price unavailable\. Refresh and try again\.$/],
    ['the last item', { quote: { takeT: null, lastItem: true } }, {}, /last item stays/],
    ['an item no longer in the vault', { item: { onShelf: false, outside: true } }, {}, /no longer in the vault/],
    ['an unrevealed item', { item: { revealed: false } }, {}, new RegExp(`^${ITEM_NOT_REVEALED}$`)],
    ['too few coins', { balance: TAKE - 1n }, {}, /More than this wallet holds/],
    ['a stale read', {}, { stale: true }, /Refresh before sending/],
    ['an unverified read', {}, { verified: false }, /Refresh before sending/],
    ['a closed box', {}, { failed: { cause: 'Deadline', at: 1n } }, /closed/],
  ])('refuses %s before the wallet is asked to send', async (_name, double, patch, message) => {
    const { view, source } = await box(patch);
    await expect(sendTakeOutV2(source, view, A, 3n, TAKE, io(double))).rejects.toThrow(message);
    expect(sends()).toHaveLength(0);
  });
  it('refuses a closed gate and a changed wallet before anything is sent', async () => {
    const { view, source } = await box();
    await expect(sendTakeOutV2(source, { ...view, gate: { ...view.gate, open: false } }, A, 3n, TAKE, io())).rejects.toThrow(/opens with the box/);
    wallet.mockImplementation(async ({ method }) => method === 'eth_chainId' ? '0x7a69' : [B]);
    await expect(sendTakeOutV2(source, view, A, 3n, TAKE, io())).rejects.toThrow(/Wallet changed/);
    expect(sends()).toHaveLength(0);
  });
  it('the shared guard refuses wiring where the vault and the collection are one address, before the wallet', async () => {
    const { view, source } = await box();
    const contracts = [...view.record.contracts]; contracts[4] = required(contracts[3]);
    const broken = { ...view, record: { ...view.record, contracts } };
    const error = await sendTakeOutV2(source, broken, A, 3n, TAKE, io()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotSendableError);
    expect(vaultErrorText(error)).toBe('Not sent. Nothing reached your wallet.');
    expect(sends()).toHaveLength(0);
  });
  it('a declined approval stops before the take', async () => {
    const { view, source } = await box();
    wallet.mockImplementation(async ({ method }) => { if (method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); return method === 'eth_chainId' ? '0x7a69' : [A]; });
    const steps: VaultStepV2[] = [];
    const error = await sendTakeOutV2(source, view, A, 3n, TAKE, io(), (step) => steps.push(step)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletRejectedError); expect(vaultErrorText(error)).toBe('Declined in your wallet.');
    expect(steps).toEqual(['checking', 'approve', 'checking']);
  });
});

describe('SH-235 the sender reads no older than what this card saw confirmed (XR-ITEMS-CARD S1)', () => {
  /**
   * A chain whose head is `head` with this wallet's allowance spent (0); a node behind it (`stale`, or none) answers its
   * block with the old allowance, for a read asked at that block or earlier. Each confirmed transaction mines one block;
   * an approval sets the allowance it names. `honour` false: the reader returns the old answer whatever block was asked
   * for (a reader that ignores the floor).
   */
  function chain({ head = 20n, stale = { block: 10n, allowance: takeLimit(TAKE) } as { readonly block: bigint; readonly allowance: bigint } | null, honour = true, spentAfterFirstRead = false } = {}) {
    let block = head; let allowance = 0n; let reads = 0;
    const coinReads: bigint[] = []; const simulated: (bigint | undefined)[] = []; const estimated: (bigint | undefined)[] = []; const receipts: bigint[] = [];
    const base = io();
    const double: VaultItemsIO = {
      ...base,
      head: async (floor = 0n) => stale && (!honour || floor <= stale.block) ? stale.block : block,
      coins: async (_account, atLeast = 0n) => {
        coinReads.push(atLeast); reads += 1;
        // Another tab's take spends the allowance between this run's first read and its re-read.
        if (spentAfterFirstRead && reads === 2) allowance = 0n;
        return stale === null || (honour && atLeast > stale.block) ? { balance: 2n * TAKE, allowance, block } : { balance: 2n * TAKE, allowance: stale.allowance, block: stale.block };
      },
      simulate: vi.fn(async (_to: Address, _data: Hex, _account: Address, at?: bigint) => { simulated.push(at); }),
      estimate: async (_to, _data, _account, at) => { estimated.push(at); return 200_000n; },
      receipt: async (hash) => {
        block += 1n; receipts.push(block);
        const tx = required(sends().at(-1));
        if (tx.data.startsWith('0x095ea7b3')) allowance = decodeFunctionData({ abi: erc20Abi, data: tx.data }).args[1] as bigint;
        return { transactionHash: hash, blockNumber: block, blockHash: H(Number(block)), status: 'success' as const };
      },
    };
    return { io: double, coinReads, simulated, estimated, receipts, setAllowance: (value: bigint) => { allowance = value; } };
  }
  const kinds = (roles: { vault: Address }, view: V2Snapshot) => sends().map((tx) => (tx.to === view.token ? 'approve' : tx.to === roles.vault ? 'withdraw' : tx.to));

  it('an old, used-up allowance cannot skip the approval: the coins are read at a block not older than this card’s last confirmed take', async () => {
    const { view, source, roles } = await box();
    const c = chain();
    const seen: bigint[] = [];
    // The card's last confirmed take was mined at block 20; the node at block 10 still shows the allowance it spent.
    await sendTakeOutV2(source, view, A, 3n, TAKE, c.io, () => undefined, { floor: 20n, onReceipt: (b) => seen.push(b) });
    expect(c.coinReads[0]).toBe(20n);
    expect(kinds(roles, view)).toEqual(['approve', 'withdraw']);
    expect(decodeFunctionData({ abi: erc20Abi, data: required(sends()[0]).data }).args).toEqual([roles.vault, takeLimit(TAKE)]);
    expect(seen).toEqual(c.receipts);
  });
  it('a reader that answers older than the floor is never used: the refresh line after it, nothing sent', async () => {
    const { view, source } = await box();
    const c = chain({ honour: false });
    const error = await sendTakeOutV2(source, view, A, 3n, TAKE, c.io, () => undefined, { floor: 20n }).catch((e: unknown) => e);
    expect(vaultErrorText(error)).toBe(REFRESH_LINE);
    expect(sends()).toHaveLength(0);
    // Control: with no floor (a first take in this visit) the same answer is all there is, and the approval is skipped.
    const { view: again } = await box();
    await sendTakeOutV2(source, again, A, 3n, TAKE, chain({ honour: false }).io);
    expect(sends().map((tx) => tx.to)).toEqual([required(vaultRolesOf(again)).vault]);
  });
  it('the approval’s receipt gates a still head: no move can use the older block', async () => {
    const { view, source, roles } = await box();
    const c = chain({ head: 5n, stale: null });
    c.io.head = async () => 5n; // Receipt at 6 does not move this node's head.
    c.io.coins = async (_account, _floor, at = 5n) => ({ balance: TAKE * 2n, allowance: takeLimit(TAKE), block: at });
    let reads = 0; const coins = c.io.coins;
    c.io.coins = async (...args) => ({ ...await coins(...args), allowance: ++reads === 1 ? 0n : takeLimit(TAKE) });
    const error = await sendTakeOutV2(source, view, A, 3n, TAKE, c.io).catch((e: unknown) => e);
    expect(vaultErrorText(error)).toBe(REFRESH_LINE);
    expect(c.receipts).toEqual([6n]); expect(c.simulated).toEqual([5n]); expect(c.estimated).toEqual([5n]);
    expect(kinds(roles, view)).toEqual(['approve']);
  });
  it('a node that has not seen the approval yet: the refresh line, no withdraw sent; the approval’s block is kept for the next press', async () => {
    const { view, source, roles } = await box();
    // The node stays at block 5, before the approval mined at 6.
    const c = chain({ head: 5n, stale: { block: 5n, allowance: 0n }, honour: false });
    const seen: bigint[] = [];
    const error = await sendTakeOutV2(source, view, A, 3n, TAKE, c.io, () => undefined, { onReceipt: (b) => seen.push(b) }).catch((e: unknown) => e);
    expect(vaultErrorText(error)).toBe(REFRESH_LINE);
    expect(kinds(roles, view)).toEqual(['approve']);
    expect(seen).toEqual([6n]);
  });
  it('the allowance is read again right before the withdraw: spent since the first read, it is approved once more, never twice', async () => {
    const { view, source, roles } = await box();
    const c = chain({ head: 5n, stale: null, spentAfterFirstRead: true });
    c.setAllowance(takeLimit(TAKE));
    await sendTakeOutV2(source, view, A, 3n, TAKE, c.io);
    expect(kinds(roles, view)).toEqual(['approve', 'withdraw']);
    expect(c.coinReads).toEqual([5n, 5n, 6n]);
    expect(c.simulated.at(-1)).toBe(6n);
    // Approved and still short (spent again in between): no second approval; the vault's own simulation decides.
    const { view: next } = await box();
    const d = chain({ head: 5n, stale: null });
    const refused = { ...d.io, coins: async (_a: Address, atLeast = 0n) => ({ balance: 2n * TAKE, allowance: 0n, block: atLeast > 5n ? atLeast : 5n }),
      simulate: vi.fn(async (_to: Address, data: Hex) => { if (data.startsWith('0x095ea7b3')) return; throw new ContractFunctionRevertedErrorDouble(); }) } as VaultItemsIO;
    const before = sends().length;
    const error = await sendTakeOutV2(source, next, A, 3n, TAKE, refused).catch((e: unknown) => e);
    expect(sends().slice(before).map((tx) => tx.to)).toEqual([next.token]);
    expect(vaultErrorText(error)).toBe(REFRESH_LINE);
  });
  it('a put-back after its item approval is simulated at the approval’s block', async () => {
    const { view, source } = await box();
    const c = chain({ head: 7n }); let approved = false;
    await sendPutBackV2(source, view, A, 1n, BACK, { ...c.io, item: async (id) => ({ id, owner: A, onShelf: false, outside: true, revealed: true, imageHash: null, modelHash: null }), itemApproved: async () => approved, head: async (floor = 0n) => floor > 7n ? floor : 7n,
      receipt: async (hash) => { approved = true; return { transactionHash: hash, blockNumber: 8n, blockHash: H(8), status: 'success' as const }; } });
    expect(c.simulated).toEqual([7n, 8n]);
  });
  it('the real reader asks the head again until it reaches the floor, then reads both coin figures at that block by number', async () => {
    const { view, source } = await box();
    let head = 3n; const tags: unknown[] = [];
    const inner = vaultRpcFetch({ balanceOf: () => 5n, allowance: () => 7n });
    vi.stubGlobal('fetch', (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as RpcCall & { id: number };
      if (body.method === 'eth_blockNumber') { const n = head; head += 1n; return Response.json({ jsonrpc: '2.0', id: body.id, result: `0x${n.toString(16)}` }); }
      if (body.method === 'eth_call') tags.push(body.params?.[1]);
      return inner.fetch(url, init);
    }) as typeof fetch);
    const pauses: number[] = [];
    const reader = vaultItemsIO(source, view, wallet, async (ms) => { pauses.push(ms); });
    expect(await reader.coins(A, 5n)).toEqual({ balance: 5n, allowance: 7n, block: 5n });
    expect(pauses).toEqual([FLOOR_WAIT_MS, FLOOR_WAIT_MS]);
    expect(tags).toEqual(['0x5', '0x5']);
    // A head that never gets there: FLOOR_READS asks, then the refresh line; no coin read at an older block.
    head = 0n; tags.length = 0; pauses.length = 0;
    const stuck = vaultItemsIO(source, view, wallet, async (ms) => { pauses.push(ms); head = 0n; });
    await expect(stuck.coins(A, 50n)).rejects.toThrow(REFRESH_LINE);
    expect(pauses).toHaveLength(FLOOR_READS - 1);
    expect(tags).toEqual([]);
    vi.unstubAllGlobals();
  });
  it('the real reader asks a pinned read again when a node could not answer it, never a refusal', async () => {
    const { view, source } = await box();
    let failures = 1;
    const answers = vaultRpcFetch({ balanceOf: () => { if (failures > 0) { failures -= 1; throw nodeUnavailable(); } return 5n; }, allowance: () => 7n });
    vi.stubGlobal('fetch', answers.fetch);
    const pauses: number[] = [];
    expect(await vaultItemsIO(source, view, wallet, async (ms) => { pauses.push(ms); }).coins(A, 100n)).toEqual({ balance: 5n, allowance: 7n, block: 100n });
    expect(pauses).toEqual([FLOOR_WAIT_MS]);
    const refused = vaultRpcFetch({ balanceOf: () => { throw revertWith(encodeErrorResult({ abi: vaultV2Abi, errorName: 'LastItem' })); }, allowance: () => 7n });
    vi.stubGlobal('fetch', refused.fetch);
    pauses.length = 0;
    await expect(vaultItemsIO(source, view, wallet, async (ms) => { pauses.push(ms); }).coins(A)).rejects.toThrow();
    expect(pauses).toEqual([]);
    expect(refused.asked.filter((read) => read.name === 'balanceOf')).toHaveLength(1);
    vi.unstubAllGlobals();
  });
  it('an unread quote, an unrevealed item and an unread receipt give their true lines', async () => {
    const { view, source } = await box();
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 3n, TAKE, io({ quote: { takeT: null } })).catch((e: unknown) => e))).toBe('Price unavailable. Refresh and try again.');
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 3n, TAKE, io({ quote: { takeT: takeLimit(TAKE) + 1n } })).catch((e: unknown) => e))).toBe('The price changed. Refresh and try again.');
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 3n, TAKE, io({ item: { revealed: false } })).catch((e: unknown) => e))).toBe(ITEM_NOT_REVEALED);
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 3n, TAKE, io({ item: { onShelf: false, outside: true } })).catch((e: unknown) => e))).toBe('Item #3 is no longer in the vault.');
    expect(sends()).toHaveLength(0);
    // The wallet returned a hash and its receipt timed out: sent, but not confirmed (never "Nothing confirmed. Try again.").
    const timedOut = { ...io({ allowance: takeLimit(TAKE) }), receipt: async (hash: Hex) => { throw new WaitForTransactionReceiptTimeoutError({ hash }); } };
    const error = await sendTakeOutV2(source, view, A, 3n, TAKE, timedOut).catch((e: unknown) => e);
    expect(sends()).toHaveLength(1);
    expect(vaultErrorText(error)).toBe('Sent, but not confirmed. Check your wallet before trying again.');
    // Control: the same timeout error with no hash sent stays the old line.
    expect(vaultErrorText(new WaitForTransactionReceiptTimeoutError({ hash: H(1) }))).toBe('Nothing confirmed. Try again.');
  });
});

/** A plain stand-in for a vault refusal in a simulation (the real one is decoded from the node's revert data). */
class ContractFunctionRevertedErrorDouble extends Error {}

describe('SH-TA-33 put one back', () => {
  const mine = { owner: A, onShelf: false, outside: true };
  it('approves the vault for this one item, then returnItem(id, min, now + 20 min)', async () => {
    const { view, source, roles } = await box();
    const steps: VaultStepV2[] = [];
    await sendPutBackV2(source, view, A, 1n, BACK, io({ item: mine }), (step) => steps.push(step));
    expect(steps).toEqual(['checking', 'approve', 'checking', 'confirming', 'checking', 'checking', 'return', 'checking', 'confirming', 'checking']);
    const [approve, back] = sends();
    expect(approve?.to).toBe(roles.collection);
    expect(decodeFunctionData({ abi: boxCollectionAbi, data: required(approve).data })).toMatchObject({ functionName: 'approve', args: [roles.vault, 1n] });
    expect(back?.to).toBe(roles.vault);
    expect(decodeFunctionData({ abi: vaultV2Abi, data: required(back).data })).toMatchObject({ functionName: 'returnItem', args: [1n, returnLimit(BACK), NOW + DEADLINE_SECONDS] });
  });
  it('skips the item approval when the vault may already take it', async () => {
    const { view, source, roles } = await box();
    await sendPutBackV2(source, view, A, 1n, BACK, io({ item: mine, approved: true }));
    expect(sends().map((tx) => tx.to)).toEqual([roles.vault]);
  });
  it.each<[string, Double, RegExp]>([
    ['another owner’s item', { item: { ...mine, owner: B } }, /not in your wallet/],
    ['an item in the vault', { item: { ...mine, outside: false } }, /not in your wallet/],
    ['an unrevealed item', { item: { ...mine, revealed: false } }, /once it is revealed/],
    ['an amount below the 1% limit', { item: mine, quote: { returnT: returnLimit(BACK) - 1n } }, /amount changed/],
    ['an unread amount', { item: mine, quote: { returnT: null } }, /Price unavailable/],
  ])('refuses %s before the wallet is asked to send', async (_name, double, message) => {
    const { view, source } = await box();
    await expect(sendPutBackV2(source, view, A, 1n, BACK, io(double))).rejects.toThrow(message);
    expect(sends()).toHaveLength(0);
  });
  it('the prepared item approval names only the vault and that item; another id is refused by the guard', async () => {
    const { view, source, roles } = await box();
    const target = vaultTargetV2(source, view, A, { kind: 'item', id: 1n });
    expect(target).toMatchObject({ vault: roles.vault, collection: roles.collection, collectionCaller: A, collectionApproval: { kind: 'item', id: 1n } });
    const { assertSendableCallV2 } = await import('../../../../../../packages/chain/src/core/v2/write-calls-v2');
    const { encodeFunctionData } = await import('viem');
    const other = { to: roles.collection, data: encodeFunctionData({ abi: boxCollectionAbi, functionName: 'approve', args: [roles.vault, 2n] }), value: 0n };
    expect(() => assertSendableCallV2(other, target, A)).toThrow(NotSendableError);
    expect(() => assertSendableCallV2(other, target, B)).toThrow(NotSendableError);
  });
});

describe('SH-TA-33 error lines', () => {
  it('names what happened in a few words', () => {
    expect(vaultErrorText(new Error('Not confirmed'))).toMatch(/not confirmed/);
    expect(vaultErrorText(new Error('More than this wallet holds.'))).toBe('More than this wallet holds.');
    expect(vaultErrorText(null)).toBe('Nothing confirmed. Try again.');
  });
});


describe('SH-235 review: true read and receipt outcomes', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('hidden inside is unavailable, and only outside says no longer in the vault', async () => {
    const { view, source } = await box();
    for (const outside of [false, true]) {
      const e = await sendTakeOutV2(source, view, A, 3n, TAKE, io({ item: { onShelf: false, outside } })).catch((e: unknown) => e);
      expect(vaultErrorText(e)).toBe(outside ? 'Item #3 is no longer in the vault.' : 'Item #3 unavailable. Refresh and try again.');
    }
    expect(sends()).toHaveLength(0);
  });
  it('a real viem item read with a no-data upstream error says unavailable, never refused', async () => {
    const { view, source } = await box();
    vi.stubGlobal('fetch', vaultRpcFetch({ ownerOf: () => A, isOnShelf: () => { throw nodeUnavailable(); }, isOutside: () => false, traitsOf: () => [true, 0n, H(1), H(0)] }).fetch);
    expect(vaultErrorText(await vaultItemsIO(source, view, wallet).item(3n).catch((e: unknown) => e))).toBe('Item #3 unavailable. Refresh and try again.');
    expect(sends()).toHaveLength(0);
  });
  it.each(['coins', 'now'] as const)('a failed %s read after a confirmed approval never says Nothing confirmed', async (which) => {
    const { view, source } = await box();
    const base = io(); const seen: bigint[] = []; let reads = 0;
    const d = { ...base, [which]: which === 'coins' ? async () => { if (++reads > 1) throw nodeUnavailable(); return { balance: TAKE * 2n, allowance: 0n, block: 9n }; } : async () => { if (++reads > 1) throw nodeUnavailable(); return NOW; } } as VaultItemsIO;
    const e = await sendTakeOutV2(source, view, A, 3n, TAKE, d, undefined, { onReceipt: (b) => seen.push(b) }).catch((e: unknown) => e);
    expect(seen).toEqual([9n]); expect(sends()).toHaveLength(1);
    expect(vaultErrorText(e)).toBe(REFRESH_LINE);
  });
  it('a verified same-call replacement returns its mined hash and raises the floor', async () => {
    const { view, source } = await box(); const seen: bigint[] = [];
    const d: VaultItemsIO = { ...io({ allowance: takeLimit(TAKE) }), receipt: async (hash, onReplaced) => {
      const tx = required(sends().at(-1));
      const original = { hash, from: A, to: tx.to, input: tx.data, value: 0n, nonce: 7 };
      const receipt = { transactionHash: H(78), blockNumber: 21n, blockHash: H(21), status: 'success' as const };
      onReplaced?.({ reason: 'repriced', replacedTransaction: original, transaction: { ...original, hash: H(78) }, transactionReceipt: receipt } as import('./vault-operations').VaultReplacementV2);
      return receipt;
    } };
    const result = await sendTakeOutV2(source, view, A, 3n, TAKE, d, undefined, { onReceipt: (b) => seen.push(b) });
    expect(result.receipt.transactionHash).toBe(H(78)); expect(seen).toEqual([21n]); expect(sends()).toHaveLength(1);
  });
  it('an unknown wallet error after a confirmed approval uses an existing truthful fallback', async () => {
    const { view, source } = await box(); const base = io(); let attempts = 0;
    const d = { ...base, submit: async (request: Parameters<VaultItemsIO['submit']>[0]) => { if (++attempts > 1) throw new Error('private RPC details'); return base.submit(request); } };
    const e = await sendTakeOutV2(source, view, A, 3n, TAKE, d).catch((e: unknown) => e);
    expect(vaultErrorText(e)).toBe(REASON_FALLBACK); expect(sends()).toHaveLength(1);
    expect(vaultErrorText(new Error('private RPC details'))).toBe('Nothing confirmed. Try again.');
  });
  it('a mined revert is a refusal and preserves its confirmed receipt', async () => {
    const { view, source } = await box();
    const receipts: bigint[] = [];
    const d: VaultItemsIO = { ...io({ allowance: takeLimit(TAKE) }), receipt: async (hash) => ({ transactionHash: hash, blockNumber: 20n, blockHash: H(20), status: 'reverted' }) };
    const e = await sendTakeOutV2(source, view, A, 3n, TAKE, d, undefined, { onReceipt: (block) => receipts.push(block) }).catch((e: unknown) => e);
    expect(vaultErrorText(e)).toBe('The vault refused it. Refresh and try again.');
    expect(receipts).toEqual([20n]);
    expect(sends()).toHaveLength(1);
  });
  it('ten slow simulation timeouts take their RPC time plus nine pauses, then stop without a send', async () => {
    const { view, source, roles } = await box(); let attempts = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      vi.stubGlobal('fetch', (async (_url: RequestInfo | URL, init?: RequestInit) => {
        attempts++;
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }) as typeof fetch);
      let settled = false;
      const read = vaultItemsIO(source, view, wallet).simulate(roles.vault, '0x12345678', A, 20n).catch((e: unknown) => e).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(108_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      expect(await read).toBeInstanceOf(Error); expect(attempts).toBe(FLOOR_READS);
      expect(sends()).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(['simulate', 'estimate'] as const)('an unread real %s ends with the refresh sentence, never a refusal', async (method) => {
    const { view, source } = await box(); let calls = 0;
    vi.stubGlobal('fetch', rpcFetch(async ({ method }) => { if (method === 'eth_chainId') return '0x7a69'; calls++; throw nodeUnavailable(); }));
    const real = vaultItemsIO(source, view, wallet, async () => {});
    const d = { ...io({ allowance: takeLimit(TAKE) }), [method]: real[method] };
    const error = await sendTakeOutV2(source, view, A, 3n, TAKE, d).catch((e: unknown) => e);
    expect(vaultErrorText(error)).toBe(REFRESH_LINE); expect(calls).toBe(FLOOR_READS); expect(sends()).toHaveLength(0);
  });
  it.each(['simulate', 'estimate'] as const)('real %s retries only unread pinned calls, with strict revert data classification', async (method) => {
    const { view, source, roles } = await box();
    const pauses: number[] = []; let attempts = 0; let data: Hex | undefined = undefined;
    vi.stubGlobal('fetch', rpcFetch(async ({ method: rpcMethod }) => {
      if (rpcMethod === 'eth_chainId') return '0x7a69';
      attempts += 1;
      if (data) throw revertWith(data);
      if (attempts < 3) throw nodeUnavailable();
      return method === 'simulate' ? '0x' : '0x186a0';
    }));
    const d = vaultItemsIO(source, view, wallet, async (ms) => { pauses.push(ms); });
    await d[method](roles.vault, '0x12345678', A, 20n);
    expect(attempts).toBe(3); expect(pauses).toEqual([1000, 1000]);
    attempts = 0; pauses.length = 0; data = encodeErrorResult({ abi: vaultV2Abi, errorName: 'LastItem' });
    const e = await d[method](roles.vault, '0x12345678', A, 20n).catch((e: unknown) => e);
    expect(attempts).toBe(1); expect(pauses).toEqual([]);
    expect(vaultErrorText(e)).toBe('The vault refused it. Refresh and try again.');
  });
});

describe('SH-235 R3 the chain is the memory', () => {
  const earlier = 'An earlier transaction is still under way.';
  const walletError = 'Your wallet returned an error. Check it before trying again.';
  const sendOf = (kind: 'take' | 'return') => kind === 'take' ? sendTakeOutV2 : sendPutBackV2;
  const forKind = (kind: 'take' | 'return', approval = false) => io({ allowance: approval ? 0n : takeLimit(TAKE), approved: !approval,
    item: kind === 'take' ? {} : { onShelf: false, outside: true } });
  it.each(['take', 'return'] as const)('pending count stops %s and its approval before simulation', async (kind) => {
    const { view, source } = await box();
    for (const approval of [false, true]) {
      const d = forKind(kind, approval); d.counts = async () => ({ mined: 4n, latest: 4n, latestAfter: 4n, pending: 5n });
      const error = await sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d).catch((e: unknown) => e);
      expect(vaultErrorText(error)).toBe(earlier); expect(sends()).toHaveLength(0); expect(wallet).not.toHaveBeenCalled(); expect(d.simulate).not.toHaveBeenCalled();
    }
  });
  it.each(['take', 'return'] as const)('a transaction appearing during %s preflight is caught after the sender checks', async (kind) => {
    const { view, source } = await box();
    for (const approval of [false, true]) {
      const d = forKind(kind, approval); let pending = 0n;
      d.estimate = async () => { pending = 1n; return 200_000n; };
      d.counts = async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending });
      const error = await sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d).catch((e: unknown) => e);
      expect(vaultErrorText(error)).toBe(earlier); expect(sends()).toHaveLength(0);
    }
  });
  it.each(['start', 'wallet boundary'])('unreadable count at %s stops with refresh and no wallet request', async (where) => {
    const { view, source } = await box(); const d = io(); let boundary = false;
    d.estimate = async () => { boundary = true; return 200_000n; };
    d.counts = async () => { if (where === 'start' || boundary) throw nodeUnavailable(); return { mined: 0n, latest: 0n, latestAfter: 0n, pending: 0n }; };
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(REFRESH_LINE);
    expect(sends()).toHaveLength(0);
  });
  it.each(['take', 'return'] as const)('equal counts after the first %s mined stop the next run at its item read', async (kind) => {
    const { view, source } = await box(); const d = forKind(kind); const item = d.item; let mined = false;
    d.item = async (...args) => ({ ...await item(...args), ...(mined ? { onShelf: kind === 'return', outside: kind === 'take' } : {}) });
    const receipt = d.receipt; d.receipt = async (...args) => { mined = true; return receipt(...args); };
    d.counts = async () => ({ mined: mined ? 1n : 0n, latest: mined ? 1n : 0n, latestAfter: mined ? 1n : 0n, pending: mined ? 1n : 0n });
    await sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d);
    const error = await sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d).catch((e: unknown) => e);
    expect(vaultErrorText(error)).toBe(kind === 'take' ? 'Item #1 is no longer in the vault.' : 'Item #1 is not in your wallet.');
    expect(sends()).toHaveLength(1);
  });
  it.each(['cancelled', 'dropped'])('%s while away: equal counts allow the next run with no saved hash lock', async () => {
    const { view, source } = await box(); const d = forKind('take'); let pending = 1n;
    d.counts = async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending });
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(earlier);
    expect(sends()).toHaveLength(0); pending = 0n;
    await sendTakeOutV2(source, view, A, 1n, TAKE, d); expect(sends()).toHaveLength(1);
  });
  it('one look pins item, price, coins, count, timestamp, simulation and estimate to its head', async () => {
    const { view, source } = await box(); const d = forKind('take'); const blocks: [string, bigint | undefined][] = [];
    let head = 40n;
    d.head = async () => ++head;
    d.counts = async (_a, block) => { blocks.push(['count', block]); return { mined: 0n, latest: 0n, latestAfter: 0n, pending: 0n }; };
    const quote = d.quote; d.quote = async (block) => { blocks.push(['quote', block]); return quote(block); };
    const item = d.item; d.item = async (id, block) => { blocks.push(['item', block]); return item(id, block); };
    d.coins = async (_a, _floor, block) => { blocks.push(['coins', block]); if (block === undefined) throw new Error('Expected pinned block'); return { balance: TAKE * 2n, allowance: takeLimit(TAKE), block }; };
    d.now = async (block) => { blocks.push(['time', block]); return NOW; };
    d.simulate = async (_to, _data, _a, block) => { blocks.push(['simulation', block]); };
    d.estimate = async (_to, _data, _a, block) => { blocks.push(['estimate', block]); return 200_000n; };
    await sendTakeOutV2(source, view, A, 1n, TAKE, d);
    expect(blocks).toEqual([['count', 41n], ['quote', 41n], ['item', 41n], ['coins', 41n], ['time', 41n], ['count', 42n], ['quote', 42n], ['item', 42n], ['coins', 42n], ['time', 42n], ['simulation', 42n], ['estimate', 42n], ['count', 42n]]);
    expect(sends()).toHaveLength(1);
  });
  it('the real reader pins item and price calls and reads numbered, latest and pending counts together', async () => {
    const { view, source } = await box(); const tags: [string, unknown][] = [];
    const rpc = vaultRpcFetch({ inside: () => 3n, pickFeeBps: () => 0n, returnFeeBps: () => 0n, quoteWithdraw: () => 100n, quoteReturn: () => 90n,
      ownerOf: () => A, isOnShelf: () => true, isOutside: () => false, traitsOf: () => [true, 0n, H(0), H(0)], balanceOf: () => 1000n, allowance: () => 101n });
    vi.stubGlobal('fetch', (async (url, init) => {
      const call = JSON.parse(String(init?.body)) as RpcCall;
      if (call.method === 'eth_getTransactionCount') { tags.push([call.method, call.params?.[1]]); return Response.json({ jsonrpc: '2.0', id: (call as RpcCall & { id: number }).id, result: '0x4' }); }
      if (call.method === 'eth_call') tags.push([call.method, call.params?.[1]]);
      return rpc.fetch(url, init);
    }) as typeof fetch);
    const reader = vaultItemsIO(source, view, wallet);
    await Promise.all([reader.item(1n, 42n), reader.quote(42n), reader.coins(A, 42n, 42n), reader.counts(A, 42n)]);
    expect(tags.filter(([method]) => method === 'eth_call').every(([, tag]) => tag === '0x2a')).toBe(true);
    expect(tags.filter(([method]) => method === 'eth_getTransactionCount')).toEqual([['eth_getTransactionCount', '0x2a'], ['eth_getTransactionCount', 'latest'], ['eth_getTransactionCount', 'pending'], ['eth_getTransactionCount', 'latest']]);
    expect(sends()).toHaveLength(0);
  });
  it('put-back approval at 20 then a failed read: the next run refuses head 10 without another approval', async () => {
    const { view, source } = await box(); const d = forKind('return', true); let head = 19n; let floor = 0n;
    d.head = async () => head;
    d.receipt = async (hash) => { head = 20n; return { transactionHash: hash, blockNumber: 20n, blockHash: H(20), status: 'success' }; };
    const item = d.item; d.item = async (...args) => { if (head === 20n) throw nodeUnavailable(); return item(...args); };
    const first = await sendPutBackV2(source, view, A, 1n, BACK, d, undefined, { onReceipt: (b) => { floor = b; } }).catch((e: unknown) => e);
    expect(vaultErrorText(first)).toBe('Item #1 unavailable. Refresh and try again.'); expect(floor).toBe(20n); expect(sends()).toHaveLength(1);
    head = 10n;
    expect(vaultErrorText(await sendPutBackV2(source, view, A, 1n, BACK, d, undefined, { floor }).catch((e: unknown) => e))).toBe(REFRESH_LINE);
    expect(sends()).toHaveLength(1);
  });
  it.each(['missing', 'transferred', 'approved'] as const)('put-back rereads ownership and approval after its receipt: %s', async (state) => {
    const { view, source } = await box(); const d = forKind('return', true); let block = 19n; const reads: [string, bigint | undefined][] = [];
    d.head = async () => block;
    d.receipt = async (hash) => { block = 20n; return { transactionHash: hash, blockNumber: block, blockHash: H(20), status: 'success' }; };
    const item = d.item; d.item = async (id, at) => { reads.push(['owner', at]); return { ...await item(id, at), owner: block === 20n && state === 'transferred' ? B : A }; };
    d.itemApproved = async (_id, _a, at) => { reads.push(['approval', at]); return block === 20n && state === 'approved'; };
    const result = await sendPutBackV2(source, view, A, 1n, BACK, d).catch((e: unknown) => e);
    expect(reads).toEqual([['owner', 19n], ['approval', 19n], ['owner', 20n], ['approval', 20n]]);
    expect(sends()).toHaveLength(state === 'approved' ? 2 : 1);
    if (state !== 'approved') expect(vaultErrorText(result)).toBe(state === 'missing' ? REFRESH_LINE : 'Item #1 is not in your wallet.');
  });
  it.each(['lost', 'not a hash'] as const)('wallet reply %s after sending uses wallet-error; the remembered repeat uses unknown-send', async (reply) => {
    const { view, source } = await box(); const d = forKind('take'); let pending = false;
    const request = d.request;
    d.request = async (arg) => { if (arg.method === 'eth_sendTransaction') { await request(arg); pending = true; if (reply === 'lost') throw new Error('reply lost'); return 'invalid'; } return request(arg); };
    d.counts = async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending: pending ? 1n : 0n });
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(walletError);
    expect(sends()).toHaveLength(1);
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(REASON_WORDS['unknown-send']);
    expect(sends()).toHaveLength(1);
  });
  it('a failed shared fee read is refresh before any wallet request', async () => {
    const { view, source } = await box(); const d = forKind('take');
    const unread = { ...d, feeReader: { ...TEST_FEE_READER, getBalance: async () => { throw nodeUnavailable(); } } };
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, unread).catch((e: unknown) => e))).toBe(REFRESH_LINE);
    expect(sends()).toHaveLength(0);
  });
});

describe('SH-235 R4 a pending move lasts only while it can happen', () => {
  const unconfirmed = 'Sent, but not confirmed. Check your wallet before trying again.';
  const stored = (): PendingVaultMoveV2[] => JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY) ?? '[]') as PendingVaultMoveV2[];
  const sendOf = (kind: 'take' | 'return') => kind === 'take' ? sendTakeOutV2 : sendPutBackV2;
  const ready = (kind: 'take' | 'return' = 'take') => io({ allowance: takeLimit(TAKE), approved: true, item: { outside: kind === 'return', onShelf: kind === 'take' } });
  const unseen = async () => { throw new Error('unseen receipt'); };
  const line = async (p: Promise<unknown>) => vaultErrorText(await p.catch((e: unknown) => e));
  it.each(['take', 'return'] as const)('the R3 omitted-transaction probe cannot send a second %s', async (kind) => {
    const { view, source } = await box(); const d = ready(kind); d.receipt = unseen;
    for (let i = 0; i < 2; i++) expect(await line(sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d))).toBe(unconfirmed);
    // The node still reports the original place and equal counts, even if an operator restores it between mines.
    expect(sends()).toHaveLength(1); expect(stored()).toHaveLength(1);
  });
  it.each(['take', 'return'] as const)('the %s record exists before the wallet sees the call, then gains its hash', async (kind) => {
    const { view, source, roles } = await box(); const d = ready(kind); const request = d.request;
    d.request = async (arg) => {
      if (arg.method === 'eth_sendTransaction') {
        const tx = (arg.params as readonly Tx[])[0];
        const call = decodeFunctionData({ abi: vaultV2Abi, data: required(tx).data });
        expect(stored()).toEqual([{ chain: String(source.manifest.chainId), vault: roles.vault.toLowerCase(), account: A.toLowerCase(), kind, id: '1', deadline: String(call.args[2]) }]);
      }
      return request(arg);
    };
    d.receipt = async () => { expect(stored()[0]?.hash).toBe(H(77)); return unseen(); };
    expect(await line(sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d))).toBe(unconfirmed);
    expect(sends()).toHaveLength(1);
  });
  it('an uncertain wallet answer holds a repeat with the unknown-send line', async () => {
    const { view, source } = await box(); const d = ready(); const request = d.request;
    d.request = async (arg) => { const reply = await request(arg); return arg.method === 'eth_sendTransaction' ? 'not a hash' : reply; };
    expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe('Your wallet returned an error. Check it before trying again.');
    expect(stored()[0]?.hash).toBeUndefined();
    expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe(REASON_WORDS['unknown-send']); expect(sends()).toHaveLength(1);
  });
  it('a reload and another spelling of the account keep the unproved move', async () => {
    const { view, source } = await box(); const d = ready(); d.receipt = unseen;
    await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch(() => {});
    resetPendingVaultMovesForTests();
    expect(await line(sendTakeOutV2(source, view, getAddress(A), 1n, TAKE, d))).toBe(unconfirmed); expect(sends()).toHaveLength(1);
  });
  it.each(['throws', 'missing'] as const)('storage %s still holds in this visit; reload falls back to the count check', async (mode) => {
    const { view, source } = await box(); const d = ready(); d.receipt = unseen;
    vi.stubGlobal('localStorage', mode === 'missing' ? undefined : { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch(() => {});
    expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe(unconfirmed); expect(sends()).toHaveLength(1);
    resetPendingVaultMovesForTests(); d.counts = async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending: 1n });
    expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe('An earlier transaction is still under way.'); expect(sends()).toHaveLength(1);
    d.counts = async () => ({ mined: 0n, latest: 0n, latestAfter: 0n, pending: 0n });
    expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe(unconfirmed); expect(sends()).toHaveLength(2); // No durable record and node omits it: the stated limit.
  });
  it('chain time alone ends the record strictly past its deadline, never at equality', async () => {
    const { view, source } = await box(); const d = ready(); d.receipt = unseen; let now = NOW;
    d.now = async () => now;
    await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch(() => {});
    vi.spyOn(Date, 'now').mockReturnValue(Number((NOW + DEADLINE_SECONDS + 10000n) * 1000n));
    for (now of [NOW + DEADLINE_SECONDS - 1n, NOW + DEADLINE_SECONDS]) {
      expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe(unconfirmed); expect(sends()).toHaveLength(1);
    }
    now += 1n; await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch(() => {});
    expect(sends()).toHaveLength(2); expect(stored()).toHaveLength(1); expect(stored()[0]?.deadline).toBe(String(now + DEADLINE_SECONDS));
  });
  it('a decline removes the record and permits a fresh request', async () => {
    const { view, source } = await box(); const d = ready(); const request = d.request; let decline = true;
    d.request = async (arg) => { if (arg.method === 'eth_sendTransaction' && decline) throw Object.assign(new Error('declined'), { code: 4001 }); return request(arg); };
    expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe('Declined in your wallet.'); expect(stored()).toEqual([]);
    decline = false; await sendTakeOutV2(source, view, A, 1n, TAKE, d); expect(sends()).toHaveLength(1); expect(stored()).toEqual([]);
  });
  it.each(['success', 'reverted', 'repriced', 'replaced', 'cancelled'] as const)('a proved %s outcome removes the move', async (outcome) => {
    const { view, source } = await box(); const d = ready();
    d.receipt = async (hash, onReplaced) => {
      const receipt = { transactionHash: hash, blockNumber: 20n, blockHash: H(20), status: outcome === 'reverted' ? 'reverted' as const : 'success' as const };
      if (outcome === 'success' || outcome === 'reverted') return receipt;
      const tx = required(sends().at(-1)); const original = { hash, from: A, to: tx.to, input: tx.data, value: 0n, nonce: 7 };
      const transaction = { ...original, hash: H(78), ...(outcome === 'cancelled' ? { to: A, input: '0x' } : outcome === 'replaced' ? { to: B, input: '0x1234' } : {}) };
      const actual = { ...receipt, transactionHash: transaction.hash };
      onReplaced?.({ reason: outcome === 'cancelled' ? 'cancelled' : 'repriced', replacedTransaction: original, transaction, transactionReceipt: actual } as import('./vault-operations').VaultReplacementV2);
      return actual;
    };
    await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch(() => {});
    expect(stored()).toEqual([]); expect(pendingVaultMoveLine(source.manifest.chainId, required(vaultRolesOf(view)).vault, A, 'take', 1n, NOW)).toBeNull();
  });
  it.each(['take', 'return'] as const)('an item read showing the %s result must keep its record', async (kind) => {
    const { view, source } = await box(); const d = ready(kind); d.receipt = unseen;
    await sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d).catch(() => {});
    const item = d.item; d.item = async (...args) => ({ ...await item(...args), outside: kind === 'take', onShelf: kind === 'return' });
    await sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d).catch(() => {});
    expect(stored()).toHaveLength(1); expect(sends()).toHaveLength(1);
  });
  it.each(['take', 'return'] as const)('an approval for %s never creates a move record', async (kind) => {
    const { view, source } = await box(); const d = io({ item: { onShelf: kind === 'take', outside: kind === 'return' } });
    const request = d.request; d.request = async (arg) => { if (arg.method === 'eth_sendTransaction') expect(stored()).toEqual([]); return request(arg); }; d.receipt = unseen;
    await sendOf(kind)(source, view, A, 1n, kind === 'take' ? TAKE : BACK, d).catch(() => {});
    expect(stored()).toEqual([]); expect(sends()).toHaveLength(1);
  });
  it.each(['account', 'id', 'kind', 'vault', 'chain'] as const)('a record for another %s does not hold this move', async (field) => {
    const { view, source, roles } = await box();
    const other = { chain: String(source.manifest.chainId), vault: roles.vault.toLowerCase(), account: A.toLowerCase(), kind: 'take', id: '1', deadline: String(NOW + DEADLINE_SECONDS),
      [field]: { account: B, id: '2', kind: 'return', vault: B, chain: '1' }[field] };
    localStorage.setItem(PENDING_VAULT_MOVES_KEY, JSON.stringify([other]));
    const d = ready(); d.receiptOnce = vi.fn(async () => null);
    await sendTakeOutV2(source, view, A, 1n, TAKE, d); expect(sends()).toHaveLength(1); expect(d.receiptOnce).not.toHaveBeenCalled();
  });
  it.each(['bad json', '{}', '[null,{},7,{"deadline":"tomorrow"}]'])('malformed storage %s is discarded', async (raw) => {
    const { view, source } = await box(); localStorage.setItem(PENDING_VAULT_MOVES_KEY, raw);
    await sendTakeOutV2(source, view, A, 1n, TAKE, ready()); expect(sends()).toHaveLength(1); expect(stored()).toEqual([]);
  });
  it('another tab writing during preflight is read again before forwarding', async () => {
    const { view, source, roles } = await box(); const d = ready();
    d.estimate = async () => {
      localStorage.setItem(PENDING_VAULT_MOVES_KEY, JSON.stringify([{ chain: String(source.manifest.chainId), vault: roles.vault.toLowerCase(), account: A.toLowerCase(), kind: 'take', id: '1', deadline: String(NOW + DEADLINE_SECONDS), hash: H(88) }]));
      return 200_000n;
    };
    expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe(unconfirmed); expect(sends()).toHaveLength(0);
  });
  it.each([6n, 8n])('latest %s differs from look count 7 with nothing pending: refresh, not earlier', async (current) => {
    const { view, source } = await box(); const d = ready(); let latest = 7n;
    d.head = async () => 40n; d.coins = async () => ({ balance: TAKE * 3n, allowance: takeLimit(TAKE), block: 40n });
    d.counts = async () => ({ mined: 7n, latest, latestAfter: latest, pending: latest });
    d.estimate = async () => { latest = current; return 200_000n; };
    expect(await line(sendTakeOutV2(source, view, A, 1n, TAKE, d))).toBe(REFRESH_LINE); expect(sends()).toHaveLength(0);
  });
});

it('R5 an older placement read must retain the live record and prevent a repeat', async () => {
  const {view,source,roles}=await box(); let head=100n;
  const d=io({allowance:takeLimit(TAKE)});
  d.head=async()=>head;
  d.coins=async(_a,_floor,at=100n)=>({balance:TAKE*3n,allowance:takeLimit(TAKE),block:at});
  d.counts=async()=>({mined:7n,latest:7n, latestAfter: 7n,pending:7n});
  d.now=async(at)=>NOW+(at===99n?-12n:0n);
  d.item=async(id,at)=>({id,owner:at===99n?A:roles.vault,onShelf:at!==99n,outside:at===99n,revealed:true,imageHash:null,modelHash:null});
  d.receipt=async()=>{throw Error('node omits the sent transaction');};
  // Card first read at 98 remembers count 7. A's count does not change when its approved operator transfers N to B,
  // and B returns it at 100. Thus the card's persisted floor remains 98 (P:169-175), even after a look at 100.
  const options={floor:98n,onCount:(count:bigint)=>expect(count).toBe(7n)};
  expect(vaultErrorText(await sendTakeOutV2(source,view,A,1n,TAKE,d,undefined,options).catch(e=>e))).toBe('Sent, but not confirmed. Check your wallet before trying again.');
  expect(sends()).toHaveLength(1);
  expect(pendingVaultMoveLine(source.manifest.chainId,roles.vault,A,'take',1n,NOW)).not.toBeNull();
  // Load-balanced node honestly answers block 99, when A held N, before the requested move even existed.
  head=99n;
  const error=await sendTakeOutV2(source,view,A,1n,TAKE,d,undefined,options).catch(e=>e);
  expect(vaultErrorText(error)).toBe('Item #1 is no longer in the vault.');
  expect(pendingVaultMoveLine(source.manifest.chainId,roles.vault,A,'take',1n,NOW)).not.toBeNull();
  head=100n;
  expect(vaultErrorText(await sendTakeOutV2(source,view,A,1n,TAKE,d,undefined,options).catch(e=>e))).toBe('Sent, but not confirmed. Check your wallet before trying again.');
  expect(sends()).toHaveLength(1);
  // The same unexpired record holds, without storage loss or concurrent tabs.
});


it('R5 another actor delivering and returning the item must retain the live record', async () => {
  const {view,source,roles}=await box(); let head=100n;
  const d=io({allowance:takeLimit(TAKE)});
  d.head=async()=>head;
  d.coins=async(_a,_floor,at=100n)=>({balance:TAKE*3n,allowance:takeLimit(TAKE),block:at});
  d.counts=async()=>({mined:7n,latest:7n, latestAfter: 7n,pending:7n});
  d.now=async(at)=>NOW+12n*((at??100n)-100n);
  d.item=async(id,at)=>({id,owner:at===101n?A:roles.vault,onShelf:at!==101n,outside:at===101n,revealed:true,imageHash:null,modelHash:null});
  d.receipt=async()=>{throw Error('node omits the sent transaction');};
  // A's private request remains unmined. B withdraws N and transfers it to A at 101; A's count stays 7.
  const options={floor:98n,onCount:(count:bigint)=>expect(count).toBe(7n)};
  expect(vaultErrorText(await sendTakeOutV2(source,view,A,1n,TAKE,d,undefined,options).catch(e=>e))).toBe('Sent, but not confirmed. Check your wallet before trying again.');
  expect(sends()).toHaveLength(1);
  expect(pendingVaultMoveLine(source.manifest.chainId,roles.vault,A,'take',1n,NOW)).not.toBeNull();
  // The latest block now honestly shows A holding N, delivered by B, not by A's still-pending request.
  head=101n;
  const error=await sendTakeOutV2(source,view,A,1n,TAKE,d,undefined,options).catch(e=>e);
  expect(vaultErrorText(error)).toBe('Item #1 is no longer in the vault.');
  expect(pendingVaultMoveLine(source.manifest.chainId,roles.vault,A,'take',1n,NOW)).not.toBeNull();
  // Previously approved B transfers N from A to B and returns N at 102.
  head=102n;
  expect(vaultErrorText(await sendTakeOutV2(source,view,A,1n,TAKE,d,undefined,options).catch(e=>e))).toBe('Sent, but not confirmed. Check your wallet before trying again.');
  expect(sends()).toHaveLength(1);
  expect(decodeFunctionData({abi:vaultV2Abi,data:required(sends()[0]).data}).args[2]).toBeGreaterThan(NOW+24n); // first still valid
});


describe('SH-235 R5 only a recorded transaction receipt ends its hold', () => {
  const heldLine = 'Sent, but not confirmed. Check your wallet before trying again.';
  const stored = (): PendingVaultMoveV2[] => JSON.parse(localStorage.getItem(PENDING_VAULT_MOVES_KEY) ?? '[]') as PendingVaultMoveV2[];
  const saved = async (hash: Hex | undefined = H(88)) => {
    const b = await box();
    const record: PendingVaultMoveV2 = { chain: String(b.source.manifest.chainId), vault: b.roles.vault, account: A,
      kind: 'take', id: '1', deadline: String(NOW + DEADLINE_SECONDS), ...(hash ? { hash } : {}) };
    rememberVaultMove({ ...record, hash: undefined }, NOW);
    rememberVaultMove(record, NOW);
    return { ...b, record };
  };
  it.each(['success', 'reverted'] as const)('its own %s receipt at the next look must release the record and use this run’s reads', async (status) => {
    const { view, source, record } = await saved(); const d = io({ allowance: takeLimit(TAKE) });
    d.receiptOnce = vi.fn(async (hash) => { expect(stored()).toHaveLength(1); return { transactionHash: hash, blockNumber: 8n, blockHash: H(8), status }; });
    const quoteRead = vi.spyOn(d, 'quote');
    await sendTakeOutV2(source, view, A, 1n, TAKE, d);
    expect(d.receiptOnce).toHaveBeenCalledExactlyOnceWith(record.hash);
    expect(quoteRead).toHaveBeenCalledTimes(2); expect(sends()).toHaveLength(1); expect(stored()).toEqual([]);
  });
  it('a receipt must release only the hold; this run’s changed price must still stop the move', async () => {
    const { view, source } = await saved(); const d = io({ allowance: takeLimit(TAKE), quote: { takeT: takeLimit(TAKE) + 1n } });
    d.receiptOnce = async (hash) => ({ transactionHash: hash, blockNumber: 8n, blockHash: H(8), status: 'success' });
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe('The price changed. Refresh and try again.');
    expect(stored()).toEqual([]); expect(sends()).toHaveLength(0);
  });
  it.each(['absent', 'unreadable', 'another hash'] as const)('%s receipt must keep the hold until chain time passes the deadline', async (state) => {
    const { view, source } = await saved(); const d = io({ allowance: takeLimit(TAKE) }); let now = NOW;
    d.now = async () => now;
    d.receiptOnce = vi.fn(async () => {
      if (state === 'unreadable') throw new Error('node unreadable');
      return state === 'absent' ? null : { transactionHash: H(99), blockNumber: 8n, blockHash: H(8), status: 'success' as const };
    });
    for (now of [NOW, NOW + DEADLINE_SECONDS]) {
      expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(heldLine);
      expect(stored()).toHaveLength(1); expect(sends()).toHaveLength(0);
    }
    expect(d.receiptOnce).toHaveBeenCalledTimes(2);
    now++; await sendTakeOutV2(source, view, A, 1n, TAKE, d);
    expect(d.receiptOnce).toHaveBeenCalledTimes(2); expect(sends()).toHaveLength(1); expect(stored()).toEqual([]);
  });
  it('a record without a hash must never read another transaction receipt or lose its hold before expiry', async () => {
    const { view, source, record } = await saved();
    rememberVaultMove({ ...record, hash: undefined }, NOW);
    const d = io({ allowance: takeLimit(TAKE) }); let now = NOW; d.now = async () => now;
    d.receiptOnce = vi.fn(async () => ({ transactionHash: H(99), blockNumber: 8n, blockHash: H(8), status: 'success' as const }));
    for (now of [NOW, NOW + DEADLINE_SECONDS]) {
      expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(REASON_WORDS['unknown-send']);
      expect(stored()).toHaveLength(1); expect(stored()[0]?.hash).toBeUndefined();
    }
    expect(d.receiptOnce).not.toHaveBeenCalled(); expect(sends()).toHaveLength(0);
    now++; await sendTakeOutV2(source, view, A, 1n, TAKE, d);
    expect(d.receiptOnce).not.toHaveBeenCalled(); expect(sends()).toHaveLength(1);
  });
  it('an unanswered receipt read must be bounded and its late answer must not remove the record or send', async () => {
    const { view, source } = await saved(); const d = io({ allowance: takeLimit(TAKE) });
    let release = () => {}; const wait = new Promise<void>((done) => { release = done; });
    d.receiptOnce = vi.fn(async (hash) => { await wait; return { transactionHash: hash, blockNumber: 8n, blockHash: H(8), status: 'success' as const }; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(120_001);
      expect(vaultErrorText(await run)).toBe(heldLine); expect(d.receiptOnce).toHaveBeenCalledTimes(1);
      release(); await vi.advanceTimersByTimeAsync(1);
      expect(stored()).toHaveLength(1); expect(sends()).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it('a held record must keep its uncertainty line when the answered counts also require refresh', async () => {
    const { view, source } = await saved(); const d = io({ allowance: takeLimit(TAKE) });
    d.counts = async () => ({ mined: 7n, latest: 7n, pending: 8n, latestAfter: 8n });
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(heldLine);
    expect(stored()).toHaveLength(1); expect(sends()).toHaveLength(0);
  });
  it('an ordinary press must keep its read counts and make no receipt lookup', async () => {
    const { view, source } = await box(); const d = io({ allowance: takeLimit(TAKE) });
    const methods = ['head', 'counts', 'quote', 'item', 'coins', 'now', 'itemApproved', 'balanceOf', 'receiptOnce', 'receipt'] as const;
    const spies = methods.map((method) => vi.spyOn(d, method));
    await sendTakeOutV2(source, view, A, 1n, TAKE, d);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([2, 3, 2, 2, 2, 2, 0, 0, 0, 1]);
    expect(sends()).toHaveLength(1);
  });
  it('the receipt lookup must make one RPC request for the exact hash without polling', async () => {
    const { view, source } = await box(); const calls: RpcCall[] = [];
    vi.stubGlobal('fetch', rpcFetch(async (call) => { calls.push(call); return null; }));
    await expect(vaultItemsIO(source, view, wallet).receiptOnce(H(88))).rejects.toThrow();
    expect(calls).toEqual([expect.objectContaining({ method: 'eth_getTransactionReceipt', params: [H(88)] })]);
  });
});

describe('SH-235 R5 count reads must distinguish mining from pending work', () => {
  it.each([false, true])('latest/pending/latest 7/8/%s must use refresh for mining and earlier only for pending work', async (pendingOnly) => {
    const { view, source } = await box(); const d = io({ allowance: takeLimit(TAKE) });
    const observed: string[] = []; let latestReads = 0; let inFlight = false;
    vi.stubGlobal('fetch', rpcFetch(async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x7a69';
      expect(inFlight, 'each count reply must finish before the next request').toBe(false); inFlight = true;
      await Promise.resolve();
      const tag = params?.[1];
      const count = tag === '0x28' ? 7n : tag === 'pending' ? 8n : ++latestReads === 1 || pendingOnly ? 7n : 8n;
      observed.push(`${tag}:${count}`); inFlight = false; return `0x${count.toString(16)}`;
    }));
    d.head = async () => 40n; d.counts = vaultItemsIO(source, view, wallet).counts;
    d.coins = async () => ({ balance: TAKE * 3n, allowance: takeLimit(TAKE), block: 40n });
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(pendingOnly ? 'An earlier transaction is still under way.' : REFRESH_LINE);
    expect(observed).toEqual(['0x28:7', 'latest:7', 'pending:8', `latest:${pendingOnly ? 7n : 8n}`]); expect(sends()).toHaveLength(0);
  });
  it('stable latest counts that differ from the look must refresh even when pending is higher', async () => {
    const { view, source } = await box(); const d = io({ allowance: takeLimit(TAKE) });
    d.counts = async () => ({ mined: 6n, latest: 7n, pending: 8n, latestAfter: 7n });
    expect(vaultErrorText(await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e))).toBe(REFRESH_LINE);
    expect(sends()).toHaveLength(0);
  });
  it('random interleavings of one mining event with no pending work must never say earlier', async () => {
    const { view, source } = await box(); let seed = 2355n; const seen = new Set<bigint>();
    const random = () => { seed = (seed * 1664525n + 1013904223n) % (2n ** 32n); return seed; };
    for (let trial = 0; trial < 100; trial++) {
      const mineBeforeRead = random() % 5n; seen.add(mineBeforeRead); const count = random() * (2n ** 53n);
      let reads = 0n; let active = false;
      vi.stubGlobal('fetch', rpcFetch(async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x7a69';
        expect(active).toBe(false); active = true;
        for (let pause = random() % 4n; pause > 0n; pause--) await Promise.resolve();
        const tag = params?.[1]; const current = reads++ >= mineBeforeRead ? count + 1n : count;
        active = false; return `0x${(tag === '0x28' ? count : current).toString(16)}`;
      }));
      const d = io({ allowance: takeLimit(TAKE) }); d.head = async () => 40n;
      d.counts = vaultItemsIO(source, view, wallet).counts;
      d.coins = async () => ({ balance: TAKE * 3n, allowance: takeLimit(TAKE), block: 40n });
      const result = await sendTakeOutV2(source, view, A, 1n, TAKE, d).catch((e: unknown) => e);
      expect(vaultErrorText(result), `mining before read ${mineBeforeRead}`).not.toBe('An earlier transaction is still under way.');
    }
    expect(seen).toEqual(new Set([0n, 1n, 2n, 3n, 4n]));
  });
});
