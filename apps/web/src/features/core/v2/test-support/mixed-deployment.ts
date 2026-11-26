import recording from '../../../../../../../packages/indexer/test/fixtures/core-local-life.json' with { type: 'json' };
import life from '../../../../../e2e/fixtures/core-local/life.json' with { type: 'json' };
import { parseCoreManifestV2 } from '../../../../../../../packages/chain/src/core/v2';
import { publishedV2 } from './published-v2';

/** Recorded v1 plus synthetic E3 output on one chain, for routing tests only. */
export async function mixedDeployment() {
  const published = await publishedV2();
  // Preserve the recorded v1 envelope. The synthetic v2 release uses box 0's existing
  // platform destination, as DeployCoreV2 requires; these are test pins, not Safe attestations.
  const manifestV1 = recording.manifest;
  const manifest = parseCoreManifestV2({ ...manifestV1, releases: published.source.manifest.releases.map((release) => ({
    ...release, startBlock: manifestV1.evidence.block.number,
    safes: { ...release.safes, platform: { ...release.safes.platform, address: manifestV1.chain.platformSafe.address } },
  })) });
  const body = {
    ...published.body, chainId: manifest.chainId,
    row: { ...published.body.row, chainId: manifest.chainId,
      record: { ...published.body.row.record, poolManager: manifest.chain.poolManager.address } },
  };
  const feed = { ...published.feed, chainId: manifest.chainId, cards: [body] };
  return { manifest, body, feed, v1: life.stages.bonding, v1Token: life.token };
}
