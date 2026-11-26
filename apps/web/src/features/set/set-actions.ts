/**
 * SH-EXISTING-NFTS-E08C: a set box's actions, framework-free: named picks, returns, the creator's recovery after a
 * failed raise, and the coordinator's close and claim. No draw, reveal or payout exists here.
 *
 * Each action re-reads the box on chain and checks it with the routing rule (set-identity.ts) before any call names its
 * vault or collection, re-checks the wallet's network and account, prepares a pick or return with E-08B's
 * `prepareSetConversion` (set-conversion.ts: one pinned block, its hash read again, the vault's own figure as the check,
 * the exact approvals and call), and sends one checked transaction at a time through E-08B's executor
 * (`SetActionIO.submit`), waiting for each receipt. An approval is its own transaction and exact: a pick approves its
 * limit of T to the vault; a return approves the vault for each of its items (approve(vault, id)); a claim approves
 * exactly its coins to the coordinator. The wallet is asked only from a press. Amounts and ids are bigint throughout.
 */
import { BaseError, erc20Abi, parseAbi, type Address, type Hex } from 'viem';
import { SET_PICK_BATCH, SET_RELEASE_BATCH, SET_RETURN_BATCH } from '@squarehole/box-spec';
import { setCoordinatorV2Abi, setGraduateCalls, setVaultV2Abi, type SetMemberState } from '@squarehole/chain/core/set-v2';
import { NotSendableError, type ChainReader } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { coordinatorGasLimit } from '../core/v2/actions-v2';
import type { SetSource } from './set-build';
import {
  ERC721_ABI, SET_TX_GAS_CAP, approveAllCall, approveTokenCall, checkIds, claimCall, closeCall, gasWithMargin, releaseCall, sdkCall, setTargetV2Of,
  type SetCall, type SetSubmit, type SetTarget,
} from './set-calls';
import { amountOf, prepareConversion } from './set-conversion';
import { tradingOf, type SetTrading } from './set-model';
import { readSetIdentity, type SetBoxIdentity } from './set-identity';
import { same, type SetReads } from './set-reads';

export interface SetActionIO {
  readonly reads: SetReads;
  /** E-08B's sender; null while this build has none (nothing is sent). */
  readonly submit: SetSubmit | null;
  readonly wallet: Eip1193Request;
}

/** Why an action stopped before its next wallet request, in the page's words. */
export class SetActionError extends Error {
  override readonly name = 'SetActionError';
}
function stop(message: string): never {
  throw new SetActionError(message);
}

/** The step an action is on, for its status line. */
export type SetActionStep = 'checking' | 'approve' | 'send';

export interface SetActionContext {
  readonly source: SetSource;
  readonly coordinator: Address;
  /** The spec bytes the indexer published; the registry record's hash authenticates them. */
  readonly encodedSpec: Hex;
  readonly account: Address;
  readonly onStep?: (step: SetActionStep) => void;
}

/** The wallet is on the box's chain and still on `account` (checked before reads and again right before each send). */
async function walletIs(io: SetActionIO, chainId: number, account: Address): Promise<void> {
  const [network, accounts] = await Promise.all([io.wallet({ method: 'eth_chainId' }), io.wallet({ method: 'eth_accounts' })]);
  if (typeof network !== 'string' || !/^0x[0-9a-f]+$/i.test(network) || BigInt(network) !== BigInt(chainId)) stop('Switch the wallet to this box’s network.');
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !same(accounts[0], account)) stop('The wallet account changed. Connect it again.');
}

/** Estimate, re-check the wallet, send through the executor and require this transaction's success. */
async function send(io: SetActionIO, target: SetTarget, call: SetCall, account: Address, chainId: number): Promise<Hex> {
  if (!io.submit) return stop('Sending is not available in this build.');
  const estimate = await io.reads.estimateGas({ account, to: call.to, data: call.data, value: call.value });
  const box = target.kind === 'box' ? target.identity : null;
  const coordinator = box !== null && same(call.to, box.coordinator);
  const limit = coordinator ? coordinatorGasLimit(estimate) : gasWithMargin(estimate);
  if (limit === null || limit > SET_TX_GAS_CAP) return stop('Too heavy for one transaction.');
  await walletIs(io, chainId, account);
  const hash = await io.submit({ wallet: io.wallet, target, call, from: account, gasLimit: limit, feeReader: io.reads.chain });
  if (await io.reads.wait(hash) !== 'success') stop('The transaction failed on chain. Nothing changed.');
  return hash;
}

async function verified(io: SetActionIO, ctx: SetActionContext): Promise<SetBoxIdentity> {
  ctx.onStep?.('checking');
  await walletIs(io, ctx.source.chainId, ctx.account);
  return readSetIdentity(io.reads, ctx.source, ctx.coordinator, ctx.encodedSpec);
}

const big = (value: unknown): bigint => (typeof value === 'bigint' ? value : stop('A read did not answer. Try again.'));

async function gateOf(io: SetActionIO, box: SetBoxIdentity): Promise<{ readonly open: boolean; readonly failed: boolean }> {
  const [open, failed] = await Promise.all([io.reads.read(box.vault, setVaultV2Abi, 'gateOpen'), io.reads.read(box.vault, setVaultV2Abi, 'failed')]);
  return { open: open === true, failed: failed === true };
}

export interface SetActionResult {
  readonly hashes: readonly Hex[];
}

/**
 * Pick the named items for at most `shownMaxIn` T (the shown limit: the quote plus its 1%): each item inside, E-08B's
 * fresh preparation whose limit must not exceed the shown one, the wallet's T, its exact approval of that limit to the
 * vault when short, then its withdrawBatch.
 */
export async function sendPick(io: SetActionIO, ctx: SetActionContext, ids: readonly bigint[], shownMaxIn: bigint): Promise<SetActionResult> {
  const named = checkIds(ids, SET_PICK_BATCH);
  const box = await verified(io, ctx);
  const gate = await gateOf(io, box);
  if (!gate.open || gate.failed) stop('Picks open at graduation.');
  const states = await Promise.all(named.map(async (id) => [await io.reads.read(box.vault, setVaultV2Abi, 'eligible', [id]), await io.reads.read(box.vault, setVaultV2Abi, 'isOutside', [id])] as const));
  const gone = named.filter((_, i) => states[i]?.[0] !== true || states[i]?.[1] === true);
  if (gone.length > 0) stop(gone.length === 1 ? `#${gone[0]?.toString() ?? ''} is not in the box.` : `${gone.length} of these items are not in the box.`);
  const prepared = await prepareConversion(io.reads, box, ctx.account, 'pick', named);
  // What the wallet approves and the vault may pull is this fresh limit, never more than the one the page showed.
  if (prepared.limit > shownMaxIn) stop('The price changed. Refresh and try again.');
  const [balance, allowance] = await Promise.all([io.reads.read(box.token, erc20Abi, 'balanceOf', [ctx.account]), io.reads.read(box.token, erc20Abi, 'allowance', [ctx.account, box.vault])]);
  if (big(balance) < amountOf(prepared)) stop('More than this wallet holds.');
  // The executor admits a T approval to the vault only at exactly this pick's limit.
  const target: SetTarget = { kind: 'box', identity: box, tokenApproval: prepared.limit };
  const hashes: Hex[] = [];
  const [approval] = prepared.approvals;
  if (approval && big(allowance) < prepared.limit) {
    ctx.onStep?.('approve');
    hashes.push(await send(io, target, sdkCall('approveToken', approval), ctx.account, box.chainId));
  }
  ctx.onStep?.('send');
  hashes.push(await send(io, target, sdkCall('pick', prepared.call), ctx.account, box.chainId));
  return { hashes };
}

/**
 * Return the named items for at least `shownMinOut` T (the shown limit: the amount less its 1%): each must be out and
 * this wallet's; E-08B's fresh preparation whose limit must not fall below the shown one; the vault approved for each
 * item it may not take yet (its approve(vault, id), one transaction each); then its returnItems. At most 16 per
 * transaction (design § 4.9).
 */
export async function sendReturn(io: SetActionIO, ctx: SetActionContext, ids: readonly bigint[], shownMinOut: bigint): Promise<SetActionResult> {
  const named = checkIds(ids, SET_RETURN_BATCH);
  const box = await verified(io, ctx);
  const gate = await gateOf(io, box);
  if (!gate.open || gate.failed) stop('Returns open at graduation.');
  const checks = await Promise.all(named.map(async (id) => {
    const [outside, owner] = await Promise.all([io.reads.read(box.vault, setVaultV2Abi, 'isOutside', [id]), io.reads.read(box.collection, ERC721_ABI, 'ownerOf', [id]).catch(() => null)]);
    return outside === true && typeof owner === 'string' && same(owner, ctx.account);
  }));
  const notYours = named.filter((_, i) => !checks[i]);
  if (notYours.length > 0) stop(notYours.length === 1 ? `#${notYours[0]?.toString() ?? ''} is not in your wallet.` : `${notYours.length} of these items are not in your wallet.`);
  const prepared = await prepareConversion(io.reads, box, ctx.account, 'return', named);
  if (prepared.limit < shownMinOut) stop('The amount changed. Refresh and try again.');
  const target: SetTarget = { kind: 'box', identity: box };
  const hashes: Hex[] = [];
  const all = await io.reads.read(box.collection, ERC721_ABI, 'isApprovedForAll', [ctx.account, box.vault]).catch(() => false);
  for (const [i, id] of named.entries()) {
    if (all === true) break;
    const one = await io.reads.read(box.collection, ERC721_ABI, 'getApproved', [id]).catch(() => null);
    const approval = prepared.approvals[i];
    if ((typeof one === 'string' && same(one, box.vault)) || !approval) continue;
    ctx.onStep?.('approve');
    hashes.push(await send(io, target, sdkCall('approveItem', approval), ctx.account, box.chainId));
  }
  ctx.onStep?.('send');
  hashes.push(await send(io, target, sdkCall('return', prepared.call), ctx.account, box.chainId));
  return { hashes };
}

/** A release and how many of its items actually left the vault (the rest the collection refused: they stay to retry). */
export interface SetReleaseResult extends SetActionResult {
  readonly sent: number;
  readonly back: number;
}

/** The box's members as the indexer publishes them (each page authenticated by registry and box id), read at a press. */
export type SetMembersRead = () => Promise<readonly { readonly id: string; readonly state: SetMemberState }[]>;

/**
 * After failure, anyone sends up to 32 loaded items back to the creator (releaseToCreator). The vault does not revert a
 * batch for an item its collection refuses, nor for one already back: the first stays inside, deferred, to retry. So
 * only the named items still inside are sent (none: nothing is sent), and what went back is read from the chain after
 * the receipt (each item's holder), never assumed from the batch.
 */
export async function sendRelease(io: SetActionIO, ctx: SetActionContext, ids: readonly bigint[], members: SetMembersRead): Promise<SetReleaseResult> {
  const named = checkIds(ids, SET_RELEASE_BATCH);
  const box = await verified(io, ctx);
  if (!(await gateOf(io, box)).failed) stop('Items go back only after a failed raise.');
  // Only items still inside, read at one block: someone else may have sent some back since the page read its list, and
  // the vault defers those without reverting (the wallet would pay for nothing). A listed item that is not out and is
  // still the vault's is inside (one refused before included); a released one is the creator's, or has left since.
  // A released one sent back to the vault since looks the same on chain (listed, not out, the vault's): the members'
  // own record, read again now, names it Released; a refused one stays Deferred, to retry.
  const block = await io.reads.blockNumber();
  const record = await members().catch(() => stop('A read did not answer. Try again.'));
  const released = new Set(record.filter((member) => member.state === 'Released').map((member) => member.id));
  const inside = await Promise.all(named.map(async (id) => {
    const [listed, outside, holder] = await Promise.all([
      io.reads.read(box.vault, setVaultV2Abi, 'eligible', [id], block),
      io.reads.read(box.vault, setVaultV2Abi, 'isOutside', [id], block),
      io.reads.read(box.collection, ERC721_ABI, 'ownerOf', [id], block).catch(() => null),
    ]);
    return listed === true && outside === false && typeof holder === 'string' && same(holder, box.vault);
  }));
  const still = named.filter((id, i) => inside[i] && !released.has(id.toString()));
  if (still.length === 0) stop('Nothing to send back.');
  ctx.onStep?.('send');
  const hash = await send(io, { kind: 'box', identity: box }, releaseCall(box, still), ctx.account, box.chainId);
  const holders = await Promise.all(still.map((id) => io.reads.read(box.collection, ERC721_ABI, 'ownerOf', [id]).catch(() => null)));
  const back = holders.filter((holder) => typeof holder === 'string' && !same(holder, box.vault)).length;
  return { hashes: [hash], sent: still.length, back };
}

const HOOK_ABI = /* @__PURE__ */ parseAbi(['function closed() view returns (bool)', 'function closedAt() view returns (uint256)']);
/** IBoxCoordinatorV2: a gate still holding may fail 14 days after openAt; a filled curve 7 days after its fill. */
export const GATE_CAP_SECONDS = 1_209_600n;
export const GRADUATION_ESCAPE_SECONDS = 604_800n;

export interface SetCoordinatorFacts {
  readonly failed: boolean;
  readonly graduated: boolean;
  /** The coordinator's trading gate (open once loading completed and the open time came). */
  readonly gateOpen: boolean;
  /** When trading opens (or opened): 0 while the gate holds. */
  readonly effectiveOpenAt: bigint;
  readonly openAt: bigint;
  readonly deadline: bigint;
  readonly hookClosed: boolean;
  readonly closedAt: bigint;
  /** The latest block's time. */
  readonly now: bigint;
  /** A failed raise's claim pot and coins left; null before failure. */
  readonly claim: { readonly pot: bigint; readonly tLeft: bigint } | null;
  /** The creator's remainder of a raise nobody bought into (quoteClaim(0)); null when there is none. */
  readonly remainder: bigint | null;
}

/** The coordinator's state for the page's close and claim, read now (view calls only). */
export async function readCoordinatorFacts(reads: SetReads, coordinator: Address): Promise<SetCoordinatorFacts> {
  const at = (fn: string, args: readonly unknown[] = []) => reads.read(coordinator, setCoordinatorV2Abi, fn, args);
  const [failed, graduated, gateOpen, effectiveOpenAt, openAt, deadline, hook, now] = await Promise.all([
    at('failed'), at('graduated'), at('gateOpen'), at('effectiveOpenAt'), at('openAt'), at('deadline'), at('hook'), reads.timestamp(),
  ]);
  const [hookClosed, closedAt] = await Promise.all([reads.read(hook as Address, HOOK_ABI, 'closed'), reads.read(hook as Address, HOOK_ABI, 'closedAt')]);
  let claim: SetCoordinatorFacts['claim'] = null;
  let remainder: bigint | null = null;
  if (failed === true) {
    const state = await at('claimState') as readonly [bigint, bigint];
    claim = { pot: big(state[0]), tLeft: big(state[1]) };
    if (claim.tLeft === 0n) remainder = await at('quoteClaim', [0n]).then((value) => (typeof value === 'bigint' && value > 0n ? value : null), () => null);
  }
  return {
    failed: failed === true, graduated: graduated === true, gateOpen: gateOpen === true, effectiveOpenAt: big(effectiveOpenAt), openAt: big(openAt),
    deadline: big(deadline), hookClosed: hookClosed === true, closedAt: big(closedAt), now, claim, remainder,
  };
}

/** The trading gate alone (the feed's cards): the coordinator's gate and opening time, and the latest block's time. */
export async function readTrading(reads: SetReads, coordinator: Address): Promise<SetTrading> {
  const block = await reads.blockNumber();
  const at = (fn: string) => reads.read(coordinator, setCoordinatorV2Abi, fn, [], block);
  const [gateOpen, effectiveOpenAt, now] = await Promise.all([at('gateOpen'), at('effectiveOpenAt'), reads.timestamp(block)]);
  return tradingOf({ gateOpen: gateOpen === true, effectiveOpenAt: big(effectiveOpenAt), now });
}

/** A filled box anyone may graduate now: its curve full (the hook closed), neither graduated nor failed. */
export const graduatable = (facts: Pick<SetCoordinatorFacts, 'hookClosed' | 'graduated' | 'failed'>): boolean =>
  facts.hookClosed && !facts.graduated && !facts.failed;

/** A read that failed on the way (the RPC rejected, refused or let it time out), whatever it was about to show. */
class SetReadFailed extends Error {
  override readonly name = 'SetReadFailed';
}

/** E-09C's own refusals of what it read (as opposed to the box's bindings or roles, or the reader's chain). */
const READ_REFUSALS: ReadonlySet<string> = new Set(['set graduation block unavailable', 'set graduation block changed', 'set graduation state unavailable']);

/** The site's reader with each of its failures marked as a read's, for E-09C's `setGraduateCalls`. */
function marked(chain: ChainReader): ChainReader {
  const attempt = async <T,>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (cause) {
      throw new SetReadFailed('A read did not answer.', { cause });
    }
  };
  return {
    ...chain,
    chainId: () => attempt(() => chain.chainId()),
    blockNumber: () => attempt(() => chain.blockNumber()),
    getBlock: (block, full) => attempt(() => chain.getBlock(block, full)),
    call: (request, block) => attempt(() => chain.call(request, block)),
  };
}

/**
 * Graduate a filled box: anyone may send it (sender ownership does not matter). The box is checked again first, then
 * E-09C's `setGraduateCalls` reads its coordinator's bindings, the hook's closure and the coordinator's graduation and
 * failure at one pinned block (its hash read again) and returns the one canonical graduate() call with that observation,
 * which E-08B's guard requires; the estimate simulates it, then the executor sends it.
 */
export async function sendGraduate(io: SetActionIO, ctx: SetActionContext): Promise<SetActionResult> {
  const box = await verified(io, ctx);
  let prepared: Awaited<ReturnType<typeof setGraduateCalls>>;
  try {
    prepared = await setGraduateCalls(marked(io.reads.chain), setTargetV2Of({ kind: 'box', identity: box }), ctx.account);
  } catch (error) {
    // The guard on the pinned observation: not full, already graduated or failed.
    if (error instanceof NotSendableError) return stop('This box cannot graduate now.');
    // A read the RPC rejected, refused or let time out; a result its ABI cannot decode (empty or malformed data); a
    // block missing or moved between the reads; a state that is not a yes or no: worth another try.
    if (error instanceof SetReadFailed || error instanceof BaseError || READ_REFUSALS.has(error instanceof Error ? error.message : '')) return stop('A read did not answer. Try again.');
    // What is left refuses the box itself: its identity checked again, the coordinator's bindings or roles, or the
    // site's reader on another chain (the wallet's network was checked first).
    return stop('This box could not be checked. Nothing was sent.');
  }
  const graduation = prepared.target.graduation;
  if (!graduation) return stop('This box cannot graduate now.');
  ctx.onStep?.('send');
  return { hashes: [await send(io, { kind: 'box', identity: box, graduation }, sdkCall('graduate', prepared.call), ctx.account, box.chainId)] };
}

/** Which close anyone may send now: fail() past the deadline or a filled curve's hatch, failClosed() past the gate's cap. */
export function closeOf(facts: SetCoordinatorFacts): 'fail' | 'failClosed' | null {
  if (facts.failed || facts.graduated) return null;
  if (!facts.gateOpen) return facts.now >= facts.openAt + GATE_CAP_SECONDS ? 'failClosed' : null;
  if (facts.hookClosed) return facts.closedAt > 0n && facts.now >= facts.closedAt + GRADUATION_ESCAPE_SECONDS ? 'fail' : null;
  return facts.deadline > 0n && facts.now >= facts.deadline ? 'fail' : null;
}

/** Close a raise that can no longer succeed (fail or failClosed, whichever the chain allows now). */
export async function sendClose(io: SetActionIO, ctx: SetActionContext): Promise<SetActionResult> {
  const box = await verified(io, ctx);
  const kind = closeOf(await readCoordinatorFacts(io.reads, box.coordinator));
  if (kind === null) stop('This raise cannot be closed now.');
  ctx.onStep?.('send');
  return { hashes: [await send(io, { kind: 'box', identity: box }, closeCall(box, kind), ctx.account, box.chainId)] };
}

/**
 * A failed raise's claim: `t` coins handed in for their share of the pot, to this wallet (an exact approval of `t` to
 * the coordinator first, when short); `t` = 0 is the creator's remainder of a raise nobody bought into.
 */
export async function sendClaim(io: SetActionIO, ctx: SetActionContext, t: bigint): Promise<SetActionResult> {
  const box = await verified(io, ctx);
  const facts = await readCoordinatorFacts(io.reads, box.coordinator);
  if (!facts.failed || facts.claim === null) stop('Claims open after a failed raise.');
  // The executor admits a T approval to the box's own coordinator only at exactly this holder's claim, to itself.
  const target: SetTarget = t === 0n ? { kind: 'box', identity: box } : { kind: 'box', identity: box, claimApproval: { from: ctx.account, amount: t } };
  const hashes: Hex[] = [];
  if (t === 0n) {
    if (!same(ctx.account, box.creator) || facts.remainder === null) stop('Nothing to claim here.');
  } else {
    const [balance, allowance] = await Promise.all([io.reads.read(box.token, erc20Abi, 'balanceOf', [ctx.account]), io.reads.read(box.token, erc20Abi, 'allowance', [ctx.account, box.coordinator])]);
    if (t < 0n || t > big(balance) || t > (facts.claim?.tLeft ?? 0n)) stop('More coins than this wallet can claim with.');
    if (big(allowance) < t) {
      ctx.onStep?.('approve');
      hashes.push(await send(io, target, approveTokenCall(box, 'coordinator', t), ctx.account, box.chainId));
    }
  }
  ctx.onStep?.('send');
  hashes.push(await send(io, target, claimCall(box, t, ctx.account), ctx.account, box.chainId));
  return { hashes };
}

/** The creator takes back the box's loading approval (setApprovalForAll(vault, false)) once loading is over. */
export async function sendRevoke(io: SetActionIO, ctx: SetActionContext): Promise<SetActionResult> {
  const box = await verified(io, ctx);
  if (!same(ctx.account, box.creator)) stop('Only the creator’s wallet holds this approval.');
  if (await io.reads.read(box.collection, ERC721_ABI, 'isApprovedForAll', [box.creator, box.vault]) !== true) stop('Already revoked.');
  ctx.onStep?.('send');
  return { hashes: [await send(io, { kind: 'box', identity: box }, approveAllCall(box, false), ctx.account, box.chainId)] };
}
