/**
 * The Demo vault (mock data, labelled Demo): E and S for each Demo scenario, made by running the vault math one ticket
 * at a time from the issuance less the Demo stream's burn, so the Demo price picture is exact vault arithmetic.
 *
 * - During the curve each placeholder is a ticket (`quoteTake`, F36 a): its principal ⌈A/n⌉ moves into E, its 1% draw
 *   fee is burned, n falls by one (MisfitsVault.openTickets).
 * - After graduation a few Misfits come back (`quoteReturnNet`): ⌊A/n⌋ leaves E less the 5% fee (burned), n rises.
 *
 * The plan (how many tickets and returns) is fit-pair/demo-vault-plan.ts, the same one `demoVaultCounters` uses, so the
 * Demo header and the Demo price picture agree for any edition size N.
 */
import { F23_FEES, quoteReturnNet, quoteTake, type VaultTotals } from '@squarehole/domain';
import type { DemoScenario } from '../fit-pair/demo-chain';
import { demoVaultPlan } from '../fit-pair/demo-vault-plan';
import { FIT_ISSUANCE_RAW } from '../fit-pair/fit-target';

export { demoVaultPlan, type DemoVaultPlan } from '../fit-pair/demo-vault-plan';

/**
 * S, E, n and N after the scenario's tickets and returns, starting from the issuance less `burnedBefore` (the Demo
 * stream's burn) with nothing locked. Every fee is burned, so S falls by the fees. N is the Demo market's edition size.
 */
export function demoVaultTotals(scenario: DemoScenario, burnedBefore: bigint, collectionSize: bigint): VaultTotals {
  const plan = demoVaultPlan(scenario);
  let totals: VaultTotals = { supply: FIT_ISSUANCE_RAW - burnedBefore, escrow: 0n, inside: collectionSize, collectionSize };
  let hidden = collectionSize;
  for (let i = 0n; i < plan.takes; i += 1n) {
    const quote = quoteTake(totals, 1n, hidden, F23_FEES);
    totals = { ...totals, supply: totals.supply - quote.fee, escrow: totals.escrow + quote.principal, inside: totals.inside - 1n };
    hidden -= 1n;
  }
  for (let i = 0n; i < plan.returns; i += 1n) {
    const quote = quoteReturnNet(totals, 1n, F23_FEES);
    totals = { ...totals, supply: totals.supply - quote.fee, escrow: totals.escrow - quote.principal, inside: totals.inside + 1n };
  }
  return Object.freeze(totals);
}
