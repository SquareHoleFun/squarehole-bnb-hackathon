/**
 * The write side's view of a deployment manifest (`packages/contracts/deployments/<chainId>.json`, schema
 * `squarehole.deployment/v1`, written by the read-only finalizer after a broadcast; ADR-0011 §10).
 *
 * There is ONE manifest parser in this package: `parseDeploymentManifest` (config/manifest.ts, SH-C integration). This
 * module only projects its result onto what the writers need, with bigint amounts and templates sorted by version.
 * Only a manifest with `status: "deployed"` on a supported write chain is accepted, and only exact addresses are taken
 * from it: template keys such as "WETH" are labels for display, never identity (AGENTS.md "Require exact chain +
 * address identities").
 */
import type { Address } from '@squarehole/domain';
import { parseDeploymentManifest, type DeploymentManifest } from '../config/manifest';
import { TESTNET_CHAIN_ID, isWriteChainId } from './chains';

export interface WriteTemplate {
  readonly version: number;
  /** Exact quote-asset address (Q). */
  readonly quote: Address;
  /** The manifest's key for the template (e.g. "WETH"): display only, never identity. */
  readonly label: string;
  readonly active: boolean;
  readonly startFdvQ: bigint;
  readonly minStartUnitValueQ: bigint;
  /** N bound of a collection launch on this template (startFdvQ / minStartUnitValueQ; ADR-0011 §4). */
  readonly maxCollectionUnits: bigint;
  readonly tickSpacing: number;
  readonly rangeTicks: number;
}

export interface WriteDeployment {
  readonly schema: 'squarehole.deployment/v1';
  readonly chainId: number;
  readonly registry: Address;
  readonly launcher: Address;
  /** R = T claim converter; null when the deployment has none (R = T launches are then refused on chain). */
  readonly converter: Address | null;
  readonly hook: Address;
  readonly poolManager: Address;
  readonly treasury: Address;
  readonly registryAdmin: Address;
  readonly templates: readonly WriteTemplate[];
  /** Testnet mock quote assets (e.g. USDT-TEST): pairs quoted in them carry the mock's disclosures (ADR-0011 §9). */
  readonly testnetMockQuotes: readonly Address[];
  /** Block range of the deployment (decimal strings in the manifest). */
  readonly startBlock: bigint;
  readonly endBlock: bigint;
}

export class DeploymentManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentManifestError';
  }
}

/** The writers' projection of an already parsed manifest (the app passes the one its chain config holds). */
export function writeDeploymentOf(manifest: DeploymentManifest): WriteDeployment {
  if (!isWriteChainId(manifest.chainId)) throw new DeploymentManifestError(`deployment manifest rejected at chainId: not a write chain (31337 or ${TESTNET_CHAIN_ID})`);
  const templates = Object.entries(manifest.templates)
    .map(([label, t]) =>
      Object.freeze({
        version: t.version,
        quote: t.quote,
        label,
        active: t.active,
        startFdvQ: BigInt(t.startFdvQ),
        minStartUnitValueQ: BigInt(t.minStartUnitValueQ),
        maxCollectionUnits: BigInt(t.maxCollectionUnits),
        tickSpacing: t.tickSpacing,
        rangeTicks: t.rangeTicks,
      }),
    )
    .sort((a, b) => a.version - b.version);
  const usdt = manifest.contracts.USDT;
  const mocks = usdt && /^MockTetherUSD\b/.test(usdt.contract) ? [usdt.address] : [];
  return Object.freeze({
    schema: manifest.schema,
    chainId: manifest.chainId,
    registry: manifest.contracts.registry.address,
    launcher: manifest.contracts.launcher.address,
    converter: manifest.contracts.claimConverter?.address ?? null,
    hook: manifest.contracts.hook.address,
    poolManager: manifest.contracts.poolManager.address,
    treasury: manifest.treasury,
    registryAdmin: manifest.registryAdmin,
    templates: Object.freeze(templates),
    testnetMockQuotes: Object.freeze(mocks),
    startBlock: BigInt(manifest.startBlock),
    endBlock: BigInt(manifest.endBlock),
  });
}

/**
 * Parses a deployed manifest for writes. `expectedChainId` guards against loading another chain's file. Throws
 * `DeploymentManifestError` naming the first problem.
 */
export function parseWriteDeployment(input: unknown, expectedChainId: number): WriteDeployment {
  const chainId = typeof input === 'object' && input !== null ? (input as { chainId?: unknown }).chainId : undefined;
  if (typeof chainId === 'number' && !isWriteChainId(chainId)) {
    throw new DeploymentManifestError(`deployment manifest rejected at chainId: not a write chain (31337 or ${TESTNET_CHAIN_ID})`);
  }
  let manifest: DeploymentManifest;
  try {
    manifest = parseDeploymentManifest(input);
  } catch (error) {
    throw new DeploymentManifestError(error instanceof Error ? error.message : 'deployment manifest rejected');
  }
  if (manifest.chainId !== expectedChainId) throw new DeploymentManifestError(`deployment manifest is for chain ${manifest.chainId}, expected ${expectedChainId}`);
  return writeDeploymentOf(manifest);
}

/**
 * Disclosure for a pair quoted in a testnet mock (ADR-0011 §9), or null. Shown before signing any write on such a pair.
 */
export function testnetMockDisclosure(deployment: WriteDeployment, quote: Address): string | null {
  if (!deployment.testnetMockQuotes.some((mock) => mock.toLowerCase() === quote.toLowerCase())) return null;
  return 'This quote asset is the testnet mock USDT-TEST. One testnet key (the deployer) can pause it, blacklist senders, destroy a blacklisted balance (including the shared Uniswap pool manager’s, which leaves every USDT-TEST claim unbacked) and switch on a transfer fee; its faucet supply can run out. Test value only (ADR-0011 §9).';
}

/** The newest ACTIVE template for an exact quote address (never a symbol), or null. */
export function templateForQuote(deployment: WriteDeployment, quote: Address): WriteTemplate | null {
  const matches = deployment.templates.filter((t) => t.active && t.quote.toLowerCase() === quote.toLowerCase());
  return matches.length === 0 ? null : (matches[matches.length - 1] ?? null);
}
