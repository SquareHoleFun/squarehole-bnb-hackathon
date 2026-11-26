/**
 * Law checker for the vault traces (v2 T06; placeholder tickets stage 1): the docs/03 identities after every step and
 * the transition laws of every operation, verified on the trace data alone (no ledger, no `vault-math.ts`).
 * Test-only.
 *
 * Per state: A = S − E; m = N − n; vault FIT = E + D; exact r, L, K, U; one-Misfit and one-ticket quotes; the identity
 * terms (E·n ≥ m·A, K·n = E·n − m·A ≥ 0, S·n = K·n + N·A, Σ holdings = S, S + burns = issuance, (E + D)·n ≥ m·A);
 * A ≥ n; Σ claimable = claims reserve; the counts n = h + s, m = outside Misfits + t, h = IDs never out and not
 * reserved, Σ NFT counts + Σ ticket counts = m; and the custody map (rebuilt from the per-step changes, with the set
 * of IDs that ever left and the revealed set) agrees with the counts and with `final`.
 *
 * Per transition: a refused operation changes nothing (revert-state preservation). Each successful operation changes
 * exactly what its law allows: a take locks ⌈A·k/n⌉ and burns ⌈p·draw/10⁴⌉ at n − k (K·n then grows by fee·m′ against
 * the fee-free take), reserving k hidden IDs; a release frees ⌊A·k/n⌋ and burns the return fee only while the gate is
 * closed; a delivery moves no FIT and needs the gate open; a named pick locks ⌈A·k/n⌉ + 25% of revealed shelf IDs; a
 * return frees ⌊A·k/n⌋ − 5% of revealed Misfits; transfers and claims leave S, E, D and n alone; a burn lowers S and
 * raises K·n by amount·m; a stream burns ⌊B·n/N⌋ and credits ⌊B·count/N⌋ per outside owner (tickets count); an
 * unsolicited FIT send follows the trace policy; a Misfit sent to the vault is always refused. FIT leaves the vault
 * only through a return or a release, by exactly its principal, and D never falls (VLT-08). S never rises (GOV-05).
 * The gate never closes. Clean fee-free round trips lose exactly ⌈ε/(n−k)⌉ (VLT-06); charged ones never profit.
 */
import { custodyPairs, groupCustody, TICKET_PREFIX, ticketHolder, VAULT_HOLDER, type TraceOp, type TraceState, type VaultTrace } from './format';
import { derivedRationals, feeBps, feeOf, identityTerms, oneMisfitQuotes, oneTicketQuote, roundTripLoss, type CoreTotals } from './identities';

export interface RoundTrip {
  readonly trace: string;
  readonly withdrawStep: number;
  readonly returnStep: number;
  readonly owner: string;
  readonly count: number;
  /** Lock pre-state. */
  readonly active: bigint;
  readonly inside: bigint;
  readonly locked: bigint;
  readonly released: bigint;
  readonly loss: bigint;
  readonly bound: bigint;
  /** Fees of the two steps (both zero for a fee-free pair, the only pairs the ⌈ε/(n−k)⌉ law describes). */
  readonly lockFee: bigint;
  readonly releaseFee: bigint;
}

export interface LawReport {
  readonly violations: readonly string[];
  readonly roundTrips: readonly RoundTrip[];
  /** Steps whose post-state passed every identity. */
  readonly statesChecked: number;
}

const big = (value: string): bigint => BigInt(value);

function totalsOf(trace: VaultTrace, state: TraceState): CoreTotals {
  let accountsTotal = 0n;
  for (const account of trace.accounts) accountsTotal += big(state.balances[account] ?? '0');
  return {
    supply: big(state.supply),
    escrow: big(state.escrow),
    unsolicited: big(state.unsolicited),
    collectionSize: BigInt(trace.collectionSize),
    inside: BigInt(state.inside),
    accountsTotal,
    claimsReserve: big(state.claimsReserve),
    burned: big(state.burned),
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Fields that must be identical before and after a refused operation (everything except the per-step changes). */
const stateWithoutChanges = (state: TraceState): TraceState => ({ ...state, custodyChanges: {} });
const noChanges = (state: TraceState): boolean => Object.keys(state.custodyChanges).length === 0;

/** Custody as the checker rebuilds it: holder per ID outside the vault, the IDs that ever left, the revealed IDs. */
interface Custody {
  readonly holder: Map<number, string>;
  readonly left: Set<number>;
  readonly revealed: Set<number>;
  /** The coordinator waived the hand-back fee (a successful `waiveHandBackFee`; not a state field). */
  waived: boolean;
}

function checkState(trace: VaultTrace, state: TraceState, where: string, fail: (message: string) => void): void {
  const t = totalsOf(trace, state);
  const n = t.inside;
  const total = t.collectionSize;
  const a = t.supply - t.escrow;
  const bps = feeBps(trace.policy.conversionFees);
  if (state.active !== a.toString()) fail(`${where}: active ≠ S − E`);
  if (BigInt(state.outside) !== total - n) fail(`${where}: m ≠ N − n`);
  if (state.vaultFit !== (t.escrow + t.unsolicited).toString()) fail(`${where}: vault FIT ≠ E + D`);
  if (n < 1n || n > total) fail(`${where}: n outside 1..N (block-last)`);
  if (t.escrow > t.supply) fail(`${where}: E > S`);
  if (a < n) fail(`${where}: A < n (fewer than one raw FIT per inside Misfit)`);
  if (t.unsolicited !== 0n && trace.policy.unsolicitedFit === 'raw-balance') fail(`${where}: D ≠ 0 under raw-balance`);
  if (state.hidden > state.inside) fail(`${where}: h > n`);
  if (state.inside + state.tickets > trace.collectionSize) fail(`${where}: n + t > N`);

  const ids = identityTerms(t);
  if (!same(state.identities, ids)) fail(`${where}: identity terms differ from the state fields`);
  const en = t.escrow * n;
  const ma = (total - n) * a;
  if (en < ma) fail(`${where}: E·n < m·A (escrow insolvent)`);
  if (big(ids.Kn) !== en - ma || big(ids.Kn) < 0n) fail(`${where}: K·n ≠ E·n − m·A or K < 0`);
  if (big(ids.Sn) !== big(ids.Kn) + big(ids.NA)) fail(`${where}: S·n ≠ K·n + N·A`);
  if (ids.held !== state.supply) fail(`${where}: Σ holdings ≠ S`);
  if (ids.issued !== trace.initialSupply) fail(`${where}: S + burned ≠ initial issuance`);
  if (big(ids.vaultFitN) < ma) fail(`${where}: vault FIT does not cover the outside Misfits and tickets`);

  const derived = derivedRationals(t);
  if (!same(state.rate, derived.rate)) fail(`${where}: r ≠ A/n`);
  if (!same(state.obligation, derived.obligation)) fail(`${where}: L ≠ m·A/n`);
  if (!same(state.surplus, derived.surplus)) fail(`${where}: K ≠ E − L`);
  if (!same(state.envelope, derived.envelope)) fail(`${where}: U ≠ N·A/n`);
  const quotes = oneMisfitQuotes(t);
  if (!same(state.quoteWithdraw1, quotes.withdraw)) fail(`${where}: one-Misfit withdraw quote`);
  if (!same(state.quoteReturn1, quotes.ret)) fail(`${where}: one-Misfit return quote`);
  if (!same(state.quoteTake1, oneTicketQuote(t, BigInt(state.hidden), bps.draw))) fail(`${where}: one-ticket quote`);

  let claims = 0n;
  let counts = 0;
  let tickets = 0;
  for (const account of trace.accounts) {
    claims += big(state.claimable[account] ?? '0');
    counts += state.nftCounts[account] ?? 0;
    tickets += state.ticketCounts[account] ?? 0;
  }
  if (claims !== t.claimsReserve) fail(`${where}: Σ claimable ≠ claims reserve`);
  if (tickets !== state.tickets) fail(`${where}: Σ ticket counts ≠ t`);
  if (BigInt(counts + tickets) !== total - n) fail(`${where}: Σ NFT counts + t ≠ m`);
}

interface Delta {
  readonly S: bigint;
  readonly E: bigint;
  readonly D: bigint;
  readonly n: bigint;
  readonly h: number;
  readonly t: number;
  readonly revealed: number;
  readonly burned: bigint;
  readonly reserve: bigint;
  readonly balances: Map<string, bigint>;
  readonly claimable: Map<string, bigint>;
  readonly counts: Map<string, number>;
  readonly tickets: Map<string, number>;
}

function delta(trace: VaultTrace, pre: TraceState, post: TraceState): Delta {
  const balances = new Map<string, bigint>();
  const claimable = new Map<string, bigint>();
  const counts = new Map<string, number>();
  const tickets = new Map<string, number>();
  for (const account of trace.accounts) {
    balances.set(account, big(post.balances[account] ?? '0') - big(pre.balances[account] ?? '0'));
    claimable.set(account, big(post.claimable[account] ?? '0') - big(pre.claimable[account] ?? '0'));
    counts.set(account, (post.nftCounts[account] ?? 0) - (pre.nftCounts[account] ?? 0));
    tickets.set(account, (post.ticketCounts[account] ?? 0) - (pre.ticketCounts[account] ?? 0));
  }
  return {
    S: big(post.supply) - big(pre.supply),
    E: big(post.escrow) - big(pre.escrow),
    D: big(post.unsolicited) - big(pre.unsolicited),
    n: BigInt(post.inside - pre.inside),
    h: post.hidden - pre.hidden,
    t: post.tickets - pre.tickets,
    revealed: post.revealed - pre.revealed,
    burned: big(post.burned) - big(pre.burned),
    reserve: big(post.claimsReserve) - big(pre.claimsReserve),
    balances,
    claimable,
    counts,
    tickets,
  };
}

/** Expected per-account change: only the named accounts move, by the given amounts. */
function onlyAccounts<T extends bigint | number>(actual: Map<string, T>, expected: Record<string, T>, zero: T): boolean {
  for (const [account, value] of actual) {
    const want = expected[account] ?? zero;
    if (value !== want) return false;
  }
  return true;
}

function sumOf(values: Record<string, bigint>): bigint {
  return Object.values(values).reduce((s, v) => s + v, 0n);
}

function checkTransition(
  trace: VaultTrace,
  i: number,
  op: TraceOp,
  pre: TraceState,
  post: TraceState,
  custody: Custody,
  fail: (message: string) => void,
): void {
  const where = `step ${i} (${op.op})`;
  const step = trace.steps[i];
  if (!step) return;
  const d = delta(trace, pre, post);
  const t = totalsOf(trace, pre);
  const a = t.supply - t.escrow;
  const n = t.inside;
  const total = t.collectionSize;
  const bps = feeBps(trace.policy.conversionFees);

  // Always: S never rises and moves only with true burns; D never falls; the gate never closes.
  if (d.S > 0n) fail(`${where}: S rose (GOV-05)`);
  if (d.S !== -d.burned) fail(`${where}: ΔS ≠ −Δburned`);
  if (d.D < 0n) fail(`${where}: unsolicited FIT D fell`);
  if (pre.gateOpen && !post.gateOpen) fail(`${where}: the gate closed`);
  const vaultFitDelta = d.E + d.D;

  if ('error' in step.outcome) {
    if (!same(stateWithoutChanges(pre), stateWithoutChanges(post))) fail(`${where}: refused operation changed the state`);
    if (!noChanges(post)) fail(`${where}: refused operation moved a Misfit`);
    return;
  }
  const result = step.outcome.ok;
  const counters = (label: string, want: { S?: bigint; E?: bigint; D?: bigint; n?: bigint; h?: number; t?: number; revealed?: number }): void => {
    if (d.S !== (want.S ?? 0n) || d.E !== (want.E ?? 0n) || d.D !== (want.D ?? 0n) || d.n !== (want.n ?? 0n)) fail(`${where}: ${label} changed S, E, D or n`);
    if (d.h !== (want.h ?? 0) || d.t !== (want.t ?? 0) || d.revealed !== (want.revealed ?? 0)) fail(`${where}: ${label} changed h, t or the reveals`);
    if (op.op !== 'openGate' && pre.gateOpen !== post.gateOpen) fail(`${where}: ${label} moved the gate`);
  };
  const noClaimsChange = (): void => {
    if (d.reserve !== 0n || !onlyAccounts(d.claimable, {}, 0n)) fail(`${where}: claims changed`);
  };
  const noCountsChange = (): void => {
    if (!onlyAccounts(d.counts, {}, 0) || !onlyAccounts(d.tickets, {}, 0) || !noChanges(post)) fail(`${where}: custody changed`);
  };
  const expectChanges = (changes: [number, string][]): void => {
    const want = groupCustody(changes, trace.accounts);
    if (!same(post.custodyChanges, want)) fail(`${where}: custody changes ${JSON.stringify(post.custodyChanges)} ≠ ${JSON.stringify(want)}`);
  };
  const expectFee = (principal: bigint, rate: bigint): bigint => {
    const fee = feeOf(principal, rate);
    if (result.principal !== principal.toString()) fail(`${where}: principal ${result.principal} ≠ ${principal}`);
    if (result.fee !== fee.toString()) fail(`${where}: fee ${result.fee} ≠ ⌈p·${rate}/10⁴⌉ = ${fee}`);
    return fee;
  };
  /** The fee burn lands at the post-operation occupancy: K·n′ exceeds the fee-free K·n′ by exactly fee·m′. */
  const feeAtNewOccupancy = (fee: bigint): void => {
    const n1 = BigInt(post.inside);
    const m1 = total - n1;
    const e1 = big(post.escrow);
    const knFree = e1 * n1 - m1 * (t.supply - e1);
    if (big(post.identities.Kn) - knFree !== fee * m1) fail(`${where}: K·n′ − (fee-free K·n′) ≠ fee·m′`);
  };
  const isHidden = (id: number): boolean => id >= 0 && id < trace.collectionSize && !custody.holder.has(id) && !custody.left.has(id);

  switch (op.op) {
    case 'take': {
      const k = BigInt(op.count);
      const principal = (a * k + n - 1n) / n;
      const fee = expectFee(principal, bps.draw);
      if (op.maxFit !== undefined && principal + fee > big(op.maxFit)) fail(`${where}: principal + fee above maxFit`);
      counters('take', { S: -fee, E: principal, n: -k, h: -op.count, t: op.count });
      if (!onlyAccounts(d.balances, { [op.owner]: -(principal + fee) }, 0n)) fail(`${where}: balances`);
      if (!onlyAccounts(d.tickets, { [op.owner]: op.count }, 0) || !onlyAccounts(d.counts, {}, 0)) fail(`${where}: ticket counts`);
      noClaimsChange();
      feeAtNewOccupancy(fee);
      const ids = result.ids ?? [];
      if (ids.length !== op.count) fail(`${where}: ${ids.length} IDs reserved for ${op.count} tickets`);
      for (const id of ids) if (!isHidden(id)) fail(`${where}: reserved ID ${id} was not hidden`);
      expectChanges(ids.map((id) => [id, ticketHolder(op.owner)]));
      break;
    }
    case 'release': {
      const k = BigInt(op.ids.length);
      const principal = (a * k) / n;
      const fee = expectFee(principal, pre.gateOpen || custody.waived ? 0n : bps.ret);
      if (op.minFit !== undefined && principal - fee < big(op.minFit)) fail(`${where}: net below minFit`);
      counters('release', { S: -fee, E: -principal, n: k, h: op.ids.length, t: -op.ids.length });
      if (!onlyAccounts(d.balances, { [op.owner]: principal - fee }, 0n)) fail(`${where}: balances`);
      if (!onlyAccounts(d.tickets, { [op.owner]: -op.ids.length }, 0) || !onlyAccounts(d.counts, {}, 0)) fail(`${where}: ticket counts`);
      noClaimsChange();
      feeAtNewOccupancy(fee);
      for (const id of op.ids) if (custody.holder.get(id) !== ticketHolder(op.owner)) fail(`${where}: ${id} was not the caller's ticket`);
      expectChanges(op.ids.map((id) => [id, VAULT_HOLDER]));
      break;
    }
    case 'deliver': {
      if (!pre.gateOpen) fail(`${where}: delivered before graduation`);
      counters('delivery', { t: -op.ids.length });
      if (!onlyAccounts(d.balances, {}, 0n)) fail(`${where}: a delivery moved FIT`);
      if (!onlyAccounts(d.tickets, { [op.owner]: -op.ids.length }, 0) || !onlyAccounts(d.counts, { [op.owner]: op.ids.length }, 0)) fail(`${where}: counts`);
      noClaimsChange();
      for (const id of op.ids) if (custody.holder.get(id) !== ticketHolder(op.owner)) fail(`${where}: ${id} was not the caller's ticket`);
      expectChanges(op.ids.map((id) => [id, op.owner]));
      break;
    }
    case 'waiveHandBackFee': {
      if (pre.gateOpen) fail(`${where}: the hand-back fee was waived after graduation`);
      if (custody.waived) fail(`${where}: the hand-back fee was waived twice`);
      counters('waiver', {});
      if (!onlyAccounts(d.balances, {}, 0n)) fail(`${where}: balances`);
      noClaimsChange();
      noCountsChange();
      break;
    }
    case 'openGate': {
      if (pre.gateOpen || !post.gateOpen) fail(`${where}: the gate did not open exactly now`);
      counters('graduation', {});
      if (!onlyAccounts(d.balances, {}, 0n)) fail(`${where}: balances`);
      noClaimsChange();
      noCountsChange();
      break;
    }
    case 'reveal': {
      counters('reveal', { revealed: op.ids.length });
      if (!onlyAccounts(d.balances, {}, 0n)) fail(`${where}: balances`);
      noClaimsChange();
      noCountsChange();
      for (const id of op.ids) {
        if (!custody.left.has(id)) fail(`${where}: ${id} revealed before it ever left the vault`);
        if (custody.revealed.has(id)) fail(`${where}: ${id} revealed twice`);
      }
      if (new Set(op.ids).size !== op.ids.length) fail(`${where}: an ID listed twice`);
      break;
    }
    case 'withdraw': {
      if (!pre.gateOpen) fail(`${where}: named pick before graduation`);
      const k = BigInt(op.ids.length);
      const principal = (a * k + n - 1n) / n;
      const fee = expectFee(principal, bps.pick);
      if (op.maxFit !== undefined && principal + fee > big(op.maxFit)) fail(`${where}: principal + fee above maxFit`);
      counters('named pick', { S: -fee, E: principal, n: -k });
      if (!onlyAccounts(d.balances, { [op.owner]: -(principal + fee) }, 0n)) fail(`${where}: balances`);
      if (!onlyAccounts(d.counts, { [op.owner]: op.ids.length }, 0) || !onlyAccounts(d.tickets, {}, 0)) fail(`${where}: NFT counts`);
      noClaimsChange();
      feeAtNewOccupancy(fee);
      expectChanges(op.ids.map((id) => [id, op.owner]));
      for (const id of op.ids) {
        if (custody.holder.has(id) || !custody.left.has(id)) fail(`${where}: ${id} was not on the shelf (SEL-06)`);
        if (!custody.revealed.has(id)) fail(`${where}: ${id} picked unrevealed (Fable R-14)`);
      }
      break;
    }
    case 'return': {
      if (!pre.gateOpen) fail(`${where}: return before graduation`);
      const k = BigInt(op.ids.length);
      const principal = (a * k) / n;
      const fee = expectFee(principal, bps.ret);
      if (op.minFit !== undefined && principal - fee < big(op.minFit)) fail(`${where}: net below minFit`);
      counters('return', { S: -fee, E: -principal, n: k });
      if (!onlyAccounts(d.balances, { [op.owner]: principal - fee }, 0n)) fail(`${where}: balances`);
      if (!onlyAccounts(d.counts, { [op.owner]: -op.ids.length }, 0) || !onlyAccounts(d.tickets, {}, 0)) fail(`${where}: NFT counts`);
      noClaimsChange();
      feeAtNewOccupancy(fee);
      expectChanges(op.ids.map((id) => [id, VAULT_HOLDER]));
      for (const id of op.ids) {
        if (custody.holder.get(id) !== op.owner) fail(`${where}: Misfit ${id} was not the caller's`);
        if (!custody.revealed.has(id)) fail(`${where}: Misfit ${id} returned unrevealed (Fable R-14)`);
      }
      break;
    }
    case 'transferTicket': {
      counters('placeholder transfer', {});
      if (!onlyAccounts(d.balances, {}, 0n)) fail(`${where}: balances`);
      noClaimsChange();
      if (custody.holder.get(op.id) !== ticketHolder(op.from)) fail(`${where}: sender did not hold the ticket`);
      if (op.from !== op.to && !onlyAccounts(d.tickets, { [op.from]: -1, [op.to]: 1 }, 0)) fail(`${where}: ticket counts`);
      expectChanges(op.from === op.to ? [] : [[op.id, ticketHolder(op.to)]]);
      break;
    }
    case 'transferMisfit': {
      counters('Misfit transfer', {});
      if (!onlyAccounts(d.balances, {}, 0n)) fail(`${where}: balances`);
      noClaimsChange();
      if (custody.holder.get(op.id) !== op.from) fail(`${where}: sender did not own the Misfit`);
      if (op.from !== op.to && !onlyAccounts(d.counts, { [op.from]: -1, [op.to]: 1 }, 0)) fail(`${where}: NFT counts`);
      expectChanges(op.from === op.to ? [] : [[op.id, op.to]]);
      break;
    }
    case 'transferFit': {
      counters('FIT transfer', {});
      const amount = big(op.amount);
      const want = op.from === op.to ? {} : { [op.from]: -amount, [op.to]: amount };
      if (!onlyAccounts(d.balances, want, 0n)) fail(`${where}: balances`);
      noClaimsChange();
      noCountsChange();
      break;
    }
    case 'sendFitToVault': {
      const amount = big(op.amount);
      if (trace.policy.unsolicitedFit === 'quote-neutral') {
        counters('unsolicited FIT (quote-neutral)', { D: amount });
        if (!same(pre.rate, post.rate) || !same(pre.quoteWithdraw1, post.quoteWithdraw1) || !same(pre.quoteReturn1, post.quoteReturn1)) {
          fail(`${where}: a quote moved under quote-neutral`);
        }
      } else {
        counters('unsolicited FIT (raw-balance)', { E: amount });
      }
      if (!onlyAccounts(d.balances, { [op.from]: -amount }, 0n)) fail(`${where}: balances`);
      noClaimsChange();
      noCountsChange();
      break;
    }
    case 'sendMisfitToVault':
      fail(`${where}: a Misfit sent outside a return must be refused (policy refuse)`);
      break;
    case 'burn': {
      const amount = big(op.amount);
      counters('burn', { S: -amount });
      if (!onlyAccounts(d.balances, { [op.owner]: -amount }, 0n)) fail(`${where}: balances`);
      if (big(post.identities.Kn) - big(pre.identities.Kn) !== amount * (total - n)) fail(`${where}: ΔK·n ≠ burn·m`);
      noClaimsChange();
      noCountsChange();
      break;
    }
    case 'allocateStream': {
      const budget = big(op.budget);
      const burned = (budget * n) / total;
      const credits: Record<string, bigint> = {};
      for (const account of trace.accounts) {
        const count = BigInt((pre.nftCounts[account] ?? 0) + (pre.ticketCounts[account] ?? 0));
        if (count > 0n) credits[account] = (budget * count) / total;
      }
      const credited = sumOf(credits);
      if (result.burned !== burned.toString() || result.credited !== credited.toString()) fail(`${where}: stream split`);
      if (result.dust !== (budget - burned - credited).toString()) fail(`${where}: stream dust`);
      counters('stream', { S: -burned });
      if (d.reserve !== credited) fail(`${where}: stream totals`);
      if (!onlyAccounts(d.balances, { [op.source]: -(burned + credited) }, 0n)) fail(`${where}: balances`);
      if (!onlyAccounts(d.claimable, credits, 0n)) fail(`${where}: claimable`);
      noCountsChange();
      break;
    }
    case 'claim': {
      const owed = big(pre.claimable[op.owner] ?? '0');
      if (result.paid !== owed.toString()) fail(`${where}: paid ≠ claimable`);
      counters('claim', {});
      if (d.reserve !== -owed || !onlyAccounts(d.claimable, { [op.owner]: -owed }, 0n)) fail(`${where}: claims`);
      if (!onlyAccounts(d.balances, { [op.owner]: owed }, 0n)) fail(`${where}: balances`);
      if (pre.rate.num !== post.rate.num || pre.rate.den !== post.rate.den) fail(`${where}: a claim moved r (REV-08)`);
      noCountsChange();
      break;
    }
  }
  const releases = op.op === 'return' || op.op === 'release';
  if (vaultFitDelta < 0n && !(releases && vaultFitDelta === -big(result.principal ?? '0'))) {
    fail(`${where}: FIT left the vault outside a return or release (VLT-08)`);
  }
}

/** Apply one step's custody changes to the rebuilt map (and record the IDs that left and the reveals). */
function applyCustody(custody: Custody, op: TraceOp, state: TraceState, ok: boolean): void {
  for (const [id, holder] of custodyPairs(state.custodyChanges)) {
    if (holder === VAULT_HOLDER) custody.holder.delete(id);
    else {
      custody.holder.set(id, holder);
      if (!holder.startsWith(TICKET_PREFIX)) custody.left.add(id);
    }
  }
  if (ok && op.op === 'reveal') for (const id of op.ids) custody.revealed.add(id);
  if (ok && op.op === 'waiveHandBackFee') custody.waived = true;
}

/** Check a trace against the docs/03 identities and the transition laws. Returns every violation found. */
export function checkTraceLaws(trace: VaultTrace): LawReport {
  const violations: string[] = [];
  const fail = (message: string): void => {
    violations.push(`${trace.id} ${message}`);
  };
  const custody: Custody = { holder: new Map(), left: new Set(), revealed: new Set(), waived: false };
  const init = trace.initial;
  checkState(trace, init, 'initial', fail);
  if (init.escrow !== '0' || init.unsolicited !== '0' || init.burned !== '0' || init.claimsReserve !== '0') fail('initial: vault buckets not empty');
  if (init.inside !== trace.collectionSize || init.hidden !== trace.collectionSize || init.tickets !== 0 || !noChanges(init)) {
    fail('initial: not every Misfit inside and hidden');
  }
  if (init.gateOpen || init.revealed !== 0) fail('initial: the gate is open or something is revealed');
  if (init.supply !== trace.initialSupply) fail('initial: S ≠ issuance');

  const roundTrips: RoundTrip[] = [];
  let states = 1;
  let pre = init;
  trace.steps.forEach((step, i) => {
    const before = violations.length;
    checkState(trace, step.state, `step ${i}`, fail);
    checkTransition(trace, i, step.op, pre, step.state, custody, fail);
    applyCustody(custody, step.op, step.state, 'ok' in step.outcome);
    const nft = new Map<string, number>();
    const tix = new Map<string, number>();
    for (const holder of custody.holder.values()) {
      if (holder.startsWith(TICKET_PREFIX)) {
        const account = holder.slice(TICKET_PREFIX.length);
        tix.set(account, (tix.get(account) ?? 0) + 1);
      } else nft.set(holder, (nft.get(holder) ?? 0) + 1);
    }
    for (const account of trace.accounts) {
      if ((nft.get(account) ?? 0) !== step.state.nftCounts[account]) fail(`step ${i}: custody map disagrees with NFT counts`);
      if ((tix.get(account) ?? 0) !== step.state.ticketCounts[account]) fail(`step ${i}: custody map disagrees with ticket counts`);
    }
    if (custody.holder.size !== step.state.outside) fail(`step ${i}: custody map size ≠ m`);
    const neverOut = trace.collectionSize - [...new Set([...custody.left, ...custody.holder.keys()])].length;
    if (neverOut !== step.state.hidden) fail(`step ${i}: h ≠ IDs never out and not reserved`);
    if (custody.revealed.size !== step.state.revealed) fail(`step ${i}: reveal count`);
    if (violations.length === before) states += 1;
    pre = step.state;
  });
  const misfits = [...custody.holder].filter(([, h]) => !h.startsWith(TICKET_PREFIX));
  const tickets = [...custody.holder].filter(([, h]) => h.startsWith(TICKET_PREFIX));
  if (!same(groupCustody(misfits, trace.accounts), trace.final.outside)) fail('final: custody map ≠ final.outside');
  if (!same(groupCustody(tickets, trace.accounts), trace.final.tickets)) fail('final: custody map ≠ final.tickets');

  // VLT-06: a release of k by the owner of an earlier lock of k (a take or a named pick), with the quote state (A, n)
  // unchanged in between, is a clean round trip. Fee-free, its loss is exact and bounded; charged, it only loses more.
  const lockOps = new Set(['take', 'withdraw']);
  trace.steps.forEach((step, j) => {
    if ((step.op.op !== 'return' && step.op.op !== 'release') || !('ok' in step.outcome)) return;
    const k = step.op.ids.length;
    const owner = step.op.owner;
    const preReturn = j === 0 ? init : trace.steps[j - 1]?.state;
    if (!preReturn) return;
    for (let w = j - 1; w >= 0; w -= 1) {
      const candidate = trace.steps[w];
      if (!candidate || !lockOps.has(candidate.op.op) || !('ok' in candidate.outcome)) continue;
      const lockOwner = candidate.op.op === 'take' || candidate.op.op === 'withdraw' ? candidate.op.owner : '';
      const lockCount = candidate.op.op === 'take' ? candidate.op.count : candidate.op.op === 'withdraw' ? candidate.op.ids.length : -1;
      if (lockOwner !== owner || lockCount !== k) continue;
      if (candidate.state.active !== preReturn.active || candidate.state.inside !== preReturn.inside) continue;
      const preWithdraw = w === 0 ? init : trace.steps[w - 1]?.state;
      if (!preWithdraw) continue;
      const active = big(preWithdraw.active);
      const inside = BigInt(preWithdraw.inside);
      const locked = big(candidate.outcome.ok.principal ?? '0');
      const released = big(step.outcome.ok.principal ?? '0');
      const lockFee = big(candidate.outcome.ok.fee ?? '0');
      const releaseFee = big(step.outcome.ok.fee ?? '0');
      const { loss, bound } = roundTripLoss(active, inside, BigInt(k));
      if (released > locked) fail(`round trip ${w}→${j}: FIT profit (VLT-06)`);
      if (lockFee === 0n && releaseFee === 0n) {
        if (locked - released !== loss) fail(`round trip ${w}→${j}: loss ${locked - released} ≠ ⌈ε/(n−k)⌉ = ${loss}`);
        if (loss > bound) fail(`round trip ${w}→${j}: loss above ⌈(n−1)/(n−k)⌉`);
      } else if (locked - released < loss) {
        fail(`round trip ${w}→${j}: a charged round trip lost less principal than a free one`);
      }
      roundTrips.push({ trace: trace.id, withdrawStep: w, returnStep: j, owner, count: k, active, inside, locked, released, loss, bound, lockFee, releaseFee });
      break;
    }
  });
  return { violations, roundTrips, statesChecked: states };
}
