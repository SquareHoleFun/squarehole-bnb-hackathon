import { F23_FEES, quotePick, quoteReturnNet, quoteTake, quoteWithdrawPrincipal, type VaultTotals } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIOS } from '../fit-pair/demo-chain';
import { DEMO_FIT_TARGET, FIT_ISSUANCE_RAW } from '../fit-pair/fit-target';
import { demoVaultCounters } from '../fit-pair/useLivePool';
import { demoVaultPlan, demoVaultTotals } from './demo-vault';
import { costTokens, perMillion, releaseTokens } from './price-format';
import { chargedQuote, firstQuote, priceModel, type PriceInputs } from './price-model';

const FIT = 10n ** 18n;
const inputs = (totals: VaultTotals, chainQuoteOne: bigint | null = null): PriceInputs => ({ ...totals, chainQuoteOne, block: null });
const fresh = (size: bigint): VaultTotals => ({ supply: FIT_ISSUANCE_RAW, escrow: 0n, inside: size, collectionSize: size });

/** r = (S − E)/n compared exactly: a·d ≤ c·b for a/b ≤ c/d. */
const rateAtMost = (after: VaultTotals, before: VaultTotals) => (after.supply - after.escrow) * before.inside <= (before.supply - before.escrow) * after.inside;
/** r in thousandths of a FIT (truncated), for the measured steps. */
const milliFit = (t: VaultTotals) => ((t.supply - t.escrow) * 1_000n) / t.inside / FIT;

describe('the price picture (F49 M1): FIT per Misfit from the vault, never an ETH-per-Misfit figure', () => {
  it('equals the vault quote for one, and agrees with the chain’s own quote when it is read', () => {
    const t = fresh(4_200n);
    const model = priceModel(inputs(t, quoteWithdrawPrincipal(t, 1n)));
    expect(model?.fitPerItem).toBe(quoteWithdrawPrincipal(t, 1n));
    expect(model?.check).toBe('matches_chain');
    expect(priceModel(inputs(t, 1n))?.check).toBe('mismatch');
    expect(priceModel(inputs(t))?.check).toBe('not_checked');
    expect(model).toMatchObject({ locked: 0n, unlocked: FIT_ISSUANCE_RAW, outside: 0n, burned: 0n, releasePerItem: null });
  });

  it('charges what the vault would charge: the chain’s own quote when it disagrees, else the computed one', () => {
    const t = fresh(4_269n);
    const computed = quoteWithdrawPrincipal(t, 1n);
    expect(chargedQuote(priceModel(inputs(t)), inputs(t))).toBe(computed);
    expect(chargedQuote(priceModel(inputs(t, computed)), inputs(t, computed))).toBe(computed);
    const other = computed + 5n * FIT;
    expect(chargedQuote(priceModel(inputs(t, other)), inputs(t, other))).toBe(other);
    expect(chargedQuote(null, null)).toBeNull();
  });

  it('writes a cost rounded up and a release rounded down, in whole tokens; the price per 1M, truncated', () => {
    // ⌈1B / 4,200⌉ = 238,095.238… FIT: charged as at most 238,096, released as 238,095.
    expect(costTokens(firstQuote(4_200n))).toBe('238,096');
    expect(releaseTokens(firstQuote(4_200n))).toBe('238,095');
    expect(costTokens(238_095n * FIT)).toBe('238,095');
    expect(perMillion('0.00000000479119')).toBe('0.0047911');
  });

  it('is about 238,095 FIT at 4,200 and 234,246 FIT at 4,269 before any burn: computed, never hard-coded', () => {
    expect(firstQuote(4_200n)).toBe(238_095_238_095_238_095_238_096n);
    expect(firstQuote(4_269n)).toBe(234_246_896_228_624_970_719_138n);
    expect(firstQuote(4_200n) / FIT).toBe(238_095n);
    expect(firstQuote(4_269n) / FIT).toBe(234_246n);
  });

  it('a draw, a named pick and a put-back each lower r only by the burned fee (measured at S = 1B, E = 0)', () => {
    // Thousandths of a FIT (truncated): 0.567 / 14.176 / 2.835 at 4,200; 0.549 / 13.721 / 2.744 at 4,269.
    for (const [size, draw, pick, back] of [
      [4_200n, 567n, 14_176n, 2_835n],
      [4_269n, 549n, 13_721n, 2_744n],
    ] as const) {
      const t = fresh(size);
      const r0 = milliFit(t);
      const take = quoteTake(t, 1n, size, F23_FEES);
      const afterTake = { ...t, supply: t.supply - take.fee, escrow: t.escrow + take.principal, inside: t.inside - 1n };
      expect(r0 - milliFit(afterTake), `draw at ${size}`).toBe(draw);
      const picked = quotePick(t, 1n, F23_FEES);
      const afterPick = { ...t, supply: t.supply - picked.fee, escrow: t.escrow + picked.principal, inside: t.inside - 1n };
      expect(r0 - milliFit(afterPick), `pick at ${size}`).toBe(pick);
      const ret = quoteReturnNet(afterTake, 1n, F23_FEES);
      const afterReturn = { ...afterTake, supply: afterTake.supply - ret.fee, escrow: afterTake.escrow - ret.principal, inside: afterTake.inside + 1n };
      expect(milliFit(afterTake) - milliFit(afterReturn), `put-back at ${size}`).toBe(back);
    }
  });

  it('on a seeded random trace, r never goes up and E moves by exactly each principal', () => {
    let seed = 0x5eedn;
    const next = (mod: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return (seed >> 16n) % mod;
    };
    let t = fresh(4_200n);
    let hidden = 4_200n;
    for (let step = 0; step < 600; step += 1) {
      const before = t;
      const op = next(4n);
      if (op === 0n && hidden > 0n && t.inside > 1n) {
        const q = quoteTake(t, 1n, hidden, F23_FEES);
        t = { ...t, supply: t.supply - q.fee, escrow: t.escrow + q.principal, inside: t.inside - 1n };
        hidden -= 1n;
        expect(t.escrow - before.escrow).toBe(q.principal);
      } else if (op === 1n && t.inside > 1n) {
        const q = quotePick(t, 1n, F23_FEES);
        t = { ...t, supply: t.supply - q.fee, escrow: t.escrow + q.principal, inside: t.inside - 1n };
        expect(t.escrow - before.escrow).toBe(q.principal);
      } else if (op === 2n && t.inside < t.collectionSize) {
        const q = quoteReturnNet(t, 1n, F23_FEES);
        t = { ...t, supply: t.supply - q.fee, escrow: t.escrow - q.principal, inside: t.inside + 1n };
        expect(before.escrow - t.escrow).toBe(q.principal);
      } else {
        // A buy-and-burn: S falls, nothing else moves.
        t = { ...t, supply: t.supply - next(50_000n) * FIT };
      }
      expect(rateAtMost(t, before), `step ${step}`).toBe(true);
      const model = priceModel(inputs(t));
      expect(model?.locked).toBe(t.escrow);
      expect(model?.outside).toBe(t.collectionSize - t.inside);
    }
  });

  it('says unavailable for totals no vault can have, and has no quote with one Misfit left', () => {
    expect(priceModel(inputs({ supply: 10n, escrow: 11n, inside: 1n, collectionSize: 4_200n }))).toBeNull();
    expect(priceModel(inputs({ supply: FIT_ISSUANCE_RAW, escrow: 0n, inside: 0n, collectionSize: 4_200n }))).toBeNull();
    const last = priceModel(inputs({ supply: FIT_ISSUANCE_RAW, escrow: FIT_ISSUANCE_RAW / 2n, inside: 1n, collectionSize: 4_200n }));
    expect(last).toMatchObject({ fitPerItem: null, fees: null, check: 'not_checked' });
  });

  it('lists the flat fees on one Misfit at today’s quote, rounded up: 1% draw, 25% named pick, 5% put back', () => {
    const fees = priceModel(inputs(fresh(4_200n)))?.fees;
    expect(fees?.draw).toBe((238_095_238_095_238_095_238_096n * 100n + 9_999n) / 10_000n);
    expect(fees?.pick).toBe((238_095_238_095_238_095_238_096n * 2_500n + 9_999n) / 10_000n);
  });
});

describe('the Demo vault: exact vault math per scenario', () => {
  it('runs the scenario’s tickets and returns, consistent with the Demo counters', () => {
    const burned = 1_000_000n * FIT;
    for (const scenario of DEMO_SCENARIOS) {
      const totals = demoVaultTotals(scenario, burned, DEMO_FIT_TARGET.collectionSize);
      const counters = demoVaultCounters(scenario, DEMO_FIT_TARGET.collectionSize);
      const plan = demoVaultPlan(scenario);
      expect(totals.inside, scenario).toBe(counters.inside);
      expect(counters.placeholdersTaken, scenario).toBe(plan.takes);
      expect(counters.gateOpen, scenario).toBe(plan.graduated);
      expect(totals.supply <= FIT_ISSUANCE_RAW - burned).toBe(true);
      const model = priceModel({ ...totals, chainQuoteOne: null, block: null });
      expect(model, scenario).not.toBeNull();
      expect(model?.outside).toBe(plan.takes - plan.returns);
      expect(model?.unlocked).toBe(totals.supply - totals.escrow);
    }
    // The Demo runs the F49 E8 edition: 4,269.
    expect(DEMO_FIT_TARGET.collectionSize).toBe(4_269n);
    expect(demoVaultTotals('before_open', 0n, 4_269n)).toEqual({ supply: FIT_ISSUANCE_RAW, escrow: 0n, inside: 4_269n, collectionSize: 4_269n });
    // 37 placeholders lock about 37 × 238,095 FIT at 4,200, 37 × 234,246 FIT at 4,269.
    expect(demoVaultTotals('curve', 0n, 4_200n).escrow / FIT).toBe(8_809_145n);
    expect(demoVaultTotals('curve', 0n, 4_269n).escrow / FIT).toBe(8_666_768n);
  });

  it('keeps the Demo counters and the Demo price picture on the same N, whatever the edition size', () => {
    for (const size of [4_200n, 4_269n, 120n]) {
      const counters = demoVaultCounters('migrated', size);
      const totals = demoVaultTotals('migrated', 0n, size);
      expect(counters.collectionSize).toBe(size);
      expect(counters.inside).toBe(totals.inside);
    }
  });
});
