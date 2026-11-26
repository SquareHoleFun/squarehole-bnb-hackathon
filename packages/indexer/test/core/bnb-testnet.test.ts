/**
 * SH-259 Part 2: the indexer on a BNB Chain testnet manifest (chain 97, network `bnb-testnet`, no v1 family: `versions`
 * is empty, no box 0). The fixture is SH-258's, with fake 0x9700... addresses; the real file comes from SH-260.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { TESTNET_PROFILES } from '@squarehole/chain';
import { CoreChainIndexer, PACE_12S, PACE_FAST } from '../../src/core/chain-indexer';
import { loadCoreConfig } from '../../src/core/core-config';
import type { LogFilter } from '../../src/core/core-reader';
import { ScriptedCoreChain } from './scripted-core-chain';

const fixture = readFileSync(new URL('../../../chain/test/fixtures/bnb-testnet/core-manifest-97.json', import.meta.url), 'utf8');
const env = { SH_CORE_MANIFEST: '/manifests/97.json' };

function headers(last: bigint) {
  const out = [];
  let parent = `0x${'00'.repeat(32)}` as Hex;
  for (let n = 0n; n <= last; n += 1n) {
    const hash = `0x${n.toString(16).padStart(64, '9')}` as Hex;
    out.push({ number: n, hash, parentHash: parent, timestamp: 1_800_000_000n + (n * 45n) / 100n });
    parent = hash;
  }
  return out;
}

describe('SH-259: the indexer on a chain-97 manifest', () => {
  it('takes the BNB profile\'s log-capable RPCs and the fast pace by default; settings override both', () => {
    const config = loadCoreConfig(env, () => fixture);
    expect(config.manifest.chainId).toBe(97);
    expect(config.httpUrls).toEqual([...TESTNET_PROFILES.bnb.publicRpcUrls]);
    expect(config.httpUrls).toEqual(['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org']);
    expect(config.pace).toBe(PACE_FAST);
    const set = loadCoreConfig({ ...env, SH_CORE_HTTP_URLS: 'http://127.0.0.1:8572', SH_CORE_BLOCK_MS: '12000' }, () => fixture);
    expect(set.httpUrls).toEqual(['http://127.0.0.1:8572']);
    expect(set.pace).toBe(PACE_12S);
  });

  it('follows a release with no box 0 from the release\'s deployment block, never the chain\'s first block', async () => {
    const { manifest } = loadCoreConfig(env, () => fixture);
    const start = BigInt((JSON.parse(fixture) as { releases: { startBlock: string }[] }).releases[0]?.startBlock ?? 'x');
    const chain = new ScriptedCoreChain(97, headers(start + 300n), []);
    const asked: bigint[] = [];
    const rangeLogs = chain.rangeLogs.bind(chain);
    chain.rangeLogs = async (from: bigint, to: bigint, filter: LogFilter, anchors) => { asked.push(from); return rangeLogs(from, to, filter, anchors); };
    const indexer = new CoreChainIndexer({ reader: chain, manifest, pace: PACE_FAST });
    await indexer.start();
    await indexer.idle();
    expect(indexer.metrics.errors).toBe(0);
    expect(indexer.head()?.number).toBe(start + 300n);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.reduce((min, n) => (n < min ? n : min))).toBe(start);
    expect(indexer.v2FeedView().cards).toEqual([]);
  });
});
