/**
 * SH-306 fixtures: three answers of the BNB Chain testnet (chain 97) test site's indexer, recorded from the live test
 * site on 26 November 2026 (apps/web/e2e/fixtures/recorded-live-test-site-2026-11-26/; real reads, public chain data):
 * - `gpu-poor-box-view.json`: GPU Poor's single-box answer (`GET /v2/boxes/97/<token>`), priced in tNVDA, with its
 *   `prices` block (NVDAB/USD, 272 s old of 910 allowed when read);
 * - `the-alchemist-box-view.json`: The Alchemist's single-box answer, priced in tUSDC with a tNVDA pile: two price
 *   entries, roles "price" (USDC/USD) and "pile" (NVDAB/USD);
 * - `feed-without-prices.json`: the list (`GET /v2/feed?chain=97`), 7 cards, none with `prices`.
 * Each is as read less its row's role-keyed copy of the code hashes (`row.codeHashes`), which `row.record.codeHashes`
 * holds as well and nothing reads, and whose `token` key reads as a secret to the secret scan (as life-v2.ts does).
 * The source is the committed chain-97 deployment with a stand-in origin: no test ever asks the real site.
 */
import gpuPoorBox from '../../../../../e2e/fixtures/recorded-live-test-site-2026-11-26/gpu-poor-box-view.json' with { type: 'json' };
import alchemistBox from '../../../../../e2e/fixtures/recorded-live-test-site-2026-11-26/the-alchemist-box-view.json' with { type: 'json' };
import feed from '../../../../../e2e/fixtures/recorded-live-test-site-2026-11-26/feed-without-prices.json' with { type: 'json' };
import bnb from '../../../../../../../packages/contracts/deployments/core-v1/97.json' with { type: 'json' };
import { parseCoreManifestV2 } from '../../../../../../../packages/chain/src/core/v2';
import type { V2Source } from '../indexer-v2';

type Json = Record<string, unknown>;

export const LIVE_BNB_ORIGIN = 'https://indexer.test';

/** The source the recorded answers belong to: the committed chain-97 deployment, read through a stand-in origin. */
export function liveBnbSourceV2(): V2Source {
  return { network: 'sepolia', manifest: parseCoreManifestV2(bnb), origin: LIVE_BNB_ORIGIN, rpc: 'http://127.0.0.1:8599', art: [] };
}

/** The recorded answers, as read (a fresh copy each call). */
export const liveBnbAnswersV2 = {
  gpuPoor: () => structuredClone(gpuPoorBox) as Json,
  alchemist: () => structuredClone(alchemistBox) as Json,
  feed: () => structuredClone(feed) as Json,
} as const;

/** A box's card in the recorded list, by its token. */
export function listedCardV2(token: string): Json {
  const card = (liveBnbAnswersV2.feed().cards as Json[]).find((c) => String(c.token).toLowerCase() === token.toLowerCase());
  if (!card) throw new Error(`No card for ${token} in the recorded list`);
  return card;
}
