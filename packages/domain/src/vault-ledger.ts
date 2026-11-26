/**
 * Immutable reference ledger for the v2 lock/release vault (v2 T05; placeholder tickets stage 1, F36 a).
 *
 * Two layers share one state:
 * - **The oracle's rule set** (`withdrawMisfits`, `returnMisfits`, `transferMisfit`, `burnFit`, the stream): it
 *   mirrors the preserved oracle `square-hole-core-v2/reference/v0_1/model.py` (class `Vault`, policy `block_last`,
 *   fee-free) operation by operation, including its check order, so a differential test can compare raw integers
 *   after every step. A withdrawal here takes any inside ID (the lowest when none are given), with no gate, no reveal
 *   rule and no fee. It is reference arithmetic, not what the contract allows.
 * - **The vault's rule set** (`takeTickets`, `releaseTickets`, `deliverTickets`, `openVaultGate`, `waiveHandBackFee`,
 *   `revealMisfits`, `pickMisfits`, `returnRevealedMisfits`, `transferTicket`): what `MisfitsVault` does since stage 1
 *   and its review. A Misfit that never left the vault is *hidden* and leaves only through a ticket: the ticket locks
 *   the quote while the gate may still be closed (a placeholder during the curve, a draw after it), lowers n and h, and
 *   the Misfit is delivered after graduation. Named picks take revealed shelf Misfits only; returns need the reveal (or
 *   the adapter's return fallback); the flat fees of F23 C3 are burned after the principal moves (`fees`, ADR-0014
 *   § G05), except the hand-back fee once the coordinator waived it (F38 4 hook).
 *
 * Tickets are labelled with concrete IDs here: a take reserves the lowest unreserved hidden IDs, and a delivery hands
 * over one of the holder's reserved IDs. The contract reserves only a count and chooses the Misfit at delivery (the
 * placeholder's shuffle or a draw's pick); since every hidden Misfit weighs the same, the labels change no amount. They
 * let the oracle replay a ticket as an ordinary withdrawal of those IDs.
 *
 * One addition over the oracle (F23, v2-G06): `sendFitToVault` puts FIT into the vault outside a conversion. It lands
 * in `unsolicited`, not in the principal escrow E, so quotes do not move, and no operation here can take it out.
 *
 * Every operation returns a new ledger or throws `VaultRuleError`; the input ledger is never changed.
 */
import { VaultRuleError, type VaultRuleCode } from './errors';
import {
  assertBurnKeepsUnit,
  assertFeeBurnKeepsUnit,
  assertVaultCounts,
  feeSchedule,
  isEscrowSolvent,
  quoteHandBack,
  quotePick,
  quoteReturnNet,
  quoteReturnPrincipal,
  quoteTake,
  quoteWithdrawPrincipal,
  splitSlotStream,
  type VaultFeePolicy,
  type VaultFeeSchedule,
  type VaultTotals,
} from './vault-math';

export interface VaultLedger {
  /** N. Misfit IDs are 0 … N−1. */
  readonly collectionSize: number;
  readonly initialSupply: bigint;
  /** S. */
  readonly supply: bigint;
  /** Ordinary FIT accounts (wallets, pool, fee source, treasury). Excludes the three vault buckets below. */
  readonly balances: ReadonlyMap<string, bigint>;
  /** E: principal locked by withdrawals and tickets. */
  readonly escrow: bigint;
  /** F23: FIT sent to the vault outside a conversion. Never in E, never paid out. */
  readonly unsolicited: bigint;
  /** FIT credited by the slot stream and not yet claimed. Part of A. */
  readonly claimsReserve: bigint;
  readonly claims: ReadonlyMap<string, bigint>;
  /** IDs inside the vault (n = size): the hidden ones and the shelf. */
  readonly inventory: ReadonlySet<number>;
  /** Outside Misfit ID → current owner. */
  readonly outside: ReadonlyMap<number, string>;
  /** Stream population per owner: outside Misfits plus tickets held (a ticket counts as outside, ADR-0014 § G07). */
  readonly ownerCounts: ReadonlyMap<string, number>;
  /** Cumulative true burns (holder burns, stream burns and conversion fees). */
  readonly burned: bigint;
  /** h: IDs that never left the vault and that no ticket reserves. Always a subset of `inventory`. */
  readonly hidden: ReadonlySet<number>;
  /** t: reserved IDs (never left the vault, counted outside n) → the ticket holder. */
  readonly tickets: ReadonlyMap<number, string>;
  /** IDs whose art is revealed in the collection (only IDs that have left the vault can be). */
  readonly revealed: ReadonlySet<number>;
  /** The phase gate: false during the curve, true from graduation on, for good. */
  readonly gateOpen: boolean;
  /** The coordinator waived the return fee on hand-backs before graduation (F38 4 hook), for good. */
  readonly handBackFeeWaived: boolean;
  readonly fees: VaultFeeSchedule;
}

export interface VaultLedgerSetup {
  readonly allocations: ReadonlyMap<string, bigint> | Readonly<Record<string, bigint>>;
  readonly collectionSize: number;
  /** Default `none` (the oracle's fee-free arithmetic). */
  readonly fees?: VaultFeePolicy;
}

function fail(code: VaultRuleCode, message: string): never {
  throw new VaultRuleError(code, message);
}

/** Account names starting with `__` are reserved for vault buckets. */
function checkAccount(name: string): void {
  if (name.length === 0 || name.startsWith('__')) fail('reserved_account', 'use a named ordinary account');
}

function checkAmount(amount: bigint): void {
  if (amount < 0n) fail('invalid_amount', 'amount must be ≥ 0');
}

const balanceOf = (ledger: VaultLedger, account: string): bigint => ledger.balances.get(account) ?? 0n;

function withBalance(balances: ReadonlyMap<string, bigint>, account: string, delta: bigint): Map<string, bigint> {
  const next = new Map(balances);
  next.set(account, (balances.get(account) ?? 0n) + delta);
  return next;
}

function withCount(counts: ReadonlyMap<string, number>, owner: string, delta: number): Map<string, number> {
  const next = new Map(counts);
  const value = (counts.get(owner) ?? 0) + delta;
  if (value === 0) next.delete(owner);
  else next.set(owner, value);
  return next;
}

/** The quote inputs (S, E, n, N) of this ledger. */
export function ledgerTotals(ledger: VaultLedger): VaultTotals {
  return {
    supply: ledger.supply,
    escrow: ledger.escrow,
    inside: BigInt(ledger.inventory.size),
    collectionSize: BigInt(ledger.collectionSize),
  };
}

/** Stage-1 counts: n = h + shelf, m = N − n = Misfits outside + tickets. */
export interface LedgerCounts {
  readonly inside: number;
  readonly hidden: number;
  readonly tickets: number;
  readonly shelf: number;
  readonly outside: number;
  readonly misfitsOutside: number;
}

export function vaultCounts(ledger: VaultLedger): LedgerCounts {
  const inside = ledger.inventory.size;
  const hidden = ledger.hidden.size;
  const tickets = ledger.tickets.size;
  return {
    inside,
    hidden,
    tickets,
    shelf: inside - hidden,
    outside: ledger.collectionSize - inside,
    misfitsOutside: ledger.outside.size,
  };
}

/** True once `id` has left the vault (it is neither hidden nor reserved by a ticket). */
export function hasLeftVault(ledger: VaultLedger, id: number): boolean {
  return isCollectionId(ledger, id) && !ledger.hidden.has(id) && !ledger.tickets.has(id);
}

const isCollectionId = (ledger: VaultLedger, id: number): boolean => Number.isSafeInteger(id) && id >= 0 && id < ledger.collectionSize;

/** Throws a plain Error (a bug, not a rule) when any v2 docs/03 identity fails. */
export function checkLedgerInvariants(ledger: VaultLedger): void {
  const broken = (what: string): never => {
    throw new Error(`vault ledger invariant broken: ${what}`);
  };
  const n = ledger.inventory.size;
  const m = ledger.outside.size + ledger.tickets.size;
  if (n < 1 || n + m !== ledger.collectionSize) broken('1 ≤ n and n + Misfits outside + tickets = N');
  for (const id of ledger.outside.keys()) if (ledger.inventory.has(id) || ledger.tickets.has(id)) broken('an ID is outside and inside or reserved');
  for (const id of ledger.tickets.keys()) if (ledger.inventory.has(id)) broken('a reserved ID is inside');
  for (const id of ledger.hidden) if (!ledger.inventory.has(id)) broken('a hidden ID is not inside');
  for (const id of ledger.revealed) if (!hasLeftVault(ledger, id)) broken('a revealed ID never left the vault');
  assertVaultCounts({
    collectionSize: BigInt(ledger.collectionSize),
    inside: BigInt(n),
    hidden: BigInt(ledger.hidden.size),
    tickets: BigInt(ledger.tickets.size),
  });
  let counted = 0;
  for (const count of ledger.ownerCounts.values()) counted += count;
  if (counted !== m) broken('owner counts add up to m');
  let held = 0n;
  for (const value of ledger.balances.values()) {
    if (value < 0n) broken('balances ≥ 0');
    held += value;
  }
  if (ledger.escrow < 0n || ledger.unsolicited < 0n || ledger.claimsReserve < 0n) broken('vault buckets ≥ 0');
  if (ledger.supply + ledger.burned !== ledger.initialSupply) broken('S + burned = initial supply');
  if (held + ledger.escrow + ledger.unsolicited + ledger.claimsReserve !== ledger.supply) broken('Σ balances = S');
  let claimed = 0n;
  for (const value of ledger.claims.values()) claimed += value;
  if (claimed !== ledger.claimsReserve) broken('Σ claims = claims reserve');
  const totals = ledgerTotals(ledger);
  if (totals.supply - totals.escrow < totals.inside) broken('A ≥ n');
  if (!isEscrowSolvent(totals)) broken('E·n ≥ m·A');
}

/** A fresh vault: all N Misfits inside and hidden, E = 0, the gate closed, FIT issued once to `allocations`. */
export function createVaultLedger(setup: VaultLedgerSetup): VaultLedger {
  const { collectionSize } = setup;
  if (!Number.isSafeInteger(collectionSize) || collectionSize < 1) fail('invalid_totals', 'collection size must be ≥ 1');
  const entries = setup.allocations instanceof Map ? [...setup.allocations] : Object.entries(setup.allocations);
  const balances = new Map<string, bigint>();
  for (const [account, amount] of entries) {
    checkAccount(account);
    checkAmount(amount);
    balances.set(account, amount);
  }
  const supply = [...balances.values()].reduce((sum, value) => sum + value, 0n);
  if (supply < BigInt(collectionSize)) fail('invalid_totals', 'at least one raw FIT per Misfit is required');
  const ids = Array.from({ length: collectionSize }, (_, id) => id);
  const ledger: VaultLedger = {
    collectionSize,
    initialSupply: supply,
    supply,
    balances,
    escrow: 0n,
    unsolicited: 0n,
    claimsReserve: 0n,
    claims: new Map(),
    inventory: new Set(ids),
    outside: new Map(),
    ownerCounts: new Map(),
    burned: 0n,
    hidden: new Set(ids),
    tickets: new Map(),
    revealed: new Set(),
    gateOpen: false,
    handBackFeeWaived: false,
    fees: feeSchedule(setup.fees ?? 'none'),
  };
  checkLedgerInvariants(ledger);
  return ledger;
}

function commit(ledger: VaultLedger): VaultLedger {
  checkLedgerInvariants(ledger);
  return ledger;
}

/** Plain FIT transfer between ordinary accounts. Quotes do not change (A is unchanged). */
export function transferFit(ledger: VaultLedger, from: string, to: string, amount: bigint): VaultLedger {
  checkAccount(from);
  checkAccount(to);
  checkAmount(amount);
  if (balanceOf(ledger, from) < amount) fail('insufficient_fit', 'insufficient FIT');
  return commit({ ...ledger, balances: withBalance(withBalance(ledger.balances, from, -amount), to, amount) });
}

/** F23: FIT sent straight to the vault. It becomes permanent surplus; S, E, A and every quote stay the same. */
export function sendFitToVault(ledger: VaultLedger, from: string, amount: bigint): VaultLedger {
  checkAccount(from);
  checkAmount(amount);
  if (balanceOf(ledger, from) < amount) fail('insufficient_fit', 'insufficient FIT');
  return commit({
    ...ledger,
    balances: withBalance(ledger.balances, from, -amount),
    unsolicited: ledger.unsolicited + amount,
  });
}

/**
 * Alternative reading of unsolicited FIT, kept for the differential harness only (v2 T06): the oracle's literal
 * `donate_fit_to_escrow`, which ADR-0014 (draft, under review) proposes. The FIT joins E, so A falls and r drops by
 * amount/n, like a burn. Not the rule `sendFitToVault` applies; which one ships is a founder/review decision (v2-G06).
 * Refused when it would leave fewer than one raw FIT per inside Misfit (the oracle's guard).
 */
export function donateFitToEscrow(ledger: VaultLedger, from: string, amount: bigint): VaultLedger {
  checkAccount(from);
  checkAmount(amount);
  if (balanceOf(ledger, from) < amount) fail('insufficient_fit', 'insufficient FIT');
  assertBurnKeepsUnit(ledgerTotals(ledger), amount);
  return commit({ ...ledger, balances: withBalance(ledger.balances, from, -amount), escrow: ledger.escrow + amount });
}

/**
 * What the vault does with a Misfit sent to it outside a return. The recommended rule (ADR-0014 draft, v2-G06, founder
 * to confirm) refuses it, so a direct transfer can never create a second return right or change n. This is the only
 * place that decides; a different ratified rule changes this constant and the branch below.
 */
export const UNSOLICITED_MISFIT_POLICY = 'refuse' as const;

/**
 * A Misfit sent straight to the vault (not through `returnMisfits`). Only the current outside owner could send it, so
 * anyone else gets `not_owner`; the owner gets `unsolicited_misfit`. Always throws: nothing changes. A ticket is not a
 * Misfit: nobody owns a reserved ID, so sending one is `not_owner`.
 */
export function sendMisfitToVault(ledger: VaultLedger, from: string, id: number): VaultLedger {
  checkAccount(from);
  if (ledger.outside.get(id) !== from) fail('not_owner', 'sender does not own this outside Misfit');
  if (UNSOLICITED_MISFIT_POLICY === 'refuse') fail('unsolicited_misfit', 'a Misfit enters the vault only through a return');
  return ledger;
}

export interface WithdrawRequest {
  readonly owner: string;
  readonly count: number;
  /** Refuse if the principal is above this (slippage limit). */
  readonly maxFit?: bigint;
  /** Exact IDs to take. Without them the lowest IDs are taken (oracle order only, not a draw). */
  readonly ids?: readonly number[];
}

export interface WithdrawResult {
  readonly ledger: VaultLedger;
  readonly ids: readonly number[];
  readonly principal: bigint;
}

/**
 * The oracle's withdrawal: lock ⌈A·k/n⌉ FIT from `owner` into E and move k inside Misfits (hidden or shelf) out to
 * `owner`. No gate, no shelf or reveal rule, no fee; S is unchanged (VLT-02). The vault's own rules are `takeTickets`
 * (hidden Misfits) and `pickMisfits` (the shelf).
 */
export function withdrawMisfits(ledger: VaultLedger, request: WithdrawRequest): WithdrawResult {
  const { owner, count } = request;
  checkAccount(owner);
  if (!Number.isSafeInteger(count)) fail('invalid_quantity', 'count must be an integer');
  const principal = quoteWithdrawPrincipal(ledgerTotals(ledger), BigInt(count));
  if (request.maxFit !== undefined && principal > request.maxFit) fail('max_fit_exceeded', 'principal above maxFit');
  if (balanceOf(ledger, owner) < principal) fail('insufficient_fit', 'insufficient FIT for the principal');
  const ids = request.ids ? [...request.ids] : [...ledger.inventory].sort((a, b) => a - b).slice(0, count);
  if (ids.length !== count || new Set(ids).size !== count || ids.some((id) => !ledger.inventory.has(id))) {
    fail('ineligible_ids', 'IDs must be distinct and inside the vault');
  }
  const inventory = new Set(ledger.inventory);
  const hidden = new Set(ledger.hidden);
  const outside = new Map(ledger.outside);
  for (const id of ids) {
    inventory.delete(id);
    hidden.delete(id);
    outside.set(id, owner);
  }
  const next = commit({
    ...ledger,
    balances: withBalance(ledger.balances, owner, -principal),
    escrow: ledger.escrow + principal,
    inventory,
    hidden,
    outside,
    ownerCounts: withCount(ledger.ownerCounts, owner, count),
  });
  return { ledger: next, ids, principal };
}

export interface ReturnRequest {
  readonly owner: string;
  readonly ids: readonly number[];
  /** Refuse if the release is below this (slippage limit). */
  readonly minFit?: bigint;
}

export interface ReturnResult {
  readonly ledger: VaultLedger;
  readonly principal: bigint;
}

/**
 * The oracle's return: take back Misfits the caller owns outside and release ⌊A·k/n⌋ FIT from E to them. Only the
 * current owner can do this; no earlier deposit is remembered (VLT-03, VLT-04). No gate, reveal rule or fee (see
 * `returnRevealedMisfits`). S is unchanged; unsolicited FIT is never touched.
 */
export function returnMisfits(ledger: VaultLedger, request: ReturnRequest): ReturnResult {
  const { owner, ids } = request;
  checkAccount(owner);
  if (ids.length === 0 || new Set(ids).size !== ids.length) fail('invalid_id_list', 'IDs must be non-empty and distinct');
  if (ids.some((id) => ledger.outside.get(id) !== owner)) fail('not_owner', 'caller does not own these outside Misfits');
  const principal = quoteReturnPrincipal(ledgerTotals(ledger), BigInt(ids.length));
  if (request.minFit !== undefined && principal < request.minFit) fail('min_fit_not_met', 'release below minFit');
  if (principal > ledger.escrow) fail('escrow_insolvent', 'escrow below the release');
  const inventory = new Set(ledger.inventory);
  const outside = new Map(ledger.outside);
  for (const id of ids) {
    outside.delete(id);
    inventory.add(id);
  }
  const next = commit({
    ...ledger,
    balances: withBalance(ledger.balances, owner, principal),
    escrow: ledger.escrow - principal,
    inventory,
    outside,
    ownerCounts: withCount(ledger.ownerCounts, owner, -ids.length),
  });
  return { ledger: next, principal };
}

/** Move an outside Misfit to a new owner. The return right moves with it; nothing else changes. */
export function transferMisfit(ledger: VaultLedger, from: string, to: string, id: number): VaultLedger {
  checkAccount(from);
  checkAccount(to);
  if (ledger.outside.get(id) !== from) fail('not_owner', 'sender does not own this outside Misfit');
  const outside = new Map(ledger.outside);
  outside.set(id, to);
  return commit({ ...ledger, outside, ownerCounts: withCount(withCount(ledger.ownerCounts, from, -1), to, 1) });
}

/** True burn from an ordinary funded account (never from E). r falls by amount/n; K grows by amount·m/n. */
export function burnFit(ledger: VaultLedger, owner: string, amount: bigint): VaultLedger {
  checkAccount(owner);
  checkAmount(amount);
  if (balanceOf(ledger, owner) < amount) fail('insufficient_fit', 'insufficient FIT to burn');
  assertBurnKeepsUnit(ledgerTotals(ledger), amount);
  return commit({
    ...ledger,
    balances: withBalance(ledger.balances, owner, -amount),
    supply: ledger.supply - amount,
    burned: ledger.burned + amount,
  });
}

export interface StreamAllocation {
  readonly budget: bigint;
  readonly burned: bigint;
  readonly credited: bigint;
  readonly dustRetainedBySource: bigint;
}

/**
 * Allocate a funded FIT stream budget across the N Misfit slots (F23 A3): inside shares burn now, outside shares are
 * credited to current owners (claimable later, never expiring). A ticket counts as outside (ADR-0014 § G07). Rounding
 * dust stays with `source`.
 */
export function accrueSlotStream(
  ledger: VaultLedger,
  source: string,
  budget: bigint,
): { readonly ledger: VaultLedger; readonly allocation: StreamAllocation } {
  checkAccount(source);
  checkAmount(budget);
  if (balanceOf(ledger, source) < budget) fail('stream_not_funded', 'stream budget is not funded');
  const counts = new Map([...ledger.ownerCounts].map(([owner, count]) => [owner, BigInt(count)] as const));
  const totals = ledgerTotals(ledger);
  const split = splitSlotStream(budget, totals.inside, totals.collectionSize, counts);
  if (totals.supply - totals.escrow - split.burned < totals.inside) {
    fail('dust_guard', 'stream burn would leave less than one raw FIT per inside Misfit');
  }
  const claims = new Map(ledger.claims);
  for (const [owner, value] of split.credits) claims.set(owner, (claims.get(owner) ?? 0n) + value);
  const next = commit({
    ...ledger,
    balances: withBalance(ledger.balances, source, -(split.burned + split.credited)),
    supply: ledger.supply - split.burned,
    burned: ledger.burned + split.burned,
    claimsReserve: ledger.claimsReserve + split.credited,
    claims,
  });
  return {
    ledger: next,
    allocation: { budget, burned: split.burned, credited: split.credited, dustRetainedBySource: split.dust },
  };
}

/** Pay out everything credited to `owner`. S, E, n and r do not change. */
export function claimSlotStream(ledger: VaultLedger, owner: string): { readonly ledger: VaultLedger; readonly paid: bigint } {
  checkAccount(owner);
  const paid = ledger.claims.get(owner) ?? 0n;
  const claims = new Map(ledger.claims);
  claims.set(owner, 0n);
  const next = commit({
    ...ledger,
    balances: withBalance(ledger.balances, owner, paid),
    claimsReserve: ledger.claimsReserve - paid,
    claims,
  });
  return { ledger: next, paid };
}

// ---------------------------------------------------------------------------------------------------------------
// The vault's rule set (placeholder tickets, stage 1).

/** The fee burn of a conversion: after the principal moved, at the new occupancy (ADR-0014 § G05). */
function burnFee(after: VaultLedger, fee: bigint): VaultLedger {
  assertFeeBurnKeepsUnit(ledgerTotals(after), fee);
  return { ...after, supply: after.supply - fee, burned: after.burned + fee };
}

function checkIdList(ids: readonly number[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) fail('invalid_id_list', 'IDs must be non-empty and distinct');
}

export interface TakeRequest {
  readonly owner: string;
  readonly count: number;
  /** Refuse if principal + draw fee is above this (slippage limit). */
  readonly maxFit?: bigint;
}

export interface TakeResult {
  readonly ledger: VaultLedger;
  /** The reserved IDs (labels; the contract chooses the Misfit at delivery). */
  readonly ids: readonly number[];
  readonly principal: bigint;
  readonly fee: bigint;
}

/**
 * k tickets for `owner` (`MisfitsVault.openTickets`): lock ⌈A·k/n⌉ into E, then burn the draw fee at n − k. n and h
 * fall by k, t rises by k; no Misfit moves. Allowed with the gate closed (placeholders during the curve) or open
 * (draws). Refusals in the vault's order: invalid_quantity, last_misfit, no_hidden, max_fit_exceeded,
 * insufficient_fit, dust_guard.
 */
export function takeTickets(ledger: VaultLedger, request: TakeRequest): TakeResult {
  const { owner, count } = request;
  checkAccount(owner);
  if (!Number.isSafeInteger(count)) fail('invalid_quantity', 'count must be an integer');
  const q = quoteTake(ledgerTotals(ledger), BigInt(count), BigInt(ledger.hidden.size), ledger.fees);
  if (request.maxFit !== undefined && q.total > request.maxFit) fail('max_fit_exceeded', 'principal + fee above maxFit');
  if (balanceOf(ledger, owner) < q.total) fail('insufficient_fit', 'insufficient FIT for the principal and the fee');
  const ids = [...ledger.hidden].sort((a, b) => a - b).slice(0, count);
  const inventory = new Set(ledger.inventory);
  const hidden = new Set(ledger.hidden);
  const tickets = new Map(ledger.tickets);
  for (const id of ids) {
    inventory.delete(id);
    hidden.delete(id);
    tickets.set(id, owner);
  }
  const locked: VaultLedger = {
    ...ledger,
    balances: withBalance(ledger.balances, owner, -q.total),
    escrow: ledger.escrow + q.principal,
    inventory,
    hidden,
    tickets,
    ownerCounts: withCount(ledger.ownerCounts, owner, count),
  };
  // The fee was taken from the owner with the principal; the vault burns it now, at n − k.
  return { ledger: commit(burnFee(locked, q.fee)), ids, principal: q.principal, fee: q.fee };
}

export interface ReleaseRequest {
  readonly owner: string;
  /** Reserved IDs of `owner`'s tickets. */
  readonly ids: readonly number[];
  /** Refuse if principal − fee is below this (slippage limit). */
  readonly minFit?: bigint;
}

export interface ReleaseResult {
  readonly ledger: VaultLedger;
  readonly principal: bigint;
  readonly fee: bigint;
}

/**
 * k tickets handed back or cancelled (`MisfitsVault.releaseTickets`): release ⌊A·k/n⌋ from E; while the gate is closed
 * the return fee is burned from it (a hand-back during the curve) unless the coordinator waived it, once the gate is
 * open nothing is (a cancel). n and h rise by k, t falls by k; the draw fee paid at the take is not refunded.
 * Refusals: invalid_id_list, not_owner, return_below_unit, min_fit_not_met, escrow_insolvent, dust_guard.
 */
export function releaseTickets(ledger: VaultLedger, request: ReleaseRequest): ReleaseResult {
  const { owner, ids } = request;
  checkAccount(owner);
  checkIdList(ids);
  if (ids.some((id) => ledger.tickets.get(id) !== owner)) fail('not_owner', 'caller does not hold these tickets');
  const feeFree = ledger.gateOpen || ledger.handBackFeeWaived;
  const q = quoteHandBack(ledgerTotals(ledger), BigInt(ids.length), BigInt(ledger.tickets.size), feeFree, ledger.fees);
  if (request.minFit !== undefined && q.net < request.minFit) fail('min_fit_not_met', 'release below minFit');
  if (q.principal > ledger.escrow) fail('escrow_insolvent', 'escrow below the release');
  const inventory = new Set(ledger.inventory);
  const hidden = new Set(ledger.hidden);
  const tickets = new Map(ledger.tickets);
  for (const id of ids) {
    tickets.delete(id);
    inventory.add(id);
    hidden.add(id);
  }
  const released: VaultLedger = {
    ...ledger,
    balances: withBalance(ledger.balances, owner, q.net),
    escrow: ledger.escrow - q.principal,
    inventory,
    hidden,
    tickets,
    ownerCounts: withCount(ledger.ownerCounts, owner, -ids.length),
  };
  return { ledger: commit(burnFee(released, q.fee)), principal: q.principal, fee: q.fee };
}

export interface DeliverRequest {
  readonly owner: string;
  readonly ids: readonly number[];
}

/**
 * Deliver the Misfits behind `owner`'s tickets (`MisfitsVault.deliverTicket`, once per ID), only after graduation. No
 * FIT moves and m is unchanged: the ticket already counted as outside. Refusals: invalid_id_list, not_owner,
 * gate_closed.
 */
export function deliverTickets(ledger: VaultLedger, request: DeliverRequest): VaultLedger {
  const { owner, ids } = request;
  checkAccount(owner);
  checkIdList(ids);
  if (ids.some((id) => ledger.tickets.get(id) !== owner)) fail('not_owner', 'caller does not hold these tickets');
  if (!ledger.gateOpen) fail('gate_closed', 'Misfits are delivered only after graduation');
  const tickets = new Map(ledger.tickets);
  const outside = new Map(ledger.outside);
  for (const id of ids) {
    tickets.delete(id);
    outside.set(id, owner);
  }
  return commit({ ...ledger, tickets, outside });
}

/** A placeholder changes hands: the ticket (and its stream count) moves; nothing else changes. */
export function transferTicket(ledger: VaultLedger, from: string, to: string, id: number): VaultLedger {
  checkAccount(from);
  checkAccount(to);
  if (ledger.tickets.get(id) !== from) fail('not_owner', 'sender does not hold this ticket');
  const tickets = new Map(ledger.tickets);
  tickets.set(id, to);
  return commit({ ...ledger, tickets, ownerCounts: withCount(withCount(ledger.ownerCounts, from, -1), to, 1) });
}

/** Graduation (`MisfitsVault.openGate`): once, for good. */
export function openVaultGate(ledger: VaultLedger): VaultLedger {
  if (ledger.gateOpen) fail('gate_already_open', 'the gate opens once');
  return commit({ ...ledger, gateOpen: true });
}

/**
 * The coordinator's F38 (4) hook (`MisfitsVault.waiveHandBackFee`): from now on a hand-back before graduation pays no
 * return fee. Only while the gate is closed, once, for good. Refusals: gate_already_open, fee_already_waived.
 */
export function waiveHandBackFee(ledger: VaultLedger): VaultLedger {
  if (ledger.gateOpen) fail('gate_already_open', 'the hand-back fee is waived only before graduation');
  if (ledger.handBackFeeWaived) fail('fee_already_waived', 'the hand-back fee is waived once');
  return commit({ ...ledger, handBackFeeWaived: true });
}

/**
 * The collection's reveals (`REVEAL_ON_EXIT`): every ID must have left the vault at least once and not be revealed
 * yet; all or nothing. Refusals per ID in list order: ineligible_ids (not a collection ID), not_revealable,
 * already_revealed.
 */
export function revealMisfits(ledger: VaultLedger, ids: readonly number[]): VaultLedger {
  if (ids.length === 0) fail('invalid_id_list', 'nothing to reveal');
  const revealed = new Set(ledger.revealed);
  for (const id of ids) {
    if (!isCollectionId(ledger, id)) fail('ineligible_ids', 'not a collection ID');
    if (!hasLeftVault(ledger, id)) fail('not_revealable', 'a Misfit is revealable only after it left the vault');
    if (revealed.has(id)) fail('already_revealed', 'revealed once');
    revealed.add(id);
  }
  return commit({ ...ledger, revealed });
}

export interface PickRequest {
  readonly owner: string;
  readonly ids: readonly number[];
  /** Refuse if principal + pick fee is above this (slippage limit). */
  readonly maxFit?: bigint;
}

export interface ChargedResult {
  readonly ledger: VaultLedger;
  readonly principal: bigint;
  readonly fee: bigint;
}

/**
 * A named pick (`MisfitsVault.withdraw` / `withdrawBatch`): only after graduation, only revealed shelf Misfits (Fable
 * R-09, R-14), for ⌈A·k/n⌉ plus 25%. h is unchanged. Refusals in the vault's order: gate_closed, invalid_quantity,
 * last_misfit, max_fit_exceeded, insufficient_fit, then per ID in list order ineligible_ids (foreign, outside, reserved
 * by nobody's ticket but out, or listed twice), hidden_misfit (never out, reserved or not), not_revealed; dust_guard.
 */
export function pickMisfits(ledger: VaultLedger, request: PickRequest): ChargedResult {
  const { owner, ids } = request;
  checkAccount(owner);
  if (!ledger.gateOpen) fail('gate_closed', 'named picks open at graduation');
  const q = quotePick(ledgerTotals(ledger), BigInt(ids.length), ledger.fees);
  if (request.maxFit !== undefined && q.total > request.maxFit) fail('max_fit_exceeded', 'principal + fee above maxFit');
  if (balanceOf(ledger, owner) < q.total) fail('insufficient_fit', 'insufficient FIT for the principal and the fee');
  const marked = new Set<number>();
  for (const id of ids) {
    if (!isCollectionId(ledger, id) || ledger.outside.has(id) || marked.has(id)) fail('ineligible_ids', 'not an inside collection ID');
    marked.add(id);
    if (ledger.hidden.has(id) || ledger.tickets.has(id)) fail('hidden_misfit', 'a hidden Misfit leaves only through a ticket');
    if (!ledger.revealed.has(id)) fail('not_revealed', 'a named pick needs a revealed Misfit');
  }
  const inventory = new Set(ledger.inventory);
  const outside = new Map(ledger.outside);
  for (const id of ids) {
    inventory.delete(id);
    outside.set(id, owner);
  }
  const locked: VaultLedger = {
    ...ledger,
    balances: withBalance(ledger.balances, owner, -q.total),
    escrow: ledger.escrow + q.principal,
    inventory,
    outside,
    ownerCounts: withCount(ledger.ownerCounts, owner, ids.length),
  };
  return { ledger: commit(burnFee(locked, q.fee)), principal: q.principal, fee: q.fee };
}

export interface RevealedReturnRequest {
  readonly owner: string;
  readonly ids: readonly number[];
  /** Refuse if principal − fee is below this (slippage limit). */
  readonly minFit?: bigint;
  /**
   * IDs the ticket adapter reports returnable without their reveal now (`MisfitsPlaceholders.returnableFrom`: 180 days
   * after a Misfit left through the reveal fallback). The ledger has no clock; the vault asks the adapter at the call.
   */
  readonly returnableUnrevealed?: readonly number[];
}

/**
 * A return (`MisfitsVault.returnMisfit` / `returnMisfits`): only after graduation and only revealed Misfits (Fable
 * R-14), or unrevealed ones the adapter reports returnable, for ⌊A·k/n⌋ less 5%. The Misfits join the shelf (an
 * unrevealed one waits there: a named pick needs the reveal). Refusals in the vault's order: gate_closed,
 * invalid_id_list, per ID not_owner then not_revealed, return_below_unit, min_fit_not_met, escrow_insolvent,
 * dust_guard.
 */
export function returnRevealedMisfits(ledger: VaultLedger, request: RevealedReturnRequest): ChargedResult {
  const { owner, ids } = request;
  checkAccount(owner);
  if (!ledger.gateOpen) fail('gate_closed', 'returns open at graduation');
  checkIdList(ids);
  const returnable = new Set(request.returnableUnrevealed ?? []);
  for (const id of ids) {
    if (ledger.outside.get(id) !== owner) fail('not_owner', 'caller does not own this outside Misfit');
    if (!ledger.revealed.has(id) && !returnable.has(id)) fail('not_revealed', 'a return needs a revealed Misfit');
  }
  const q = quoteReturnNet(ledgerTotals(ledger), BigInt(ids.length), ledger.fees);
  if (request.minFit !== undefined && q.net < request.minFit) fail('min_fit_not_met', 'release below minFit');
  if (q.principal > ledger.escrow) fail('escrow_insolvent', 'escrow below the release');
  const inventory = new Set(ledger.inventory);
  const outside = new Map(ledger.outside);
  for (const id of ids) {
    outside.delete(id);
    inventory.add(id);
  }
  const released: VaultLedger = {
    ...ledger,
    balances: withBalance(ledger.balances, owner, q.net),
    escrow: ledger.escrow - q.principal,
    inventory,
    outside,
    ownerCounts: withCount(ledger.ownerCounts, owner, -ids.length),
  };
  return { ledger: commit(burnFee(released, q.fee)), principal: q.principal, fee: q.fee };
}
