/**
 * TA-50: draws on a hidden-art box's page (BoxTicketsV2: `draw`, `openDraw`; SH-TA-32's builders and guard).
 *
 * - **Draw**: one hidden item for the vault's quote plus the 1% draw fee, up to the quote plus 1% (`drawLimitFor`), with
 *   the drand round's posting bounty as the draw's value (`drawValueFor`: 600,000 gas at twice today's base fee plus
 *   1 gwei; the contract keeps the round's shortfall and sends the rest back). A finite approval of exactly that limit
 *   to the tickets comes first when the wallet has not given it. The draw sends exactly the bounty the drawer confirmed;
 *   when the fee at sending needs more, nothing is sent and the new amount needs its own confirmation (fix round 1).
 * - **Waiting**: a requested draw waits for its quicknet round to be posted (anyone posts it; its bounty pays the
 *   poster) and for the queue to settle it (anyone settles; the keeper does). Only then does it name its item.
 * - **Open**: a settled draw opens with its item's reveal and proof, which only the creator's reveal file gives (the
 *   reveal service posts the same for the drawer). Without it the drawer waits for the reveal.
 *
 * Every send runs only after a press: fresh chain reads, the call built by the shared builders (each runs the shared
 * guard), a simulation with the exact value, an estimate, the wallet checked again, then `submitWrite` (which runs the
 * guard once more) and the receipt. Reads never touch the wallet.
 */
import { drawLimitFor, drawValueFor } from '@squarehole/chain';
import { boxCollectionAbi, boxTicketsAbi, drandSourceAbi } from '@squarehole/chain/abi';
import { submitWrite, type SendFeeReader } from '@squarehole/chain/write';
import { feeReaderOf } from './actions-v2';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { BaseError, ContractFunctionRevertedError, createPublicClient, decodeEventLog, erc20Abi, http, parseAbiItem, type Abi, type Address, type Hex } from 'viem';
import {
  collectionTargetV2, collectionTokenApprovalCallV2, drawCallV2, openDrawCallV2, vaultV2Abi,
  type BoxRecordV2, type CollectionTargetV2, type ItemRevealV2,
} from '../../../../../../packages/chain/src/core/v2';
import type { WriteCallV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import { ArtMode } from '@squarehole/box-spec';
import { DRAW, PHASE } from '../box0/box0-model';
import { Box0UnconfirmedError, gasLimitForBox0 } from '../box0/box0-send';
import type { RevealFile } from './reveal-file';

/** The box's roles a hidden draw needs, from its verified record. */
export interface HiddenRoles {
  readonly chainId: number;
  readonly record: BoxRecordV2;
  readonly tickets: Address;
  readonly vault: Address;
  readonly collection: Address;
  readonly token: Address;
  /** The address that made the box (the record's): the one who holds the reveal file. */
  readonly creator: Address;
}

export type HiddenRead = 'phase' | 'status' | 'drawTicket' | 'source' | 'collectionSize' | 'quoteTake' | 'revealRoot' | 'firstId' | 'traitsOf'
  | 'requestOf' | 'beaconOf' | 'balanceOf' | 'allowance';

const ABIS: Readonly<Record<HiddenRead, Abi>> = {
  phase: boxTicketsAbi, status: boxTicketsAbi, drawTicket: boxTicketsAbi, source: boxTicketsAbi, collectionSize: boxTicketsAbi,
  quoteTake: vaultV2Abi, revealRoot: boxCollectionAbi, firstId: boxCollectionAbi, traitsOf: boxCollectionAbi,
  requestOf: drandSourceAbi, beaconOf: drandSourceAbi, balanceOf: erc20Abi, allowance: erc20Abi,
};

export interface HiddenLog { readonly address: Address; readonly topics: readonly Hex[]; readonly data: Hex }

export interface HiddenIO {
  chainId(): Promise<number>;
  readonly request: Eip1193Request;
  read(to: Address, fn: HiddenRead, args?: readonly unknown[]): Promise<unknown>;
  /** The ticket ids this drawer's `DrawRequested` events name, from the box's creation block on. */
  drawsOf(tickets: Address, drawer: Address, fromBlock: bigint): Promise<readonly bigint[]>;
  block(): Promise<{ readonly timestamp: bigint; readonly baseFee: bigint }>;
  simulate(call: WriteCallV2, account: Address): Promise<void>;
  estimate(call: WriteCallV2, account: Address): Promise<bigint>;
  receipt(hash: Hex): Promise<{ readonly status: 'success' | 'reverted'; readonly logs: readonly HiddenLog[] }>;
  readonly submit: typeof submitWrite;
  /** SH-SEND-FEES: the box RPC's fee and balance reads the send carries. */
  readonly feeReader: SendFeeReader;
}

const DRAW_REQUESTED = parseAbiItem('event DrawRequested(uint256 indexed ticketId, address indexed drawer, uint256 principal, uint256 fee, uint256 round, uint256 bounty)');

/** Fix round 1 (F3): the latest block's base fee could not be read as a fee. No draw is prepared or sent on it. */
export class FeeUnavailableError extends Error {
  constructor() {
    super('Network fee unavailable. Try again.');
    this.name = 'FeeUnavailableError';
  }
}

/**
 * Fix round 1 (F3): a block's base fee as a draw needs it, a nonnegative whole number of wei. An explicit 0 is a fee (a
 * local chain). A missing one (null: no EIP-1559 fee) or a malformed one is refused, never read as 0.
 */
export function baseFeeOf(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new FeeUnavailableError();
  return value;
}

/** Fix round 1 (F1): the bounty the drawer confirmed no longer covers the round at the fee now. Nothing was sent. */
export class DrawBountyRoseError extends Error {
  constructor() {
    super('The network fee rose. Check the new amount and confirm again.');
    this.name = 'DrawBountyRoseError';
  }
}

/** The default IO: the box's RPC for reads, the connected wallet (when there is one) for the one send. */
export function hiddenIO(rpcUrl: string, request: Eip1193Request): HiddenIO {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) });
  return {
    chainId: () => client.getChainId(),
    request,
    read: (to, fn, args = []) => client.readContract({ address: to, abi: ABIS[fn], functionName: fn, args } as never),
    drawsOf: async (tickets, drawer, fromBlock) => {
      const logs = await client.getLogs({ address: tickets, event: DRAW_REQUESTED, args: { drawer }, fromBlock, toBlock: 'latest' });
      return logs.map((log) => log.args.ticketId).filter((id): id is bigint => typeof id === 'bigint');
    },
    block: async () => {
      let block: { readonly timestamp: bigint; readonly baseFeePerGas: bigint | null };
      try {
        block = await client.getBlock({ blockTag: 'latest' });
      } catch {
        // Unread, or a field the client could not parse (a malformed base fee among them): never a fee of 0.
        throw new FeeUnavailableError();
      }
      return { timestamp: block.timestamp, baseFee: baseFeeOf(block.baseFeePerGas) };
    },
    simulate: async (call, account) => { await client.call({ to: call.to, data: call.data, value: call.value, account }); },
    estimate: (call, account) => client.estimateGas({ to: call.to, data: call.data, value: call.value, account }),
    receipt: async (hash) => {
      const r = await client.waitForTransactionReceipt({ hash });
      return { status: r.status, logs: r.logs.map((log) => ({ address: log.address, topics: log.topics as Hex[], data: log.data })) };
    },
    submit: submitWrite,
    feeReader: feeReaderOf(rpcUrl),
  };
}

/** Reads need no wallet: the same IO without one (its request refuses). */
export const readOnlyIO = (rpcUrl: string): HiddenIO => hiddenIO(rpcUrl, async () => { throw new Error('No wallet for reads'); });

/** One draw as the page shows it. */
export interface HiddenDraw {
  readonly id: bigint;
  readonly drawer: Address;
  readonly status: number;
  /** Its quicknet round (a requested draw); null once settled or when unread. */
  readonly round: bigint | null;
  /** Whether that round is posted on the source. */
  readonly posted: boolean;
  /** The drawn item (settled or opened); 0 before. */
  readonly itemId: bigint;
  /** The item's picture hash once the collection says it is revealed; null before (or unread). */
  readonly imageHash: Hex | null;
}

/** Fix round 1 (F2): the draw's price could not be read (the RPC, not the vault): never the same as "no draw". */
export const QUOTE_UNAVAILABLE = 'unavailable';

export interface HiddenReads {
  readonly phase: number;
  /**
   * One draw's price now (principal + 1% fee); null when the vault refuses to quote one (its own error: failed, nothing
   * hidden left); `QUOTE_UNAVAILABLE` when the price could not be read.
   */
  readonly quote: bigint | null | typeof QUOTE_UNAVAILABLE;
  readonly revealRoot: Hex;
  readonly collectionSize: bigint;
  readonly firstId: bigint;
  readonly draws: readonly HiddenDraw[];
}

/** How many of the latest draws the creator's view reads (to open others' settled draws with the file). */
export const RECENT_DRAWS = 64n;
const ZERO = /^0x0{64}$/i;
const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : 0n);

/** The vault's own refusal: a revert that carries its error (fix round 1, F2). Any other failure is not an answer. */
function vaultRefused(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError && typeof revert.raw === 'string' && revert.raw !== '0x';
}

async function quoteOne(roles: HiddenRoles, io: HiddenIO): Promise<HiddenReads['quote']> {
  let quote: unknown;
  try {
    quote = await io.read(roles.vault, 'quoteTake', [1n]);
  } catch (error) {
    // The vault refusing (failed, nothing hidden left) offers no draw; an unread price is unavailable (fix round 1, F2).
    return vaultRefused(error) ? null : QUOTE_UNAVAILABLE;
  }
  if (!Array.isArray(quote) || typeof quote[0] !== 'bigint' || typeof quote[1] !== 'bigint') return QUOTE_UNAVAILABLE;
  return quote[0] + quote[1];
}

type TicketRead = { readonly id: bigint; readonly drawer: Address; readonly status: number; readonly itemId: bigint };

async function readTicket(roles: HiddenRoles, id: bigint, io: HiddenIO): Promise<TicketRead> {
  const d = (await io.read(roles.tickets, 'drawTicket', [id])) as { drawer?: unknown; status?: unknown; itemId?: unknown } | null;
  return { id, drawer: (typeof d?.drawer === 'string' ? d.drawer : `0x${'0'.repeat(40)}`) as Address, status: Number(d?.status ?? 0), itemId: big(d?.itemId) };
}

/** A followed draw's round (while requested) and its item's revealed picture hash (once the chain stores one). */
async function detail(roles: HiddenRoles, source: Address, t: TicketRead, io: HiddenIO): Promise<HiddenDraw> {
  let round: bigint | null = null;
  let posted = false;
  if (t.status === DRAW.Requested) {
    const request = (await io.read(source, 'requestOf', [roles.tickets, t.id])) as readonly unknown[];
    round = big(request?.[1]);
    const beacon = (await io.read(source, 'beaconOf', [round])) as readonly unknown[];
    posted = big(beacon?.[1]) > 0n;
  }
  let imageHash: Hex | null = null;
  if ((t.status === DRAW.Settled || t.status === DRAW.Opened) && t.itemId > 0n) {
    // Only the chain's own record of a revealed item names a picture to show (never the reveal file's).
    const traits = (await io.read(roles.collection, 'traitsOf', [t.itemId])) as readonly unknown[];
    if (traits?.[0] === true && typeof traits[2] === 'string' && !ZERO.test(traits[2])) imageHash = traits[2].toLowerCase() as Hex;
  }
  return { ...t, round, posted, imageHash };
}

/**
 * The panel's reads: the phase, a draw's price, the collection's root and size, and the draws this viewer follows:
 * its own (its `DrawRequested` events, and this tab's) and, for the creator, the latest settled draws that wait for a
 * reveal. When the node refuses the log range, the latest draws stand in for the wallet's own.
 */
export async function readHiddenDraws(roles: HiddenRoles, account: Address | null, session: readonly bigint[], io: HiddenIO): Promise<HiddenReads> {
  const [phase, status, source, quote, revealRoot, collectionSize, firstId] = await Promise.all([
    io.read(roles.tickets, 'phase'), io.read(roles.tickets, 'status'), io.read(roles.tickets, 'source'), quoteOne(roles, io),
    io.read(roles.collection, 'revealRoot'), io.read(roles.tickets, 'collectionSize'), io.read(roles.collection, 'firstId'),
  ]);
  const requested = big((status as { drawsRequested?: unknown } | null)?.drawsRequested);
  const within = (id: bigint) => id >= 1n && id <= requested;
  const mine = new Set<bigint>(session.filter(within));
  const creator = account !== null && same(account, roles.creator);
  let scan = creator;
  if (account) {
    try {
      for (const id of await io.drawsOf(roles.tickets, account, roles.record.creationBlock)) if (within(id)) mine.add(id);
    } catch {
      scan = true;
    }
  }
  const recent: bigint[] = [];
  if (scan) for (let id = requested; id >= 1n && id > requested - RECENT_DRAWS; id -= 1n) recent.push(id);
  const ids = [...new Set([...mine, ...recent])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tickets = await Promise.all(ids.map((id) => readTicket(roles, id, io)));
  const followed = tickets.filter((t) => mine.has(t.id) || (account !== null && same(t.drawer, account)) || (creator && t.status === DRAW.Settled));
  const draws = await Promise.all(followed.map((t) => detail(roles, source as Address, t, io)));
  return { phase: Number(phase), quote, revealRoot: revealRoot as Hex, collectionSize: big(collectionSize), firstId: big(firstId), draws };
}

/** Whether the tickets draw now (after graduation, not stopped), by the phase alone. */
const drawingPhase = (phase: number): boolean => phase === PHASE.AwaitingWord || phase === PHASE.Drawing;

/** Whether the page offers a draw now: the tickets draw (after graduation, not stopped) and the vault quotes one. */
export const drawOpen = (reads: Pick<HiddenReads, 'phase' | 'quote'>): boolean =>
  drawingPhase(reads.phase) && typeof reads.quote === 'bigint' && reads.quote > 0n;

/** Fix round 1 (F2): the tickets draw, but the price is unread: the draw shows as unavailable, not offered, not hidden. */
export const drawPriceUnavailable = (reads: Pick<HiddenReads, 'phase' | 'quote'>): boolean =>
  drawingPhase(reads.phase) && reads.quote === QUOTE_UNAVAILABLE;

/** One draw's row: its line, and the press it offers (none while it waits). */
export type DrawRow =
  | { readonly kind: 'waiting-round'; readonly draw: HiddenDraw }
  | { readonly kind: 'settling'; readonly draw: HiddenDraw }
  | { readonly kind: 'open'; readonly draw: HiddenDraw }
  | { readonly kind: 'waiting-reveal'; readonly draw: HiddenDraw }
  | { readonly kind: 'revealed'; readonly draw: HiddenDraw }
  | { readonly kind: 'unrevealed'; readonly draw: HiddenDraw };

/**
 * Where each draw stands for this viewer. A settled draw opens here only with the creator's reveal file loaded and
 * holding that item; the drawer waits for the reveal otherwise. An item shows its picture only once revealed on chain.
 */
export function drawRows(reads: HiddenReads, account: Address | null, file: RevealFile | null): DrawRow[] {
  const rows: DrawRow[] = [];
  for (const draw of reads.draws) {
    if (draw.status === DRAW.Requested) rows.push({ kind: draw.posted ? 'settling' : 'waiting-round', draw });
    else if (draw.status === DRAW.Settled) {
      const mine = account !== null && same(draw.drawer, account);
      const opens = file !== null && file.revealOf(draw.itemId) !== null;
      if (opens) rows.push({ kind: 'open', draw });
      else if (mine) rows.push({ kind: 'waiting-reveal', draw });
    } else if (draw.status === DRAW.Opened) rows.push({ kind: draw.imageHash ? 'revealed' : 'unrevealed', draw });
  }
  return rows;
}

/** A draw's deadline: 30 minutes after the latest block (box 0's). */
const DRAW_DEADLINE_SECONDS = 1_800n;

export interface DrawPlanV2 {
  /** The chain's quote for one: principal + 1% draw fee. */
  readonly quote: bigint;
  /** The most the draw may take: the quote plus 1%; also the exact approval. */
  readonly limit: bigint;
  readonly needsApproval: boolean;
  /** The wallet holds less than the quote. */
  readonly short: boolean;
  /** The drand round's bounty sent with the draw; all but the round's top-up comes back in the same call. */
  readonly value: bigint;
}

/** The wallet is on the box's network and still on `account`: checked before the reads and again right before sending. */
async function identity(roles: HiddenRoles, account: Address, io: Pick<HiddenIO, 'chainId' | 'request'>): Promise<void> {
  const [network, walletNetwork, accounts] = await Promise.all([io.chainId(), io.request({ method: 'eth_chainId' }), io.request({ method: 'eth_accounts' })]);
  if (network !== roles.chainId || typeof walletNetwork !== 'string' || BigInt(walletNetwork) !== BigInt(roles.chainId)) throw new Error('Wrong network');
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== account.toLowerCase()) throw new Error('Wallet changed; confirm again');
}

async function drawing(roles: HiddenRoles, io: HiddenIO): Promise<bigint> {
  const phase = Number(await io.read(roles.tickets, 'phase'));
  const quote = await quoteOne(roles, io);
  if (drawPriceUnavailable({ phase, quote })) throw new Error('Price unavailable. Try again.');
  if (!drawOpen({ phase, quote }) || typeof quote !== 'bigint') throw new Error('The box is not drawing now');
  return quote;
}

/** What a draw takes now, read after the press (no wallet request). */
export async function prepareDrawV2(roles: HiddenRoles, account: Address, io: HiddenIO): Promise<DrawPlanV2> {
  const quote = await drawing(roles, io);
  const limit = drawLimitFor(quote);
  const [allowance, balance, block] = await Promise.all([io.read(roles.token, 'allowance', [account, roles.tickets]), io.read(roles.token, 'balanceOf', [account]), io.block()]);
  if (typeof allowance !== 'bigint' || typeof balance !== 'bigint') throw new Error('Balance unavailable');
  return { quote, limit, needsApproval: allowance < limit, short: balance < quote, value: drawValueFor(baseFeeOf(block.baseFee)) };
}

export type HiddenStep =
  | { readonly kind: 'approve'; readonly amount: bigint }
  /** `value`: the bounty the drawer confirmed (the plan's), sent exactly (fix round 1, F1). */
  | { readonly kind: 'draw'; readonly limit: bigint; readonly value: bigint }
  | { readonly kind: 'open'; readonly ticket: bigint; readonly file: RevealFile };

/** The shared builders' target for this box and caller (SH-TA-32), with this step's exact approval or bounty. */
export function hiddenTarget(roles: HiddenRoles, account: Address, extra: Partial<Pick<CollectionTargetV2, 'collectionApproval' | 'drawValue'>> = {}): CollectionTargetV2 {
  const target = collectionTargetV2(roles.chainId, roles.record, account);
  if (!same(target.tickets, roles.tickets) || !same(target.collection, roles.collection) || !same(target.vault, roles.vault) || !same(target.token, roles.token)) throw new Error('Box roles changed; refresh');
  return { ...target, ...extra };
}

/** The step's call, built after the contract's own conditions are read again now. */
async function prepared(roles: HiddenRoles, account: Address, step: HiddenStep, io: HiddenIO): Promise<{ readonly target: CollectionTargetV2; readonly call: WriteCallV2 }> {
  switch (step.kind) {
    case 'approve': {
      if (step.amount <= 0n) throw new Error('Nothing to approve');
      const target = hiddenTarget(roles, account, { collectionApproval: { kind: 'token', spender: 'tickets', amount: step.amount } });
      return { target, call: collectionTokenApprovalCallV2(target, account) };
    }
    case 'draw': {
      const quote = await drawing(roles, io);
      if (quote > step.limit) throw new Error('The price moved; check the new price');
      const [allowance, balance, block] = await Promise.all([io.read(roles.token, 'allowance', [account, roles.tickets]), io.read(roles.token, 'balanceOf', [account]), io.block()]);
      if (typeof allowance !== 'bigint' || allowance < step.limit) throw new Error('Approve the coins first');
      // The contract pulls the quote at inclusion; a balance between the quote and the limit is enough.
      if (typeof balance !== 'bigint' || balance < quote) throw new Error('Not enough coins');
      // Fix round 1 (F1): exactly the confirmed bounty, in the call and in the guard's target. A fee that now needs more
      // stops here; the page shows the new amount for a new confirmation. Less needed: the contract sends the rest back.
      if (drawValueFor(baseFeeOf(block.baseFee)) > step.value) throw new DrawBountyRoseError();
      const target = hiddenTarget(roles, account, { drawValue: step.value });
      return { target, call: drawCallV2(target, step.limit, block.timestamp + DRAW_DEADLINE_SECONDS, account) };
    }
    case 'open': {
      const d = (await io.read(roles.tickets, 'drawTicket', [step.ticket])) as { status?: unknown; itemId?: unknown } | null;
      if (Number(d?.status) !== DRAW.Settled) throw new Error('This draw has no item yet');
      const reveal: ItemRevealV2 | null = step.file.revealOf(big(d?.itemId));
      const root = await io.read(roles.collection, 'revealRoot');
      if (!reveal || !same(root, step.file.root)) throw new Error('The reveal file does not hold this item');
      const target = hiddenTarget(roles, account);
      return { target, call: openDrawCallV2(target, step.ticket, reveal, account) };
    }
  }
}

/** The draw ticket the receipt's own `DrawRequested` names (from the tickets contract, for this drawer). */
function ticketOf(roles: HiddenRoles, account: Address, logs: readonly HiddenLog[]): bigint | undefined {
  for (const log of logs) {
    if (!same(log.address, roles.tickets)) continue;
    try {
      const event = decodeEventLog({ abi: boxTicketsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (event.eventName === 'DrawRequested' && same(event.args.drawer, account)) return event.args.ticketId;
    } catch {
      // Another event of the tickets contract.
    }
  }
  return undefined;
}

/** @deprecated For openings use createHiddenOpeningSession().prepareOpening(ticket), then .open(handle).
 * Opening calls here are refused. One checked draw/approval send: identity, the step's call, a simulation, an estimate, identity again, the shared sender, the receipt. */
export async function sendHidden(roles: HiddenRoles, account: Address, step: HiddenStep, io: HiddenIO): Promise<{ readonly hash: Hex; readonly ticketId?: bigint }> {
  if (step.kind === 'open') throw new Error('opening-session-required');
  await identity(roles, account, io);
  const { target, call } = await prepared(roles, account, step, io);
  await io.simulate(call, account);
  const estimate = await io.estimate(call, account);
  await identity(roles, account, io);
  const hash = await io.submit({ protocol: 'core-v2', target, call, wallet: io.request, from: account, gasLimit: gasLimitForBox0(estimate), feeReader: io.feeReader });
  let receipt: Awaited<ReturnType<HiddenIO['receipt']>>;
  try {
    receipt = await io.receipt(hash);
  } catch {
    throw new Box0UnconfirmedError();
  }
  if (receipt.status !== 'success') throw new Error('Transaction reverted; nothing confirmed');
  const ticketId = step.kind === 'draw' ? ticketOf(roles, account, receipt.logs) : undefined;
  return ticketId === undefined ? { hash } : { hash, ticketId };
}

/** This box's roles for hidden draws, or null for a box without them (no tickets, or open art). */
export function hiddenRolesOf(chainId: number, record: BoxRecordV2, contracts: { readonly tickets: Address | null; readonly vault: Address | null; readonly collection: Address | null; readonly token: Address | null }, artMode: number): HiddenRoles | null {
  const { tickets, vault, collection, token } = contracts;
  if (artMode !== ArtMode.HIDDEN || !tickets || !vault || !collection || !token) return null;
  return { chainId, record, tickets, vault, collection, token, creator: record.creator };
}

/** Replacement for the page's old sendHidden(open) path. Shared session owns the lock and journal. */
export { createRevealSession as createHiddenOpeningSession } from './reveal-session';
