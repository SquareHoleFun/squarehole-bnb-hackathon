// @vitest-environment node
/**
 * SH-300: a deployment with two v2 releases (chain 97 after lane c's second release, the one whose card shop also takes
 * a ten-minute wait). Create uses `releases[0]` and a second release changes nothing in what it reads or sends; a box
 * of either release is read and checked with its OWN release (its trade: trade-sepolia/trade-target-releases.test.ts).
 */
import { encodeFunctionResult, type Address, type Hex } from 'viem';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import realManifest from '../../../../../../packages/contracts/deployments/core-v1/97.json' with { type: 'json' };
import { parseCoreManifestV2, receiverModulesV21Abi, type AlchemistReadsV21 } from '../../../../../../packages/chain/src/core/v2';
import type { V2Source } from '../../core/v2/indexer-v2';
import { createReleaseOf, releaseOfRegistry } from '../../core/v2/releases';
import { SECOND, firstRelease97, twoReleaseManifest97 } from '../../core/v2/test-support/two-releases-97';
import { required } from '../../core/v2/test-support/required';
import { alchemistReleaseV21, boxAlchemistReleaseOf } from './alchemist';
import { listingsOptions } from '../../core/v2/pile-coin';
import { createOptionsTargetOf } from './create-options';
import { loadListingsV2 } from './indexer-listings';

const sourceOf = (raw: unknown): V2Source => ({ network: 'sepolia', manifest: parseCoreManifestV2(raw), origin: 'https://index.bnb.test', rpc: 'https://rpc.bnb.test' });
// Today's live release alone (the committed file's FIRST release), so the suite reads the same before and after the
// real file gains its second release.
const one = sourceOf({ ...(realManifest as unknown as Record<string, unknown>), releases: [(realManifest as unknown as { releases: unknown[] }).releases[0]] });
const two = sourceOf(twoReleaseManifest97);
const FIRST = firstRelease97 as unknown as { factory: { address: string }; registry: { address: string }; listingRegistry: { address: string }; implementations: Record<string, { address: string }> };

describe('the two-release manifest', () => {
  it('parses: two releases, the first byte for byte the live one; the one-release source has exactly one', () => {
    expect(one.manifest.releases.length).toBe(1);
    expect(two.manifest.releases.length).toBe(2);
    expect(two.manifest.releases[0]).toEqual(one.manifest.releases[0]);
    expect(two.manifest.releases[1]?.factory.address).toBe(SECOND.factory);
  });
  it('a box names its release by its registry', () => {
    expect(releaseOfRegistry(two.manifest, SECOND.registry)?.factory.address).toBe(SECOND.factory);
    expect(releaseOfRegistry(two.manifest, FIRST.registry.address.toUpperCase().replace('0X', '0x'))?.factory.address).toBe(FIRST.factory.address);
    expect(releaseOfRegistry(two.manifest, '0x00000000000000000000000000000000000000ee')).toBeUndefined();
  });
});

describe('Create uses releases[0]; a second release changes nothing in what it reads or sends', () => {
  it('the release Create uses', () => {
    expect(createReleaseOf(two.manifest)).toBe(two.manifest.releases[0]);
    expect(createReleaseOf(two.manifest)?.factory.address).toBe(FIRST.factory.address);
  });
  it('the send chain (factory, listing registry, coordinator implementation) is the same with one release or two', async () => {
    // The BNB build (chain 97 is a write chain only there).
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const { createChainOf } = await import('./useCreateSend');
    vi.unstubAllEnvs();
    const chainOne = createChainOf(one);
    const chainTwo = createChainOf(two);
    expect(chainOne).not.toBeNull();
    expect(chainTwo).toEqual(chainOne);
    expect(chainTwo).toMatchObject({ factory: FIRST.factory.address, listingRegistry: FIRST.listingRegistry.address, coordinatorImplementation: required(FIRST.implementations.coordinator).address });
  });
  it('the create-options list is the first release\'s, the same file as with one release', () => {
    expect(createOptionsTargetOf(two)).toEqual(createOptionsTargetOf(one));
    expect(createOptionsTargetOf(two)?.url).toBe(`https://index.bnb.test/v2/create-options/97/${FIRST.factory.address.toLowerCase()}.json`);
  });
  it('the price coins are the first release\'s book (listing ids repeat across releases: a book is one registry\'s)', async () => {
    const asked: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      asked.push(url);
      const registry = url.split('/').pop();
      return new Response(JSON.stringify({ schema: 'sh.core-listings.v2', chainId: 97, registry, listings: [] }));
    }) as unknown as typeof fetch;
    const reader = { call: vi.fn() } as never;
    await loadListingsV2(one, fetcher, reader);
    await loadListingsV2(two, fetcher, reader);
    await loadListingsV2(two, fetcher, reader, two.manifest.releases[1]);
    expect(asked).toEqual([
      `https://index.bnb.test/v2/listings/97/${FIRST.registry.address.toLowerCase()}`,
      `https://index.bnb.test/v2/listings/97/${FIRST.registry.address.toLowerCase()}`,
      `https://index.bnb.test/v2/listings/97/${SECOND.registry}`,
    ]);
  });
  it('The Alchemist\'s release parts are the first release\'s (its receiver\'s directory, its coordinator implementation)', async () => {
    const directory: Address = '0x00000000000000000000000000000000000000d1';
    const called: string[] = [];
    const reads: AlchemistReadsV21 = {
      call: async (to: Address) => {
        called.push(to.toLowerCase());
        return encodeFunctionResult({ abi: receiverModulesV21Abi, functionName: 'receiverCode', result: ['0x0000000000000000000000000000000000000073', '0x0000000000000000000000000000000000000074', directory] }) as Hex;
      },
      code: async () => '0x6080' as Hex,
    };
    const fromOne = await alchemistReleaseV21(reads, one);
    const fromTwo = await alchemistReleaseV21(reads, two);
    expect(fromTwo).toEqual(fromOne);
    expect(fromTwo.coordinatorImplementation).toBe(required(FIRST.implementations.coordinator).address);
    expect(called).toEqual([required(FIRST.implementations.receiver).address.toLowerCase(), required(FIRST.implementations.receiver).address.toLowerCase()]);
  });
});

describe('a box of the SECOND release is read with its own release (each would fail with the first\'s)', () => {
  const second = required(two.manifest.releases[1]);
  const first = required(two.manifest.releases[0]);
  it('the fixture tells the releases apart in every implementation', () => {
    for (const name of Object.keys(first.implementations) as (keyof typeof first.implementations)[]) {
      expect(required(second.implementations[name]).address, name).not.toBe(required(first.implementations[name]).address);
    }
  });
  it('The Alchemist\'s module check on its page uses its own receiver and coordinator implementations', () => {
    const parts = boxAlchemistReleaseOf(two, second);
    expect(parts).toEqual({ poolManager: two.manifest.chain.poolManager.address, receiverImplementation: second.implementations.receiver.address, coordinatorImplementation: second.implementations.coordinator.address });
    expect(parts.receiverImplementation).not.toBe(first.implementations.receiver.address);
    expect(parts.coordinatorImplementation).not.toBe(first.implementations.coordinator.address);
  });
  it('the pile coin\'s listing book is its own registry\'s, cached under that registry', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ schema: 'sh.core-listings.v2', chainId: 97, registry: url.split('/').pop(), listings: [] }));
    }));
    try {
      const own = listingsOptions(two, second, true);
      expect(own.queryKey).toContain(SECOND.registry);
      expect(own.queryKey).not.toContain(first.registry.address);
      await own.queryFn();
      const theFirst = listingsOptions(two, first, true);
      await theFirst.queryFn();
      expect(asked).toEqual([`https://index.bnb.test/v2/listings/97/${SECOND.registry}`, `https://index.bnb.test/v2/listings/97/${first.registry.address.toLowerCase()}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * The same with lane c's writer output (its fork rehearsal's files, or the real run's): set SH300_FORK_FILES to the
 * folder holding core-v1/97.json and create-options/data/97/. Skipped otherwise (the committed files have one release
 * until the real run).
 */
const FORK_FILES = process.env.SH300_FORK_FILES;
// The files are read only when the folder is named (a skipped describe's body is still collected).
(FORK_FILES ? describe : describe.skip)('lane c\'s two-release files', () => {
  const dir = FORK_FILES ?? '';
  const raw = FORK_FILES ? JSON.parse(readFileSync(join(dir, 'core-v1/97.json'), 'utf8')) as { releases: unknown[] } : { releases: [] };
  const fork = FORK_FILES ? sourceOf(raw) : one;
  it('parse; the first release is today\'s byte for byte; Create reads and sends as with one release', async () => {
    expect(fork.manifest.releases.length).toBe(2);
    expect(raw.releases[0]).toEqual((realManifest as unknown as { releases: unknown[] }).releases[0]);
    expect(createOptionsTargetOf(fork)).toEqual(createOptionsTargetOf(one));
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const { createChainOf } = await import('./useCreateSend');
    vi.unstubAllEnvs();
    expect(createChainOf(fork)).toEqual(createChainOf(one));
  });
  it('the second release has its own create-options file, named by its factory, for its registry', () => {
    const second = required(fork.manifest.releases[1]);
    const files = readdirSync(join(dir, 'create-options/data/97'));
    expect(files).toContain(`${second.factory.address.toLowerCase()}.json`);
    const doc = JSON.parse(readFileSync(join(dir, 'create-options/data/97', `${second.factory.address.toLowerCase()}.json`), 'utf8')) as Record<string, unknown>;
    expect([doc.chainId, String(doc.factory).toLowerCase(), String(doc.registry).toLowerCase(), String(doc.versionCodeHash).toLowerCase()])
      .toEqual([97, second.factory.address.toLowerCase(), second.registry.address.toLowerCase(), second.versionCodeHash.toLowerCase()]);
    expect(releaseOfRegistry(fork.manifest, second.registry.address)).toBe(second);
  });
});
