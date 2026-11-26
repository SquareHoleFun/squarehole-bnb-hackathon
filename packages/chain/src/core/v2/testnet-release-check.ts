/**
 * SH-258: the minimal chain check of a BNB Chain testnet (97) release manifest, the counterpart of Sepolia's
 * `checkReleaseOnChain` (sepolia-release-chain.ts, whose Safe and release-plan rules are Sepolia's only). Read-only, at
 * the manifest's evidence block: the RPC's chain id, the evidence block's hash, and the code hash at every address the
 * manifest names (the chain's contracts, each release's factory, registries, directory, implementations and the two
 * fee holders), plus the factory's own registry and listing registry. No signing, no sending.
 */
import { BNB_TESTNET_CHAIN_ID } from '../../config/testnet-profile';
import type { DeployedCoreManifestV2 } from './manifest-v2';
import type { ReleaseChainReads } from './sepolia-release-chain';

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** All problems found (empty: the chain matches the manifest at its evidence block). */
export async function checkTestnetReleaseOnChain(
  manifest: DeployedCoreManifestV2,
  reads: Pick<ReleaseChainReads, 'chainId' | 'blockHash' | 'codeHash' | 'call'>,
): Promise<string[]> {
  if (manifest.chainId !== BNB_TESTNET_CHAIN_ID) return [`the manifest is for chain ${manifest.chainId}, not BNB Chain testnet (${BNB_TESTNET_CHAIN_ID})`];
  const chainId = await reads.chainId();
  if (chainId !== BNB_TESTNET_CHAIN_ID) return [`the RPC is chain ${chainId}, not BNB Chain testnet (${BNB_TESTNET_CHAIN_ID})`];
  const n = BigInt(manifest.evidence.block.number);
  const blockHash = await reads.blockHash(n);
  if (!same(blockHash, manifest.evidence.block.hash)) return [`block ${n} is ${blockHash} on this RPC, the manifest says ${manifest.evidence.block.hash} (reorg or another chain)`];

  const problems: string[] = [];
  const code = async (label: string, entry: { readonly address: string; readonly codeHash: string }) => {
    const observed = await reads.codeHash(entry.address as `0x${string}`, n);
    if (!same(observed, entry.codeHash)) problems.push(`${label} ${entry.address}: code hash ${observed}, manifest ${entry.codeHash}`);
  };
  for (const key of ['poolManager', 'weth', 'randomness', 'platformSafe'] as const) await code(`chain.${key}`, manifest.chain[key]);
  for (const [i, release] of manifest.releases.entries()) {
    const at = `releases.${i}`;
    for (const key of ['factory', 'registry', 'listingRegistry'] as const) await code(`${at}.${key}`, release[key]);
    if (release.feeModuleDirectory) await code(`${at}.feeModuleDirectory`, release.feeModuleDirectory);
    for (const [name, entry] of Object.entries(release.implementations)) if (entry) await code(`${at}.implementations.${name}`, entry);
    for (const role of ['fit', 'platform'] as const) await code(`${at}.safes.${role}`, release.safes[role]);
    for (const view of ['registry', 'listingRegistry'] as const) {
      const observed = String(await reads.call(release.factory.address, view, [], n));
      if (!same(observed, release[view].address)) problems.push(`${at}: factory.${view}() is ${observed}, manifest ${release[view].address}`);
    }
  }
  return problems;
}
