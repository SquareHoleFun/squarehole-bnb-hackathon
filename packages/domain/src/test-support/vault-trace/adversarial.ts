/**
 * Adversarial trace families (v2 T06; placeholder tickets stage 1): each one aims at a docs/03 boundary, a v2
 * acceptance item or a ticket rule, and is seeded, so a failing trace reproduces exactly. Test-only.
 *
 * Since stage 1 a Misfit that never left the vault leaves only through a ticket (`take`, and `deliver` after
 * `openGate`); the families that withdrew hidden IDs by name in v1 now take tickets, and the ones that returned
 * Misfits deliver, reveal and return them.
 */
import { createPrng, type Prng } from '../prng';
import type { ConversionFeePolicy, UnsolicitedFitPolicy, VaultTrace } from './format';
import {
  activeOf,
  balanceOf,
  below,
  buildTrace,
  hiddenIds,
  idRange,
  insideIds,
  MAX_UINT256,
  ownedIds,
  pickQuote,
  returnNetQuote,
  returnQuote,
  shelfIds,
  shuffled,
  takeQuote,
  ticketIds,
  WAD,
  type TraceBuilder,
  type TraceMeta,
} from './generate';

type FamilyMeta = Omit<TraceMeta, 'family' | 'seed' | 'policy' | 'fees'>;
const policyTag = (policy: UnsolicitedFitPolicy): string => (policy === 'quote-neutral' ? 'qn' : 'rb');
const feeTag = (fees: ConversionFeePolicy): string => (fees === 'none' ? 'nf' : 'ff');

/** One seeded family trace. `prng` is the family's own generator, already used for the setup. */
function adversarial(
  prng: Prng,
  seed: number,
  policy: UnsolicitedFitPolicy,
  fees: ConversionFeePolicy,
  meta: FamilyMeta,
  script: (b: TraceBuilder, prng: Prng) => void,
): VaultTrace {
  return buildTrace({ ...meta, family: 'adversarial', seed, policy, fees }, (b) => script(b, prng));
}

/** Odd issuance for small collections: A mod n is rarely 0, so every rounding direction is exercised. */
function oddAllocations(prng: Prng, collectionSize: number): Record<string, bigint> {
  const n = BigInt(collectionSize);
  return {
    alice: 10n ** BigInt(6 + prng.int(10)) * n + below(prng, 7n * n),
    bob: below(prng, 10n ** 6n) + 1n,
    carol: below(prng, 1000n),
    fees: n + below(prng, 10n ** 5n),
  };
}

/** Move every other account's FIT to `to`, so one payer holds all of A and can reach the dust-guard edge. */
function gatherInto(b: TraceBuilder, to: string): void {
  for (const from of [...b.ledger().balances.keys()]) {
    const amount = balanceOf(b.ledger(), from);
    if (from !== to && amount > 0n) b.apply({ op: 'transferFit', from, to, amount: amount.toString() });
  }
}

/** Take k tickets for `owner` and return the reserved IDs (empty when refused). */
function take(b: TraceBuilder, owner: string, count: number, maxFit?: bigint): number[] {
  const outcome = b.apply(maxFit === undefined ? { op: 'take', owner, count } : { op: 'take', owner, count, maxFit: maxFit.toString() });
  return 'ok' in outcome ? [...(outcome.ok.ids ?? [])] : [];
}

/** Take k tickets, and once the gate is open deliver and reveal them: k Misfits outside, revealed. */
function takeOut(b: TraceBuilder, owner: string, count: number): number[] {
  const ids = take(b, owner, count);
  if (ids.length === 0) return ids;
  if (!b.ledger().gateOpen) b.apply({ op: 'openGate' });
  b.apply({ op: 'deliver', owner, ids });
  b.apply({ op: 'reveal', ids });
  return ids;
}

/**
 * VLT-06: repeated lock/release round trips: tickets taken and handed back during the curve (k = 1, 2, n − 1 or
 * random), then Misfits taken, delivered, revealed and returned after graduation, with quote-neutral events between
 * some pairs.
 */
export function roundTripTrace(seed: number, policy: UnsolicitedFitPolicy, fees: ConversionFeePolicy): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 5 + prng.int(36);
  return adversarial(
    prng,
    seed,
    policy,
    fees,
    {
      id: `adv-round-trip-${policyTag(policy)}-${feeTag(fees)}-${seed.toString(16)}`,
      name: 'round-trip',
      purpose: 'Take k then hand k back (the curve), then take, deliver, reveal and return k (after graduation), with FIT and ticket transfers, claims and unsolicited sends between some pairs.',
      acceptance: ['VLT-06', 'VLT-02', 'VLT-03', 'VLT-08'],
      collectionSize,
      allocations: oddAllocations(prng, collectionSize),
    },
    (b, p) => {
      for (let cycle = 0; cycle < 12; cycle += 1) {
        const n = b.ledger().inventory.size;
        if (n < 2) break;
        if (cycle === 8) b.apply({ op: 'openGate' });
        const roll = p.int(10);
        const k = roll < 4 ? 1 : roll < 6 ? Math.min(2, n - 1) : roll < 8 ? n - 1 : 1 + p.int(n - 1);
        const ids = take(b, 'alice', k);
        if (ids.length === 0) continue;
        const between = p.int(5);
        if (between === 1) b.apply({ op: 'transferFit', from: 'bob', to: 'carol', amount: below(p, balanceOf(b.ledger(), 'bob')).toString() });
        if (between === 2) {
          b.apply({ op: 'transferTicket', from: 'alice', to: 'bob', id: ids[0] as number });
          b.apply({ op: 'transferTicket', from: 'bob', to: 'alice', id: ids[0] as number });
        }
        if (between === 3) b.apply({ op: 'sendFitToVault', from: 'carol', amount: below(p, balanceOf(b.ledger(), 'carol')).toString() });
        if (between === 4) b.apply({ op: 'burn', owner: 'fees', amount: below(p, 1000n).toString() }); // breaks the clean pair
        if (p.int(3) === 0) b.apply({ op: 'claim', owner: 'alice' });
        if (b.ledger().gateOpen) {
          b.apply({ op: 'deliver', owner: 'alice', ids });
          b.apply({ op: 'reveal', ids });
          b.apply({ op: 'return', owner: 'alice', ids: shuffled(p, ids) });
        } else {
          b.apply({ op: 'release', owner: 'alice', ids: shuffled(p, ids) });
        }
        if (p.int(4) === 0) b.apply({ op: 'allocateStream', source: 'fees', budget: below(p, 10_000n).toString() });
      }
    },
  );
}

/** VLT-06 worst case: all but one Misfit make the round trip at A = 40·q + 39, n = 40, so the loss is n − 1 = 39. */
export function roundTripWorstTrace(): VaultTrace {
  return buildTrace(
    {
      id: 'adv-round-trip-worst',
      family: 'adversarial',
      name: 'round-trip-worst',
      purpose:
        'Round-trip loss extremes at n = 40 (fee-free tickets): k = n − 1 with ε = n − 1 loses the bound ⌈(n−1)/(n−k)⌉ = 39 raw; k = 1 loses 0 raw at an integer rate and 1 raw after a 1-raw burn.',
      acceptance: ['VLT-06', 'VLT-07'],
      seed: null,
      policy: 'quote-neutral',
      fees: 'none',
      collectionSize: 40,
      allocations: { alice: 40_000n, fees: 39n },
    },
    (b) => {
      b.apply({ op: 'take', owner: 'alice', count: 39 });
      b.apply({ op: 'release', owner: 'alice', ids: idRange(0, 39) });
      b.apply({ op: 'take', owner: 'alice', count: 1 });
      b.apply({ op: 'release', owner: 'alice', ids: [0] });
      b.apply({ op: 'burn', owner: 'fees', amount: '1' });
      b.apply({ op: 'take', owner: 'alice', count: 1 });
      b.apply({ op: 'release', owner: 'alice', ids: [0] });
    },
  );
}

/** VLT-07: the same k tickets as one batch or as k single conversions, from the same start (two traces). */
export function batchVsSingleTraces(seed: number): [VaultTrace, VaultTrace] {
  const make = (mode: 'batch' | 'single'): VaultTrace => {
    const prng = createPrng(seed);
    const collectionSize = 12 + prng.int(29);
    const allocations = oddAllocations(prng, collectionSize);
    const k = 2 + prng.int(Math.min(8, collectionSize - 2));
    return adversarial(
      prng,
      seed,
      'quote-neutral',
      'none',
      {
        id: `adv-batch-${mode}-${seed.toString(16)}`,
        name: `batch-vs-single/${mode}`,
        purpose: `The same ${k} tickets taken and handed back ${mode === 'batch' ? 'as one batch each way' : 'one at a time'} (compare with the ${mode === 'batch' ? 'single' : 'batch'} trace of the same seed).`,
        acceptance: ['VLT-07', 'VLT-06'],
        collectionSize,
        allocations,
      },
      (b) => {
        if (mode === 'batch') {
          const ids = take(b, 'alice', k);
          b.apply({ op: 'release', owner: 'alice', ids });
          return;
        }
        const ids: number[] = [];
        for (let i = 0; i < k; i += 1) ids.push(...take(b, 'alice', 1));
        for (const id of ids) b.apply({ op: 'release', owner: 'alice', ids: [id] });
      },
    );
  };
  return [make('batch'), make('single')];
}

/** F23 C2 / v2-G04 (VLT-10 precursor): tickets down to n = 1; the last one, n + 1 and none are refused; edges. */
export function lastMisfitTrace(seed: number, fees: ConversionFeePolicy): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 9 + prng.int(8);
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    fees,
    {
      id: `adv-last-misfit-${feeTag(fees)}-${seed.toString(16)}`,
      name: 'last-misfit',
      purpose: 'Tickets down to one Misfit left; the last one, too many and none are refused; burns and a stream at the one-raw-per-Misfit edge; everything comes back.',
      acceptance: ['VLT-10', 'VLT-11', 'VLT-09', 'VLT-08'],
      collectionSize,
      allocations: { ...oddAllocations(prng, collectionSize), alice: 10n ** 12n * BigInt(collectionSize) + below(prng, 999n) },
    },
    (b, p) => {
      for (let guard = 0; guard < 64 && b.ledger().inventory.size > 1; guard += 1) {
        const n = b.ledger().inventory.size;
        const k = Math.min(n - 1, 1 + p.int(3));
        if (take(b, 'alice', k).length === 0) break;
      }
      b.apply({ op: 'take', owner: 'alice', count: 1 });
      b.apply({ op: 'take', owner: 'alice', count: 2 });
      b.apply({ op: 'take', owner: 'bob', count: 0 });
      gatherInto(b, 'alice');
      const edge = activeOf(b.ledger()) - BigInt(b.ledger().inventory.size);
      b.apply({ op: 'burn', owner: 'alice', amount: (edge + 1n).toString() });
      b.apply({ op: 'burn', owner: 'alice', amount: edge.toString() });
      b.apply({ op: 'allocateStream', source: 'alice', budget: '1' });
      b.apply({ op: 'allocateStream', source: 'alice', budget: String(collectionSize) });
      b.apply({ op: 'release', owner: 'alice', ids: [p.pick(ticketIds(b.ledger(), 'alice'))] });
      b.apply({ op: 'claim', owner: 'alice' });
      b.apply({ op: 'openGate' });
      b.apply({ op: 'release', owner: 'alice', ids: ticketIds(b.ledger(), 'alice') });
      take(b, 'alice', 1);
    },
  );
}

/** N = 1: every ticket is the last Misfit; a stream burns everything; nothing can enter. */
export function singleMisfitTrace(): VaultTrace {
  return buildTrace(
    {
      id: 'adv-single-misfit',
      family: 'adversarial',
      name: 'single-misfit',
      purpose: 'A one-Misfit collection: tickets and picks are refused (last Misfit), streams burn their whole budget down to the dust guard, a Misfit send is refused.',
      acceptance: ['VLT-10', 'VLT-11'],
      seed: null,
      policy: 'quote-neutral',
      fees: 'flat-f23',
      collectionSize: 1,
      allocations: { alice: 1_000n, fees: 7n },
    },
    (b) => {
      b.apply({ op: 'take', owner: 'alice', count: 1 });
      b.apply({ op: 'withdraw', owner: 'alice', ids: [0] });
      b.apply({ op: 'openGate' });
      b.apply({ op: 'withdraw', owner: 'alice', ids: [0] });
      b.apply({ op: 'return', owner: 'alice', ids: [0] });
      b.apply({ op: 'release', owner: 'alice', ids: [0] });
      b.apply({ op: 'sendMisfitToVault', from: 'alice', id: 0 });
      b.apply({ op: 'reveal', ids: [0] });
      b.apply({ op: 'allocateStream', source: 'fees', budget: '7' });
      b.apply({ op: 'claim', owner: 'alice' });
      b.apply({ op: 'allocateStream', source: 'alice', budget: '1000' }); // would burn the last raw FIT: dust guard
      b.apply({ op: 'allocateStream', source: 'alice', budget: '999' });
      b.apply({ op: 'burn', owner: 'alice', amount: '1' }); // A = n = 1: dust guard
      b.apply({ op: 'burn', owner: 'alice', amount: '2' });
      b.apply({ op: 'sendFitToVault', from: 'alice', amount: '2' });
      b.apply({ op: 'sendFitToVault', from: 'alice', amount: '1' });
    },
  );
}

/** F23 C2 / v2-G06 (VLT-15, VLT-09): unsolicited FIT under the trace policy, then every ticket comes back. */
export function unsolicitedFitTrace(seed: number, policy: UnsolicitedFitPolicy): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 10 + prng.int(10);
  return adversarial(
    prng,
    seed,
    policy,
    'none',
    {
      id: `adv-unsolicited-fit-${policyTag(policy)}-${seed.toString(16)}`,
      name: 'unsolicited-fit',
      purpose: `FIT sent to the vault outside a conversion (${policy}), before and after tickets; every ticket comes back and the surplus stays.`,
      acceptance: ['VLT-15', 'VLT-09', 'VLT-08', 'VLT-19'],
      collectionSize,
      allocations: oddAllocations(prng, collectionSize),
    },
    (b, p) => {
      b.apply({ op: 'sendFitToVault', from: 'bob', amount: '0' });
      b.apply({ op: 'sendFitToVault', from: 'bob', amount: '1' });
      take(b, 'alice', 4);
      b.apply({ op: 'sendFitToVault', from: 'bob', amount: (balanceOf(b.ledger(), 'bob') / 2n).toString() });
      b.apply({ op: 'sendFitToVault', from: 'carol', amount: (balanceOf(b.ledger(), 'carol') + 1n).toString() });
      take(b, 'alice', 2);
      const held = ticketIds(b.ledger(), 'alice');
      if (held.length > 0) b.apply({ op: 'transferTicket', from: 'alice', to: 'carol', id: p.pick(held) });
      b.apply({ op: 'allocateStream', source: 'fees', budget: below(p, balanceOf(b.ledger(), 'fees')).toString() });
      b.apply({ op: 'sendFitToVault', from: 'fees', amount: (balanceOf(b.ledger(), 'fees') / 3n).toString() });
      b.apply({ op: 'release', owner: 'carol', ids: ticketIds(b.ledger(), 'carol') });
      b.apply({ op: 'release', owner: 'alice', ids: ticketIds(b.ledger(), 'alice') });
      b.apply({ op: 'claim', owner: 'alice' });
      b.apply({ op: 'claim', owner: 'carol' });
      b.apply({ op: 'sendFitToVault', from: 'alice', amount: below(p, balanceOf(b.ledger(), 'alice') / 10n).toString() });
      // At the one-raw-per-Misfit edge. raw-balance: one past it is refused (dust guard), exactly at it is accepted and
      // r becomes 1 raw. quote-neutral: no guard is needed, A does not move.
      gatherInto(b, 'alice');
      const edge = activeOf(b.ledger()) - BigInt(b.ledger().inventory.size);
      b.apply({ op: 'sendFitToVault', from: 'alice', amount: (edge + 1n).toString() });
      b.apply({ op: 'sendFitToVault', from: 'alice', amount: edge.toString() });
      take(b, 'alice', 1);
    },
  );
}

/** v2-G06 (F24 d): a Misfit sent to the vault outside a return is refused; a reserved ID is nobody's to send. */
export function unsolicitedMisfitTrace(seed: number): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 8 + prng.int(8);
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    'flat-f23',
    {
      id: `adv-unsolicited-misfit-${seed.toString(16)}`,
      name: 'unsolicited-misfit',
      purpose: 'Owner, non-owner, reserved, inside and foreign Misfits sent straight to the vault are all refused; returns still work.',
      acceptance: ['VLT-16', 'VLT-13', 'VLT-03'],
      collectionSize,
      allocations: oddAllocations(prng, collectionSize),
    },
    (b) => {
      const [x, y, z] = take(b, 'alice', 3) as [number, number, number];
      b.apply({ op: 'sendMisfitToVault', from: 'alice', id: x });
      b.apply({ op: 'openGate' });
      b.apply({ op: 'deliver', owner: 'alice', ids: [x, y] });
      b.apply({ op: 'sendMisfitToVault', from: 'alice', id: x });
      b.apply({ op: 'sendMisfitToVault', from: 'bob', id: y });
      b.apply({ op: 'sendMisfitToVault', from: 'alice', id: z });
      b.apply({ op: 'sendMisfitToVault', from: 'alice', id: insideIds(b.ledger())[0] as number });
      b.apply({ op: 'sendMisfitToVault', from: 'alice', id: collectionSize + 3 });
      b.apply({ op: 'reveal', ids: [x, y] });
      b.apply({ op: 'return', owner: 'alice', ids: [x] });
      b.apply({ op: 'sendMisfitToVault', from: 'alice', id: x });
      b.apply({ op: 'transferMisfit', from: 'alice', to: 'bob', id: y });
      b.apply({ op: 'sendMisfitToVault', from: 'alice', id: y });
      b.apply({ op: 'sendMisfitToVault', from: 'bob', id: y });
      b.apply({ op: 'return', owner: 'bob', ids: [y] });
    },
  );
}

/** VLT-13 / VLT-05 / SEL-06: every kind of wrong ID list is refused with the state unchanged. */
export function wrongInventoryTrace(seed: number): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 12 + prng.int(10);
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    'flat-f23',
    {
      id: `adv-wrong-inventory-${seed.toString(16)}`,
      name: 'wrong-inventory',
      purpose: 'Wrong ID lists for hand-backs, deliveries, named picks and returns are refused with the state unchanged; hidden and reserved IDs are never named; a transferred Misfit can be returned only by its new owner.',
      acceptance: ['VLT-13', 'VLT-05', 'VLT-03', 'SEL-06'],
      collectionSize,
      allocations: oddAllocations(prng, collectionSize),
    },
    (b) => {
      const [x, y, z] = take(b, 'alice', 3) as [number, number, number];
      const hiddenId = hiddenIds(b.ledger())[0] as number;
      b.apply({ op: 'release', owner: 'alice', ids: [] });
      b.apply({ op: 'release', owner: 'alice', ids: [x, x] });
      b.apply({ op: 'release', owner: 'bob', ids: [x] });
      b.apply({ op: 'release', owner: 'alice', ids: [hiddenId] });
      b.apply({ op: 'deliver', owner: 'alice', ids: [x] });
      b.apply({ op: 'withdraw', owner: 'alice', ids: [hiddenId] });
      b.apply({ op: 'openGate' });
      b.apply({ op: 'deliver', owner: 'alice', ids: [x, x] });
      b.apply({ op: 'deliver', owner: 'bob', ids: [x] });
      b.apply({ op: 'deliver', owner: 'alice', ids: [x, collectionSize] });
      b.apply({ op: 'deliver', owner: 'alice', ids: [x, y] });
      b.apply({ op: 'withdraw', owner: 'alice', ids: [x, x] });
      b.apply({ op: 'withdraw', owner: 'alice', ids: [collectionSize] });
      b.apply({ op: 'withdraw', owner: 'alice', ids: [hiddenId] });
      b.apply({ op: 'withdraw', owner: 'alice', ids: [z] });
      b.apply({ op: 'reveal', ids: [hiddenId] });
      b.apply({ op: 'reveal', ids: [z] });
      b.apply({ op: 'return', owner: 'alice', ids: [] });
      b.apply({ op: 'return', owner: 'alice', ids: [x, x] });
      b.apply({ op: 'return', owner: 'alice', ids: [z] });
      b.apply({ op: 'return', owner: 'bob', ids: [x] });
      b.apply({ op: 'return', owner: 'alice', ids: [x] });
      b.apply({ op: 'transferMisfit', from: 'bob', to: 'carol', id: x });
      b.apply({ op: 'transferMisfit', from: 'alice', to: 'bob', id: z });
      b.apply({ op: 'transferTicket', from: 'alice', to: 'bob', id: x });
      b.apply({ op: 'transferMisfit', from: 'alice', to: 'bob', id: x });
      b.apply({ op: 'reveal', ids: [x, x] });
      b.apply({ op: 'reveal', ids: [x] });
      b.apply({ op: 'reveal', ids: [x] });
      b.apply({ op: 'return', owner: 'alice', ids: [x] });
      b.apply({ op: 'return', owner: 'bob', ids: [x] });
      b.apply({ op: 'return', owner: 'alice', ids: [y, x] });
      b.apply({ op: 'return', owner: 'alice', ids: [y] });
      b.apply({ op: 'reveal', ids: [y] });
      b.apply({ op: 'withdraw', owner: 'bob', ids: [x, y] });
      b.apply({ op: 'return', owner: 'alice', ids: [y] });
      b.apply({ op: 'return', owner: 'alice', ids: [y] });
      b.apply({ op: 'withdraw', owner: 'bob', ids: [x] });
      b.apply({ op: 'deliver', owner: 'alice', ids: [z] });
    },
  );
}

/** VLT-17 limits and EX12: maxFit/minFit at and one past the quote (fees included), and a stale minimum after a burn. */
export function slippageTrace(seed: number): VaultTrace {
  const prng = createPrng(seed);
  const million = (fit: bigint): bigint => fit * 1_000_000n * WAD;
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    'flat-f23',
    {
      id: `adv-slippage-${seed.toString(16)}`,
      name: 'slippage',
      purpose: 'Limits at 1bn FIT and 10,000 Misfits, fees included: one raw unit past maxFit or minFit is refused for tickets, hand-backs, named picks and returns; a burn after the preview makes the old minimum fail.',
      acceptance: ['VLT-17', 'VLT-01', 'VLT-04'],
      collectionSize: 10_000,
      allocations: { alice: million(900n), bob: million(50n) + below(prng, WAD), fees: million(50n) },
    },
    (b) => {
      const quote = takeQuote(b.ledger(), 1) ?? 0n;
      b.apply({ op: 'take', owner: 'alice', count: 1, maxFit: (quote - 1n).toString() });
      b.apply({ op: 'take', owner: 'alice', count: 1, maxFit: '0' });
      const first = take(b, 'alice', 1, quote);
      const three = take(b, 'bob', 3, takeQuote(b.ledger(), 3) ?? 0n);
      const handBack = returnQuote(b.ledger(), 1) ?? 0n;
      const fee = (handBack * 500n + 9_999n) / 10_000n;
      b.apply({ op: 'release', owner: 'alice', ids: first, minFit: (handBack - fee + 1n).toString() });
      b.apply({ op: 'burn', owner: 'fees', amount: (million(1n) + below(prng, WAD)).toString() });
      b.apply({ op: 'openGate' });
      b.apply({ op: 'deliver', owner: 'bob', ids: three });
      b.apply({ op: 'reveal', ids: three });
      const preview = returnNetQuote(b.ledger(), 1) ?? 0n;
      b.apply({ op: 'return', owner: 'bob', ids: [three[0] as number], minFit: (preview + 1n).toString() });
      b.apply({ op: 'burn', owner: 'fees', amount: (million(3n) + below(prng, WAD)).toString() });
      b.apply({ op: 'return', owner: 'bob', ids: [three[0] as number], minFit: preview.toString() });
      b.apply({ op: 'return', owner: 'bob', ids: [three[0] as number], minFit: (returnNetQuote(b.ledger(), 1) ?? 0n).toString() });
      const pick = pickQuote(b.ledger(), 1) ?? 0n;
      b.apply({ op: 'withdraw', owner: 'alice', ids: [three[0] as number], maxFit: (pick - 1n).toString() });
      b.apply({ op: 'withdraw', owner: 'alice', ids: [three[0] as number], maxFit: pick.toString() });
      const cancel = returnQuote(b.ledger(), 1) ?? 0n;
      b.apply({ op: 'release', owner: 'alice', ids: first, minFit: (cancel + 1n).toString() });
      b.apply({ op: 'release', owner: 'alice', ids: first, minFit: cancel.toString() });
    },
  );
}

/** VLT-09: tickets, a burn, a stream and unsolicited FIT, then every Misfit returns; E (and D) stay; conversions go on. */
export function fullReturnTrace(seed: number, policy: UnsolicitedFitPolicy, fees: ConversionFeePolicy): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 16 + prng.int(16);
  return adversarial(
    prng,
    seed,
    policy,
    fees,
    {
      id: `adv-full-return-${policyTag(policy)}-${feeTag(fees)}-${seed.toString(16)}`,
      name: 'full-return-with-surplus',
      purpose: 'After a burn, a stream and unsolicited FIT, every Misfit comes back: E keeps the stuck surplus, nothing sweeps it, and the vault keeps working.',
      acceptance: ['VLT-09', 'VLT-08', 'VLT-04', 'REV-03'],
      collectionSize,
      allocations: oddAllocations(prng, collectionSize),
    },
    (b, p) => {
      take(b, 'alice', Math.floor(collectionSize / 2));
      b.apply({ op: 'transferFit', from: 'alice', to: 'bob', amount: (balanceOf(b.ledger(), 'alice') / 3n).toString() });
      take(b, 'bob', 3);
      b.apply({ op: 'burn', owner: 'fees', amount: below(p, balanceOf(b.ledger(), 'fees') / 2n).toString() });
      b.apply({ op: 'allocateStream', source: 'fees', budget: below(p, balanceOf(b.ledger(), 'fees')).toString() });
      const held = ticketIds(b.ledger(), 'alice');
      if (held.length > 0) b.apply({ op: 'transferTicket', from: 'alice', to: 'carol', id: p.pick(held) });
      b.apply({ op: 'sendFitToVault', from: 'bob', amount: below(p, balanceOf(b.ledger(), 'bob') / 4n).toString() });
      b.apply({ op: 'openGate' });
      for (const owner of ['carol', 'bob', 'alice']) {
        const ids = ticketIds(b.ledger(), owner);
        if (ids.length === 0) continue;
        b.apply({ op: 'deliver', owner, ids });
        b.apply({ op: 'reveal', ids });
      }
      b.apply({ op: 'return', owner: 'carol', ids: ownedIds(b.ledger(), 'carol') });
      b.apply({ op: 'return', owner: 'bob', ids: ownedIds(b.ledger(), 'bob') });
      b.apply({ op: 'return', owner: 'alice', ids: ownedIds(b.ledger(), 'alice') });
      for (const owner of ['alice', 'bob', 'carol']) b.apply({ op: 'claim', owner });
      take(b, 'alice', 3);
      b.apply({ op: 'withdraw', owner: 'alice', ids: shelfIds(b.ledger()).slice(0, 2) });
    },
  );
}

/** REV-03 / REV-08 / EX04-EX05 shape: stream allocations around transfers, occupancy changes, claims and refusals. */
export function streamHistoryTrace(seed: number): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 20 + prng.int(20);
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    'flat-f23',
    {
      id: `adv-stream-history-${seed.toString(16)}`,
      name: 'stream-history',
      purpose: 'Each owner claims only its own stream history (tickets count as outside); claims change no quote; unfunded and dust-guard budgets are refused.',
      acceptance: ['REV-02', 'REV-03', 'REV-08', 'REV-01'],
      collectionSize,
      allocations: oddAllocations(prng, collectionSize),
    },
    (b, p) => {
      const [x] = take(b, 'alice', 1) as [number];
      b.apply({ op: 'allocateStream', source: 'fees', budget: below(p, balanceOf(b.ledger(), 'fees') / 4n).toString() });
      b.apply({ op: 'transferTicket', from: 'alice', to: 'bob', id: x });
      b.apply({ op: 'openGate' });
      b.apply({ op: 'deliver', owner: 'bob', ids: [x] });
      b.apply({ op: 'allocateStream', source: 'fees', budget: below(p, balanceOf(b.ledger(), 'fees') / 4n).toString() });
      b.apply({ op: 'claim', owner: 'alice' });
      b.apply({ op: 'claim', owner: 'bob' });
      b.apply({ op: 'claim', owner: 'bob' });
      b.apply({ op: 'transferFit', from: 'alice', to: 'carol', amount: (balanceOf(b.ledger(), 'alice') / 2n).toString() });
      const carol = take(b, 'carol', Math.floor(b.ledger().inventory.size / 3));
      b.apply({ op: 'allocateStream', source: 'fees', budget: below(p, balanceOf(b.ledger(), 'fees') / 2n).toString() });
      b.apply({ op: 'allocateStream', source: 'bob', budget: (balanceOf(b.ledger(), 'bob') + 1n).toString() });
      const totals = { active: activeOf(b.ledger()), inside: BigInt(b.ledger().inventory.size), total: BigInt(collectionSize) };
      const edgeBudget = ((totals.active - totals.inside + 1n) * totals.total + totals.inside - 1n) / totals.inside;
      b.apply({ op: 'allocateStream', source: 'alice', budget: edgeBudget.toString() });
      const two = carol.slice(0, 2);
      if (two.length > 0) {
        b.apply({ op: 'deliver', owner: 'carol', ids: two });
        b.apply({ op: 'reveal', ids: two });
        b.apply({ op: 'return', owner: 'carol', ids: two });
      }
      b.apply({ op: 'allocateStream', source: 'fees', budget: below(p, balanceOf(b.ledger(), 'fees')).toString() });
      for (const owner of ['alice', 'bob', 'carol', 'fees']) b.apply({ op: 'claim', owner });
    },
  );
}

/** VLT-12: S = 2^256 − 1 and N = 10,000, so A·k, B·n, E·n and p·bps all exceed 2^256; Solidity needs full-precision mulDiv. */
export function maxSupplyTrace(seed: number): VaultTrace {
  const prng = createPrng(seed);
  const fees = MAX_UINT256 / 8n + below(prng, 10n ** 30n);
  const bob = MAX_UINT256 / 16n + below(prng, 10n ** 30n);
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    'flat-f23',
    {
      id: `adv-max-supply-${seed.toString(16)}`,
      name: 'max-supply',
      purpose: 'Largest ERC-20 supply (2^256 − 1 raw) with 10,000 Misfits: every product in a quote, fee or stream split overflows 256 bits.',
      acceptance: ['VLT-12', 'VLT-08', 'GOV-05'],
      collectionSize: 10_000,
      allocations: { alice: MAX_UINT256 - fees - bob, bob, fees },
    },
    (b, p) => {
      const alice = take(b, 'alice', 1200);
      b.apply({ op: 'allocateStream', source: 'fees', budget: (balanceOf(b.ledger(), 'fees') / 2n + below(p, 10n ** 20n)).toString() });
      const bobs = take(b, 'bob', 7, takeQuote(b.ledger(), 7) ?? 0n);
      b.apply({ op: 'burn', owner: 'fees', amount: (balanceOf(b.ledger(), 'fees') / 3n).toString() });
      b.apply({ op: 'release', owner: 'alice', ids: alice.slice(0, 50) });
      b.apply({ op: 'openGate' });
      b.apply({ op: 'deliver', owner: 'alice', ids: alice.slice(50, 700) });
      b.apply({ op: 'transferMisfit', from: 'alice', to: 'bob', id: alice[60] as number });
      b.apply({ op: 'sendFitToVault', from: 'bob', amount: (balanceOf(b.ledger(), 'bob') / 5n).toString() });
      b.apply({ op: 'reveal', ids: alice.slice(50, 700) });
      b.apply({ op: 'return', owner: 'alice', ids: ownedIds(b.ledger(), 'alice').slice(0, 600) });
      b.apply({ op: 'claim', owner: 'alice' });
      b.apply({ op: 'claim', owner: 'bob' });
      b.apply({ op: 'deliver', owner: 'bob', ids: bobs });
      b.apply({ op: 'reveal', ids: bobs });
      const owned = ownedIds(b.ledger(), 'bob');
      b.apply({ op: 'return', owner: 'bob', ids: owned, minFit: (returnNetQuote(b.ledger(), owned.length) ?? 0n).toString() });
      b.apply({ op: 'withdraw', owner: 'alice', ids: shelfIds(b.ledger()).slice(0, 5), maxFit: (pickQuote(b.ledger(), 5) ?? 0n).toString() });
      b.apply({ op: 'allocateStream', source: 'fees', budget: balanceOf(b.ledger(), 'fees').toString() });
    },
  );
}

/** VLT-04: two holders return in either order (two traces from the same start). */
export function orderTraces(seed: number): [VaultTrace, VaultTrace] {
  const make = (order: 'alice-first' | 'bob-first'): VaultTrace => {
    const prng = createPrng(seed);
    const collectionSize = 20 + prng.int(20);
    const allocations = oddAllocations(prng, collectionSize);
    return adversarial(
      prng,
      seed,
      'quote-neutral',
      'none',
      {
        id: `adv-order-${order}-${seed.toString(16)}`,
        name: `return-order/${order}`,
        purpose: `Alice and Bob hold Misfits through a burn; ${order === 'alice-first' ? 'Alice' : 'Bob'} returns first (compare with the other order).`,
        acceptance: ['VLT-04', 'VLT-03'],
        collectionSize,
        allocations: { ...allocations, bob: allocations.alice ?? 0n },
      },
      (b, p) => {
        const aliceIds = takeOut(b, 'alice', 3 + p.int(5));
        const bobIds = takeOut(b, 'bob', 2 + p.int(5));
        b.apply({ op: 'burn', owner: 'fees', amount: below(p, balanceOf(b.ledger(), 'fees') / 2n).toString() });
        const alice = (): void => void b.apply({ op: 'return', owner: 'alice', ids: aliceIds });
        const bob = (): void => void b.apply({ op: 'return', owner: 'bob', ids: bobIds });
        if (order === 'alice-first') {
          alice();
          bob();
        } else {
          bob();
          alice();
        }
      },
    );
  };
  return [make('alice-first'), make('bob-first')];
}

/**
 * The placeholder life cycle (F36 a): takes during the curve by several holders, placeholder transfers, charged
 * hand-backs, every refusal of the closed gate, graduation once, deliveries, fee-free cancels, reveals, returns to the
 * shelf, named picks from it, and tickets refused once the hidden Misfits run out while the shelf still holds some.
 */
export function ticketLifecycleTrace(seed: number, fees: ConversionFeePolicy): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 8 + prng.int(12);
  const unit = 10n ** BigInt(9 + prng.int(9)) + below(prng, 999n);
  const size = BigInt(collectionSize);
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    fees,
    {
      id: `adv-ticket-lifecycle-${feeTag(fees)}-${seed.toString(16)}`,
      name: 'ticket-lifecycle',
      purpose: 'Placeholders taken, transferred and handed back during the curve; the closed gate refuses deliveries, picks and returns; after graduation tickets are delivered or cancelled fee-free; the shelf never serves a ticket (no_hidden).',
      acceptance: ['SEL-04', 'SEL-05', 'SEL-06', 'VLT-02', 'VLT-03', 'VLT-08'],
      collectionSize,
      allocations: { alice: unit * size * 3n, bob: unit * size * 3n, carol: unit * size * 3n, fees: unit * size + below(prng, unit) },
    },
    (b, p) => {
      const a = take(b, 'alice', 2);
      const bb = take(b, 'bob', 2);
      const c = take(b, 'carol', 1);
      b.apply({ op: 'transferTicket', from: 'alice', to: 'carol', id: a[0] as number });
      b.apply({ op: 'transferTicket', from: 'bob', to: 'carol', id: a[1] as number });
      b.apply({ op: 'release', owner: 'carol', ids: [a[0] as number] });
      b.apply({ op: 'release', owner: 'alice', ids: [a[0] as number] });
      b.apply({ op: 'deliver', owner: 'bob', ids: bb });
      b.apply({ op: 'return', owner: 'bob', ids: [bb[0] as number] });
      b.apply({ op: 'withdraw', owner: 'bob', ids: [a[0] as number] });
      b.apply({ op: 'reveal', ids: bb });
      take(b, 'alice', 1);
      b.apply({ op: 'openGate' });
      b.apply({ op: 'openGate' });
      b.apply({ op: 'return', owner: 'bob', ids: [bb[0] as number] });
      b.apply({ op: 'deliver', owner: 'bob', ids: bb });
      b.apply({ op: 'release', owner: 'carol', ids: c });
      b.apply({ op: 'return', owner: 'bob', ids: bb });
      b.apply({ op: 'reveal', ids: bb });
      b.apply({ op: 'withdraw', owner: 'carol', ids: [bb[0] as number] });
      b.apply({ op: 'return', owner: 'bob', ids: bb });
      // Drain the hidden Misfits with tickets while the shelf holds two: a ticket is then refused (no_hidden), the
      // shelf Misfit still leaves by name, and a cancel frees a hidden Misfit for the next ticket.
      gatherInto(b, 'bob');
      for (let guard = 0; guard < 60 && b.ledger().hidden.size > 0; guard += 1) {
        if (take(b, 'bob', Math.min(b.ledger().hidden.size, 1 + p.int(3))).length === 0) break;
      }
      b.apply({ op: 'take', owner: 'bob', count: 1 });
      const shelf = shelfIds(b.ledger());
      b.apply({ op: 'withdraw', owner: 'bob', ids: shelf.slice(0, 1) });
      b.apply({ op: 'release', owner: 'bob', ids: ticketIds(b.ledger(), 'bob').slice(0, 2) });
      take(b, 'bob', 1);
    },
  );
}

/**
 * The coordinator's hand-back fee waiver (F38 4 hook; stage-1 review): hand-backs before graduation pay the return fee
 * until the waiver, none after it; the waiver works once and only before graduation; takes keep their draw fee and
 * Misfit returns their return fee.
 */
export function handBackWaiverTrace(seed: number): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 8 + prng.int(12);
  const unit = 10n ** BigInt(9 + prng.int(9)) + below(prng, 999n);
  const size = BigInt(collectionSize);
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    'flat-f23',
    {
      id: `adv-hand-back-waiver-${seed.toString(16)}`,
      name: 'hand-back-waiver',
      purpose: 'Placeholders handed back during the curve pay the 5% return fee until the coordinator waives it (F38 4 hook), then none; a second waiver and one after graduation are refused; takes keep the 1% draw fee and Misfit returns the 5% fee.',
      acceptance: ['SEL-04', 'SEL-05', 'VLT-02', 'VLT-03', 'VLT-08'],
      collectionSize,
      allocations: { alice: unit * size * 8n, bob: unit * size * 8n, carol: unit * size * 8n, fees: unit * size + below(prng, unit) },
    },
    (b) => {
      const a = take(b, 'alice', 2);
      const bb = take(b, 'bob', 2);
      const c = take(b, 'carol', 1);
      b.apply({ op: 'release', owner: 'alice', ids: [a[0] as number] }); // charged
      b.apply({ op: 'waiveHandBackFee' });
      b.apply({ op: 'waiveHandBackFee' }); // fee_already_waived
      b.apply({ op: 'release', owner: 'bob', ids: [bb[0] as number] }); // fee-free
      b.apply({ op: 'transferTicket', from: 'alice', to: 'carol', id: a[1] as number });
      b.apply({ op: 'release', owner: 'carol', ids: [a[1] as number, c[0] as number] }); // fee-free
      const later = take(b, 'alice', 1); // the draw fee still applies
      b.apply({ op: 'openGate' });
      b.apply({ op: 'waiveHandBackFee' }); // gate_already_open
      b.apply({ op: 'deliver', owner: 'alice', ids: later });
      b.apply({ op: 'reveal', ids: later });
      b.apply({ op: 'return', owner: 'alice', ids: [later[0] as number] }); // a Misfit return pays 5%
      b.apply({ op: 'release', owner: 'bob', ids: [bb[1] as number] }); // a cancel, fee-free
    },
  );
}

/**
 * The fee burn at the dust guard (ADR-0014 § G05): once burns leave exactly one raw FIT per inside Misfit (A = n), a
 * fee would take the supply below the floor E + n. `curve`: a ticket's draw fee and a hand-back's return fee are
 * refused, and the same hand-back after graduation (a fee-free cancel) passes. `graduated`: a ticket's, a named pick's
 * and a return's fee are refused, a fee-free cancel passes.
 */
export function feeDustTrace(seed: number, phase: 'curve' | 'graduated'): VaultTrace {
  const prng = createPrng(seed);
  const collectionSize = 10 + prng.int(10);
  const n = BigInt(collectionSize);
  return adversarial(
    prng,
    seed,
    'quote-neutral',
    'flat-f23',
    {
      id: `adv-fee-dust-${phase}-${seed.toString(16)}`,
      name: `fee-dust/${phase}`,
      purpose: `At A = n (one raw FIT per inside Misfit) every flat fee hits the supply floor E + n and is refused (dust guard), ${phase === 'curve' ? 'during the curve' : 'after graduation'}; a fee-free cancel passes.`,
      acceptance: ['VLT-11', 'VLT-08'],
      collectionSize,
      allocations: { alice: 10n ** 6n * n + below(prng, 10n ** 5n), bob: 0n },
    },
    (b) => {
      const ids = take(b, 'alice', 4);
      if (phase === 'graduated') {
        b.apply({ op: 'openGate' });
        b.apply({ op: 'deliver', owner: 'alice', ids: ids.slice(0, 2) });
        b.apply({ op: 'reveal', ids: ids.slice(0, 2) });
        b.apply({ op: 'return', owner: 'alice', ids: ids.slice(0, 1) });
      }
      const edge = activeOf(b.ledger()) - BigInt(b.ledger().inventory.size);
      b.apply({ op: 'burn', owner: 'alice', amount: (edge + 1n).toString() });
      b.apply({ op: 'burn', owner: 'alice', amount: edge.toString() });
      b.apply({ op: 'take', owner: 'alice', count: 1 });
      if (phase === 'curve') {
        b.apply({ op: 'release', owner: 'alice', ids: ids.slice(0, 1) });
        b.apply({ op: 'openGate' });
        b.apply({ op: 'release', owner: 'alice', ids: ids.slice(0, 1) });
        b.apply({ op: 'deliver', owner: 'alice', ids: ids.slice(1, 2) });
        b.apply({ op: 'reveal', ids: ids.slice(1, 2) });
        b.apply({ op: 'return', owner: 'alice', ids: ids.slice(1, 2) });
        return;
      }
      b.apply({ op: 'withdraw', owner: 'alice', ids: ids.slice(0, 1) });
      b.apply({ op: 'return', owner: 'alice', ids: ids.slice(1, 2) });
      b.apply({ op: 'release', owner: 'alice', ids: ids.slice(2, 3) });
      b.apply({ op: 'transferFit', from: 'alice', to: 'bob', amount: '1' });
      b.apply({ op: 'withdraw', owner: 'alice', ids: ids.slice(0, 1) });
    },
  );
}

/** Every adversarial family for one seed (both unsolicited-FIT and both fee policies where they matter). */
export function adversarialTraces(seed: number): VaultTrace[] {
  return [
    roundTripTrace(seed, 'quote-neutral', 'none'),
    roundTripTrace(seed, 'quote-neutral', 'flat-f23'),
    roundTripTrace(seed, 'raw-balance', 'none'),
    ...batchVsSingleTraces(seed),
    lastMisfitTrace(seed, 'none'),
    lastMisfitTrace(seed, 'flat-f23'),
    unsolicitedFitTrace(seed, 'quote-neutral'),
    unsolicitedFitTrace(seed, 'raw-balance'),
    unsolicitedMisfitTrace(seed),
    wrongInventoryTrace(seed),
    slippageTrace(seed),
    fullReturnTrace(seed, 'quote-neutral', 'flat-f23'),
    fullReturnTrace(seed, 'raw-balance', 'none'),
    streamHistoryTrace(seed),
    maxSupplyTrace(seed),
    ...orderTraces(seed),
    ticketLifecycleTrace(seed, 'none'),
    ticketLifecycleTrace(seed, 'flat-f23'),
    feeDustTrace(seed, 'curve'),
    feeDustTrace(seed, 'graduated'),
    handBackWaiverTrace(seed),
  ];
}
