/**
 * Chain request specs for the pages (Stage C): each binds one writer of `@squarehole/chain/write` to a deployment,
 * an RPC reader and a write chain. A page passes the spec as `useTxFlow({ …, chain })` (or in the claim store's
 * request); without one its flow stays the labelled demo flow.
 *
 * The emergency payout in Q (`chainClaimAsQFallbackSpec`) is a separate request with its own label: a page offers it
 * only after the converter reported conversion impossible (a `sold_out` refusal), and only on the person's click.
 */
import type { ChainReader, CreateLaunchInput, WriteChain, WriteDeployment } from '@squarehole/chain/write';
import type { Address, LaunchDraft } from '@squarehole/domain';
import type { ChainTxSpec } from './chain-types';

export interface ChainWriteTarget {
  readonly writeChain: WriteChain;
  readonly deployment: WriteDeployment;
  readonly reader: ChainReader;
  readonly now?: () => number;
}

const freeze = (spec: ChainTxSpec): ChainTxSpec => Object.freeze(spec);

/** The writers load with the first chain request (they bring viem's ABI coder), never with the page. */
const writers = () => import('@squarehole/chain/write');

/** Quote validity of a conversion: 20 minutes (the value of `CLAIM_AS_T_DEADLINE_SECONDS` in the write package). */
export const CHAIN_CLAIM_AS_T_DEADLINE_SECONDS = 20 * 60;

function check(target: ChainWriteTarget): void {
  if (target.writeChain.chainId !== target.deployment.chainId) {
    throw new RangeError(`the deployment is on chain ${target.deployment.chainId}, the write chain is ${target.writeChain.chainId}`);
  }
}

/** createLaunch from the wizard's launcher input (`createLaunchInputFromDraft`). No deadline, no value, no first buy. */
export function chainCreateLaunchSpec(target: ChainWriteTarget, input: CreateLaunchInput): ChainTxSpec {
  check(target);
  return freeze({
    ...target,
    deadlineSeconds: null,
    prepare: async ({ account }) => (await writers()).prepareCreateLaunch({ reader: target.reader, deployment: target.deployment, account }, input),
  });
}

/**
 * createLaunch from the wizard's validated draft (SH-C). The draft → launcher input conversion runs in `prepare`
 * (it needs the write package, which loads with the first chain request); a draft the launcher cannot take is refused
 * there with its reason, before anything is simulated or sent. `tokenWholeSupply` is the fixed supply of a token launch.
 */
export function chainCreateLaunchFromDraftSpec(target: ChainWriteTarget, draft: LaunchDraft, options: { readonly tokenWholeSupply?: bigint } = {}): ChainTxSpec {
  check(target);
  return freeze({
    ...target,
    deadlineSeconds: null,
    prepare: async ({ account }) => {
      const w = await writers();
      const input = w.createLaunchInputFromDraft(draft, { tokenWholeSupply: options.tokenWholeSupply });
      return w.prepareCreateLaunch({ reader: target.reader, deployment: target.deployment, account }, input);
    },
  });
}

/** R = Q claim of the whole entitlement for the pair of `token`. */
export function chainClaimSpec(target: ChainWriteTarget, token: Address): ChainTxSpec {
  check(target);
  return freeze({
    ...target,
    deadlineSeconds: null,
    prepare: async ({ account }) => (await writers()).prepareClaim({ reader: target.reader, deployment: target.deployment, account }, token),
  });
}

/** R = T: the whole entitlement converted with an eth_call-quoted minimum; valid for 20 minutes (on chain too). */
export function chainClaimAsTSpec(target: ChainWriteTarget, token: Address): ChainTxSpec {
  check(target);
  return freeze({
    ...target,
    deadlineSeconds: CHAIN_CLAIM_AS_T_DEADLINE_SECONDS,
    prepare: async ({ account, deadline }) => {
      const w = await writers();
      if (deadline === null) throw new w.PrepareRefusal('invalid_input', 'a conversion needs a deadline');
      return w.prepareClaimAsT({ reader: target.reader, deployment: target.deployment, account }, token, deadline);
    },
  });
}

/** The labelled emergency payout in Q while the pool is sold out (never offered automatically). */
export function chainClaimAsQFallbackSpec(target: ChainWriteTarget, token: Address): ChainTxSpec {
  check(target);
  return freeze({
    ...target,
    deadlineSeconds: null,
    prepare: async ({ account }) => (await writers()).prepareClaimAsQWhenSoldOut({ reader: target.reader, deployment: target.deployment, account }, token),
  });
}
