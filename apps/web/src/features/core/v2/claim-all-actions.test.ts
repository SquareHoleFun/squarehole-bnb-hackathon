/**
 * F128: the creator's claims and the hand-in (claim-all-actions.ts). What each reads and checks before the wallet, and
 * the exact call it hands the shared sender; the sender's own guard runs for real.
 */
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, erc20Abi, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { submitWrite } from '@squarehole/chain/write';
import { coordinatorV2Abi, receiverV2Abi, rolesOfV2, royaltyRouterV2Abi, type CreatorClaimReaderV2 } from '../../../../../../packages/chain/src/core/v2';
import { boxSteps, singleState, withSingleClaim, withSingleRead } from './claim-all';
import { coordinatorClaimedOf, creatorClaimedOf, creatorFeesOf, creatorRemainderInboxPOf, creatorRemainderOf, readCreatorFeesV2, readHandInV2, seedOwedOf, sendCreatorFeesV2, sendCreatorRemainderV2, sendHandInApprovalV2, sendHandInV2, type ClaimAllIO } from './claim-all-actions';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { publishedM2, A, B, H } from './test-support/m2-published';
import { required } from './test-support/required';
import { ETH, publishedPile } from './test-support/m3-published';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

async function failedBox() {
  const { body, source } = await publishedM2(true);
  return { view: parseSnapshotV2(body, source), source };
}
/** The same box with an RC6 income inbox at role 8 (the synthetic M2 box has none). */
const INBOX = '0x00000000000000000000000000000000000ee008' as const;
const withInbox = (view: V2Snapshot): V2Snapshot => ({ ...view, record: { ...view.record, contracts: view.record.contracts.map((a, i) => (i === 8 ? INBOX : a)) } });
type Answers = Record<string, unknown>;
/** A recording IO: reads answer from `answers` (at the snapshot and now alike); the wallet answers a hash. */
function io(view: V2Snapshot, answers: Answers, chainId: number, logs: readonly unknown[] = []) {
  const sent: { to: Address; data: Hex }[] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: readonly unknown[] | Record<string, unknown> }) => {
    if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
    if (method === 'eth_accounts') return [A];
    const tx = Array.isArray(params) ? params[0] as { to: Address; data: Hex } | undefined : undefined; if (tx) sent.push(tx);
    return H(7);
  });
  const answer = async (_to: Address, _abi: unknown, fn: string, args: readonly unknown[] = []) => (typeof answers[fn] === 'function' ? (answers[fn] as (a: readonly unknown[]) => unknown)(args) : answers[fn]);
  const value: ClaimAllIO = { feeReader: TEST_FEE_READER, chainId: async () => chainId, request, simulate: async () => undefined, estimate: async () => 100n, submit: submitWrite,
    receipt: async (hash) => ({ transactionHash: hash, blockNumber: view.block + 1n, blockHash: H(9), status: 'success', logs }), at: vi.fn(answer), now: vi.fn(answer),
    as: vi.fn(async (_from: Address, to: Address, abi: unknown, fn: string, args: readonly unknown[] = []) => answer(to, abi, fn, args)) };
  return { io: value, sent, request };
}

describe('F128 the hand-in', () => {
  it('reads this wallet’s coins up to the coins still counted, their P out of the pot and the approval, at the displayed snapshot', async () => {
    const { view } = await failedBox();
    const { io: rec } = io(view, { balanceOf: 5n * ETH, allowance: 2n, quoteClaim: (a: readonly unknown[]) => (a[0] as bigint) / 10n ** 12n }, 31337);
    // tLeft is 3 coins: the wallet's 5 are capped there.
    expect(await readHandInV2(view, A, rec)).toEqual({ block: view.block, amount: 3n * ETH, pOut: 3000000n, approved: 2n });
    expect(await readHandInV2({ ...view, failed: null }, A, rec)).toEqual({ block: view.block, amount: 0n });
  });

  it('approves exactly the coins for the coordinator, then hands them in to the caller, each checked against the chain now', async () => {
    const { view, source } = await failedBox(); const roles = rolesOfV2(view.record).contracts;
    const answers: Answers = { failed: true, balanceOf: 3n * ETH, claimState: [10000001n, 3n * ETH], allowance: 0n, quoteClaim: 3333333n };
    const { io: rec, sent } = io(view, answers, source.manifest.chainId);
    await expect(sendHandInV2(source, view, A, 3n * ETH, rec)).rejects.toThrow('Approve these coins first');
    await sendHandInApprovalV2(source, view, A, 3n * ETH, rec);
    answers.allowance = 3n * ETH;
    await sendHandInV2(source, view, A, 3n * ETH, rec);
    expect(sent.map((tx) => tx.to)).toEqual([view.token, roles.coordinator]);
    expect(decodeFunctionData({ abi: erc20Abi, data: sent[0]?.data as Hex })).toMatchObject({ functionName: 'approve', args: [roles.coordinator, 3n * ETH] });
    expect(decodeFunctionData({ abi: coordinatorV2Abi, data: sent[1]?.data as Hex })).toMatchObject({ functionName: 'claim', args: [3n * ETH, A] });
  });

  it('SH-RC7 item 29: a refused quote is an error, never an unpriced read, also for the final share while P waits in the inbox', async () => {
    // The merged coordinator quotes the final share at its pot plus the inbox's readable P; it refuses only an inbox it
    // cannot read, whose claim refuses too. The unpriced collect-first reading (RC6 R1-3) is gone.
    const view = withInbox((await failedBox()).view);
    const refusal = (errorName: 'ClaimFailed' | 'InvalidClaim') => () => { throw Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: coordinatorV2Abi, errorName }) }); };
    for (const answers of [{ balanceOf: 5n * ETH, quoteClaim: refusal('ClaimFailed'), pendingPriceCoin: 7n }, { balanceOf: ETH, quoteClaim: refusal('ClaimFailed'), pendingPriceCoin: 7n },
      { balanceOf: 5n * ETH, quoteClaim: refusal('ClaimFailed'), pendingPriceCoin: 0n }, { balanceOf: 5n * ETH, quoteClaim: refusal('ClaimFailed'), pendingPriceCoin: () => { throw new Error('inbox read failed'); } },
      { balanceOf: 5n * ETH, quoteClaim: refusal('InvalidClaim'), pendingPriceCoin: 7n }, { balanceOf: 5n * ETH, quoteClaim: () => { throw new Error('RPC down'); }, pendingPriceCoin: 7n }]) {
      const { io: rec } = io(view, { allowance: 2n, ...answers }, 31337);
      await expect(readHandInV2(view, A, rec)).rejects.toThrow();
      expect(rec.at).not.toHaveBeenCalledWith(expect.anything(), royaltyRouterV2Abi, 'pendingPriceCoin');
    }
  });

  it('SH-RC7 item 29: a hand-in whose quote refuses sends nothing, the final share included; a quoted one goes on to the claim’s simulation', async () => {
    const box = await failedBox(); const source = box.source; const view = withInbox(box.view); const roles = rolesOfV2(view.record).contracts;
    const refusal = (errorName: 'ClaimFailed' | 'InvalidClaim') => () => { throw Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: coordinatorV2Abi, errorName }) }); };
    const base: Answers = { failed: true, balanceOf: 3n * ETH, claimState: [10000001n, 3n * ETH], allowance: 3n * ETH, quoteClaim: refusal('ClaimFailed'), pendingPriceCoin: 7n };
    for (const patch of [{}, { pendingPriceCoin: 0n }, { quoteClaim: refusal('InvalidClaim') }]) {
      const { io: other, request } = io(view, { ...base, ...patch }, source.manifest.chainId);
      await expect(sendHandInV2(source, view, A, 3n * ETH, other)).rejects.toThrow();
      expect(request.mock.calls.map(([c]) => c.method)).not.toContain('eth_sendTransaction');
      expect(other.now).not.toHaveBeenCalledWith(expect.anything(), royaltyRouterV2Abi, 'pendingPriceCoin');
    }
    // Quoted at pot plus the inbox P, the final share is claimed; the claim's simulation still decides.
    const { io: rec, sent } = io(view, { ...base, quoteClaim: 12_000_001n }, source.manifest.chainId);
    await sendHandInV2(source, view, A, 3n * ETH, rec);
    expect(sent.map((tx) => tx.to)).toEqual([roles.coordinator]);
    expect(decodeFunctionData({ abi: coordinatorV2Abi, data: sent[0]?.data as Hex })).toMatchObject({ functionName: 'claim', args: [3n * ETH, A] });
    const { io: blocked, request } = io(view, { ...base, quoteClaim: 12_000_001n }, source.manifest.chainId);
    await expect(sendHandInV2(source, view, A, 3n * ETH, { ...blocked, simulate: async () => { throw new Error('execution reverted: ClaimFailed'); } })).rejects.toThrow('ClaimFailed');
    expect(request.mock.calls.map(([c]) => c.method)).not.toContain('eth_sendTransaction');
  });

  it('RC6-RR-INBOX: the final share quoted with the inbox P names that P from the snapshot, at its hash; a partial share does not', async () => {
    const box = await failedBox();
    const view: V2Snapshot = { ...withInbox(box.view), closing: { ...required(box.view.closing), inboxP: 2_000_000n } };
    const { io: rec } = io(view, { balanceOf: 5n * ETH, allowance: 2n, quoteClaim: 12_000_001n }, 31337);
    expect(await readHandInV2(view, A, rec)).toEqual({ block: view.block, amount: 3n * ETH, pOut: 12_000_001n, approved: 2n, collectFirstP: 2_000_000n });
    // The same snapshot names the inbox P: no second read, and no read of the inbox role at all.
    expect(rec.at).not.toHaveBeenCalledWith(expect.anything(), royaltyRouterV2Abi, 'pendingPriceCoin');
    const { io: partial } = io(view, { balanceOf: ETH, allowance: 2n, quoteClaim: 1n }, 31337);
    expect(await readHandInV2(view, A, partial)).toEqual({ block: view.block, amount: ETH, pOut: 1n, approved: 2n });
    for (const inboxP of [0n, null]) {
      const { io: none } = io(view, { balanceOf: 5n * ETH, allowance: 2n, quoteClaim: 1n }, 31337);
      expect(await readHandInV2({ ...view, closing: { ...required(view.closing), inboxP } }, A, none)).toEqual({ block: view.block, amount: 3n * ETH, pOut: 1n, approved: 2n });
    }
  });

  it('RC6-RR-INBOX: a mined hand-in reports the P the coordinator’s Claimed paid, for this holder, recipient and coins only', async () => {
    const { view, source } = await failedBox(); const coordinator = required(rolesOfV2(view.record).contracts.coordinator);
    const answers: Answers = { failed: true, balanceOf: 3n * ETH, claimState: [10000001n, 3n * ETH], allowance: 3n * ETH, quoteClaim: 3333333n };
    const { io: rec } = io(view, answers, source.manifest.chainId, [handInLog(coordinator, A, A, 3n * ETH, 3333334n)]);
    expect((await sendHandInV2(source, view, A, 3n * ETH, rec)).paidP).toBe(3333334n);
    expect(coordinatorClaimedOf({ logs: [handInLog(coordinator, A, A, 3n * ETH, 5n)] }, coordinator, A, 3n * ETH)).toBe(5n);
    for (const log of [handInLog(B, A, A, 3n * ETH, 5n), handInLog(coordinator, B, A, 3n * ETH, 5n), handInLog(coordinator, A, B, 3n * ETH, 5n),
      handInLog(coordinator, A, A, ETH, 5n), { address: coordinator, topics: [H(1)], data: '0x' }]) {
      expect(coordinatorClaimedOf({ logs: [log] }, coordinator, A, 3n * ETH)).toBeNull();
    }
    expect(coordinatorClaimedOf({}, coordinator, A, 0n)).toBeNull();
  });

  it('refuses before the wallet when the coins changed: fewer held, fewer still counted, or the box not failed', async () => {
    const { view, source } = await failedBox();
    for (const patch of [{ balanceOf: ETH }, { claimState: [1n, ETH] }, { failed: false }]) {
      const { io: rec, request } = io(view, { failed: true, balanceOf: 3n * ETH, claimState: [1n, 3n * ETH], allowance: 3n * ETH, quoteClaim: 1n, ...patch }, source.manifest.chainId);
      await expect(sendHandInApprovalV2(source, view, A, 3n * ETH, rec)).rejects.toThrow('Coins changed');
      expect(request.mock.calls.map(([c]) => c.method)).not.toContain('eth_sendTransaction');
    }
  });
});

describe('F128 the creator’s claims', () => {
  it('the fees belong to the payee after graduation and before failure, as only the receiver can say; the remainder to the creator once no coins are counted', async () => {
    const { view } = await failedBox();
    const money = view.money as NonNullable<V2Snapshot['money']>;
    const graduated: V2Snapshot = { ...view, failed: null, graduated: true, money: { ...money, creatorPayee: A } };
    // FINAL-OC01: never the stored creatorOwed; the snapshot only says when there is nothing to read.
    expect(creatorFeesOf(graduated, A)).toBeNull();
    expect(creatorFeesOf({ ...graduated, money: null }, A)).toBeNull();
    expect(creatorFeesOf(graduated, B)).toBe(0n);
    // No payee (zero address): nobody can call claimCreator, so nothing is read.
    expect(creatorFeesOf({ ...graduated, money: { ...money, creatorPayee: `0x${'0'.repeat(40)}` } }, `0x${'0'.repeat(40)}`)).toBe(0n);
    expect(creatorFeesOf({ ...graduated, graduated: false }, A)).toBe(0n);
    expect(creatorFeesOf(view, A)).toBe(0n);
    const nobody: V2Snapshot = { ...view, record: { ...view.record, creator: A }, closing: { pot: 9n, initialT: 0n, tLeft: 0n, creatorEntitlement: 9n } };
    expect(creatorRemainderOf(nobody, A)).toBe(9n);
    expect(creatorRemainderOf(nobody, B)).toBe(0n);
    expect(creatorRemainderOf({ ...nobody, closing: { pot: 9n, initialT: 1n, tLeft: 1n, creatorEntitlement: 9n } }, A)).toBe(0n);
  });

  it('claims the fees in P to the payee, exactly the next payment shown, re-simulated at the same hash; a changed amount sends nothing', async () => {
    const { view, source } = await failedBox(); const roles = rolesOfV2(view.record).contracts;
    const graduated: V2Snapshot = { ...view, failed: null, graduated: true };
    // The receiver books 2 more on the claim itself: creatorOwed says 5, the claim pays 7. Only 7 is ever sent.
    const answers: Answers = { creatorPayee: A, graduated: true, failed: false, creatorOwed: [5n, 0n], claimCreator: 7n };
    const { io: rec, sent } = io(graduated, answers, source.manifest.chainId);
    await expect(sendCreatorFeesV2(source, graduated, A, 5n, rec)).rejects.toThrow('Creator fees changed');
    await sendCreatorFeesV2(source, graduated, A, 7n, rec);
    expect(rec.as).toHaveBeenCalledWith(A, roles.receiver, receiverV2Abi, 'claimCreator', [view.record.q, A]);
    expect(rec.at).not.toHaveBeenCalledWith(roles.receiver, receiverV2Abi, 'creatorOwed', expect.anything());
    expect(sent[0]?.to).toBe(roles.receiver);
    expect(decodeFunctionData({ abi: receiverV2Abi, data: sent[0]?.data as Hex })).toMatchObject({ functionName: 'claimCreator', args: [view.record.q, A] });
    await expect(sendCreatorFeesV2(source, graduated, A, 6n, rec)).rejects.toThrow('Creator fees changed');
    answers.creatorPayee = B;
    await expect(sendCreatorFeesV2(source, graduated, A, 7n, rec)).rejects.toThrow('Creator fees changed');
    expect(sent).toHaveLength(1);
  });

  it('claims the remainder with claim(0, creator) only when no coins are counted and the quote matches', async () => {
    const { view, source } = await failedBox(); const roles = rolesOfV2(view.record).contracts;
    const mine: V2Snapshot = { ...view, record: { ...view.record, creator: A } };
    const answers: Answers = { claimState: [9n, 0n], quoteClaim: 9n };
    const { io: rec, sent } = io(mine, answers, source.manifest.chainId);
    await expect(sendCreatorRemainderV2(source, view, A, 9n, rec)).rejects.toThrow('No creator remainder');
    await sendCreatorRemainderV2(source, mine, A, 9n, rec);
    expect(sent[0]?.to).toBe(roles.coordinator);
    expect(decodeFunctionData({ abi: coordinatorV2Abi, data: sent[0]?.data as Hex })).toMatchObject({ functionName: 'claim', args: [0n, A] });
    answers.claimState = [9n, 1n];
    await expect(sendCreatorRemainderV2(source, mine, A, 9n, rec)).rejects.toThrow('Creator remainder changed');
    expect(sent).toHaveLength(1);
  });

  it('RC6RR-FC-3: a creator who was paid before claims the late inbox P that quoteClaim(0) now shows, and is told what Claimed paid', async () => {
    const { view, source } = await failedBox(); const coordinator = required(rolesOfV2(view.record).contracts.coordinator);
    // 77 P reached the inbox after the creator's first claim; claimState and quoteClaim(0) both preview it (RC6-RR-INBOX).
    const late: V2Snapshot = { ...withInbox(view), record: { ...withInbox(view).record, creator: A },
      closing: { pot: 77n, initialT: 0n, tLeft: 0n, creatorEntitlement: 77n, inboxP: 77n } };
    expect(creatorRemainderOf(late, A)).toBe(77n);
    expect(creatorRemainderInboxPOf(late, A)).toBe(77n);
    // The intake was blocked at claim time: only the established remainder was paid, and the session says so.
    const { io: rec, sent } = io(late, { claimState: [77n, 0n], quoteClaim: 77n }, source.manifest.chainId, [handInLog(coordinator, A, A, 0n, 40n)]);
    expect((await sendCreatorRemainderV2(source, late, A, 77n, rec)).paidP).toBe(40n);
    expect(decodeFunctionData({ abi: coordinatorV2Abi, data: sent[0]?.data as Hex })).toMatchObject({ functionName: 'claim', args: [0n, A] });
    // No note when the remainder holds no inbox P, for another wallet, a box with buyers, or an unknown inbox figure.
    for (const [v, account] of [[{ ...late, closing: { ...required(late.closing), inboxP: 0n } }, A], [late, B],
      [{ ...late, closing: { ...required(late.closing), initialT: 3n } }, A], [{ ...late, closing: { ...required(late.closing), inboxP: null } }, A]] as const) {
      expect(creatorRemainderInboxPOf(v, account)).toBeNull();
    }
  });

  it('a stale or unverified snapshot sends nothing', async () => {
    const { view, source } = await failedBox();
    const { io: rec, request } = io(view, {}, source.manifest.chainId);
    await expect(sendHandInV2(source, { ...view, stale: true }, A, ETH, rec)).rejects.toThrow('Refresh before claiming');
    await expect(sendCreatorFeesV2(source, { ...view, verified: false }, A, 1n, rec)).rejects.toThrow('Refresh before claiming');
    expect(request).not.toHaveBeenCalled();
  });
});

const CAP = 4n * ((1n << 127n) - 1n);
/**
 * A sender-aware canonical reader double for the shared creator quote (`readCreatorClaimV2` runs for real): it answers
 * raw eth_call bytes for the payee, phase and the payee's simulated claimCreator, and records each call's hash and sender.
 */
function quoteChain(state: { payee: Address; graduated: boolean; failed: boolean; next: bigint | Error }) {
  const calls: { fn: string; from: Address | null; hash: Hex }[] = [];
  const call = async (from: Address | null, _to: Address, data: Hex, hash: Hex): Promise<Hex> => {
    for (const abi of [receiverV2Abi, coordinatorV2Abi] as readonly Abi[]) {
      let fn: string;
      try { fn = decodeFunctionData({ abi, data }).functionName; } catch { continue; }
      calls.push({ fn, from, hash });
      if (fn === 'claimCreator') {
        if (state.next instanceof Error) throw state.next;
        return encodeFunctionResult({ abi: receiverV2Abi, functionName: 'claimCreator', result: state.next });
      }
      const result = fn === 'creatorPayee' ? state.payee : fn === 'graduated' ? state.graduated : fn === 'failed' ? state.failed : undefined;
      if (result === undefined) throw new Error(`unscripted ${fn}`);
      return encodeFunctionResult({ abi, functionName: fn, result } as never);
    }
    throw new Error('unknown call');
  };
  const reader: CreatorClaimReaderV2 = { callAt: (to, data, hash) => call(null, to, data, hash), callFromAt: (from, to, data, hash) => call(from, to, data, hash) };
  return { reader, calls };
}
/** The coordinator's Claimed(holder, to, t, p): a hand-in, or the creator's remainder with t = 0. */
const handInLog = (coordinator: Address, holder: Address, to: Address, t: bigint, p: bigint) => ({
  address: coordinator, topics: encodeEventTopics({ abi: coordinatorV2Abi, eventName: 'Claimed', args: { holder, to } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [t, p]),
});
const claimedLog = (receiver: Address, payee: Address, token: Address, to: Address, amount: bigint) => ({
  address: receiver, topics: encodeEventTopics({ abi: receiverV2Abi, eventName: 'CreatorClaimed', args: { payee, token } }),
  data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, amount]),
});

describe('FINAL-OC01 the creator’s next payment (readCreatorClaimV2), shown and sent', () => {
  async function graduatedBox(stored: bigint) {
    const { view, source } = await failedBox();
    const money = view.money as NonNullable<V2Snapshot['money']>;
    const graduated: V2Snapshot = { ...view, failed: null, graduated: true, money: { ...money, creatorPayee: A, creatorOwed: stored } };
    return { view: graduated, source, receiver: rolesOfV2(view.record).contracts.receiver as Address };
  }

  it('lazy royalties: creatorOwed is 0 while the receiver pays 1,234; the site quotes 1,234 and sends exactly that', async () => {
    const { view, source } = await graduatedBox(0n);
    const chain = quoteChain({ payee: A, graduated: true, failed: false, next: 1234n });
    expect(await readCreatorFeesV2(view, A, chain.reader)).toEqual({ block: view.block, amount: 1234n });
    // Every read at the displayed hash; the claim simulated as the payee itself.
    expect(chain.calls.every((c) => c.hash === view.blockHash)).toBe(true);
    expect(chain.calls.find((c) => c.fn === 'claimCreator')?.from).toBe(A);
    expect(boxSteps({ holder: [], items: [], creator: singleState(withSingleRead(undefined, { block: view.block, amount: 1234n })), remainder: { kind: 'none' }, handIn: { kind: 'none' } })).toEqual([{ kind: 'creator', amount: 1234n }]);
    const { io: rec, sent } = io(view, { creatorPayee: A, graduated: true, failed: false, creatorOwed: [0n, 0n], claimCreator: 1234n }, source.manifest.chainId);
    await expect(sendCreatorFeesV2(source, view, A, 0n, rec)).rejects.toThrow('No creator fees');
    await sendCreatorFeesV2(source, view, A, 1234n, rec);
    expect(sent).toHaveLength(1);
  });

  it('the four-part bound: stored CAP + 7, one claim pays CAP; its CreatorClaimed shows CAP, then the seven-unit tail is claimable, then nothing', async () => {
    const { view, source, receiver } = await graduatedBox(CAP + 7n);
    const chain = quoteChain({ payee: A, graduated: true, failed: false, next: CAP });
    const first = await readCreatorFeesV2(view, A, chain.reader);
    expect(first.amount).toBe(CAP);
    const { io: rec } = io(view, { creatorPayee: A, graduated: true, failed: false, claimCreator: CAP }, source.manifest.chainId, [claimedLog(receiver, A, view.record.q, A, CAP)]);
    const paid = await sendCreatorFeesV2(source, view, A, CAP, rec);
    expect(paid).toMatchObject({ status: 'success', blockNumber: view.block + 1n, paidP: CAP });
    // Mined at R = block + 1: Claimed until a read at R or later decides; that read finds the 7-unit tail.
    let known = withSingleClaim(withSingleRead(undefined, first), { tx: paid.transactionHash, block: paid.blockNumber, paid: paid.paidP ?? 0n });
    expect(singleState(known)).toEqual({ kind: 'claimed', amount: CAP });
    const next: V2Snapshot = { ...view, block: view.block + 1n, blockHash: H(101) };
    chain.calls.length = 0;
    known = withSingleRead(known, await readCreatorFeesV2(next, A, quoteChain({ payee: A, graduated: true, failed: false, next: 7n }).reader));
    expect(singleState(known)).toEqual({ kind: 'ready', read: { block: next.block, amount: 7n } });
    const tail = io(next, { creatorPayee: A, graduated: true, failed: false, claimCreator: 7n }, source.manifest.chainId, [claimedLog(receiver, A, view.record.q, A, 7n)]);
    expect((await sendCreatorFeesV2(source, next, A, 7n, tail.io)).paidP).toBe(7n);
    // Exhausted: the receiver's quote is 0, so nothing to claim and nothing sent.
    const done: V2Snapshot = { ...next, block: next.block + 1n, blockHash: H(102) };
    expect(await readCreatorFeesV2(done, A, quoteChain({ payee: A, graduated: true, failed: false, next: 0n }).reader)).toEqual({ block: done.block, amount: 0n });
    await expect(sendCreatorFeesV2(source, done, A, 0n, tail.io)).rejects.toThrow('No creator fees');
  });

  it('a payout the receiver refuses, or any failed read, is unavailable (a rejected read), never 0; the send refuses too', async () => {
    const { view, source } = await graduatedBox(5n);
    const refusal = Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: parseAbi(['error TransferNotExact(uint256 expected,uint256 received)']), errorName: 'TransferNotExact', args: [5n, 0n] }) });
    await expect(readCreatorFeesV2(view, A, quoteChain({ payee: A, graduated: true, failed: false, next: refusal }).reader)).rejects.toThrow();
    await expect(readCreatorFeesV2(view, A, quoteChain({ payee: A, graduated: true, failed: false, next: new Error('RPC down') }).reader)).rejects.toThrow('RPC down');
    const { io: rec, request } = io(view, { creatorPayee: A, graduated: true, failed: false, claimCreator: () => { throw refusal; } }, source.manifest.chainId);
    await expect(sendCreatorFeesV2(source, view, A, 5n, rec)).rejects.toThrow();
    expect(request.mock.calls.map(([c]) => c.method)).not.toContain('eth_sendTransaction');
  });

  it('another payee, an open or a failed box: 0 without simulating; an unknown payee is read on chain first', async () => {
    const { view } = await graduatedBox(5n);
    for (const [v, account] of [[view, B], [{ ...view, graduated: false }, A], [{ ...view, failed: { cause: 'Deadline', at: 1n } }, A]] as const) {
      const chain = quoteChain({ payee: A, graduated: true, failed: false, next: 9n });
      expect(await readCreatorFeesV2(v, account, chain.reader)).toEqual({ block: view.block, amount: 0n });
      expect(chain.calls).toEqual([]);
    }
    const chain = quoteChain({ payee: B, graduated: true, failed: false, next: 9n });
    expect(await readCreatorFeesV2({ ...view, money: null }, A, chain.reader)).toEqual({ block: view.block, amount: 0n });
    expect(chain.calls.map((c) => c.fn)).not.toContain('claimCreator');
  });

  it('reads the paid amount only from the receiver’s CreatorClaimed for this payee, coin and recipient', async () => {
    const { view, receiver } = await graduatedBox(0n);
    const q = view.record.q;
    expect(creatorClaimedOf({ logs: [claimedLog(receiver, A, q, A, 11n)] }, receiver, A, q)).toBe(11n);
    expect(creatorClaimedOf({ logs: [claimedLog(B, A, q, A, 11n)] }, receiver, A, q)).toBeNull();
    expect(creatorClaimedOf({ logs: [claimedLog(receiver, B, q, B, 11n)] }, receiver, A, q)).toBeNull();
    expect(creatorClaimedOf({ logs: [claimedLog(receiver, A, B, A, 11n)] }, receiver, A, q)).toBeNull();
    expect(creatorClaimedOf({ logs: [{ address: receiver, topics: [H(1)], data: '0x' }] }, receiver, A, q)).toBeNull();
    expect(creatorClaimedOf({}, receiver, A, q)).toBeNull();
  });
});

describe('M363-OC03 the seed return', () => {
  it('is owed only to the recorded seeder of a failed pile, while the seed is still owed and backed', async () => {
    const { body, source, seed, asset } = await publishedPile({ failed: true, loaded: true });
    const view = parseSnapshotV2(body, source);
    const seeder = view.record.creator;
    expect(seedOwedOf(view, seeder)).toEqual({ amount: seed, asset: expect.stringMatching(new RegExp(asset, 'i')), to: seeder });
    expect(seedOwedOf(view, B)).toBeNull();
    const money = view.m3?.pileMoney as NonNullable<NonNullable<V2Snapshot['m3']>['pileMoney']>;
    const pile = view.m3?.pile as NonNullable<NonNullable<V2Snapshot['m3']>['pile']>;
    const patched = (m: Partial<typeof money>, p: Partial<typeof pile> = {}): V2Snapshot => ({ ...view, m3: { ...view.m3 as NonNullable<V2Snapshot['m3']>, pileMoney: { ...money, ...m }, pile: { ...pile, ...p } } });
    expect(seedOwedOf(patched({ failed: false }), seeder)).toBeNull();
    expect(seedOwedOf(patched({ seedReturnDue: 0n }), seeder)).toBeNull();
    expect(seedOwedOf(patched({ balance: seed - 1n }), seeder)).toBeNull();
    expect(seedOwedOf(patched({ balance: null }), seeder)).toBeNull();
    expect(seedOwedOf(patched({}, { seedReturned: true }), seeder)).toBeNull();
    // Not a pile: nothing.
    const { view: holders } = await failedBox();
    expect(seedOwedOf(holders, seeder)).toBeNull();
  });
});
