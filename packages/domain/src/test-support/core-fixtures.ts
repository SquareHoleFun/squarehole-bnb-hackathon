/**
 * Test fixtures for the core v2 model (packages/domain/src/core). Synthetic addresses and hashes only: nothing here
 * describes a deployment, and none of it is read by runtime code.
 */
import {
  assetRef,
  amountOf,
  collectionId,
  erc20AssetId,
  nativeAssetId,
  policyRef,
  toChainId,
  MISFITS_FEE_POLICY_F23,
  MISFITS_QUOTE_POLICY_DRAFT,
  MISFITS_VAULT_POLICY_F23,
  type AssetRef,
  type BlockRef,
  type ChainId,
  type VaultSnapshot,
} from '../core';

export const LOCAL: ChainId = toChainId(31_337);
export const SEPOLIA: ChainId = toChainId(11_155_111);
export const MAINNET: ChainId = toChainId(1);

export const FIT_ADDRESS = '0x00000000000000000000000000000000000000f1';
export const MISFITS_ADDRESS = '0x00000000000000000000000000000000000000f2';
export const VAULT_ADDRESS = '0x00000000000000000000000000000000000000f3';

export const ONE_FIT = 10n ** 18n;
export const GENESIS_FIT = 1_000_000_000n * ONE_FIT;

export const fitOn = (chainId: ChainId): AssetRef => assetRef({ id: erc20AssetId(chainId, FIT_ADDRESS), decimals: 18, symbol: 'FIT' });
export const ethOn = (chainId: ChainId): AssetRef => assetRef({ id: nativeAssetId(chainId), decimals: 18, symbol: 'ETH' });

export const FIT_LOCAL = fitOn(LOCAL);
export const ETH_LOCAL = ethOn(LOCAL);

export const hash32 = (byte: string): `0x${string}` => `0x${byte.repeat(32)}`;

export const blockOn = (chainId: ChainId, number = 100n, finality: BlockRef['finality'] = 'confirmed'): BlockRef => ({
  chainId,
  number,
  hash: hash32('bb'),
  finality,
});

export interface SnapshotInput {
  readonly S?: bigint;
  readonly E?: bigint;
  readonly n?: bigint;
  readonly N?: bigint;
  readonly initial?: bigint;
  readonly chainId?: ChainId;
  readonly finality?: BlockRef['finality'];
}

/**
 * A vault snapshot at one block. Defaults: genesis supply, nothing locked, all Misfits inside, at v2's worked-example
 * size N = 10,000 (the vault maths is N-generic; the edition is 4,200 since F35, which tests pass as `N`).
 */
export function snapshotOf(input: SnapshotInput = {}): VaultSnapshot {
  const chainId = input.chainId ?? LOCAL;
  const fit = fitOn(chainId);
  return {
    at: blockOn(chainId, 100n, input.finality ?? 'confirmed'),
    source: 'test fixture',
    vaultPolicy: policyRef(MISFITS_VAULT_POLICY_F23),
    fit,
    collection: collectionId(chainId, MISFITS_ADDRESS),
    collectionCount: input.N ?? 10_000n,
    insideCount: input.n ?? 10_000n,
    initialSupply: amountOf(fit, input.initial ?? GENESIS_FIT),
    totalSupply: amountOf(fit, input.S ?? GENESIS_FIT),
    escrowFit: amountOf(fit, input.E ?? 0n),
  };
}

// --- Live deployment manifests (synthetic; test data only, never a deployment) ------------------------------------

export type Json = Record<string, unknown>;

export const CODE_HASH = hash32('c0');
export const GATE_IDS = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14'] as const;

const approvalFor = (gates: string[]) => ({ adr: 'ADR-0099', gates, evidence: ['docs/evidence/TEST-ONLY.md'] });

export function evidenceFor(chainId: number, address: string, finality: string, expected: boolean): Json {
  return {
    chainId,
    address,
    method: 'eth_getCode',
    codeHash: CODE_HASH,
    expectedCodeHash: expected ? CODE_HASH : null,
    block: { number: '7000000', hash: hash32('e7') },
    finality,
  };
}

function assetsOn(chainId: number): Json {
  return {
    fit: { assetId: `eip155:${chainId}/erc20:${FIT_ADDRESS}`, decimals: 18, symbol: 'FIT', initialSupplyRaw: GENESIS_FIT.toString() },
    q: { assetId: `eip155:${chainId}/slip44:60`, decimals: 18, symbol: 'ETH' },
  };
}

/**
 * Gates F23 answers in whole or in part (founder answer, no accepted ADR yet). G08 (draw mechanism open), G10, G12 and
 * G14 stay open.
 */
const ANSWERED_BY_F23 = new Set(['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G09', 'G11', 'G13']);

/** A valid Sepolia record: verified addresses, gates still open, not live-ready (the testnet goal's shape). */
export function liveTestnetManifest(): Json {
  const chainId = 11_155_111;
  return structuredClone({
    schema: 'squarehole.core-deployment/v2',
    environment: 'testnet',
    liveReady: false,
    chainId,
    intentHash: hash32('1a'),
    assets: assetsOn(chainId),
    collection: { collectionId: `eip155:${chainId}/erc721:${MISFITS_ADDRESS}`, count: 4_200 },
    contracts: { fit: FIT_ADDRESS, misfits: MISFITS_ADDRESS, vault: VAULT_ADDRESS, escrow: VAULT_ADDRESS },
    evidence: [FIT_ADDRESS, MISFITS_ADDRESS, VAULT_ADDRESS].map((address) => evidenceFor(chainId, address, 'confirmed', false)),
    policies: { fee: MISFITS_FEE_POLICY_F23, quote: MISFITS_QUOTE_POLICY_DRAFT, vault: MISFITS_VAULT_POLICY_F23 },
    gates: GATE_IDS.map((id) => (ANSWERED_BY_F23.has(id) ? { id, status: 'ANSWERED', founderRows: ['F23'] } : { id, status: 'OPEN' })),
    release: {
      sourceCommit: null,
      licenseReport: null,
      externalRoutes: null,
      feeIncidenceTable: null,
      mintGasReport: null,
      permissionGraph: null,
      securityReview: null,
      recoveryRunbook: null,
    },
    authorization: null,
  });
}

/** A complete production record: every gate closed, approved policies, finalized evidence and a human approval. */
export function liveProductionManifest(): Json {
  const chainId = 1;
  return structuredClone({
    ...liveTestnetManifest(),
    environment: 'production',
    liveReady: true,
    chainId,
    assets: assetsOn(chainId),
    collection: { collectionId: `eip155:${chainId}/erc721:${MISFITS_ADDRESS}`, count: 4_200 },
    evidence: [FIT_ADDRESS, MISFITS_ADDRESS, VAULT_ADDRESS].map((address) => evidenceFor(chainId, address, 'finalized', true)),
    policies: {
      fee: { ...MISFITS_FEE_POLICY_F23, status: 'approved', approval: approvalFor(['G05', 'G07']) },
      quote: { ...MISFITS_QUOTE_POLICY_DRAFT, status: 'approved', feeOrder: 'PRE_OPERATION_OCCUPANCY', approval: approvalFor(['G05']) },
      vault: {
        ...MISFITS_VAULT_POLICY_F23,
        status: 'approved',
        selection: { mode: 'VERIFIABLE_RANDOM', drawRequired: true },
        approval: approvalFor(['G04', 'G06', 'G08', 'G09']),
      },
    },
    gates: GATE_IDS.map((id) => ({ id, status: 'CLOSED', adr: 'ADR-0099', evidence: ['docs/evidence/TEST-ONLY.md'] })),
    release: {
      sourceCommit: 'a'.repeat(40),
      licenseReport: 'docs/evidence/TEST-ONLY.md#licences',
      externalRoutes: 'docs/evidence/TEST-ONLY.md#routes',
      feeIncidenceTable: 'docs/evidence/TEST-ONLY.md#fees',
      mintGasReport: 'docs/evidence/TEST-ONLY.md#gas',
      permissionGraph: 'docs/evidence/TEST-ONLY.md#roles',
      securityReview: 'docs/evidence/TEST-ONLY.md#review',
      recoveryRunbook: 'docs/evidence/TEST-ONLY.md#recovery',
    },
    authorization: { by: 'test owner', at: '2026-09-28T12:00:00Z', scope: 'production', ref: 'docs/evidence/TEST-ONLY.md#approval' },
  });
}
