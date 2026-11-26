#!/usr/bin/env node
/** Offline kit -> the Create page's own Download BoxSpec bytes, using Node 24's built-in transformer. */
import { createBuildCache, digest, kitInputKey, writeCacheAsset } from './cache.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// cache.mjs takes the source/dependency baseline before any of these modules execute.
const { ITEMS_INSIDE_POLICIES, PROFILES, loadProfileExamples } = await import('../../packages/box-spec/examples/v2/registry.mjs');
const { specV2, artwork, model, checks, artFiles, itemFiles, modelV2, picturesV2, recipes, listingsV2, artPlan } = await import('./app.mjs');
const { encodePicture, encodeFree, FREE_FIT } = await import('./pictures.mjs');
const { KIT_IDS, KIT_TEXTS, BINDING_SLOTS, JUNKYARD_SEPOLIA_COLLECTIONS, SHOP_STOCK_COLLECTIONS, SEPOLIA_STAND_INS } = await import('./catalog.mjs');
const { UNIQUE_KITS, buildUniqueSet } = await import('./unique.mjs');

export { KIT_IDS };
const { validateBoxSpecV2 } = specV2;
const { canonicalJson, sha256Hex, boxLeaf, buildBoxTree } = artwork;
const { DEFAULT_FORM, commitArt, revealList, traitTable } = model;
const { PROBE_OWNER } = checks;
const { readArt, readPicture, MODEL_TYPE } = artFiles;
const { keepItemFiles, forgetItemFiles } = itemFiles;
const { boxSpecFile, buildSpecV2, DEFAULT_V2 } = modelV2;
const { committedPictures, committedModels } = picturesV2;
const { pickFor, alchemistPick } = recipes;
const { RAISE_ETH } = listingsV2;
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const { encodeAbiParameters, formatUnits, isAddress, keccak256, zeroAddress, zeroHash } = createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');
const json = value => `${JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
// Conversion is only for bounded enum/count fields required as JS numbers by the app; never for raw amounts.
const count = value => { assert.match(String(value), /^(0|[1-9][0-9]*)$/); assert.ok(BigInt(value) <= 0xffffffffn); return Number(value); };
const address = value => { assert.ok(typeof value === 'string' && isAddress(value) && value !== zeroAddress, 'nonzero public binding required'); return value; };
const raw = (value, allowZero = false) => {
  assert.ok(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'raw decimal string required');
  const n = BigInt(value);
  assert.ok(n <= (1n << 256n) - 1n && (allowZero || n > 0n), 'raw amount out of range');
  return n;
};
const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;

/** The exact ordered starter-set hash used by IStarterSetLoaderV2, without importing an RPC program. */
export function starterEntries(items) {
  let nextHash = zeroHash;
  return items.toReversed().map(item => {
    const hash = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }], [item.collection, BigInt(item.id), item.tier, nextHash]));
    const entry = { ...item, hash, nextHash }; nextHash = hash; return entry;
  }).reverse();
}

function checkedBindings(bindings) {
  assert.ok(bindings && typeof bindings === 'object' && !Array.isArray(bindings), 'bindings object required');
  assert.ok(Object.keys(bindings).every(k => ['owner', 'assets', 'collections', 'alchemistRow', 'priceListing', 'nativeRaise', 'creatorBuy'].includes(k)), 'unknown binding');
  if (bindings.owner !== undefined) address(bindings.owner);
  for (const [group, keys] of [['assets', [...new Set(Object.values(SEPOLIA_STAND_INS).map(c => c.key))]], ['collections', SHOP_STOCK_COLLECTIONS.map(c => c.id)]]) {
    if (bindings[group] === undefined) continue;
    assert.ok(bindings[group] && typeof bindings[group] === 'object' && !Array.isArray(bindings[group]), 'binding map required');
    for (const [key, value] of Object.entries(bindings[group])) { assert.ok(keys.includes(key), 'unknown binding'); address(value); }
  }
  if (bindings.alchemistRow !== undefined) assert.equal(typeof bindings.alchemistRow, 'string', 'row id must be a decimal string');
  if (bindings.alchemistRow !== undefined) count(bindings.alchemistRow);
  if (bindings.nativeRaise !== undefined) raw(bindings.nativeRaise);
  if (bindings.creatorBuy !== undefined) raw(bindings.creatorBuy, true);
  if (bindings.priceListing !== undefined) {
    const p = bindings.priceListing;
    assert.ok(p && typeof p === 'object' && !Array.isArray(p), 'priceListing object required');
    assert.deepEqual(Object.keys(p).sort(), ['id', 'raise', 'token'], 'priceListing keys');
    assert.equal(typeof p.id, 'string', 'listing id must be a decimal string');
    count(p.id); raw(p.raise);
    if (p.id === '0') assert.equal(p.token, zeroAddress, 'native listing requires native token');
    else address(p.token);
  }
  return bindings;
}

// Serialize the whole build, including consumers using Promise.all: the app's item-file store is global.
let builds = Promise.resolve();
const cachedBuild = createBuildCache(resolve(ROOT, '.cache/kits'));
/** `options.profile`: the test network the settings are for, `sepolia` (the default) or `bnb` (chain 97). */
export function buildKit(id, supplied = {}, options = {}) {
  const profile = options.profile ?? 'sepolia';
  const next = builds.then(async () => {
    assert.ok(KIT_IDS.includes(id), 'choose a supported kit');
    assert.ok(Object.hasOwn(PROFILES, profile), 'choose a supported profile');
    assert.ok(Object.hasOwn(KIT_TEXTS[profile], id), `kit ${id} is not built for profile ${profile}`);
    checkedBindings(supplied);
    const disabled = options.disabled ?? process.env.SH_KIT_CACHE === '0';
    const inputs = options.fresh || disabled ? null : kitInputKey();
    // The Sepolia key is as before; another profile's adds its name.
    const key = inputs === null ? null : digest(`${inputs}:${id}:${JSON.stringify(supplied)}${profile === 'sepolia' ? '' : `:${profile}`}`);
    const kit = await cachedBuild(key, () => buildKitSerial(id, supplied, profile), {
      ...options, disabled: disabled || inputs === null, isCurrent: () => inputs !== null && kitInputKey() === inputs,
    });
    // Generated source paths must survive removal of a producer's temporary build directory.
    if (key !== null && kit.items.length) {
      const assets = resolve(ROOT, '.cache/kits/assets', key);
      mkdirSync(assets, { recursive: true });
      for (const item of kit.items) {
        if (Object.hasOwn(UNIQUE_KITS, id)) {
          item.source = resolve(assets, `${item.id}.png`);
          writeCacheAsset(item.source, item.bytes);
          if (item.model) {
            item.model.source = resolve(assets, `${item.id}.glb`);
            writeCacheAsset(item.model.source, item.model.bytes);
          }
        }
      }
    }
    return kit;
  });
  builds = next.catch(() => {});
  return next;
}

/**
 * Public test template. Supplied bindings are syntax-checked, never asserted deployed or route-compatible. A 3D kit
 * (Rent Free, Bag Holders: modelPolicy '3d') commits its reviewed GLBs exactly as Create does: the numbered models go
 * through Create's own reader beside the numbered pictures, and Create's commitment, reveal list and BoxSpec file carry
 * them (SH-CREATE-ITEM-MODELS). Link Marines v2 and Exit Liquidity stay 2D: their review GLBs never enter the art.
 */
async function buildKitSerial(id, supplied, profile = 'sepolia') {
  assert.ok(KIT_IDS.includes(id), 'choose a supported kit');
  const modelPolicy = Object.hasOwn(UNIQUE_KITS, id) ? UNIQUE_KITS[id].modelPolicy : '2d';
  const bindings = checkedBindings(supplied);
  const row = loadProfileExamples(profile).find(example => example.id === id);
  assert.ok(row, 'registry row required');
  const hidden = row.contents.art.mode === 'hidden';
  const base = resolve(ROOT, 'examples/boxes', id);
  const unresolved = [];
  const bind = (group, key) => {
    if (bindings[group]?.[key]) return bindings[group][key];
    unresolved.push({ field: `${group}.${key}`, placeholder: BINDING_SLOTS[key] });
    return BINDING_SLOTS[key];
  };
  const collection = row.contents.kind === 'collection';
  const isShop = row.contents.kind === 'shop';
  const owner = bindings.owner ?? PROBE_OWNER;
  if ((collection || isShop) && !bindings.owner) unresolved.push({ field: 'owner', placeholder: PROBE_OWNER, resolve: isShop ? 'connected creator Safe' : 'connected creator wallet' });
  const native = profile === 'bnb'
    // Chain 97's native listing (id 0): its raise is the bound `nativeRaise` (lowered to 0.001 BNB there), never Sepolia's.
    ? { id: 0, token: zeroAddress, decimals: 18, class: 1, kind: 1, raise: bindings.nativeRaise === undefined ? RAISE_ETH : raw(bindings.nativeRaise), symbol: 'BNB', name: 'BNB Chain test BNB', powers: [], eat: 'allowed' }
    : { id: 0, token: zeroAddress, decimals: 18, class: 1, kind: 1, raise: RAISE_ETH, symbol: 'ETH', name: 'Sepolia test Ether', powers: [], eat: 'allowed' };
  const standIn = row.priceCoin.symbol === 'ETH' ? null : SEPOLIA_STAND_INS[row.priceCoin.symbol];
  assert.ok(row.priceCoin.symbol === 'ETH' || standIn, 'price coin needs a Sepolia stand-in');
  const selected = bindings.priceListing;
  if (selected) {
    assert.equal(selected.id === '0', !standIn, 'listing must match the kit price coin kind');
    if (standIn && bindings.assets?.[standIn.key]) assert.equal(selected.token.toLowerCase(), bindings.assets[standIn.key].toLowerCase(), 'price asset and listing disagree');
  } else if (standIn) unresolved.push({ field: 'priceCoin', placeholder: 'ETH listing 0', resolve: `${standIn.key} listing (registry ${row.priceCoin.symbol}); supply priceListing with id, token and raise` });
  const pricing = selected ? { ...native, ...(standIn ?? {}),
    id: count(selected.id), token: selected.token, raise: raw(selected.raise) } : native;
  const listings = [pricing];
  const env = { digest: async bytes => sha256Hex(bytes), thumbnail: async () => null, encodeCover: encodePicture, encodeFree, salt: () => zeroHash };
  const picture = async (file, kind) => {
    const result = await readPicture(new File([readFileSync(resolve(base, file))], file, { type: 'image/png' }), env, kind, FREE_FIT);
    assert.ok(!('error' in result), result.error);
    return result.picture;
  };
  const cover = await picture('art/logo.png', 'logo');
  const collectionCover = collection ? await picture('art/cover.png', 'collection') : null;
  const page = collection ? { banner: await picture('art/box-banner.png', 'banner'), teasers: [] } : { banner: null, teasers: [] };
  if (collection) for (const scene of ['01', '02', '03', '04']) page.teasers.push(await picture(`art/scenes/scene-${scene}.png`, 'teaser'));

  let items = []; let traitsCsv = 'id\n'; let art = null; let plan = null; let hiddenCommitment = null;
  // Nothing is left for Create to integrate: the 3D kits use its own model reader (kept for the inventory's shape).
  const integrationRequirements = [];
  // The app's item file store is global; finish each kit serially and clear it in finally.
  forgetItemFiles();
  try {
    if (hidden) {
      // Public template only: read the plan, never the hidden item bytes, assignments or salts.
      const csv = readFileSync(resolve(base, 'plan.csv'), 'utf8');
      const parsed = artPlan.parsePlan(csv);
      assert.deepEqual(parsed.issues, [], 'valid hidden plan required');
      assert.equal(BigInt(parsed.total), BigInt(row.contents.size), 'plan count');
      const { traitTypes } = traitTable(parsed.rows, 'sorted');
      // A domain-separated public marker, NOT an edition root. Create must deal the plan privately and replace it.
      const marker = sha256Hex(Buffer.from(`squarehole.hidden-kit-template/1:${id}:${sha256Hex(Buffer.from(csv))}`));
      hiddenCommitment = { n: parsed.total, traitTypes, packed: [], revealRoot: marker, revealListId: zeroHash };
      plan = { path: `examples/boxes/${id}/plan.csv`, sha256: sha256Hex(Buffer.from(csv)), count: String(parsed.total),
        specimen: id === 'paper-certificates' ? '0' : null, templateRoot: marker };
    } else if (collection) {
      if (Object.hasOwn(UNIQUE_KITS, id)) {
        const unique = await buildUniqueSet(id);
        assert.equal(BigInt(unique.count), BigInt(row.contents.size), 'unique registry count');
        items = unique.items.map(item => ({
          id: item.id, traits: item.traits, source: item.picture.path, sha256: item.picture.sha256,
          bytes: readFileSync(item.picture.path),
          model: item.model ? { source: item.model.path, sha256: item.model.sha256, bytes: readFileSync(item.model.path) } : null,
        }));
        traitsCsv = `${[['id', ...unique.columns].join(','), ...items.map(item =>
          [item.id, ...unique.columns.map(column => item.traits[column])].map(csvCell).join(','))].join('\n')}\n`;
      } else {
        // Archival Link Marines v1 only. Never relax this public assignment path allowlist.
        const assignment = JSON.parse(readFileSync(resolve(base, 'assignment.json'), 'utf8'));
        const assigned = assignment.items ?? assignment.assignments;
        assert.equal(BigInt(assignment.count), BigInt(row.contents.size), 'assignment count');
        assert.equal(BigInt(assigned.length), BigInt(row.contents.size), 'assignment length');
        assert.equal(id, 'link-marines', 'open kit requires a unique producer');
        const columns = ['Variant', 'Squad'];
        const lines = [['id', ...columns].join(',')];
        items = assigned.map((item, i) => {
          const itemId = item.id ?? item.tokenId;
          assert.equal(itemId, String(i + 1), 'assignment must be ordered 1..N');
          assert.match(item.image, /^art\/(items|houses)\/variant-[0-9]{2}\.png$/, 'local public item picture');
          const source = resolve(base, item.image);
          const bytes = readFileSync(source);
          lines.push([itemId, ...columns.map(column => item[column.toLowerCase()])].map(csvCell).join(','));
          return { id: itemId, source, sha256: sha256Hex(bytes), bytes };
        });
        traitsCsv = `${lines.join('\n')}\n`;
      }
      // Create's own reader, as Load settings reads the bundle's items/ folder: <id>.png, a 3D kit's <id>.glb beside it, traits.csv.
      assert.ok(items.every(item => Boolean(item.model) === (modelPolicy === '3d')), 'model policy requires exactly the approved models');
      const itemFiles = new Map();
      art = await readArt([
        ...items.map(item => new File([item.bytes], `${item.id}.png`, { type: 'image/png' })),
        ...items.filter(item => item.model).map(item => new File([item.model.bytes], `${item.id}.glb`, { type: MODEL_TYPE })),
        new File([traitsCsv], 'traits.csv'),
      ], { env, onItemFile: (sha, file) => itemFiles.set(sha, file) });
      keepItemFiles(itemFiles);
      assert.deepEqual(art.problems, [], 'Create must accept the numbered pictures, models and traits');
      for (const [index, item] of items.entries()) {
        assert.equal(art.items[index].imageSha256, item.sha256, 'reader must retain exact reviewed PNG bytes');
        assert.equal(art.items[index].modelSha256 ?? null, item.model?.sha256 ?? null, 'reader must retain exact reviewed GLB bytes');
      }
      // Public assignments ONLY: deterministic public salts provide no concealment and are never used for hidden art.
      art = { ...art, salts: items.map(item => sha256Hex(Buffer.from(`squarehole.open-kit/1:${id}:${item.id}:${item.sha256}`))) };
    }
    // Create's commitment and canonical list: each leaf and list entry carries its item's model hash (zero for 2D).
    const commitment = hiddenCommitment ?? commitArt(art, 'open');
    const list = art ? revealList(art, commitment.packed) : null;
    let pile = null;
    if (row.contents.kind === 'pile') {
      const seed = row.contents.seed;
      const standIn = seed.symbol === 'ETH' ? null : SEPOLIA_STAND_INS[seed.symbol];
      assert.ok(seed.symbol === 'ETH' || standIn, 'pile coin needs a Sepolia stand-in');
      // The pile follows the price coin for One Dollar (one whole unit of it) and for Lake House, whose fees go to the
      // pile on both sides and so need the pile in the price coin (an empty pile: its seed is 0 in any decimals).
      const follows = id === 'one-dollar' || id === 'lake-house';
      const asset = follows ? pricing.token : standIn ? bind('assets', standIn.key) : zeroAddress;
      const decimals = follows ? pricing.decimals : standIn ? standIn.decimals : 18;
      if (!listings.some(l => l.token.toLowerCase() === asset.toLowerCase())) listings.push({ ...native, id: pricing.id === 1 ? 2 : 1, token: asset, class: standIn?.class ?? 1, decimals, symbol: standIn?.symbol ?? 'ETH', name: standIn?.name ?? native.name });
      pile = { asset, seed: id === 'one-dollar' ? '1' : formatUnits(BigInt(seed.amount), decimals), leaveBehindBps: count(row.contents.leaveBehindBps ?? '0') };
    }
    let shop = null; let starter = [];
    if (isShop) {
      // Sepolia stock is TA-40's Test Junk: the Junkyard's local scrap keys map to all five collections; any other shop
      // row names TA-40 keys itself (the one-collection shop's bent-cans, ids 3 to 12) and keeps its own ids. The card
      // shop (SH-262) names its four test card collections, one per rarity tier.
      const stock = id === 'junkyard' ? JUNKYARD_SEPOLIA_COLLECTIONS : row.contents.shop.collections;
      assert.ok(stock.every(c => SHOP_STOCK_COLLECTIONS.some(known => known.id === c.id)), 'shop stock must be TA-40 test collections or the test cards');
      const config = { ...row.contents.shop, collections: stock };
      const collections = config.collections.map(c => ({ address: bind('collections', c.id), tier: count(c.tier) }));
      assert.equal(new Set(collections.map(c => c.address.toLowerCase())).size, collections.length, 'distinct starter collections required');
      shop = { seed: formatUnits(BigInt(config.seedT), 18), prices: config.givePricesT.map(p => formatUnits(BigInt(p), 18)),
        pickBps: count(config.pickBps), weeklyBps: count(config.weeklyBps), collectionBps: count(config.collectionBps),
        listDelayDays: count(config.listDelay) / 86400, curator: config.curator, curatorAddress: '', collections };
      starter = starterEntries(config.collections.flatMap((c, i) => c.starterIds.map(itemId => ({ collection: collections[i].address, id: itemId, tier: count(c.tier) }))));
    }
    const choose = fee => {
      if (fee.choice !== 'alchemist') return pickFor(fee.choice, ITEMS_INSIDE_POLICIES[fee.inside], count(fee.ceilingPreset ?? '2'));
      if (bindings.alchemistRow === undefined) unresolved.push({ field: 'alchemistRow', placeholder: '0', resolve: 'mature compatible Alchemist row; 0 is an unset slot, not a selected directory row' });
      return alchemistPick(count(bindings.alchemistRow ?? '0'));
    };
    let creatorBuy = BigInt(row.creator?.buyEthEquivalent ?? '0');
    if (bindings.creatorBuy !== undefined) {
      assert.ok(row.creator || bindings.creatorBuy === '0', 'creatorBuy binding only applies to a shop');
      creatorBuy = raw(bindings.creatorBuy, true);
    } else if (creatorBuy && pricing.token !== zeroAddress) {
      if (bindings.nativeRaise === undefined) unresolved.push({ field: 'nativeRaise', placeholder: RAISE_ETH.toString(), resolve: 'verified native listing raise for the creator buy conversion, or a freshly quoted creatorBuy' });
      const nativeRaise = raw(bindings.nativeRaise ?? RAISE_ETH.toString());
      creatorBuy = (creatorBuy * pricing.raise + nativeRaise - 1n) / nativeRaise;
    }
    assert.ok(creatorBuy < pricing.raise, 'creator buy must be below the raise; supply a freshly quoted creatorBuy');
    const input = {
      form: { ...DEFAULT_FORM, name: row.name, ticker: row.ticker, description: KIT_TEXTS[profile][id], contents: collection ? 'collection' : 'token', artMode: hidden ? 'hidden' : 'open',
        hiddenSvg: hidden ? readFileSync(resolve(base, 'art/hidden.svg'), 'utf8').replace(/[\r\n]/g, '') : DEFAULT_FORM.hiddenSvg,
        royaltyBps: count(row.royalties.bps), deadlineDays: count(row.deadline.days), firstIn: formatUnits(creatorBuy, pricing.decimals), rights: false },
      art, commitment, cover, collectionCover, page, owner, nowMs: 0,
      v2: { ...DEFAULT_V2, pricing: pricing.token, buyers: choose(row.fees.buyers), sellers: choose(row.fees.sellers), pickFeeBps: count(row.contents.pickFeeBps), deadlineDays: count(row.deadline.days), pile, shop }, listings,
    };
    let spec = buildSpecV2(input);
    if (isShop) spec = { ...spec, addOns: spec.addOns.map(addon => addon.id === 8 ? { id: 8, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [starter[0].hash, starter.length]) } : addon) };
    const verdict = validateBoxSpecV2(spec, { listing: pricing });
    assert.equal(verdict.reason, 0, `invalid spec field ${verdict.field}`);
    const committed = await committedPictures(spec, { cover, collectionCover, page, art }, env.digest);
    assert.deepEqual(committed.missing, []);
    // The BoxSpec file's models, as Create's download collects them (none for every 2D kit).
    const models = await committedModels(spec, { art });
    assert.deepEqual(models.missing, []);
    assert.equal(models.models.length, modelPolicy === '3d' ? new Set(items.map(item => item.model.sha256)).size : 0, 'model policy');
    const tree = list ? buildBoxTree(list.items.map(item => boxLeaf({ ...item, id: count(item.id), traitsPacked: BigInt(item.traitsPacked) }, items.length)), items.length) : null;
    const proofs = list ? { format: 'squarehole.kit-proofs/1', root: tree.root, items: list.items.map(item => ({ ...item, proof: tree.proof(count(item.id)) })) } : null;
    assert.ok(!list || sha256Hex(Buffer.from(canonicalJson(list))) === spec.revealListId);
    return { id, profile, row, spec, context: { pricing, listings }, input, art, items, traitsCsv, pictures: committed.pictures, models: models.models, revealList: list, proofs, starter, unresolved, plan, modelPolicy, integrationRequirements };
  } finally { forgetItemFiles(); }
}

export function settingsText(kit) {
  return boxSpecFile(kit.spec, kit.context, { pictures: kit.pictures, models: kit.models, revealList: kit.revealList }).parts.join('');
}
/**
 * Where the download goes. A reveal-free one (including a public hidden-plan template) is the committed `settings/` file. An open collection's
 * carries its public reveal list (every item's traits, image hash and salt), so it goes only to the ignored `build/`,
 * beside the bundle that holds the same bytes.
 */
export function settingsPath(kit) {
  // Another profile's settings go one folder down, named for it (BNB Chain testnet: `settings/bnb/`).
  const folder = `${kit.revealList ? 'build' : 'settings'}${kit.profile && kit.profile !== 'sepolia' ? `/${kit.profile}` : ''}`;
  return `examples/boxes/${kit.id}/${folder}/${kit.id}-boxspec-v2.json`;
}
/** Same Create serialization wherever it lands; `root` is the repository (a test passes a scratch copy). */
export function writeSettings(kit, root = ROOT) {
  const path = resolve(root, settingsPath(kit));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, settingsText(kit));
  if (kit.plan) writeFileSync(resolve(dirname(path), `${kit.id}-plan.json`), json(planManifest(kit)));
  return settingsPath(kit);
}
export function planManifest(kit) {
  assert.ok(kit.plan, 'hidden plan required');
  return { format: 'squarehole.hidden-kit-plan/1', settingsSha256: sha256Hex(Buffer.from(settingsText(kit))), plan: kit.plan,
    instructions: 'Public template only. Supply the plan and its twelve private variant pictures to Create; deal new numbers and salts and replace the template root. Keep the reveal file and hidden item pictures private.' };
}
export function cliArgs(given) {
  // `--profile bnb` (at the end) builds a kit's BNB Chain testnet settings; without it, Sepolia's as before.
  const at = given.indexOf('--profile');
  const profile = at === -1 ? 'sepolia' : given[at + 1];
  assert.ok(at === -1 || at === given.length - 2, 'usage: ID [--bindings PUBLIC_JSON] [--profile sepolia|bnb]');
  assert.ok(Object.hasOwn(PROFILES, profile), 'choose a supported profile');
  const args = at === -1 ? given : given.slice(0, at);
  assert.ok(args.length === 1 || (args.length === 3 && args[1] === '--bindings'), 'usage: ID [--bindings PUBLIC_JSON] [--profile sepolia|bnb]');
  assert.ok(args[0] === 'all' || KIT_IDS.includes(args[0]), 'choose a supported kit');
  const ids = args[0] === 'all' ? KIT_IDS.filter(id => Object.hasOwn(KIT_TEXTS[profile], id)) : [args[0]];
  // A Sepolia call answers as it always has (no profile field).
  return { ids, bindings: args.length === 3 ? checkedBindings(JSON.parse(readFileSync(args[2], 'utf8'))) : {}, ...(at === -1 ? {} : { profile }) };
}
export { json };
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  try {
    const { ids, bindings, profile } = cliArgs(process.argv.slice(2));
    for (const id of ids) { const kit = await buildKit(id, bindings, { profile }); process.stdout.write(`${writeSettings(kit)} (${kit.unresolved.length} unresolved bindings; see scripts/kits/README.md)\n`); }
  } catch (error) {
    console.error(error?.code === 'ERR_CWEBP_REQUIRED'
      ? 'kit settings refused: cwebp is required for the offline free-picture encoder.'
      : `kit settings refused: ${error.message}`);
    process.exitCode = 1;
  }
}
