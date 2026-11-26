/**
 * Box 0's BoxSpec for the Sepolia rehearsal of core v1 (docs/runbooks/sepolia-core-v1.md), written as the deploy
 * script reads it: packages/contracts/script/config/box0-spec.11155111.json (`.encoded`, the ABI-encoded BoxSpec;
 * `SH_CORE_V1_SPEC_FILE` of script/DeployCoreV1.s.sol), its desk-question Z3 twin box0-spec.11155111.safe.json and
 * (F78) box0-spec.11155111.rehearsal.json for the rehearsal build (FOUNDRY_PROFILE=rehearsal): the default file with
 * the rehearsal build's raise, 0.4206980085 ETH (1/10), which only that build accepts (its `.build` names it).
 * Written here with SH_WRITE_VECTORS=1, compared otherwise; Foundry decodes, validates and checks both against the
 * factory's template-0 rules and the script (packages/contracts/test/box/sepolia/SepoliaBox0Spec.t.sol).
 *
 * Box 0's fixture (BOX_0_MISFITS, packages/box-spec/fixtures/box-0-misfits.json) with these changes only:
 * - neutral public names and texts (F30 Q2, as the v2 rehearsal: docs/v2/sepolia-full.md): "Rehearsal Token 3" / RHT3
 *   and "Rehearsal Collection 2" / RHC2 (the v2 rehearsals' RHT, RHT2 and RHC are on Sepolia under the same deployer),
 *   the neutral set's hidden text and grey tile, and neutral labels for the three edition-specials series (their counts
 *   kept);
 * - the reveal root, metadata table and generator hash of the Sepolia test set
 *   (packages/contracts/test/vectors/box/sepolia-box0-test-set.json: every leaf from a public label, so any drawn
 *   number can be revealed; the table is the neutral twin of the round-7 table, 3,341 bytes, F75 W1's size);
 * - openAt: a clock time (DECISION-LOG F80; docs/design/open-at-clock-time.md), the UTC time the founder picks on
 *   deploy day with the runbook's Step 0 (packages/contracts/scripts/sepolia-open-at.sh: at least 45 minutes and at most
 *   14 days ahead of Sepolia's latest block), which runs this file with SH_SEPOLIA_OPEN_AT and SH_WRITE_VECTORS=1;
 *   by hand: `SH_SEPOLIA_OPEN_AT=2026-10-06T11:00:00Z pnpm sepolia-spec:write` (a UTC time with the Z, or Unix seconds;
 *   at least 15 minutes ahead, as script/DeployCoreV1.s.sol requires, and at most 14 days). Without it every run keeps
 *   the committed time, so nothing here pins one (the committed one is an example until the founder's pick). After the
 *   deploy, `scripts/sepolia-open-at.sh --deployed <registry>` records the deployed box's openAt (read from the chain;
 *   SH_SEPOLIA_OPEN_AT_DEPLOYED=1 skips the lead check) and keeps the files only if their spec hash is the registry's;
 * - marketplaceOwner: the desk's Z3 (default the testnet deployer 0x1F14…4eeE; `.safe.json` names the mainnet Safe,
 *   which has no code on Sepolia).
 * And a fourth file (SH-SEP-BOX0-SAFE), box0-spec.11155111.rehearsal.sepolia-safe.json: the rehearsal build's file with
 * the founder's Sepolia platform Safe as marketplaceOwner, the box 0 core v2's deploy accepts (DeployCoreV2 refuses a
 * box 0 whose receiver's platformSafe() is not its 1-of-1 platform Safe: WrongPlatformSafe). The Safe is an input:
 * SH_SEPOLIA_PLATFORM_SAFE=<address> writes it; without it every run keeps the committed file's (the example
 * EXAMPLE_SEPOLIA_PLATFORM_SAFE until the founder's Safe is written, which Step 0 refuses: it has no code on Sepolia).
 * Kept from the fixture: N 4,269, the raise (but in the rehearsal file), layouts, streams, royalties 250 bps into fee
 * handling, the logo (coverSha256), the collection cover (the Sorter, F75 U11) and banner A (F75 U10): the final hashes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  AddOnId,
  BOX_0_MISFITS,
  BUILD_PROFILE_MAINNET,
  BUILD_PROFILE_REHEARSAL,
  CONTEXT_V1,
  Field,
  Reason,
  contextForBuild,
  PLATFORM_SAFE_MAINNET,
  decodeBoxSpecV1,
  decodeCollectionMetadataParams,
  decodeEditionSpecialsParams,
  decodePlaceholdersParams,
  encodeBoxSpecV1,
  encodeEditionSpecialsParams,
  encodePlaceholdersParams,
  specHash,
  validateBoxSpecV1,
  type AddOnV1,
  type BoxSpecV1,
  type BuildProfile,
} from './index';

const contracts = (path: string) => fileURLToPath(new URL(`../../contracts/${path}`, import.meta.url));
const TEST_SET = 'test/vectors/box/sepolia-box0-test-set.json';
const SEPOLIA = 11_155_111;
/** F08: the testnet deployer (its key stays outside the repository; only its address is used). */
const TESTNET_DEPLOYER: Address = '0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE';
const DEFAULT_FILE = 'script/config/box0-spec.11155111.json';
/** The rehearsal build's file with the Sepolia platform Safe as platform (SH-SEP-BOX0-SAFE). */
const SEPOLIA_SAFE_FILE = 'script/config/box0-spec.11155111.rehearsal.sepolia-safe.json';
/**
 * The platform the Safe file holds until the founder's Sepolia Safe is written into it: no code on Sepolia, so Step 0
 * (scripts/sepolia-open-at.sh, which names it too) refuses it, as it refuses anything but a 1-of-1 Safe there.
 */
export const EXAMPLE_SEPOLIA_PLATFORM_SAFE: Address = '0x00000000000000000000000000000000005aFE01';
/** The Safe file's spec at 2026-10-06 11:00 UTC with the test Safe 0x5afe…5AfE (a pin of the encoding, not a deploy). */
const PINNED_EXAMPLE_HASH: Hex = '0x243ba12e15e92dbce83d7e60188667fd78e6a0efaf0c2d9d5b8b9b30a6e54bd5';
/** F80: 2026-09-01 00:00:00 UTC, the least clock time the spec takes (BoxSpecV1.MIN_OPEN_AT). */
const MIN_OPEN_AT = 1_788_220_800;
const FIFTEEN_MINUTES = 15 * 60;
const FOURTEEN_DAYS = 14 * 86_400;

/** "2026-10-06T11:00:00Z" (seconds optional; UTC only) or Unix seconds, to Unix seconds; null when neither. */
export function parseOpenAt(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/.exec(text);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  const ms = Date.parse(`${iso}Z`);
  // Date.parse rolls 2026-02-30 over into March: a time that does not read back the same is not a time.
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== iso ? null : ms / 1000;
}

/**
 * The opening time SH_SEPOLIA_OPEN_AT asks for (`asked`), checked against `now` (Unix seconds); null when none is asked
 * (the files keep the committed time). The deploy-day pick must parse and be at least 15 minutes and at most 14 days
 * ahead of now. With `deployed` (SH_SEPOLIA_OPEN_AT_DEPLOYED=1; review of sh-open-at-final, finding 1) it records a box
 * already created: its openAt may have passed, so the lead is not checked, only that it is a clock time;
 * scripts/sepolia-open-at.sh --deployed <registry> reads it from the chain and keeps the files only if their spec hash
 * is the registry's.
 */
export function openAtFor(asked: string | undefined, now: number, deployed: boolean): number | null {
  if (asked === undefined || asked === '') {
    if (deployed) throw new Error('SH_SEPOLIA_OPEN_AT_DEPLOYED=1 needs SH_SEPOLIA_OPEN_AT (the deployed box\'s openAt)');
    return null;
  }
  const t = parseOpenAt(asked);
  if (t === null) throw new Error(`SH_SEPOLIA_OPEN_AT=${asked}: write a UTC time like 2026-10-06T11:00:00Z, or Unix seconds`);
  if (deployed) {
    if (t < MIN_OPEN_AT) throw new Error(`SH_SEPOLIA_OPEN_AT=${asked} is before 2026-09-01 (BoxSpecV1.MIN_OPEN_AT): not a clock time`);
    return t;
  }
  if (t < now + FIFTEEN_MINUTES) throw new Error(`SH_SEPOLIA_OPEN_AT=${asked} is less than 15 minutes ahead (the deploy script refuses it: OpenAtTooSoon)`);
  if (t > now + FOURTEEN_DAYS) throw new Error(`SH_SEPOLIA_OPEN_AT=${asked} is more than 14 days ahead (the factory refuses it: OpenAtTooFar)`);
  return t;
}

/**
 * The Sepolia platform Safe SH_SEPOLIA_PLATFORM_SAFE asks for (`asked`), checksummed; null when none is asked (the Safe
 * file keeps its committed platform). Refused: not an address (a mixed-case address must carry its checksum), zero,
 * and the two platforms that have files of their own (the testnet deployer, the mainnet Safe's address).
 */
export function platformSafeFor(asked: string | undefined): Address | null {
  if (asked === undefined || asked === '') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(asked) || !isAddress(asked)) {
    throw new Error(`SH_SEPOLIA_PLATFORM_SAFE=${asked} is not an address (0x and 40 hex digits; mixed case only with its checksum)`);
  }
  const safe = getAddress(asked);
  if (BigInt(safe) === 0n) throw new Error('SH_SEPOLIA_PLATFORM_SAFE is the zero address');
  if (safe === TESTNET_DEPLOYER) {
    throw new Error(`SH_SEPOLIA_PLATFORM_SAFE=${safe} is the testnet deployer: its file is box0-spec.11155111.rehearsal.json`);
  }
  if (safe === PLATFORM_SAFE_MAINNET) {
    throw new Error(`SH_SEPOLIA_PLATFORM_SAFE=${safe} is the mainnet Safe's address: its file is box0-spec.11155111.safe.json`);
  }
  return safe;
}

/** The opening time the files carry: SH_SEPOLIA_OPEN_AT's (`openAtFor`), else the committed default file's. */
const OPEN_AT =
  openAtFor(process.env.SH_SEPOLIA_OPEN_AT, Math.floor(Date.now() / 1000), process.env.SH_SEPOLIA_OPEN_AT_DEPLOYED === '1') ??
  (JSON.parse(readFileSync(contracts(DEFAULT_FILE), 'utf8')) as { openAt: number }).openAt;
/**
 * A fork rehearsal's own files (scripts/core-v1-life-run.sh): SH_SEPOLIA_SPEC_DIR names a folder under
 * packages/contracts (script/config/rehearsal-runs, gitignored, which forge may read) where the three files are written
 * with SH_SEPOLIA_OPEN_AT, the committed files left as they are (a fork's drand rounds need an open near the real time).
 */
const SPEC_DIR = process.env.SH_SEPOLIA_SPEC_DIR;
/**
 * The Safe file's platform: SH_SEPOLIA_PLATFORM_SAFE's (`platformSafeFor`), else the committed Safe file's, else (no
 * file yet) the example. scripts/sepolia-open-at.sh --deployed passes the factory's platform when it has code.
 */
const committedSafe = (): Address | null => {
  try {
    return getAddress((JSON.parse(readFileSync(contracts(SEPOLIA_SAFE_FILE), 'utf8')) as { platform: string }).platform);
  } catch {
    return null;
  }
};
const SEPOLIA_PLATFORM_SAFE: Address =
  platformSafeFor(process.env.SH_SEPOLIA_PLATFORM_SAFE) ?? committedSafe() ?? EXAMPLE_SEPOLIA_PLATFORM_SAFE;
if (SPEC_DIR !== undefined && SPEC_DIR !== '' && !process.env.SH_SEPOLIA_OPEN_AT) {
  throw new Error('SH_SEPOLIA_SPEC_DIR needs SH_SEPOLIA_OPEN_AT (the rehearsal\'s opening time)');
}

const NAMES = {
  tokenName: 'Rehearsal Token 3',
  tokenSymbol: 'RHT3',
  collectionName: 'Rehearsal Collection 2',
  collectionSymbol: 'RHC2',
  description:
    '4,269 test items for a rehearsal. Each item starts inside the vault: locking tokens in the vault\'s escrow takes ' +
    'one out, and handing an item back releases tokens from the escrow. Test data only: no real art is committed.',
  placeholderName: 'Rehearsal placeholder 2',
  placeholderSymbol: 'RHC2-P',
  placeholderDescription: 'Opens into one item once its number is drawn at graduation.',
  hiddenDescription: 'This item is not revealed yet. Test data only: it has no art, and revealing it shows made-up traits.',
  hiddenSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#9ca3af"/></svg>',
} as const;
/** The fixture's three edition-specials series, in order, under neutral labels (counts kept: 12, 69, 26). */
const SERIES_LABELS = ['Series A', 'Series B', 'Series C'] as const;

interface TestSet {
  root: Hex;
  metadataTable: Hex;
  generatorHash: Hex;
  tableBytes: number;
  count: number;
}

function sepoliaSpec(set: TestSet, platform: Address, build: BuildProfile): BoxSpecV1 {
  let series = 0;
  const addOns: AddOnV1[] = BOX_0_MISFITS.addOns.map((a) => {
    if (a.id === AddOnId.Placeholders) {
      return {
        id: a.id,
        params: encodePlaceholdersParams({
          placeholderName: NAMES.placeholderName,
          placeholderSymbol: NAMES.placeholderSymbol,
          placeholderDescription: NAMES.placeholderDescription,
          hiddenDescription: NAMES.hiddenDescription,
          hiddenSvg: NAMES.hiddenSvg,
        }),
      };
    }
    if (a.id === AddOnId.EditionSpecials) {
      const { count } = decodeEditionSpecialsParams(a.params);
      return { id: a.id, params: encodeEditionSpecialsParams({ label: SERIES_LABELS[series++] as string, count }) };
    }
    return a;
  });
  return {
    ...BOX_0_MISFITS,
    tokenName: NAMES.tokenName,
    tokenSymbol: NAMES.tokenSymbol,
    collectionName: NAMES.collectionName,
    collectionSymbol: NAMES.collectionSymbol,
    description: NAMES.description,
    openAt: OPEN_AT,
    // F78: the build's raise (mainnet's for the two full-size files).
    raise: build.values.RAISE,
    revealRoot: set.root,
    metadataTable: set.metadataTable,
    generatorHash: set.generatorHash,
    marketplaceOwner: platform,
    addOns,
  };
}

function specFile(spec: BoxSpecV1, z3: 'deployer' | 'safe' | 'sepolia-safe', set: TestSet, build: BuildProfile) {
  const encoded = encodeBoxSpecV1(spec);
  const banner = spec.addOns.find((a) => a.id === AddOnId.CollectionMetadata);
  const about =
    z3 === 'sepolia-safe'
      ? [
          'Box 0 (template 0) for the Sepolia rehearsal of core v1 with the REHEARSAL BUILD (F78; FOUNDRY_PROFILE=rehearsal) and the Sepolia platform Safe as platform (docs/runbooks/sepolia-core-v1.md, Z3). Core v2 (docs/runbooks/sepolia-core-v2.md) is deployed only on a box 0 whose platform is its 1-of-1 platform Safe (DeployCoreV2: WrongPlatformSafe). The deploy script reads `.encoded` (SH_CORE_V1_SPEC_FILE) and refuses the file under any other build (`.build`); everything else is for people.',
          'box0-spec.11155111.rehearsal.json with one more change: marketplaceOwner (`.platform`) is the Sepolia platform Safe, an input: `SH_SEPOLIA_PLATFORM_SAFE=<the Safe> pnpm sepolia-spec:write` writes it, every other run keeps this file\'s. Until the founder\'s Safe is written here the platform is the generator\'s example (EXAMPLE_SEPOLIA_PLATFORM_SAFE, no code): Step 0 refuses it, and any platform that is not a 1-of-1 Safe 1.4.1 or 1.5.0 on Sepolia. Kept: the rehearsal raise, neutral names and texts, the Sepolia test set, openAt, N, layouts, streams, royalties, the logo, the collection cover and banner A.',
          'openAt is the opening time in Unix seconds (openAtUtc the same in UTC; F80): the founder picks it on deploy day with Step 0 of the runbook, `scripts/sepolia-open-at.sh 2026-10-06T11:00Z` (from packages/contracts: at least 45 minutes and at most 14 days ahead), which writes it into the four Sepolia files with this generator; the window opens with the first block at or after it.',
          'GENERATED by packages/box-spec/src/sepolia-box0-spec.test.ts (SH_WRITE_VECTORS=1): do not edit by hand.',
        ]
      : build.name === 'mainnet'
      ? [
          'Box 0 (template 0) for the Sepolia rehearsal of core v1 (docs/runbooks/sepolia-core-v1.md). The deploy script reads `.encoded` (SH_CORE_V1_SPEC_FILE); everything else is for people.',
          'Box 0\'s fixture with: neutral names and texts (F30 Q2), the Sepolia test set\'s reveal root, table (the neutral twin of the round-7 table, 3,341 bytes) and generator hash, openAt (a clock time, UTC), and the desk\'s Z3 platform as marketplaceOwner. Kept: N, raise, layouts, streams, royalties, the logo, the collection cover and banner A (final hashes).',
          'openAt is the opening time in Unix seconds (openAtUtc the same in UTC; F80): the founder picks it on deploy day with Step 0 of the runbook, `scripts/sepolia-open-at.sh 2026-10-06T11:00Z` (from packages/contracts: at least 45 minutes and at most 14 days ahead), which writes it into the three Sepolia files with this generator; the window opens with the first block at or after it.',
          'GENERATED by packages/box-spec/src/sepolia-box0-spec.test.ts (SH_WRITE_VECTORS=1): do not edit by hand.',
        ]
      : [
          'Box 0 (template 0) for the Sepolia rehearsal of core v1 with the REHEARSAL BUILD (F78; FOUNDRY_PROFILE=rehearsal; docs/runbooks/sepolia-core-v1.md). The deploy script reads `.encoded` (SH_CORE_V1_SPEC_FILE) and refuses the file under any other build (`.build`); everything else is for people.',
          'box0-spec.11155111.json with one more change: the raise is the rehearsal build\'s, 0.4206980085 ETH (1/10 of mainnet\'s 4.206980085), so the curve fills with about 0.43 SepETH. Kept: neutral names and texts, the Sepolia test set, openAt, the testnet deployer as platform (Z3 default), N, layouts, streams, royalties, the logo, the collection cover and banner A.',
          'openAt is the opening time in Unix seconds (openAtUtc the same in UTC; F80): the founder picks it on deploy day with Step 0 of the runbook, `scripts/sepolia-open-at.sh 2026-10-06T11:00Z` (from packages/contracts: at least 45 minutes and at most 14 days ahead), which writes it into the three Sepolia files with this generator; the window opens with the first block at or after it.',
          'GENERATED by packages/box-spec/src/sepolia-box0-spec.test.ts (SH_WRITE_VECTORS=1): do not edit by hand.',
        ];
  return {
    format: 'squarehole.box0-spec/1',
    about,
    chainId: SEPOLIA,
    ...(build.name === 'mainnet' ? {} : { build: build.name }),
    z3,
    platform: spec.marketplaceOwner,
    specHash: specHash(spec),
    openAt: spec.openAt,
    openAtUtc: new Date(spec.openAt * 1000).toISOString(),
    testSet: TEST_SET,
    summary: {
      tokenName: spec.tokenName,
      tokenSymbol: spec.tokenSymbol,
      collectionName: spec.collectionName,
      collectionSymbol: spec.collectionSymbol,
      n: spec.n,
      raiseWei: spec.raise.toString(),
      revealRoot: spec.revealRoot,
      metadataTableBytes: set.tableBytes,
      generatorHash: spec.generatorHash,
      coverSha256: spec.coverSha256,
      collectionCoverSha256: spec.collectionCoverSha256,
      bannerSha256: banner ? decodeCollectionMetadataParams(banner.params).bannerSha256 : null,
      addOns: spec.addOns.map((a) => a.id),
    },
    encoded,
  };
}

describe('Sepolia rehearsal: box 0 spec files', () => {
  const set = JSON.parse(readFileSync(contracts(TEST_SET), 'utf8')) as TestSet;
  const variants = [
    { file: DEFAULT_FILE, z3: 'deployer' as const, platform: TESTNET_DEPLOYER, build: BUILD_PROFILE_MAINNET },
    { file: 'script/config/box0-spec.11155111.safe.json', z3: 'safe' as const, platform: PLATFORM_SAFE_MAINNET, build: BUILD_PROFILE_MAINNET },
    // F78: the rehearsal build's file (Z3 default only).
    { file: 'script/config/box0-spec.11155111.rehearsal.json', z3: 'deployer' as const, platform: TESTNET_DEPLOYER, build: BUILD_PROFILE_REHEARSAL },
    // SH-SEP-BOX0-SAFE: the rehearsal build's file with the Sepolia platform Safe (an input) as platform.
    { file: SEPOLIA_SAFE_FILE, z3: 'sepolia-safe' as const, platform: SEPOLIA_PLATFORM_SAFE, build: BUILD_PROFILE_REHEARSAL },
  ];

  for (const v of variants) {
    const spec = sepoliaSpec(set, v.platform, v.build);

    it(`${v.file}: valid under version 1 of its build only, the fixture's shape, the test set's commitment`, () => {
      expect(validateBoxSpecV1(spec, contextForBuild(CONTEXT_V1, v.build))).toEqual({ reason: 0, field: 0 });
      // A clock time (F80), whatever the founder picked: not Now, not a block count, the same in every file.
      expect(spec.openAt).toBeGreaterThanOrEqual(MIN_OPEN_AT);
      // F78: each build refuses the other build's raise (validate()'s preset rule), so a file runs on its build only.
      const other = v.build.name === 'mainnet' ? BUILD_PROFILE_REHEARSAL : BUILD_PROFILE_MAINNET;
      expect(validateBoxSpecV1(spec, contextForBuild(CONTEXT_V1, other))).toEqual({
        reason: Reason.RAISE_NOT_A_PRESET,
        field: Field.raise,
      });
      expect(spec.n).toBe(set.count);
      expect(spec.marketplaceOwner).toBe(v.platform);
      expect((spec.metadataTable.length - 2) / 2).toBe(3_341);
      expect(decodeBoxSpecV1(encodeBoxSpecV1(spec))).toEqual(spec);
      const texts = [
        spec.tokenName,
        spec.tokenSymbol,
        spec.collectionName,
        spec.collectionSymbol,
        spec.description,
        ...Object.values(decodePlaceholdersParams((spec.addOns[0] as AddOnV1).params)),
        ...spec.addOns.filter((a) => a.id === AddOnId.EditionSpecials).map((a) => decodeEditionSpecialsParams(a.params).label),
      ];
      for (const t of texts) expect(t).not.toMatch(/fit|square|hole|stonk|sorter|misfit|icon|diamond|one-of/i);
      // Only the declared fields differ from box 0's fixture.
      const differing = (Object.keys(spec) as (keyof BoxSpecV1)[]).filter(
        (k) => JSON.stringify(spec[k], (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)) !==
          JSON.stringify(BOX_0_MISFITS[k], (_, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)),
      );
      expect(differing.sort()).toEqual(
        [
          'addOns',
          'collectionName',
          'collectionSymbol',
          'description',
          'generatorHash',
          'metadataTable',
          ...(spec.openAt === BOX_0_MISFITS.openAt ? [] : ['openAt']),
          'revealRoot',
          'tokenName',
          'tokenSymbol',
          ...(v.platform === PLATFORM_SAFE_MAINNET ? [] : ['marketplaceOwner']),
          ...(v.build.name === 'mainnet' ? [] : ['raise']),
        ].sort(),
      );
    });

    if (v.build.name !== 'mainnet') {
      it(`${v.file}: the default file with the rehearsal build's raise only (F78: 1/10)`, () => {
        const full = sepoliaSpec(set, v.platform, BUILD_PROFILE_MAINNET);
        expect(spec.raise).toBe(420_698_008_500_000_000n);
        expect(spec.raise * 10n).toBe(full.raise);
        expect({ ...spec, raise: full.raise }).toEqual(full);
      });
    }

    it(`${v.file} matches the committed file (SH_WRITE_VECTORS=1 rewrites it)`, () => {
      const text = `${JSON.stringify(specFile(spec, v.z3, set, v.build), null, 2)}\n`;
      if (SPEC_DIR) {
        const at = contracts(`${SPEC_DIR}/${v.file.split('/').pop()}`);
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, text);
        expect(readFileSync(at, 'utf8')).toBe(text);
        return;
      }
      if (process.env.SH_WRITE_VECTORS === '1') writeFileSync(contracts(v.file), text);
      expect(readFileSync(contracts(v.file), 'utf8')).toBe(text);
    });
  }
});

describe('Sepolia rehearsal: the opening time the generator takes (SH_SEPOLIA_OPEN_AT)', () => {
  it('reads a UTC time with the Z or Unix seconds, nothing else', () => {
    expect(parseOpenAt('2026-10-06T11:00:00Z')).toBe(1_791_284_400);
    expect(parseOpenAt('2026-10-06T11:00Z')).toBe(1_791_284_400);
    expect(parseOpenAt('1791284400')).toBe(1_791_284_400);
    for (const bad of ['2026-10-06T11:00:00', '2026-10-06T11:00:00+02:00', '2026-02-30T11:00:00Z', '2026-10-06', 'tomorrow', '']) {
      expect(parseOpenAt(bad), bad).toBeNull();
    }
  });
});

describe('Sepolia rehearsal: recording the deployed opening time (SH_SEPOLIA_OPEN_AT_DEPLOYED; review of sh-open-at-final, finding 1)', () => {
  /** 2026-10-04 12:19:31 UTC: the review's clock, 14.5 minutes before the fork box's open. */
  const NOW = 1_791_116_371;
  const OPEN = 1_791_117_240;

  it('keeps the committed time without SH_SEPOLIA_OPEN_AT (the example file passes)', () => {
    expect(openAtFor(undefined, NOW, false)).toBeNull();
    expect(openAtFor('', NOW, false)).toBeNull();
  });

  it("takes the founder's pick 15 minutes to 14 days ahead (Step 0's files pass)", () => {
    expect(openAtFor(String(NOW + 15 * 60), NOW, false)).toBe(NOW + 15 * 60);
    expect(openAtFor('2026-10-05T09:00Z', NOW, false)).toBe(1_791_190_800);
  });

  it('refuses a passed or close openAt without the flag, as before (the deploy script would refuse it)', () => {
    expect(() => openAtFor(String(OPEN), NOW, false)).toThrow(/less than 15 minutes ahead/);
    expect(() => openAtFor(String(NOW - 3_600), NOW, false)).toThrow(/less than 15 minutes ahead/);
    expect(() => openAtFor(String(NOW + FOURTEEN_DAYS + 1), NOW, false)).toThrow(/more than 14 days ahead/);
  });

  it('records a deployed openAt with the flag, passed or not (scripts/sepolia-open-at.sh --deployed checks it against the registry)', () => {
    expect(openAtFor(String(OPEN), NOW, true)).toBe(OPEN);
    expect(openAtFor(String(NOW - 86_400), NOW, true)).toBe(NOW - 86_400);
    expect(openAtFor('2026-10-04T12:34Z', NOW, true)).toBe(OPEN);
  });

  it('the flag needs a time, a readable one, and a clock time (never Now or a block count)', () => {
    expect(() => openAtFor(undefined, NOW, true)).toThrow(/SH_SEPOLIA_OPEN_AT_DEPLOYED=1 needs SH_SEPOLIA_OPEN_AT/);
    expect(() => openAtFor('tomorrow', NOW, true)).toThrow(/write a UTC time/);
    expect(() => openAtFor('0', NOW, true)).toThrow(/before 2026-09-01/);
    expect(() => openAtFor(String(MIN_OPEN_AT - 1), NOW, true)).toThrow(/before 2026-09-01/);
  });
});

describe("Sepolia rehearsal: box 0 with the Sepolia platform Safe as platform (SH-SEP-BOX0-SAFE; core v2's WrongPlatformSafe)", () => {
  const set = JSON.parse(readFileSync(contracts(TEST_SET), 'utf8')) as TestSet;
  const REHEARSAL_FILE = 'script/config/box0-spec.11155111.rehearsal.json';
  /** Where this run wrote the files: SH_SEPOLIA_SPEC_DIR's folder (a rehearsal's, Step 0's --deployed scratch), else script/config. */
  const written = (file: string): string => (SPEC_DIR ? contracts(`${SPEC_DIR}/${file.split('/').pop()}`) : contracts(file));
  /** An example Sepolia Safe for the pins below (any 1-of-1 Safe address; not the committed file's). */
  const SAFE: Address = '0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE';

  it('takes the Safe as an input: an address, checksummed if mixed case, never zero, the testnet deployer or the mainnet Safe', () => {
    expect(platformSafeFor(undefined)).toBeNull();
    expect(platformSafeFor('')).toBeNull();
    expect(platformSafeFor(SAFE)).toBe(SAFE);
    expect(platformSafeFor(SAFE.toLowerCase())).toBe(SAFE);
    for (const bad of ['0x1234', 'safe', `${SAFE}00`, '0x5Afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE']) {
      expect(() => platformSafeFor(bad), bad).toThrow(/SH_SEPOLIA_PLATFORM_SAFE=.*not an address/);
    }
    expect(() => platformSafeFor('0x0000000000000000000000000000000000000000')).toThrow(/zero/);
    expect(() => platformSafeFor(TESTNET_DEPLOYER)).toThrow(/box0-spec\.11155111\.rehearsal\.json/);
    expect(() => platformSafeFor(PLATFORM_SAFE_MAINNET)).toThrow(/box0-spec\.11155111\.safe\.json/);
  });

  it('the example the committed file starts with has its own name, and is neither of the other platforms', () => {
    expect(EXAMPLE_SEPOLIA_PLATFORM_SAFE).toBe('0x00000000000000000000000000000000005aFE01');
    expect(EXAMPLE_SEPOLIA_PLATFORM_SAFE).not.toBe(TESTNET_DEPLOYER);
    expect(EXAMPLE_SEPOLIA_PLATFORM_SAFE).not.toBe(PLATFORM_SAFE_MAINNET);
  });

  it("is the rehearsal build's file with the Safe as marketplaceOwner and nothing else", () => {
    const withSafe = sepoliaSpec(set, SAFE, BUILD_PROFILE_REHEARSAL);
    const rehearsal = sepoliaSpec(set, TESTNET_DEPLOYER, BUILD_PROFILE_REHEARSAL);
    expect(withSafe.marketplaceOwner).toBe(SAFE);
    expect({ ...withSafe, marketplaceOwner: TESTNET_DEPLOYER }).toEqual(rehearsal);
    expect(validateBoxSpecV1(withSafe, contextForBuild(CONTEXT_V1, BUILD_PROFILE_REHEARSAL))).toEqual({ reason: 0, field: 0 });
    const file = specFile(withSafe, 'sepolia-safe', set, BUILD_PROFILE_REHEARSAL);
    expect(file.build).toBe('rehearsal');
    expect(file.z3).toBe('sepolia-safe');
    expect(file.platform).toBe(SAFE);
    expect(file.about.join('\n')).toContain('SH_SEPOLIA_PLATFORM_SAFE');
    expect(file.about.join('\n')).toContain('WrongPlatformSafe');
  });

  it('pins the spec hash for the example Safe at the runbook example time (2026-10-06 11:00 UTC)', () => {
    const at = { ...sepoliaSpec(set, SAFE, BUILD_PROFILE_REHEARSAL), openAt: 1_791_284_400 };
    const encoded = encodeBoxSpecV1(at);
    expect(encoded.toLowerCase()).toContain(SAFE.slice(2).toLowerCase());
    expect(specHash(at)).toBe(PINNED_EXAMPLE_HASH);
    // The rehearsal file at the same time (Step 2's example row): another hash, the platform is part of the spec.
    const rehearsal = JSON.parse(readFileSync(written(REHEARSAL_FILE), 'utf8')) as { specHash: Hex; openAt: number };
    expect(specHash({ ...sepoliaSpec(set, TESTNET_DEPLOYER, BUILD_PROFILE_REHEARSAL), openAt: 1_791_284_400 })).not.toBe(
      PINNED_EXAMPLE_HASH,
    );
    expect(rehearsal.openAt).toBe(OPEN_AT);
  });

  it('the committed file: the rehearsal file at the same openAt with the committed Safe (SH_SEPOLIA_PLATFORM_SAFE, else the file keeps its own)', () => {
    const committed = JSON.parse(readFileSync(written(SEPOLIA_SAFE_FILE), 'utf8')) as {
      platform: Address;
      openAt: number;
      z3: string;
      build: string;
      encoded: Hex;
    };
    expect(committed.z3).toBe('sepolia-safe');
    expect(committed.build).toBe('rehearsal');
    expect(committed.openAt).toBe(OPEN_AT);
    expect(committed.platform).toBe(SEPOLIA_PLATFORM_SAFE);
    const rehearsal = JSON.parse(readFileSync(written(REHEARSAL_FILE), 'utf8')) as { encoded: Hex };
    expect({ ...decodeBoxSpecV1(committed.encoded), marketplaceOwner: TESTNET_DEPLOYER }).toEqual(decodeBoxSpecV1(rehearsal.encoded));
  });
});
