/**
 * Differential trace harness, TypeScript side (acceptance VLT-06, VLT-08, SIM-01, SEL-06; placeholder tickets stage 1).
 *
 * Every trace (the committed corpus and a larger in-memory corpus, all seeded) is checked three ways here:
 * 1. it parses strictly and survives a text round trip;
 * 2. replaying its operations on the reference ledger reproduces every outcome and raw integer;
 * 3. the independent law checker finds every docs/03 identity and transition law intact after every step.
 * The Python oracle side is `vault-trace.oracle.test.ts`; the committed files are `vault-trace.fixtures.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readV2Json } from './test-support/vault-oracle';
import { ex08Factor, raw } from './test-support/vault-examples';
import { committedCorpus, extendedCorpus } from './test-support/vault-trace/corpus';
import { EX08_EVENTS } from './test-support/vault-trace/examples';
import {
  parseVaultTrace,
  serializeVaultTrace,
  TRACE_SCHEMA,
  type TraceOp,
  type TraceState,
  type TraceStep,
  type VaultTrace,
} from './test-support/vault-trace/format';
import { checkTraceLaws, type RoundTrip } from './test-support/vault-trace/laws';
import { diffAgainstReference } from './test-support/vault-trace/reference';

const committed = committedCorpus();
const extended = extendedCorpus();
const all = [...committed, ...extended];
const reports = new Map(all.map((trace) => [trace.id, checkTraceLaws(trace)] as const));
const byId = (id: string): VaultTrace => {
  const trace = all.find((t) => t.id === id);
  if (!trace) throw new Error(`no trace ${id}`);
  return trace;
};
const okPrincipal = (step: TraceStep | undefined): bigint =>
  step && 'ok' in step.outcome ? BigInt(step.outcome.ok.principal ?? '0') : -1n;
const stepCount = (traces: readonly VaultTrace[]): number => traces.reduce((sum, t) => sum + t.steps.length, 0);
const firstStep = (trace: VaultTrace, kind: TraceOp['op']): TraceStep | undefined => trace.steps.find((s) => s.op.op === kind);

describe('trace corpus', () => {
  it('has the documented size: 55 committed traces and 758 extended ones, all ids unique', () => {
    expect(committed).toHaveLength(55);
    expect(extended).toHaveLength(758);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
    expect(stepCount(committed)).toBe(1472);
    expect(stepCount(extended)).toBe(26_814);
    const families = new Map<string, number>();
    for (const t of committed) families.set(t.family, (families.get(t.family) ?? 0) + 1);
    expect(Object.fromEntries(families)).toEqual({ example: 9, adversarial: 25, random: 21 });
    expect(committed.filter((t) => t.policy.unsolicitedFit === 'raw-balance')).toHaveLength(8);
    expect(committed.filter((t) => t.policy.conversionFees === 'flat-f23')).toHaveLength(27);
    expect(committed.every((t) => t.schema === TRACE_SCHEMA && t.policy.selection === 'tickets')).toBe(true);
  });

  it('is deterministic: generating it again gives byte-identical text', () => {
    const again = committedCorpus();
    committed.forEach((trace, i) => expect(serializeVaultTrace(again[i] as VaultTrace)).toBe(serializeVaultTrace(trace)));
  });

  it('the v2 docs/03 examples stay fee-free; every other family runs under both fee policies', () => {
    expect(committed.filter((t) => t.family === 'example').every((t) => t.policy.conversionFees === 'none')).toBe(true);
    for (const family of ['round-trip', 'ticket-lifecycle', 'last-misfit']) {
      const fees = new Set(all.filter((t) => t.name === family).map((t) => t.policy.conversionFees));
      expect([...fees].sort(), family).toEqual(['flat-f23', 'none']);
    }
  });
});

describe('trace format squarehole.vault-trace/v2', () => {
  it('every trace parses strictly and a JSON text round trip changes nothing', () => {
    for (const trace of all) expect(parseVaultTrace(JSON.parse(serializeVaultTrace(trace)) as unknown)).toEqual(trace);
  });

  it('rejects floats, negative or non-decimal amounts, unknown fields, undeclared or reserved accounts and holders', () => {
    const base = JSON.parse(serializeVaultTrace(byId('adv-round-trip-worst'))) as Record<string, unknown> & {
      steps: { op: Record<string, unknown>; state: Record<string, unknown> }[];
      accounts: string[];
      initial: Record<string, unknown>;
      policy: Record<string, unknown>;
    };
    const mutate = (edit: (t: typeof base) => void): unknown => {
      const copy = structuredClone(base);
      edit(copy);
      return copy;
    };
    const stepState = (t: typeof base): Record<string, unknown> => (t.steps[0] as { state: Record<string, unknown> }).state;
    const bad = [
      mutate((t) => void (stepState(t).supply = '40039.5')),
      mutate((t) => void (stepState(t).supply = 40039)),
      mutate((t) => void (stepState(t).escrow = '-1')),
      mutate((t) => void (stepState(t).escrow = '0x10')),
      mutate((t) => void (stepState(t).hidden = -1)),
      mutate((t) => void (stepState(t).gateOpen = 'yes')),
      mutate((t) => void (t.extra = true)),
      mutate((t) => void ((t.steps[0] as { op: Record<string, unknown> }).op.fee = '1')),
      mutate((t) => void ((t.steps[0] as { op: Record<string, unknown> }).op.owner = 'mallory')),
      mutate((t) => void (t.accounts = ['vault', 'fees'])),
      mutate((t) => void (t.accounts = ['alice', 'alice'])),
      mutate((t) => void ((t.initial.balances as Record<string, string>).zed = '0')),
      mutate((t) => void ((t.initial.ticketCounts as Record<string, number>).zed = 0)),
      mutate((t) => void (stepState(t).custodyChanges = { 'ticket:alice': [2, 1] })),
      mutate((t) => void (stepState(t).custodyChanges = { 'ticket:mallory': [1] })),
      mutate((t) => void (stepState(t).custodyChanges = { vault: [1], alice: [2] })),
      mutate((t) => void (t.checkpoints = { late: 99 })),
      mutate((t) => void (t.policy.conversionFees = 'flat-f24')),
      mutate((t) => void (t.policy.selection = 'explicit')),
      mutate((t) => void (t.schema = 'squarehole.vault-trace/v1')),
    ];
    expect(() => parseVaultTrace(base)).not.toThrow();
    bad.forEach((input, i) => expect(() => parseVaultTrace(input), `case ${i}`).toThrow());
  });
});

describe('TypeScript reference replay', () => {
  it('reproduces every outcome and raw integer of every trace, read back from its text form', () => {
    let steps = 0;
    for (const trace of all) {
      const read = parseVaultTrace(JSON.parse(serializeVaultTrace(trace)) as unknown);
      expect(diffAgainstReference(read), read.id).toEqual([]);
      steps += read.steps.length;
    }
    expect(steps).toBe(1472 + 26_814);
  });
});

describe('docs/03 identities and transition laws after every step', () => {
  it('hold on every trace: E·n ≥ m·A, K ≥ 0, S = K + N·r, Σ holdings = S, S + burns = issuance, n = h + s (VLT-08, GOV-05)', () => {
    let states = 0;
    for (const trace of all) {
      const report = reports.get(trace.id);
      expect(report?.violations, trace.id).toEqual([]);
      states += report?.statesChecked ?? 0;
    }
    expect(states).toBe(1472 + 26_814 + all.length); // every post-state plus every initial state
  });

  it('VLT-08: FIT leaves the vault only through a return or a release, by exactly its principal; K ≥ 0 everywhere', () => {
    let surplusStates = 0;
    let unsolicitedStates = 0;
    let ticketStates = 0;
    for (const trace of all) {
      for (const { state } of trace.steps) {
        if (BigInt(state.identities.Kn) > 0n) surplusStates += 1;
        if (state.unsolicited !== '0') unsolicitedStates += 1;
        if (state.tickets > 0) ticketStates += 1;
      }
    }
    expect(surplusStates).toBeGreaterThan(5000);
    expect(unsolicitedStates).toBeGreaterThan(1000);
    expect(ticketStates).toBeGreaterThan(5000);
  });

  it('fees: every charged step burns ⌈p·bps/10⁴⌉ after the principal moved; fee-free traces never burn a fee', () => {
    const rates: Record<string, bigint> = { take: 100n, withdraw: 2_500n, return: 500n };
    let charged = 0;
    for (const trace of all) {
      let waived = false; // the coordinator's hand-back fee waiver (F38 4 hook): an op, not a state field
      trace.steps.forEach((step, i) => {
        if (step.op.op === 'waiveHandBackFee' && 'ok' in step.outcome) waived = true;
        if (!('ok' in step.outcome) || step.outcome.ok.fee === undefined) return;
        const pre = i === 0 ? trace.initial : (trace.steps[i - 1]?.state as TraceState);
        const principal = BigInt(step.outcome.ok.principal ?? '0');
        const fee = BigInt(step.outcome.ok.fee);
        const rate = step.op.op === 'release' ? (pre.gateOpen || waived ? 0n : 500n) : (rates[step.op.op] ?? -1n);
        const want = trace.policy.conversionFees === 'none' ? 0n : (principal * rate + 9_999n) / 10_000n;
        expect(fee, `${trace.id} step ${i}`).toBe(want);
        expect(BigInt(pre.supply) - BigInt(step.state.supply)).toBe(fee);
        if (fee > 0n) charged += 1;
      });
    }
    expect(charged).toBeGreaterThan(2000);
  });

  it('a cancel after graduation is fee-free and a hand-back during the curve is charged (the vault’s gate decides), unless the coordinator waived that fee', () => {
    let handBacks = 0;
    let cancels = 0;
    let waivedHandBacks = 0;
    for (const trace of all.filter((t) => t.policy.conversionFees === 'flat-f23')) {
      let waived = false;
      trace.steps.forEach((step, i) => {
        if (step.op.op === 'waiveHandBackFee' && 'ok' in step.outcome) waived = true;
        if (step.op.op !== 'release' || !('ok' in step.outcome)) return;
        const pre = i === 0 ? trace.initial : (trace.steps[i - 1]?.state as TraceState);
        if (pre.gateOpen) {
          expect(step.outcome.ok.fee).toBe('0');
          cancels += 1;
        } else if (waived) {
          expect(step.outcome.ok.fee).toBe('0');
          waivedHandBacks += 1;
        } else if (BigInt(step.outcome.ok.principal ?? '0') > 0n) {
          expect(BigInt(step.outcome.ok.fee ?? '0') > 0n).toBe(true);
          handBacks += 1;
        }
      });
    }
    expect(handBacks).toBeGreaterThan(100);
    expect(cancels).toBeGreaterThan(50);
    expect(waivedHandBacks).toBeGreaterThan(8);
  });

  it('SEL-06 / Fable R-09, R-14: nothing leaves by name unless it is a revealed shelf Misfit; nothing returns unrevealed', () => {
    let picks = 0;
    for (const trace of all) {
      for (const step of trace.steps) {
        if (step.op.op === 'withdraw' && 'ok' in step.outcome) picks += 1;
        if (step.op.op === 'deliver' && 'ok' in step.outcome) expect(step.state.gateOpen).toBe(true);
      }
    }
    expect(picks).toBeGreaterThan(30);
    // The law checker holds every named pick to "left the vault before, inside now, revealed", and every return to
    // "revealed"; here the refusals show both rules at work.
    const seen = outcomeCounts(all);
    expect(seen.get('withdraw:hidden_misfit') ?? 0).toBeGreaterThan(10);
    expect(seen.get('return:not_revealed') ?? 0).toBeGreaterThan(10);
  });

  it('VLT-06: clean fee-free round trips never profit; each loses exactly ⌈ε/(n−k)⌉ ≤ ⌈(n−1)/(n−k)⌉ raw units', () => {
    const trips: RoundTrip[] = all.flatMap((trace) => [...(reports.get(trace.id)?.roundTrips ?? [])]);
    const free = trips.filter((t) => t.lockFee === 0n && t.releaseFee === 0n);
    expect(free.length).toBeGreaterThan(200);
    for (const trip of free) {
      expect(trip.released <= trip.locked).toBe(true);
      expect(trip.loss).toBe(trip.locked - trip.released);
      expect(trip.loss <= trip.bound).toBe(true);
      if (trip.count === 1) expect(trip.loss <= 1n).toBe(true);
    }
    expect(free.some((t) => t.count > 1 && t.loss > 1n)).toBe(true);
    const charged = trips.filter((t) => t.lockFee > 0n || t.releaseFee > 0n);
    expect(charged.length).toBeGreaterThan(100);
    for (const trip of charged) expect(trip.locked + trip.lockFee - (trip.released - trip.releaseFee) > trip.loss).toBe(true);
    const worst = reports.get('adv-round-trip-worst')?.roundTrips ?? [];
    expect(worst.map((t) => [t.count, t.loss, t.bound])).toEqual([
      [39, 39n, 39n],
      [1, 0n, 1n],
      [1, 1n, 1n],
    ]);
  });

  it('VLT-07: the same tickets as one batch or as single conversions differ by at most k raw units each way', () => {
    const pairs = all.filter((t) => t.name === 'batch-vs-single/batch');
    expect(pairs.length).toBe(9);
    for (const batch of pairs) {
      const single = byId(batch.id.replace('adv-batch-batch-', 'adv-batch-single-'));
      const k = BigInt(batch.steps[0]?.op.op === 'take' ? batch.steps[0].op.count : 0);
      const half = single.steps.length / 2;
      const sum = (from: number, to: number): bigint => single.steps.slice(from, to).reduce((s, step) => s + okPrincipal(step), 0n);
      const lockedBatch = okPrincipal(batch.steps[0]);
      const releasedBatch = okPrincipal(batch.steps[1]);
      const lockedSingle = sum(0, half);
      const releasedSingle = sum(half, single.steps.length);
      expect(lockedBatch > 0n && releasedBatch > 0n, batch.id).toBe(true);
      const within = (a: bigint, b: bigint): boolean => (a > b ? a - b : b - a) <= k;
      expect(within(lockedBatch, lockedSingle), `${batch.id} lock`).toBe(true);
      expect(within(releasedBatch, releasedSingle), `${batch.id} release`).toBe(true);
      expect(releasedSingle <= lockedSingle && releasedBatch <= lockedBatch).toBe(true);
    }
  });

  it('VLT-04: return order changes what each owner gets by at most one raw unit per Misfit, none at an integer rate', () => {
    const firsts = all.filter((t) => t.name === 'return-order/alice-first');
    expect(firsts.length).toBe(9);
    for (const a of firsts) {
      const b = byId(a.id.replace('adv-order-alice-first-', 'adv-order-bob-first-'));
      const count = (trace: VaultTrace, owner: string): bigint => {
        const step = trace.steps.find((s) => s.op.op === 'take' && s.op.owner === owner);
        return BigInt(step?.op.op === 'take' ? step.op.count : 0);
      };
      const release = (trace: VaultTrace, owner: string): bigint =>
        okPrincipal(trace.steps.find((s) => s.op.op === 'return' && s.op.owner === owner));
      const burnIndex = a.steps.findIndex((s) => s.op.op === 'burn');
      const beforeReturns = a.steps[burnIndex]?.state as TraceState;
      const integerRate = beforeReturns.rate.den === '1';
      for (const owner of ['alice', 'bob']) {
        const diff = release(a, owner) - release(b, owner);
        const abs = diff < 0n ? -diff : diff;
        expect(abs <= count(a, owner), `${a.id} ${owner}`).toBe(true);
        if (integerRate) expect(abs).toBe(0n);
      }
    }
  });

  it('VLT-09: after every Misfit is back, E keeps the stuck surplus and the vault still converts', () => {
    const traces = all.filter((t) => t.name === 'full-return-with-surplus');
    expect(traces.length).toBe(18);
    let checked = 0;
    for (const trace of traces) {
      const allBack = trace.steps.findIndex((s) => s.state.inside === trace.collectionSize && s.op.op === 'return');
      if (allBack < 0) continue;
      const state = trace.steps[allBack]?.state as TraceState;
      const burned = BigInt(state.burned) > 0n;
      if (burned) expect(BigInt(state.escrow) > 0n || state.unsolicited !== '0', trace.id).toBe(true);
      expect(state.vaultFit).toBe((BigInt(state.escrow) + BigInt(state.unsolicited)).toString());
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('unsolicited FIT: quote-neutral never moves r; raw-balance lowers A by exactly the amount sent', () => {
    let neutral = 0;
    let rawBalance = 0;
    for (const trace of all) {
      trace.steps.forEach((step, i) => {
        if (step.op.op !== 'sendFitToVault' || !('ok' in step.outcome) || step.op.amount === '0') return;
        const pre = i === 0 ? trace.initial : (trace.steps[i - 1]?.state as TraceState);
        if (trace.policy.unsolicitedFit === 'quote-neutral') {
          expect(step.state.rate).toEqual(pre.rate);
          expect(step.state.escrow).toBe(pre.escrow);
          neutral += 1;
        } else {
          expect(BigInt(pre.active) - BigInt(step.state.active)).toBe(BigInt(step.op.amount));
          expect(step.state.unsolicited).toBe('0');
          rawBalance += 1;
        }
      });
    }
    expect(neutral).toBeGreaterThan(400);
    expect(rawBalance).toBeGreaterThan(150);
  });

  it('a Misfit sent to the vault outside a return is always refused (G06), and a reserved ID is nobody’s to send', () => {
    const codes = new Map<string, number>();
    for (const trace of all) {
      for (const step of trace.steps) {
        if (step.op.op !== 'sendMisfitToVault') continue;
        expect('error' in step.outcome).toBe(true);
        const code = 'error' in step.outcome ? step.outcome.error : 'ok';
        codes.set(code, (codes.get(code) ?? 0) + 1);
      }
    }
    expect([...codes.keys()].sort()).toEqual(['not_owner', 'unsolicited_misfit']);
    expect(codes.get('unsolicited_misfit') ?? 0).toBeGreaterThan(100);
  });
});

describe('SIM-01: EX01–EX08 as traces', () => {
  type Readable = {
    supplyRaw: string;
    escrowRaw: string;
    activeRaw: string;
    inside: number;
    outside: number;
    rate: { numerator_raw: string; denominator: string };
    surplus: { numerator_raw: string; denominator: string };
    trueBurnedRaw: string;
    claimsRaw: Record<string, string>;
  };
  const reference = readV2Json('examples/reference-results.json') as Record<string, Record<string, unknown>>;
  const at = (trace: VaultTrace, checkpoint: string): TraceState => {
    const index = trace.checkpoints[checkpoint];
    if (index === undefined) throw new Error(`${trace.id}: no checkpoint ${checkpoint}`);
    return index < 0 ? trace.initial : (trace.steps[index]?.state as TraceState);
  };
  const readable = (state: TraceState, claimsKeys: readonly string[]): Readable => ({
    supplyRaw: state.supply,
    escrowRaw: state.escrow,
    activeRaw: state.active,
    inside: state.inside,
    outside: state.outside,
    rate: { numerator_raw: state.rate.num, denominator: state.rate.den },
    surplus: { numerator_raw: state.surplus.num, denominator: state.surplus.den },
    trueBurnedRaw: state.burned,
    claimsRaw: Object.fromEntries(claimsKeys.map((owner) => [owner, state.claimable[owner] ?? '0'])),
  });
  const expectCheckpoint = (traceId: string, checkpoint: string, expected: unknown): void => {
    const want = expected as Readable;
    const state = at(byId(traceId), checkpoint);
    expect(readable(state, Object.keys(want.claimsRaw)), `${traceId}:${checkpoint}`).toEqual(want);
    for (const [owner, value] of Object.entries(state.claimable)) {
      if (!(owner in want.claimsRaw)) expect(value, `${traceId} ${owner}`).toBe('0');
    }
  };

  it('EX01–EX05 checkpoint states equal examples/reference-results.json field by field', () => {
    const ex = (key: string): Record<string, unknown> => reference[key] as Record<string, unknown>;
    expectCheckpoint('ex01', 'halfOutside', ex('EX01').halfOutside);
    expectCheckpoint('ex01', 'after2500Return', ex('EX01').after2500Return);
    expectCheckpoint('ex02', 'burned', ex('EX02').burned);
    expectCheckpoint('ex02', 'after2500Return', ex('EX02').after2500Return);
    expectCheckpoint('ex02', 'allReturned', ex('EX02').allReturned);
    expectCheckpoint('ex03', 'state', ex('EX03').state);
    expectCheckpoint('ex04', 'state', ex('EX04').state);
    expectCheckpoint('ex05-immediate', 'immediate', ex('EX05').immediate);
    expectCheckpoint('ex05-delayed', 'delayed', ex('EX05').delayed);
    const allocation = firstStep(byId('ex03'), 'allocateStream')?.outcome;
    expect(allocation).toEqual({ ok: { burned: raw(5_000_000n).toString(), credited: raw(5_000_000n).toString(), dust: '0' } });
    const ex03 = ex('EX03').allocation as Record<string, string>;
    expect([ex03.burned, ex03.credited, ex03.dust_retained_by_source]).toEqual([raw(5_000_000n).toString(), raw(5_000_000n).toString(), '0']);
    const claims = byId('ex04').steps.filter((s) => s.op.op === 'claim').map((s) => s.outcome);
    expect(claims).toEqual([{ ok: { paid: ex('EX04').alicePaidRaw } }, { ok: { paid: ex('EX04').bobPaidRaw } }]);
  });

  it('EX06/EX07: the pool account is untouched by conversions and burns; the return releases 9m FIT', () => {
    const ex06 = byId('ex06');
    expect(at(ex06, 'state').balances.pool).toBe((reference.EX06 as Record<string, string>).poolFitRaw);
    expect(at(ex06, 'state').balances.pool).toBe(ex06.initial.balances.pool);
    const ex07 = byId('ex07');
    const released = okPrincipal(firstStep(ex07, 'return'));
    expect(released.toString()).toBe((reference.EX07 as Record<string, string>).returnedFitRaw);
    // The Q side of the sale is pool math (fee-free x·y=k, 1,000 Q), outside the vault trace.
    const poolFit = BigInt(at(ex07, 'returned').balances.pool ?? '0');
    const receivedQ = (raw(1000n) * released) / (poolFit + released);
    expect(receivedQ.toString()).toBe((reference.EX07 as Record<string, string>).receivedQRaw);
    expect(at(ex07, 'afterSale').balances.pool).toBe((poolFit + released).toString());
  });

  it(`EX08: ${EX08_EVENTS} funded fee events track the closed form (1 − 5·10⁻⁷)^events within 1 raw unit`, () => {
    const ex08 = byId('ex08');
    const end = at(ex08, 'end');
    const events = ex08.steps.filter((s) => s.op.op === 'allocateStream').length;
    expect(events).toBe(EX08_EVENTS);
    const r = BigInt(end.active) / BigInt(end.inside);
    const closed = (raw(100_000n) * ex08Factor(BigInt(events))) / 10n ** 140n;
    const diff = r - closed;
    expect(diff >= -1n && diff <= 1n).toBe(true);
    // At 50% outside the burn and the new surplus match (docs/08 table): K·n grows by burned·m at every event.
    expect(end.surplus).toEqual({ num: end.burned, den: '1' });
  });
});

describe('negative controls: the harness notices a one-raw-unit change', () => {
  type Mutable = { steps: { state: Record<string, unknown>; outcome: Record<string, unknown> }[] };
  const source = byId('adv-full-return-qn-ff-70060001');
  const stepOf = (t: Mutable, i: number): Mutable['steps'][number] => {
    const step = t.steps[i];
    if (!step) throw new Error(`no step ${i}`);
    return step;
  };
  const bump = (record: unknown, key: string, delta: bigint): void => {
    const r = record as Record<string, string>;
    r[key] = (BigInt(r[key] ?? '0') + delta).toString();
  };
  const edits: [string, (t: Mutable) => void][] = [
    ['E + 1', (t) => bump(stepOf(t, 3).state, 'escrow', 1n)],
    ['a balance + 1', (t) => bump(stepOf(t, 4).state.balances, 'bob', 1n)],
    ['principal − 1', (t) => bump(stepOf(t, 0).outcome.ok, 'principal', -1n)],
    ['fee + 1', (t) => bump(stepOf(t, 0).outcome.ok, 'fee', 1n)],
    ['K·n + 1', (t) => bump(stepOf(t, 5).state.identities, 'Kn', 1n)],
    ['claimable + 1', (t) => bump(stepOf(t, 4).state.claimable, 'alice', 1n)],
    ['h − 1', (t) => void (stepOf(t, 2).state.hidden = (stepOf(t, 2).state.hidden as number) - 1)],
    ['t + 1', (t) => void (stepOf(t, 2).state.tickets = (stepOf(t, 2).state.tickets as number) + 1)],
    [
      'custody holder',
      (t) => {
        const state = stepOf(t, 0).state;
        state.custodyChanges = { 'ticket:bob': (state.custodyChanges as Record<string, number[]>)['ticket:alice'] };
      },
    ],
    [
      'success turned into a refusal',
      (t) => {
        stepOf(t, 0).outcome = { error: 'insufficient_fit' };
      },
    ],
  ];
  it.each(edits)('%s is caught by both the reference replay and the law checker', (_label, edit) => {
    const copy = JSON.parse(serializeVaultTrace(source)) as Mutable;
    edit(copy);
    const mutated = parseVaultTrace(copy);
    expect(diffAgainstReference(mutated).length).toBeGreaterThan(0);
    expect(checkTraceLaws(mutated).violations.length).toBeGreaterThan(0);
  });

  it('flipping the unsolicited-FIT or the fee policy of a trace is caught by the reference replay', () => {
    const trace = byId('adv-unsolicited-fit-qn-70060001');
    const flipped: VaultTrace = { ...trace, policy: { ...trace.policy, unsolicitedFit: 'raw-balance' } };
    expect(diffAgainstReference(flipped).length).toBeGreaterThan(0);
    expect(checkTraceLaws(flipped).violations.length).toBeGreaterThan(0);
    const charged = byId('adv-ticket-lifecycle-ff-70060001');
    const free: VaultTrace = { ...charged, policy: { ...charged.policy, conversionFees: 'none' } };
    expect(diffAgainstReference(free).length).toBeGreaterThan(0);
    expect(checkTraceLaws(free).violations.length).toBeGreaterThan(0);
  });
});

const REACHABLE_REFUSALS = [
  'take:invalid_quantity',
  'take:last_misfit',
  'take:no_hidden',
  'take:max_fit_exceeded',
  'take:insufficient_fit',
  'take:dust_guard',
  'release:invalid_id_list',
  'release:not_owner',
  'release:min_fit_not_met',
  'release:dust_guard',
  'deliver:invalid_id_list',
  'deliver:not_owner',
  'deliver:gate_closed',
  'openGate:gate_already_open',
  'reveal:invalid_id_list',
  'reveal:ineligible_ids',
  'reveal:not_revealable',
  'reveal:already_revealed',
  'withdraw:gate_closed',
  'withdraw:invalid_quantity',
  'withdraw:last_misfit',
  'withdraw:max_fit_exceeded',
  'withdraw:insufficient_fit',
  'withdraw:ineligible_ids',
  'withdraw:hidden_misfit',
  'withdraw:dust_guard',
  'return:gate_closed',
  'return:invalid_id_list',
  'return:not_owner',
  'return:not_revealed',
  'return:min_fit_not_met',
  'return:dust_guard',
  'transferTicket:not_owner',
  'transferMisfit:not_owner',
  'transferFit:insufficient_fit',
  'sendFitToVault:insufficient_fit',
  'sendFitToVault:dust_guard',
  'sendMisfitToVault:unsolicited_misfit',
  'sendMisfitToVault:not_owner',
  'burn:insufficient_fit',
  'burn:dust_guard',
  'allocateStream:stream_not_funded',
  'allocateStream:dust_guard',
] as const;

const OPS = ['take', 'release', 'deliver', 'openGate', 'reveal', 'withdraw', 'return', 'transferTicket', 'transferMisfit', 'transferFit', 'sendFitToVault', 'burn', 'allocateStream', 'claim'];

function outcomeCounts(traces: readonly VaultTrace[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const trace of traces) {
    for (const step of trace.steps) {
      const key = `${step.op.op}:${'ok' in step.outcome ? 'ok' : step.outcome.error}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  return seen;
}

describe('coverage of the extended and committed corpora', () => {
  it('every operation succeeds somewhere and every reachable refusal occurs', () => {
    const seen = outcomeCounts(all);
    for (const op of OPS) expect(seen.get(`${op}:ok`) ?? 0, op).toBeGreaterThan(40);
    for (const key of REACHABLE_REFUSALS) expect(seen.get(key) ?? 0, key).toBeGreaterThan(0);
    // Unreachable while A ≥ n and E·n ≥ m·A hold, and while returns need the reveal (the shelf is always revealed);
    // kept as guards, as in the oracle and the vault.
    expect(seen.get('return:return_below_unit') ?? 0).toBe(0);
    expect(seen.get('return:escrow_insolvent') ?? 0).toBe(0);
    expect(seen.get('release:escrow_insolvent') ?? 0).toBe(0);
    expect(seen.get('withdraw:not_revealed') ?? 0).toBe(0);
  });

  it('the committed corpus alone (what the contracts replay) has every success and every reachable refusal', () => {
    const seen = outcomeCounts(committed);
    for (const op of OPS) expect(seen.get(`${op}:ok`) ?? 0, op).toBeGreaterThan(3);
    for (const key of REACHABLE_REFUSALS) expect(seen.get(key) ?? 0, key).toBeGreaterThan(0);
  });

  it('covers N = 1 … 40, N = 4,200, N = 10,000, 1bn FIT and S = 2^256 − 1', () => {
    const sizes = new Set(all.map((t) => t.collectionSize));
    for (const n of [1, 2, 3, 4_200, 10_000]) expect(sizes.has(n), String(n)).toBe(true);
    expect([...sizes].filter((n) => n <= 40).length).toBeGreaterThanOrEqual(38);
    expect(all.some((t) => t.initialSupply === (10n ** 27n).toString())).toBe(true);
    expect(all.filter((t) => t.initialSupply === ((1n << 256n) - 1n).toString()).length).toBeGreaterThan(20);
  });
});
