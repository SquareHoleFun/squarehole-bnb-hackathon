import { reviewedManifestForPlatform } from '../../../../../../scripts/kits/bag-holders-normal-zero-platform-exception.mjs';
/**
 * SH-EX-O1 (examples on Sepolia): every example settings file the kits commit (examples/boxes/<kit>/settings/), through
 * this page's own Load settings as LoadSettings runs it: `readSettingsFile`, `setupOf`, a shop's starter ids
 * (`withStarters`), the chain's answers for its collections (`checkCollectionsV2`) and `finishLoad`. The listings are
 * Sepolia's: the test site today (ETH, listing 0, at the release raise) and after the founder's listing batch (ETH at
 * 0.1 and the six test coins at their presets, packages/chain/scripts/sepolia-listing-batch.mjs). What loads is then
 * checked as Create checks it there, before anything is signed: the page's own checks with the creator connected
 * (`v2Issues`), and the free tier the logo and a collection cover must fit, since the test site keeps them on Arweave
 * (useFreePictures). A hidden kit's public template loads with its plan file and the plan's twelve pictures and
 * plan.csv, dealt as the page deals them (load-settings.ts `bindPlanTemplate`). Open kits are built anew per run
 * and loaded with all reviewed unique pictures and traits; SH-CREATE-ITEM-MODELS: Rent Free and Bag Holders with their
 * reviewed 3D models too (`<id>.glb` beside each picture), so the builder's model commitments are proved to be the ones
 * Create rebuilds from the same files. One table, KITS: when the kit tooling
 * (scripts/kits) writes a file again, its row is the one place to change, and a committed file without a row fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '@squarehole/artwork';
import { beforeAll, describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { TURBO_FREE_BYTES } from '../../pictures/arweave-hosts';
import { fitsFree } from '../../pictures/arweave-publish';
import { TOO_DETAILED } from '../../pictures/shrink';
import { BROWSER_ART, readArt } from '../art-files';
import { ZERO32, commitArt, type ArtState } from '../create-model';
import { NOW, OWNER } from '../test-support/fixtures';
import { testRandomWords } from '../test-support/test-words';
import type { TokenReader } from './issuer-powers';
import { LOAD_WORDS, bindPlanTemplate, finishLoad, readPlanManifest, readSettingsFile, setupOf, templatePlanProblem, withStarters, type LoadedDraft, type LoadedSetup } from './load-settings';
import { NATIVE_TOKEN, amountText, offeredListings, type SiteListing } from './listings';
import { buildSpecV2, v2Issues } from './model';
import { freePicturesRefused } from './pictures';
import { starterItemsOf, starterKey, type StarterCheck } from './shop';
import { checkCollectionsV2 } from './shop-checks';
import { ListingClass, ListingKind } from './spec-types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
const KITS_DIR = join(ROOT, 'examples/boxes');
const SEPOLIA = 11_155_111;
const digest = async (bytes: Uint8Array) => sha256Hex(bytes);
const fileOf = (kit: string) => join(KITS_DIR, kit, 'settings', `${kit}-boxspec-v2.json`);
const two = (i: number) => String(i + 1).padStart(2, '0');
/** A hidden kit's template's items, as its creator adds them: the plan's twelve pictures, as the plan names them, and plan.csv. */
const planFiles = (kit: string): File[] => [
  ...Array.from({ length: 12 }, (_, i) => new File([readFileSync(join(KITS_DIR, kit, 'art/items', `variant-${two(i)}.png`))], `variant-${two(i)}.png`, { type: 'image/png' })),
  new File([readFileSync(join(KITS_DIR, kit, 'plan.csv'))], 'plan.csv', { type: 'text/csv' }),
];

/** Sepolia's ETH as the test site lists it today: listing 0 of the v2 release (core-v2-11155111-0xFAe1…e393.json). */
const ETH: SiteListing = { id: 0, token: NATIVE_TOKEN, decimals: 18, class: ListingClass.NATIVE, kind: ListingKind.LISTED, raise: 4_206_980_085_000_000_000n, symbol: 'ETH', name: 'Ether', powers: [], eat: 'allowed' };
/** A coin of the founder's batch. None is deployed yet: a stand-in address, never one of a kit file's binding slots. */
const testCoin = (id: number, symbol: string, decimals: number, cls: number, raise: bigint, checkedBurn = false): SiteListing => ({
  id, token: `0x7e57c014${'0'.repeat(28)}${id.toString(16).padStart(4, '0')}` as Address, decimals, class: cls, kind: ListingKind.LISTED, raise, symbol, name: symbol, powers: [], eat: 'allowed',
  ...(checkedBurn ? { checkedBurn } : {}),
});
const E18 = 10n ** 18n;
const SETS = {
  /** The test site today: ETH only, at the release raise. */
  today: [ETH],
  /** After the platform Safe batch (plan § 2, step 4): updateRaise(0, 0.1 ETH), then tLINK … tFROG in the batch's order. */
  afterBatch: [
    { ...ETH, raise: E18 / 10n },
    testCoin(1, 'tLINK', 18, ListingClass.OTHER, 100n * E18),
    testCoin(2, 'tUSDC', 6, ListingClass.STABLE, 100_000_000n),
    testCoin(3, 'tNVDA', 18, ListingClass.STOCK, 100n * E18),
    testCoin(4, 'tGOLD', 18, ListingClass.OTHER, E18),
    testCoin(5, 'tPEPE', 18, ListingClass.OTHER, 100_000n * E18),
    testCoin(6, 'tFROG', 18, ListingClass.OTHER, 100_000n * E18, true),
  ],
} as const satisfies Record<string, readonly SiteListing[]>;

/**
 * A chain for a shop's starting collections. `empty`: Sepolia today, where nothing is deployed at the binding slots
 * (0x…0023xxxx) a kit file names; `deployed`: an ERC-721 at each, as a file regenerated after TA-40's collections meets.
 */
const ERC165 = parseAbi(['function supportsInterface(bytes4 id) view returns (bool)']);
const chainOf = (deployed: boolean): TokenReader => ({
  hasCode: async () => deployed,
  call: async () => (deployed ? encodeFunctionResult({ abi: ERC165, functionName: 'supportsInterface', result: true }) : null),
});

/** What the creator sees: the line Load settings refuses the file with, or what loads and each line Create then shows. */
type Outcome = { readonly refused: string } | { readonly loads: string; readonly create: readonly string[] };

interface KitRow {
  readonly kit: string;
  /** The settings spec hash, including per-run open builds: it changes when the kit tooling changes. */
  readonly specHash: Hex;
  /** The logo's bytes (and a collection cover's) as the file carries them: what the free tier counts. */
  readonly logo: number;
  readonly cover?: number;
  /** A shop's starter ids per collection, as the creator types them: the file commits only their hash and count. */
  readonly starterIds?: readonly string[];
  /** A hidden kit's public template: loaded with its plan file (`<kit>-plan.json`) and the plan's pictures and plan.csv. */
  readonly plan?: true;
  /** Open collection: build its public reveal-list settings anew in this test run. */
  readonly open?: true;
  /** R74-ART: an open collection with a reviewed 3D model per item, loaded with its numbered models. */
  readonly models?: true;
  readonly today: Outcome;
  readonly afterBatch: Outcome;
  /** A shop: what it meets once an ERC-721 answers at each collection it names and the creator holds its starters. */
  readonly deployed?: Outcome;
}

const NO_CONTRACT = LOAD_WORDS.cannotKeep('No contract at this address');
/** The Junkyard's Sepolia stock: ids 1 and 2 of each of TA-40's five Test Junk collections (test-collections/catalog.json). */
const JUNKYARD_IDS = (JSON.parse(readFileSync(join(KITS_DIR, 'junkyard/test-collections/catalog.json'), 'utf8')) as { collections: { items: { id: string }[] }[] })
  .collections.map((collection) => collection.items.map((item) => item.id).join(', '));

/**
 * The committed files as written by L1 (`313416b14`, merged here as `62f790e3b`): every logo and cover now fits the free
 * tier. Each file is priced in ETH, listing 0, so it loads in ETH at the site's current raise. What still stops a file
 * is a placeholder its kit tooling binds later: a shop's collections and The Alchemist's Test Gold pile.
 */
const KITS: readonly KitRow[] = [
  {
    kit: 'link-marines-v2', specHash: '0x1415082e3fb7e3a55c33d7d42c87efa80681308dd4b2028d6dbc3d4312401ba5', logo: 62_156, cover: 45_478, open: true,
    today: { loads: 'Link Marines (MARINE) · 420 items, open · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'Link Marines (MARINE) · 420 items, open · raise 0.1 ETH', create: [] },
  },
  {
    // R74-ART: 404 one-of-a-kind signs that stay 2D (no models, every model hash zero), like Link Marines v2.
    kit: 'exit-liquidity', specHash: '0x629b3854f24b79511c082e6f8f8d18f05f89573b7129283c24034b6957389dcb', logo: 7_908, cover: 41_472, open: true,
    today: { loads: 'Exit Liquidity (EXIT) · 404 items, open · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'Exit Liquidity (EXIT) · 404 items, open · raise 0.1 ETH', create: [] },
  },
  {
    // SH-CREATE-ITEM-MODELS: 500 houses, each with its reviewed GLB; the spec hash is T02's offline candidate's, unchanged.
    kit: 'rent-free', specHash: '0xa2b4e52b8acb3234639f2e08d9cd754a22e667cd1611bcc06b4ed0589faccc2d', logo: 11_014, cover: 27_862, open: true, models: true,
    today: { loads: 'Rent Free (RENT) · 500 items, open, 3D · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'Rent Free (RENT) · 500 items, open, 3D · raise 0.1 ETH', create: [] },
  },
  {
    kit: 'bag-holders', specHash: '0x9283859d9d3a8f6dbdb6bdfcc175c5338465d546782831ef0d2717f55e8939b7', logo: 42_913, cover: 90_391, open: true, models: true,
    today: { loads: 'Bag Holders (TOTE) · 420 items, open, 3D · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'Bag Holders (TOTE) · 420 items, open, 3D · raise 0.1 ETH', create: [] },
  },
  {
    kit: 'dragons-hoard', specHash: '0x4e3f56058bbfa731d023f8960d2a59177d0b498e3437863c11cfc46e5b5b6ed4', logo: 72_334,
    today: { loads: 'Dragon\'s Hoard (HOARD) · Coin pile · seed 1 ETH, 5% stays · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'Dragon\'s Hoard (HOARD) · Coin pile · seed 1 ETH, 5% stays · raise 0.1 ETH', create: [] },
  },
  {
    // A public template: its plan file, then the plan's twelve pictures and plan.csv, dealt here (no number is public).
    kit: 'frog-kiln', specHash: '0xab82f071aad3e5a99a9769d8179862a74d7266c0bfdd4a1f15c7dec3ad24ba7f', logo: 66_144, cover: 38_820, plan: true,
    today: { loads: 'Frog Kiln (KILN) · 420 items, hidden · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'Frog Kiln (KILN) · 420 items, hidden · raise 0.1 ETH', create: [] },
  },
  {
    kit: 'gpu-poor', specHash: '0x70dd18bcec1f9c2f524cdbed62ffb99d7f7ae82382e82ddbaa5c280f3c12d86f', logo: 20_684,
    today: { loads: 'GPU Poor (VRAM) · Token · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'GPU Poor (VRAM) · Token · raise 0.1 ETH', create: [] },
  },
  {
    kit: 'junkyard', specHash: '0xd9468afa67690ff3be56f701ef7ff50a7859a89346472412e4a501ed665b868d', logo: 58_870, starterIds: JUNKYARD_IDS,
    today: { refused: NO_CONTRACT },
    afterBatch: { refused: NO_CONTRACT },
    // The file's 0.3 ETH creator buy is the raise or more once the raise is 0.1 ETH: it must be quoted again.
    deployed: { loads: 'The Junkyard (TRASH) · Shop · 5 collections, 10 starters, curator you · raise 0.1 ETH', create: ['Below the raise: less than 0.1 ETH'] },
  },
  {
    kit: 'one-collection-shop', specHash: '0x4a3aaab758dcf479634fb08208b0e2ec155640ea650a9d6001ed9240febf12f8', logo: 28_794, starterIds: ['3-12'],
    today: { refused: NO_CONTRACT },
    afterBatch: { refused: NO_CONTRACT },
    deployed: { loads: 'One-collection shop (SHOP) · Shop · 1 collection, 10 starters, no curator · raise 0.1 ETH', create: [] },
  },
  {
    // SH-262: the card shop of the BNB Chain test network, four test card collections at tiers 0 to 3, ids 1 to 4 each.
    // Its creator buy is a tenth of chain 97's 0.001 BNB native raise, so it stays below every raise here.
    kit: 'card-shop', specHash: '0x5732a3fa95035814ada54f630cd6ce92265bdf1c089131480ad3ed6c5fe35030', logo: 21_404, starterIds: ['1, 2, 3, 4', '1, 2, 3, 4', '1, 2, 3, 4', '1, 2, 3, 4'],
    today: { refused: NO_CONTRACT },
    afterBatch: { refused: NO_CONTRACT },
    deployed: { loads: 'Card Shop (CARD) · Shop · 4 collections, 16 starters, no curator · raise 0.1 ETH', create: [] },
  },
  {
    // Unbound, its pile is one unit of the price coin (ETH here); bound to tUSDC it is 1 tUSDC (L1).
    kit: 'one-dollar', specHash: '0x2d897e8dfc0f9f1d4abf2fc6c3d635161cb2f278e296c695730e1378b65c26d9', logo: 27_760,
    today: { loads: 'One Dollar is all you need (1) · Coin pile · seed 1 ETH · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'One Dollar is all you need (1) · Coin pile · seed 1 ETH · raise 0.1 ETH', create: [] },
  },
  {
    // A public template too: the specimen-0 edition, its plan dealing 1,929 certificates from twelve pictures.
    kit: 'paper-certificates', specHash: '0x34dfc9933789cf42a44e0e92f74978efeb957b4adf1ef9ac2c482ea55799dd20', logo: 102_482, cover: 98_000, plan: true,
    today: { loads: 'Gold Certificates (SCRIP) · 1929 items, hidden · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'Gold Certificates (SCRIP) · 1929 items, hidden · raise 0.1 ETH', create: [] },
  },
  {
    // SH-LAKE-HOUSE: unbound, its pile follows the price coin (ETH here) and starts empty; bound to tUSDC it is an empty tUSDC pile.
    kit: 'lake-house', specHash: '0x8182505146cfc5058b26dc1ff825f3719f7516f80439a14116ac6c64ad9a8c63', logo: 51_671,
    today: { loads: 'Lake House (HOUSE) · Coin pile · seed 0 ETH · raise 4.206980085 ETH', create: [] },
    afterBatch: { loads: 'Lake House (HOUSE) · Coin pile · seed 0 ETH · raise 0.1 ETH', create: [] },
  },
  {
    // Its pile coin is the Test Gold binding slot (and its Alchemist row slot 0 resolves nothing).
    kit: 'the-alchemist', specHash: '0xf7eaa5d816f27197b9a507199266c0416c937f1489941c5058bcf2dba9dc7fb0', logo: 52_070,
    today: { refused: LOAD_WORDS.pileCoin },
    afterBatch: { refused: LOAD_WORDS.pileCoin },
  },
];

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (listings: readonly SiteListing[], token: string) => offeredListings(listings).find((l) => l.token.toLowerCase() === token.toLowerCase());

/** What loaded, in a line: the names, the contents and the raise the new box would keep. */
function summary(draft: LoadedDraft, listings: readonly SiteListing[]): string {
  const { form, v2, info } = draft;
  const price = listed(listings, v2.pricing);
  const pile = v2.pile ? listed(listings, v2.pile.asset) : undefined;
  const what = form.contents === 'collection' ? `${count(info.items, 'item')}, ${info.hidden ? 'hidden' : 'open'}${info.models ? ', 3D' : ''}`
    : v2.shop ? `Shop · ${count(v2.shop.collections.length, 'collection')}, ${starterItemsOf(v2.shop)?.length ?? 0} starters, ${v2.shop.curator === 'none' ? 'no curator' : 'curator you'}`
    : v2.pile ? `Coin pile · seed ${v2.pile.seed} ${pile?.symbol ?? '?'}${v2.pile.leaveBehindBps === 500 ? ', 5% stays' : ''}`
    : 'Token';
  return [`${form.name} (${form.ticker})`, what, `raise ${price ? amountText(price.raise, price) : 'unlisted'}`, ...(info.note ? [info.note] : [])].join(' · ');
}

/** Every line Create shows for the loaded draft before anything is signed: the page's checks, then the free tier's. */
function createLines(draft: LoadedDraft, listings: readonly SiteListing[], shopChecks: LoadOptions['shopChecks']): string[] {
  const form = { ...draft.form, rights: true };
  const starters = draft.v2.shop ? starterItemsOf(draft.v2.shop) ?? [] : [];
  const starterChecks = new Map(starters.map((item): [string, StarterCheck] => [starterKey(item), 'yours']));
  const input = { form, art: draft.art, commitment: commitArt(draft.art, form.artMode), cover: draft.cover, collectionCover: draft.collectionCover, page: draft.page, owner: OWNER, nowMs: NOW, v2: draft.v2, listings };
  const lines = v2Issues({ ...input, revealSaved: true, shopChecks, starterChecks }).map((issue) => issue.message);
  if (freePicturesRefused(buildSpecV2(input), draft, fitsFree(SEPOLIA, TURBO_FREE_BYTES))) lines.push(TOO_DETAILED);
  return lines;
}

// Open settings carry a reveal list, so never rely on an earlier run's ignored build output.
const builtSettings = new Map<string, string>();
function settingsOf(row: KitRow): string {
  if (!row.open) return readFileSync(fileOf(row.kit), 'utf8');
  const text = builtSettings.get(row.kit);
  if (text === undefined) throw new Error(`Kit ${row.kit} was not prepared in setup`);
  return text;
}
function openFiles(row: KitRow): File[] {
  // T02: the builder embeds the reviewed, distinct PNGs (and a 3D kit's GLBs); traits come independently from the
  // committed manifest (Rent Free's names its rows `entries`).
  const manifest = reviewedManifestForPlatform(row.kit, JSON.parse(readFileSync(join(KITS_DIR, row.kit, 'unique/manifest.json'), 'utf8'))) as {
    items?: ManifestRow[]; entries?: ManifestRow[];
  };
  const items = manifest.items ?? manifest.entries ?? [];
  const settings = JSON.parse(builtSettings.get(row.kit) as string) as { pictures: { sha256: string; base64: string }[]; models?: { sha256: string; base64: string }[] };
  const pictures = new Map(settings.pictures.map(p => [p.sha256, p.base64]));
  const models = new Map((settings.models ?? []).map(m => [m.sha256, m.base64]));
  const columns = Object.keys(items[0]?.traits ?? {});
  const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const traits = [['id', ...columns].join(','), ...items.map(item =>
    [item.id, ...columns.map(key => item.traits[key] as string)].map(cell).join(','))].join('\n') + '\n';
  const glbs = row.models ? items.map(item => {
    const bytes = models.get(`0x${item.model?.sha256 ?? ''}`);
    if (!bytes) throw new Error(`Missing reviewed model ${item.id}`);
    return new File([Buffer.from(bytes, 'base64')], `${item.id}.glb`, { type: 'model/gltf-binary' });
  }) : [];
  return [...items.map(item => {
    const bytes = pictures.get(`0x${item.picture.sha256}`);
    if (!bytes) throw new Error(`Missing reviewed picture ${item.id}`);
    return new File([Buffer.from(bytes, 'base64')], `${item.id}.png`, { type: 'image/png' });
  }), ...glbs, new File([traits], 'traits.csv', { type: 'text/csv' })];
}
interface ManifestRow { readonly id: string; readonly traits: Record<string, string>; readonly picture: { readonly sha256: string }; readonly model?: { readonly sha256: string } }

let salted = 0;
type LoadOptions = { readonly shopChecks?: ReadonlyMap<string, 'erc721' | 'not-erc721' | 'no-code' | 'unknown'> };

/** The page's own load of a committed file, step by step as LoadSettings runs it, on `listings` and `chain`. */
async function loadKit(row: KitRow, listings: readonly SiteListing[], chain: TokenReader): Promise<Outcome> {
  const bytes = new TextEncoder().encode(settingsOf(row));
  const file = await readSettingsFile(new TextDecoder().decode(bytes), digest);
  if (!file.ok) return { refused: file.error };
  let settings = file.value;
  if (row.plan) {
    // Picked together with its plan file, which binds the template's exact bytes, its plan and its marker.
    const manifest = readPlanManifest(readFileSync(join(KITS_DIR, row.kit, 'settings', `${row.kit}-plan.json`), 'utf8'));
    if (!manifest.ok) return { refused: manifest.error };
    const bound = bindPlanTemplate(settings, await digest(bytes), manifest.value);
    if (!bound.ok) return { refused: bound.error };
    settings = bound.value;
  }
  const setup = await setupOf(settings, listings, async () => null);
  if (!setup.ok) return { refused: setup.error };
  let loaded: LoadedSetup = setup.value;
  if (loaded.starters > 0) {
    const typed = withStarters(loaded, row.starterIds ?? [], listings);
    if (!typed.ok) return { refused: typed.error };
    loaded = typed.value;
  }
  // A shop's starting collections, asked on the chain before the setup is installed (LoadSettings `finish`).
  const shop = loaded.v2.shop;
  const shopChecks = shop ? await checkCollectionsV2(chain, shop.collections.map((r) => r.address as Address)) : undefined;
  // A template's items: its plan's pictures and plan.csv (the plan file's own), dealt as the page deals them.
  let art: ArtState | null = null;
  if (loaded.info.items > 0) {
    const files = row.plan ? planFiles(row.kit) : row.open ? openFiles(row) : [];
    const problem = await templatePlanProblem(loaded, files, digest);
    if (problem) return { refused: problem };
    art = await readArt(files, { env: { ...BROWSER_ART, digest, thumbnail: async () => null, randomWords: testRandomWords(row.kit), salt: () => ZERO32 } });
  }
  const done = finishLoad(loaded, art, listings, NATIVE_TOKEN, NOW, { salt: () => sha256Hex(new TextEncoder().encode(`${row.kit}-salt-${(salted += 1)}`)), shopChecks });
  if (!done.ok) return { refused: done.error };
  if (row.kit === 'link-marines-v2') {
    const draft = done.value;
    const spec = buildSpecV2({ form: draft.form, art: draft.art, commitment: commitArt(draft.art, 'open'), cover: draft.cover, collectionCover: draft.collectionCover, page: draft.page, owner: OWNER, nowMs: NOW, v2: draft.v2, listings });
    for (const side of [spec.buyers, spec.sellers]) expect([side.a.leg, side.a.dest, BigInt(side.a.destParams)]).toEqual([1, 8, 3n]);
  }
  return { loads: summary(done.value, listings), create: createLines(done.value, listings, shopChecks) };
}

// The original ARM spec pin remains in KITS. A Node-only fixture reader derives the Intel commitment
// from the immutable Solidity fixture and the same 35-model exception used by the manifest checker.
const platformSpecHashes = new Map<string, string>();
function expectedSpecHash(row: KitRow): string {
  if (row.kit !== 'bag-holders') return row.specHash;
  let hash = platformSpecHashes.get(row.kit);
  if (hash === undefined) {
    hash = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { platformFixtureSpecHash } from "./scripts/test/fixtures/reveal-platform-expectation.mjs"; process.stdout.write(platformFixtureSpecHash(${JSON.stringify(row.kit)}, ${JSON.stringify(row.specHash)}));`],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    platformSpecHashes.set(row.kit, hash);
  }
  return hash;
}

describe('SH-EX-O1: the committed example settings files on the Sepolia test site', () => {
  it('every committed settings file has its row', () => {
    const committed = readdirSync(KITS_DIR).filter((kit) => existsSync(join(KITS_DIR, kit, 'settings')))
      .flatMap((kit) => readdirSync(join(KITS_DIR, kit, 'settings')).filter((name) => name.endsWith('-boxspec-v2.json')).map((name) => `${kit}/${name}`));
    expect(committed.sort()).toEqual(KITS.filter((row) => !row.open).map((row) => `${row.kit}/${row.kit}-boxspec-v2.json`).sort());
  });

  for (const row of KITS) {
    describe(row.kit, () => {
      // A cold build may wait on another process's kit lock. Keep that work out of every
      // assertion, including when Vitest selects only a later test in this suite.
      beforeAll(() => {
        if (row.open) builtSettings.set(row.kit, execFileSync(process.execPath, ['--input-type=module', '-e',
          'import { buildKit, settingsText } from "./scripts/kits/settings.mjs"; process.stdout.write(settingsText(await buildKit(process.argv[1])));', row.kit],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
      }, shLimit(600_000));
      it('the settings file: its spec hash and the bytes of its logo and cover', async () => {
        const text = settingsOf(row);
        const file = await readSettingsFile(text, digest);
        if (!file.ok) throw new Error(file.error);
        expect((JSON.parse(text) as { specHash: string }).specHash, 'the kit tooling wrote the file again: update its row').toBe(expectedSpecHash(row));
        const size = (role: string) => file.value.pictures.find((picture) => picture.role === role)?.bytes.byteLength;
        expect({ logo: size('logo'), cover: size('collection cover') }).toEqual({ logo: row.logo, cover: row.cover });
      }, shLimit(row.open ? 120_000 : 5_000));
      it('on the test site today', async () => {
        expect(await loadKit(row, SETS.today, chainOf(false))).toEqual(row.today);
      });
      it('after the founder’s listing batch', async () => {
        expect(await loadKit(row, SETS.afterBatch, chainOf(false))).toEqual(row.afterBatch);
      });
      if (row.deployed) {
        const deployed = row.deployed;
        it('once its collections answer as ERC-721s', async () => {
          expect(await loadKit(row, SETS.afterBatch, chainOf(true))).toEqual(deployed);
        });
      }
    });
  }
});
