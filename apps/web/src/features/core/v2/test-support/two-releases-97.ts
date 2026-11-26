/**
 * SH-300: chain 97's manifest as lane c's writer emits it, made from the real file: `releases[0]` is today's live
 * release unchanged; `releases[1]` has the same keys, its own factory, registry, listing registry, fee module directory,
 * version code hash, start block and EVERY implementation (as lane c's fork files: each implementation names its
 * release's coordinator), and the same two holding contracts. A read of the wrong release's royalty router, receiver,
 * hook or launch router therefore answers a different address. The evidence block moves past the second start block. The addresses of the second
 * release are made up for tests (no chain has them).
 */
import { required } from './required';
import realManifest from '../../../../../../../packages/contracts/deployments/core-v1/97.json' with { type: 'json' };

type Json = Record<string, unknown>;
const at = (n: number) => `0x${'5e'.repeat(18)}${n.toString(16).padStart(4, '0')}`;
const hash = (n: number) => `0x${'ab'.repeat(30)}${n.toString(16).padStart(4, '0')}`;

export const SECOND = Object.freeze({
  factory: at(1),
  registry: at(2),
  listingRegistry: at(3),
  feeModuleDirectory: at(4),
  coordinator: at(5),
  shopVault: at(6),
  startBlock: '144926000',
  versionCodeHash: hash(7),
});

const first = required((realManifest as unknown as { releases: Json[] }).releases[0]);
const firstImplementations = first.implementations as Record<string, Json>;

/** The second release, as the writer will put it beside the first. */
export const secondRelease: Json = {
  ...first,
  factory: { address: SECOND.factory, codeHash: hash(1) },
  registry: { address: SECOND.registry, codeHash: hash(2) },
  listingRegistry: { address: SECOND.listingRegistry, codeHash: hash(3) },
  feeModuleDirectory: { address: SECOND.feeModuleDirectory, codeHash: hash(4) },
  startBlock: SECOND.startBlock,
  implementations: Object.fromEntries(Object.keys(firstImplementations).map((name, i) => [name,
    name === 'coordinator' ? { address: SECOND.coordinator, codeHash: hash(5) }
      : name === 'shopVault' ? { address: SECOND.shopVault, codeHash: hash(6) }
        : { address: at(0x100 + i), codeHash: hash(0x100 + i) }])),
  versionCodeHash: SECOND.versionCodeHash,
};

/** The whole two-release manifest (raw JSON, as the build bundles it). */
export const twoReleaseManifest97: Json = {
  ...(realManifest as unknown as Json),
  evidence: { block: { number: '144927000', hash: hash(8) }, finality: 'finalized' },
  releases: [first, secondRelease],
};

/** Today's live release, as the real file has it. */
export const firstRelease97 = first;
