/**
 * The ship's chain check of a BNB Chain testnet (97) release manifest (SH-259 review point 2): SH-258's
 * `checkTestnetReleaseOnChain` at the manifest's evidence block (the block's hash, the code hash at every address the
 * manifest names, the factory's own registry and listing registry), through the profile's first public endpoint: a
 * keyless URL fixed in code, so no configured URL (which may carry a credential) reaches a command line or a log.
 *
 *   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/check-release-97.ts <manifest.json>
 *
 * Prints `release checked: ...` and exits 0, or one line per problem and exits 1. Read-only: no key, no send.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { TESTNET_PROFILES } from '../../chain/src/config/testnet-profile';
import { parseCoreManifestV2 } from '../../chain/src/core/v2/manifest-v2';
import { viemReleaseReads } from '../../chain/src/core/v2/sepolia-release-chain';
import { checkTestnetReleaseOnChain } from '../../chain/src/core/v2/testnet-release-check';

export async function checkRelease(path: string, url = TESTNET_PROFILES.bnb.publicRpcUrls[0]): Promise<string[]> {
  if (!url) return ['no public endpoint in the BNB Chain testnet profile'];
  let manifest;
  try { manifest = parseCoreManifestV2(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { return [`the manifest does not parse: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}`]; }
  if (manifest.status !== 'deployed') return ['the manifest names no deployment'];
  const client = createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 2 }) });
  return checkTestnetReleaseOnChain(manifest, viemReleaseReads(client as never));
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) { process.stderr.write('usage: check-release-97.ts <manifest.json>\n'); process.exit(2); }
  checkRelease(path).then((problems) => {
    // Only the endpoint's origin is named (STEP B point 12), never a path or a query that could carry a credential.
    const origin = new URL(TESTNET_PROFILES.bnb.publicRpcUrls[0] ?? 'https://invalid.invalid').origin;
    if (problems.length === 0) { process.stdout.write(`release checked: the chain matches the manifest at its evidence block (through ${origin})\n`); return; }
    for (const problem of problems) process.stderr.write(`release refused: ${problem}\n`);
    process.exitCode = 1;
  }, () => { process.stderr.write('release refused: the chain check could not finish\n'); process.exitCode = 1; });
}
