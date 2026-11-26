/**
 * TypeScript re-run of square-hole-core-v2/reference/check_examples.py (`run()`), built on the domain vault ledger.
 * Output has the same shape as examples/reference-results.json so the two can be compared whole. Test-only.
 *
 * The synthetic constant-product pool in EX06/EX07 is a local test helper for those two examples only: a fee-free
 * x·y=k sale, as in the oracle's `Pool`. It is not exported by the domain package and is not a trading feature.
 */
import {
  accrueSlotStream,
  burnFit,
  claimSlotStream,
  conversionRate,
  createVaultLedger,
  escrowSurplus,
  exactRatio,
  ledgerTotals,
  returnMisfits,
  transferFit,
  transferMisfit,
  withdrawMisfits,
  type ExactRatio,
  type StreamAllocation,
  type VaultLedger,
} from '../index';

export const WAD = 10n ** 18n;
/** Whole FIT → raw units (the oracle's `raw`, integers only). */
export const raw = (fit: bigint): bigint => fit * WAD;
export const idRange = (from: number, to: number): number[] => Array.from({ length: to - from }, (_, i) => from + i);

/** The oracle's `fresh()`: 1bn FIT (alice 900m, fees 100m), 10,000 Misfits, block_last. */
export function freshVault(): VaultLedger {
  return createVaultLedger({ allocations: { alice: raw(900_000_000n), fees: raw(100_000_000n) }, collectionSize: 10_000 });
}

/** Vault with a 100m-FIT pool account (EX06, EX07). */
export function vaultWithPool(): VaultLedger {
  return createVaultLedger({
    allocations: { alice: raw(800_000_000n), fees: raw(100_000_000n), pool: raw(100_000_000n) },
    collectionSize: 10_000,
  });
}

const ratioJson = (value: ExactRatio) => ({ numerator_raw: value.num.toString(), denominator: value.den.toString() });

/** The oracle's `readable(v)`. */
export function readable(ledger: VaultLedger) {
  const totals = ledgerTotals(ledger);
  return {
    supplyRaw: ledger.supply.toString(),
    escrowRaw: ledger.escrow.toString(),
    activeRaw: (ledger.supply - ledger.escrow).toString(),
    inside: ledger.inventory.size,
    outside: ledger.outside.size,
    rate: ratioJson(conversionRate(totals)),
    surplus: ratioJson(escrowSurplus(totals)),
    trueBurnedRaw: ledger.burned.toString(),
    claimsRaw: Object.fromEntries([...ledger.claims].map(([owner, value]) => [owner, value.toString()])),
  };
}

const allocationJson = (a: StreamAllocation) => ({
  budget: a.budget.toString(),
  burned: a.burned.toString(),
  credited: a.credited.toString(),
  dust_retained_by_source: a.dustRetainedBySource.toString(),
});

/** Python `str(Fraction)`: "n" when the denominator is 1, else "n/d". */
const fractionText = (value: ExactRatio): string => (value.den === 1n ? value.num.toString() : `${value.num}/${value.den}`);

function ex01() {
  let v = withdrawMisfits(freshVault(), { owner: 'alice', count: 5000 }).ledger;
  const halfOutside = readable(v);
  v = returnMisfits(v, { owner: 'alice', ids: idRange(0, 2500) }).ledger;
  return { halfOutside, after2500Return: readable(v) };
}

function ex02() {
  let v = withdrawMisfits(freshVault(), { owner: 'alice', count: 5000 }).ledger;
  v = burnFit(v, 'fees', raw(50_000_000n));
  const burned = readable(v);
  v = returnMisfits(v, { owner: 'alice', ids: idRange(0, 2500) }).ledger;
  const after2500Return = readable(v);
  v = returnMisfits(v, { owner: 'alice', ids: idRange(2500, 5000) }).ledger;
  return { burned, after2500Return, allReturned: readable(v) };
}

function ex03() {
  const v = withdrawMisfits(freshVault(), { owner: 'alice', count: 5000 }).ledger;
  const { ledger, allocation } = accrueSlotStream(v, 'fees', raw(10_000_000n));
  return { allocation: allocationJson(allocation), state: readable(ledger) };
}

function ex04() {
  let v = withdrawMisfits(freshVault(), { owner: 'alice', count: 1, ids: [42] }).ledger;
  v = accrueSlotStream(v, 'fees', raw(10_000_000n)).ledger;
  v = transferMisfit(v, 'alice', 'bob', 42);
  v = accrueSlotStream(v, 'fees', raw(20_000_000n)).ledger;
  const alice = claimSlotStream(v, 'alice');
  const bob = claimSlotStream(alice.ledger, 'bob');
  return { alicePaidRaw: alice.paid.toString(), bobPaidRaw: bob.paid.toString(), state: readable(bob.ledger) };
}

function ex05() {
  let immediate = withdrawMisfits(freshVault(), { owner: 'alice', count: 5000 }).ledger;
  immediate = burnFit(immediate, 'fees', raw(5_000_000n));
  let delayed = withdrawMisfits(freshVault(), { owner: 'alice', count: 5000 }).ledger;
  delayed = withdrawMisfits(delayed, { owner: 'alice', count: 4000 }).ledger;
  delayed = burnFit(delayed, 'fees', raw(5_000_000n));
  return { immediate: readable(immediate), delayed: readable(delayed), meaning: 'timing counterexample, not profit proof' };
}

const poolFit = (v: VaultLedger): bigint => v.balances.get('pool') ?? 0n;

function ex06() {
  const poolQ = raw(1000n);
  let v = vaultWithPool();
  const before = poolFit(v);
  v = withdrawMisfits(v, { owner: 'alice', count: 1 }).ledger;
  v = burnFit(v, 'fees', raw(1_000_000n));
  return { poolFitRaw: poolFit(v).toString(), poolQRaw: poolQ.toString(), unchanged: poolFit(v) === before };
}

function ex07() {
  let v = withdrawMisfits(vaultWithPool(), { owner: 'alice', count: 5000 }).ledger;
  v = burnFit(v, 'fees', raw(50_000_000n));
  const qBefore = raw(1000n);
  const fitBefore = poolFit(v);
  const released = returnMisfits(v, { owner: 'alice', ids: idRange(0, 100) });
  const amount = released.principal;
  // Fee-free constant-product sale of the released FIT (oracle `Pool.sell`, fee_bps = 0).
  const receivedQ = (qBefore * amount) / (fitBefore + amount);
  const afterSale = transferFit(released.ledger, 'alice', 'pool', amount);
  const qAfter = qBefore - receivedQ;
  const spotRatio = exactRatio(qAfter * fitBefore, poolFit(afterSale) * qBefore);
  return { returnedFitRaw: amount.toString(), receivedQRaw: receivedQ.toString(), spotRatio: fractionText(spotRatio) };
}

const WORK_DIGITS = 140n;
const WORK = 10n ** WORK_DIGITS;

/**
 * (1 − 5·10⁻⁷)^events, the EX08 closed form, as a fixed-point value at 10^140. Binary powering with rounding at each
 * step: the error stays far below the 50th significant digit for the event counts used here.
 */
export function ex08Factor(events: bigint): bigint {
  const mul = (a: bigint, b: bigint): bigint => (a * b + WORK / 2n) / WORK;
  let base = 9_999_995n * 10n ** (WORK_DIGITS - 7n);
  let result = WORK;
  for (let e = events; e > 0n; e >>= 1n) {
    if (e & 1n) result = mul(result, base);
    base = mul(base, base);
  }
  return result;
}

/**
 * EX08 as Python prints `Decimal(100000) * (1 - Decimal('0.005') / 10000) ** events` under a 50-digit context: the
 * power rounded half-even to 50 significant digits, times 100,000.
 */
export function ex08RateText(events: bigint): string {
  const factor = ex08Factor(events);
  if (factor * 10n < WORK || factor >= WORK) throw new Error('EX08 factor outside [0.1, 1): digit count assumption broken');
  const drop = 10n ** (WORK_DIGITS - 50n);
  let digits = factor / drop;
  const rest = factor % drop;
  if (rest * 2n > drop || (rest * 2n === drop && digits % 2n === 1n)) digits += 1n;
  // digits = the power × 10^50, so 100,000 × power = digits × 10^-45: 45 decimals, trailing zeros kept like Decimal.
  const unit = 10n ** 45n;
  return `${digits / unit}.${(digits % unit).toString().padStart(45, '0')}`;
}

/** The whole `run()` result, keyed like examples/reference-results.json. */
export function buildReferenceResults() {
  return {
    scope: 'CURRENT_HANDOFF_REFERENCE_CHECKS_NOT_CONTRACT_TESTS',
    EX01: ex01(),
    EX02: ex02(),
    EX03: ex03(),
    EX04: ex04(),
    EX05: ex05(),
    EX06: ex06(),
    EX07: ex07(),
    EX08: {
      closedFormRateFIT: { '100000': ex08RateText(100_000n), '1000000': ex08RateText(1_000_000n) },
      eventIterationsExecuted: 0,
    },
  };
}
