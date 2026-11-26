/**
 * The v2 worked examples EX01–EX08 (square-hole-core-v2/docs/08) as traces, for SIM-01: the contracts replay the same
 * steps and must reproduce every raw integer, including the principal and burn amounts their events report.
 * Checkpoint names match the keys of examples/reference-results.json. Test-only.
 *
 * Stage 1 (placeholder tickets): a Misfit that never left the vault leaves only through a ticket, so each example's
 * "withdraw k" is k tickets (the same ⌈A·k/n⌉ locked, n down by k), and where the example needs the Misfits themselves
 * (a transfer, a return) the gate opens and they are delivered; a return needs the reveal first. None of that moves a
 * raw unit, and the examples stay fee-free (fee policy `none`), as v2 docs/03 writes them. The checkpoint states are
 * therefore exactly the reference results.
 *
 * EX06/EX07 need a pool only for the Q side of a sale; the vault traces carry the FIT side (the pool is an ordinary
 * account). EX08 is a closed form over 10^5–10^6 events in the reference; the trace runs its first events with the
 * same funded rule (0.5% of one NFT-equivalent per event at 50% outside) and the test compares it to the closed form.
 */
import type { VaultTrace } from './format';
import { activeOf, buildTrace, idRange, WAD, type TraceMeta } from './generate';

const million = (fit: bigint): bigint => fit * 1_000_000n * WAD;
const FRESH = { alice: million(900n), fees: million(100n) };
const WITH_POOL = { alice: million(800n), fees: million(100n), pool: million(100n) };

type ExampleMeta = Omit<TraceMeta, 'family' | 'seed' | 'policy' | 'fees' | 'collectionSize'>;

const example = (meta: ExampleMeta, script: Parameters<typeof buildTrace>[1]): VaultTrace =>
  buildTrace({ ...meta, family: 'example', seed: null, policy: 'quote-neutral', fees: 'none', collectionSize: 10_000 }, script);

/** Number of funded fee events in the EX08 trace. */
export const EX08_EVENTS = 120;

export function exampleTraces(): VaultTrace[] {
  return [
    example(
      { id: 'ex01', name: 'EX01', purpose: 'Bob is not punished by other returns: half out, a quarter back, rate stays 100,000 FIT.', acceptance: ['SIM-01', 'VLT-01', 'VLT-04'], allocations: FRESH },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 5000 });
        b.apply({ op: 'openGate' });
        b.apply({ op: 'deliver', owner: 'alice', ids: idRange(0, 5000) });
        b.mark('halfOutside');
        b.apply({ op: 'reveal', ids: idRange(0, 2500) });
        b.apply({ op: 'return', owner: 'alice', ids: idRange(0, 2500) });
        b.mark('after2500Return');
      },
    ),
    example(
      { id: 'ex02', name: 'EX02', purpose: 'A true burn of 50m plus 50m permanently stuck surplus; all Misfits back leaves E = 50m.', acceptance: ['SIM-01', 'VLT-08', 'VLT-09'], allocations: FRESH },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 5000 });
        b.apply({ op: 'burn', owner: 'fees', amount: million(50n).toString() });
        b.mark('burned');
        b.apply({ op: 'openGate' });
        b.apply({ op: 'deliver', owner: 'alice', ids: idRange(0, 5000) });
        b.apply({ op: 'reveal', ids: idRange(0, 5000) });
        b.apply({ op: 'return', owner: 'alice', ids: idRange(0, 2500) });
        b.mark('after2500Return');
        b.apply({ op: 'return', owner: 'alice', ids: idRange(2500, 5000) });
        b.mark('allReturned');
      },
    ),
    example(
      { id: 'ex03', name: 'EX03', purpose: 'Equal-slot stream: 10m budget at n = 5,000 burns 5m and credits 5m; r falls to 99,000.', acceptance: ['SIM-01', 'REV-02'], allocations: FRESH },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 5000 });
        b.apply({ op: 'allocateStream', source: 'fees', budget: million(10n).toString() });
        b.mark('state');
      },
    ),
    example(
      { id: 'ex04', name: 'EX04', purpose: 'Sell the NFT, keep historical earnings: Alice claims 1,000 FIT, Bob 2,000.', acceptance: ['SIM-01', 'REV-03', 'VLT-05'], allocations: { ...FRESH, bob: 0n } },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 1 });
        b.apply({ op: 'openGate' });
        b.apply({ op: 'deliver', owner: 'alice', ids: [0] });
        b.apply({ op: 'allocateStream', source: 'fees', budget: million(10n).toString() });
        b.apply({ op: 'transferMisfit', from: 'alice', to: 'bob', id: 0 });
        b.apply({ op: 'allocateStream', source: 'fees', budget: million(20n).toString() });
        b.apply({ op: 'claim', owner: 'alice' });
        b.apply({ op: 'claim', owner: 'bob' });
        b.mark('state');
      },
    ),
    example(
      { id: 'ex05-immediate', name: 'EX05', purpose: 'Immediate 5m burn at n = 5,000: r = 99,000.', acceptance: ['SIM-01', 'REV-06'], allocations: FRESH },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 5000 });
        b.apply({ op: 'burn', owner: 'fees', amount: million(5n).toString() });
        b.mark('immediate');
      },
    ),
    example(
      { id: 'ex05-delayed', name: 'EX05', purpose: 'The same 5m burn after 4,000 more Misfits left: r = 95,000 (timing counterexample, not profit proof).', acceptance: ['SIM-01', 'REV-06'], allocations: FRESH },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 5000 });
        b.apply({ op: 'take', owner: 'alice', count: 4000 });
        b.apply({ op: 'burn', owner: 'fees', amount: million(5n).toString() });
        b.mark('delayed');
      },
    ),
    example(
      { id: 'ex06', name: 'EX06', purpose: 'A ticket and a separate burn leave the pool account untouched.', acceptance: ['SIM-01', 'VLT-20'], allocations: WITH_POOL },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 1 });
        b.apply({ op: 'burn', owner: 'fees', amount: million(1n).toString() });
        b.mark('state');
      },
    ),
    example(
      { id: 'ex07', name: 'EX07', purpose: 'Return 100 Misfits for 9m FIT, then the FIT leg of an external sale (the Q side is pool math, not vault).', acceptance: ['SIM-01', 'VLT-03'], allocations: WITH_POOL },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 5000 });
        b.apply({ op: 'burn', owner: 'fees', amount: million(50n).toString() });
        b.apply({ op: 'openGate' });
        b.apply({ op: 'deliver', owner: 'alice', ids: idRange(0, 100) });
        b.apply({ op: 'reveal', ids: idRange(0, 100) });
        const outcome = b.apply({ op: 'return', owner: 'alice', ids: idRange(0, 100) });
        b.mark('returned');
        const principal = 'ok' in outcome ? (outcome.ok.principal ?? '0') : '0';
        b.apply({ op: 'transferFit', from: 'alice', to: 'pool', amount: principal });
        b.mark('afterSale');
      },
    ),
    example(
      { id: 'ex08', name: 'EX08', purpose: `First ${EX08_EVENTS} funded fee events of EX08 (0.5% of one NFT-equivalent each, 50% outside), with periodic claims.`, acceptance: ['SIM-01', 'REV-02', 'REV-08'], allocations: FRESH },
      (b) => {
        b.apply({ op: 'take', owner: 'alice', count: 5000 });
        b.mark('start');
        for (let event = 1; event <= EX08_EVENTS; event += 1) {
          const ledger = b.ledger();
          const budget = (activeOf(ledger) * 5n) / (1000n * BigInt(ledger.inventory.size));
          b.apply({ op: 'allocateStream', source: 'fees', budget: budget.toString() });
          if (event % 40 === 0) b.apply({ op: 'claim', owner: 'alice' });
        }
        b.mark('end');
      },
    ),
  ];
}
