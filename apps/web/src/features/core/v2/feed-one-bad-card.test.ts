// @vitest-environment node
/**
 * SH-300 STEP 5: the behaviour the reduction returned to. One card the page cannot place fails the whole feed list,
 * as on main; there is no partial list. The feed is the stand's three cards (VRAM and RENT of the first release, QCARD
 * of the second, recorded on the fork stand). Read with fork-3's two-release manifest all three load, in the feed's
 * order; read with that manifest's first release alone, QCARD's registry is not one this page knows and the read fails.
 * The page's state and words for a failed read are main's, unchanged by this ticket: useV2Feed reports the read as
 * failed (useV2.ts) and the list, with nothing to show, says "The boxes did not load." with Retry (BoxFeedPage.tsx,
 * FEED_WORDS.none and FEED_WORDS.retry in feed-words.ts).
 */
import { describe, expect, it } from 'vitest';
import { parseCoreManifestV2 } from '../../../../../../packages/chain/src/core/v2';
import { loadFeedV2, readFeedV2, type V2Source } from './indexer-v2';
import feed from './test-support/fork3-feed-three.json' with { type: 'json' };
import manifest from './test-support/fork3-manifest-97.json' with { type: 'json' };

const sourceOf = (raw: unknown): V2Source => ({ network: 'sepolia', manifest: parseCoreManifestV2(raw), origin: 'https://index.invalid', rpc: 'http://127.0.0.1:9' });
const two = sourceOf(manifest);
const one = sourceOf({ ...(manifest as unknown as Record<string, unknown>), releases: [(manifest as unknown as { releases: unknown[] }).releases[0]] });
const answer = async () => new Response(JSON.stringify(feed), { status: 200 });

describe('the stand\'s three cards', () => {
  it('with both releases: all three, in the feed\'s order, each through its own release', async () => {
    const views = await loadFeedV2(two, answer);
    expect(views.map((view) => view.spec.tokenSymbol)).toEqual(['VRAM', 'QCARD', 'RENT']);
    expect(views.map((view) => two.manifest.releases.indexOf(view.release))).toEqual([0, 1, 0]);
  });
  it('one card the page cannot place (QCARD without its release): the whole list fails, no partial list', async () => {
    expect(one.manifest.releases).toHaveLength(1);
    await expect(loadFeedV2(one, answer)).rejects.toThrow('Unknown v2 registry');
    await expect(readFeedV2(one, answer)).rejects.toThrow('Unknown v2 registry');
  });
});
