/**
 * TA-22: what a creator's wallet may sign while the site creates a box, step by step, and the one guard the executor
 * applies to each step right before the wallet sees it. Browser-safe: no client, signer or chain read.
 *
 * Steps, in order: the price coin's exact approval to the factory (an ERC-20 price coin only), createBox with the found
 * salts, a loadChunk for each chunk, then a pile's seed (its exact ERC-20 approval to the pile, then loadSeed) or a
 * shop's (each starter page's exact item approvals and load, then its exact box-token approval to the shop, fundSeed,
 * then the starter loader's complete). The seed approvals
 * are this module's own, separate from TA-21's factory-only payment approval (SH-TA-21 "Integrator requests"): exact
 * amounts from the spec, to the created box's verified role 3 only, never before that role is known.
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, erc721Abi, isAddress, zeroAddress, type Address } from 'viem';
import { NotSendableError } from '../../write/calls';
import { starterSetLoaderV2Abi } from './abi-v2';
import { buildCreateCallsV2, createPaymentCallsV2, type CreateCallV2, type CreatePlanV2, type StarterItemV2 } from './create-calls-v2';
import { shopConfigV2 } from './m2-spec-v2';
import { pileConfigV2 } from './m3-spec-v2';
import type { BoxSpecV2 } from './spec-v2';
import type { WriteCallV2 } from './write-calls-v2';

export interface CreateSendPlanV2 extends CreatePlanV2 {
  /** The box token predictBox named (and the created coordinator answers): what a shop's seed approval is on. */
  readonly token: Address;
}
export interface StarterApprovalStepV2 extends WriteCallV2 {
  readonly kind: 'approveStarter';
  /** Position and item in the committed set, for progress and ownership checks. */
  readonly index: number;
  readonly item: StarterItemV2;
}
export type CreateStepKindV2 = CreateCallV2['kind'] | 'approveSeed' | 'approveStarter';
export type CreateStepV2 = (WriteCallV2 & { readonly kind: Exclude<CreateStepKindV2, 'approveStarter'> }) | StarterApprovalStepV2;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uint256 = (v: bigint) => v >= 0n && v < 1n << 256n;
const nonzeroAddress = (a: string): boolean => isAddress(a) && !same(a, zeroAddress);

/** A shop always, and a pile with a seed: their post-create steps need the created box's role 3 (a shop also role 19). */
export function createNeedsRolesV2(spec: BoxSpecV2): boolean {
  return spec.boxType === 4 || (spec.boxType === 5 && pileConfigV2(spec.contentsParams).seedAmount > 0n);
}

/** The seed's exact approval: an ERC-20 pile seed to the pile, a shop's T seed to the shop; null when there is none. */
export function seedApprovalV2(plan: CreateSendPlanV2): CreateStepV2 | null {
  const { spec, vault } = plan;
  let coin: Address;
  let amount: bigint;
  if (spec.boxType === 5) {
    const seed = pileConfigV2(spec.contentsParams);
    if (seed.seedAmount === 0n || same(seed.asset, zeroAddress)) return null;
    coin = seed.asset;
    amount = seed.seedAmount;
  } else if (spec.boxType === 4) {
    amount = shopConfigV2(spec.contentsParams).seedT;
    if (amount === 0n) return null;
    coin = plan.token;
  } else return null;
  if (!vault || !nonzeroAddress(vault) || !nonzeroAddress(coin) || same(coin, vault) || same(coin, plan.creator)
    || same(coin, plan.factory) || same(coin, plan.coordinator) || !uint256(amount)) throw new NotSendableError('invalid seed approval');
  return { kind: 'approveSeed', to: coin, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, amount] }) };
}

/** Exactly the committed starters, in order, approved only to the verified shop; none before its roles are known. */
export function starterApprovalsV2(plan: CreateSendPlanV2): readonly StarterApprovalStepV2[] {
  return createStepsV2(plan).filter((step): step is StarterApprovalStepV2 => step.kind === 'approveStarter');
}

/**
 * Every step of this plan in order. Until the created box's roles are known where they are needed, only the payment
 * steps (approval and createBox); after, each starter page's approvals and the seed approval right before their pulls.
 */
export function createStepsV2(plan: CreateSendPlanV2): readonly CreateStepV2[] {
  if (createNeedsRolesV2(plan.spec) && !plan.vault) {
    if (!nonzeroAddress(plan.coordinator) || same(plan.coordinator, plan.creator) || same(plan.coordinator, plan.factory)) {
      throw new NotSendableError('invalid creation roles');
    }
    return createPaymentCallsV2(plan);
  }
  // The canonical builder verifies the full ordered starter commitment, uniqueness, tiers and creation roles before
  // any approval is derived. Decode only those validated loader pages, never the call presented to the guard.
  const calls = buildCreateCallsV2(plan);
  const approval = seedApprovalV2(plan);
  if (approval && !calls.some((call) => call.kind === 'loadSeed' || call.kind === 'fundSeed')) throw new NotSendableError('seed approval without its pull');
  let index = 0;
  return calls.flatMap((call): CreateStepV2[] => {
    if (call.kind === 'loadStarter') {
      const shop = plan.vault;
      const decoded = decodeFunctionData({ abi: starterSetLoaderV2Abi, data: call.data });
      if (!shop || decoded.functionName !== 'load') throw new NotSendableError('starter approval without its pull');
      const [collections, ids, tiers] = decoded.args;
      const approvals = collections.map((collection, i): StarterApprovalStepV2 => {
        const id = ids[i];
        const tier = tiers[i];
        if (id === undefined || tier === undefined) throw new NotSendableError('invalid starter page');
        return { kind: 'approveStarter', index: index++, item: { collection, id, tier }, to: collection, value: 0n,
          data: encodeFunctionData({ abi: erc721Abi, functionName: 'approve', args: [shop, id] }) };
      });
      return [...approvals, call];
    }
    return approval && (call.kind === 'loadSeed' || call.kind === 'fundSeed') ? [approval, call] : [call];
  });
}

/**
 * Recheck immediately before signing: the creator, the chain, and exact bytes, target and value of one of this plan's
 * steps. An authorization check only: the caller keeps the order, reads progress from the chain and never resends a
 * mined step. The plan comes from the validated spec and pinned chain facts, never from the call being checked.
 */
export function assertSendableCreateStepV2(call: WriteCallV2, plan: CreateSendPlanV2, from: Address, chainId: number): void {
  if (!isAddress(from) || !same(from, plan.creator) || chainId !== plan.chainId || !Number.isSafeInteger(chainId) || chainId <= 0
    || !isAddress(call.to) || !uint256(call.value)) throw new NotSendableError('creation caller, chain or value mismatch');
  if (!createStepsV2(plan).some((step) => same(step.to, call.to) && step.value === call.value && same(step.data, call.data))) {
    throw new NotSendableError('call is not an exact creation step of this plan');
  }
}
