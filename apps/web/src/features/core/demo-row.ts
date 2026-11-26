/**
 * Box 0 on the Demo as a row (S10a § 5 "The Demo"): box 0's fixture spec (`BOX_0_MISFITS`, the repository's template-0
 * fixture) on invented addresses of the local demo chain, through the same row decoder as a chain box, so the Demo
 * Misfits are box 0 by registry and id (never by name) and every row-built part of the page (the Misfits pack by
 * collection, the links gate, the fee split) runs on it. Labelled Demo everywhere; nothing here is deployed.
 */
import { BOX_0_MISFITS, encodeBoxSpecV1, specHash } from '@squarehole/box-spec';
import { boxRowFromRecord, ROLE_NAMES, type BoxRow, type RoleName } from '@squarehole/chain';
import type { Address, Hex } from 'viem';
import { DEMO_GENESIS_TIME, DEMO_SLOT_SECONDS } from '../fit-pair/demo-chain';
import { DEMO_FIT_TARGET } from '../fit-pair/fit-target';

const demo = (tail: string): Address => `0x${tail.padStart(40, '0')}` as Address;
const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;

/** The Demo registry (invented): the Demo's "version 1" registry, so its box 0 is box 0. */
export const DEMO_REGISTRY = demo('de0');

const DEMO_CONTRACTS: Readonly<Record<RoleName, Address | null>> = {
  coordinator: demo('c00d'),
  token: DEMO_FIT_TARGET.token,
  hook: DEMO_FIT_TARGET.hook,
  vault: DEMO_FIT_TARGET.vault,
  collection: DEMO_FIT_TARGET.collection,
  receiver: demo('5ece'),
  launchRouter: DEMO_FIT_TARGET.launchRouter,
  tickets: DEMO_FIT_TARGET.placeholders,
  royaltyRouter: demo('2075'),
  executor: demo('e1ec'),
  itemStream: demo('57e0'),
  swapModule: null,
  metadataTable: demo('7ab1e'),
};

export const DEMO_BOX0_ROW: BoxRow = boxRowFromRecord(
  {
    boxId: 0n,
    templateId: hashOf(0xde0),
    specHash: specHash(BOX_0_MISFITS),
    creator: demo('c4ea'),
    q: BOX_0_MISFITS.q,
    raise: BOX_0_MISFITS.raise,
    poolManager: DEMO_FIT_TARGET.poolManager,
    poolId: DEMO_FIT_TARGET.poolId,
    creationBlock: DEMO_FIT_TARGET.deployBlock,
    // The Demo chain's clock (12-second blocks from its genesis): the open at the Demo target's open block.
    openAt: DEMO_GENESIS_TIME + (DEMO_FIT_TARGET.openBlock - DEMO_FIT_TARGET.deployBlock) * DEMO_SLOT_SECONDS,
    randomness: demo('d4a0d'),
    contracts: ROLE_NAMES.map((role) => DEMO_CONTRACTS[role] ?? demo('0')),
    codeHashes: ROLE_NAMES.map((role, i) => (DEMO_CONTRACTS[role] ? hashOf(i + 1) : hashOf(0))),
  },
  encodeBoxSpecV1(BOX_0_MISFITS),
  { chainId: DEMO_FIT_TARGET.chainId, registry: DEMO_REGISTRY, box0Registry: DEMO_REGISTRY },
);
