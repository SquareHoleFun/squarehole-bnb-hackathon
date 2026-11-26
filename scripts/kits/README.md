# Example settings and public pictures

Run from the repository root with Node 24.22.1, the installed workspace dependencies and `cwebp` 1.6.0
(libwebp's command-line encoder). No network install is performed. These commands read local public inputs;
they do not open a listener, access a key, sign, transact or upload.

```sh
node scripts/kits/settings.mjs gpu-poor
node scripts/kits/settings.mjs gpu-poor --bindings .cache/gpu-poor-bindings.json
node scripts/kits/bundle.mjs link-marines-v2
node scripts/kits/bundle.mjs all
node --test --test-concurrency=1 scripts/test/kits-settings.test.mjs scripts/test/kits-bundle.test.mjs scripts/test/kits-unique.test.mjs
```

Both commands accept one kit ID or `all`. A binding file selects **one kit's** price listing; use a separate
invocation per kit when binding different listings. Builds run serially, including concurrent API calls,
because Create's item-file store is global.
Final Sepolia regeneration waits for the test coins, listing Safe batch (including the native raise update)
and outside collections: plan §2 steps 1, 4 and 5. The Alchemist also needs its mature compatible directory row.

The six token/pile/shop downloads and the two public hidden-plan templates live in
`examples/boxes/<id>/settings/<id>-boxspec-v2.json`. The open collections (Bag Holders, Exit Liquidity, Link Marines
and Rent Free) carry public reveal lists and write to ignored `build/<id>-boxspec-v2.json`. Bundle writes the same
settings into `build/` for every kit. Move a previous build into ignored scratch before rebuilding changed bytes;
the bundle writer retains partial results and refuses to replace different files.

Settings use the actual Create `buildSpecV2`, `boxSpecFile`, picture and model collectors and readers: format,
spec hash, ABI encoded spec, decimal strings, base64 pictures and the 3D kits' `models` list use the page's
representation, and Create's Load settings loads them back (SH-CREATE-ITEM-MODELS).
`openAt: 0` means next-block opening on chain; confirm the opening choice in Create. The committed files are
unbound templates, not verified deployments. Non-native kits explicitly report `priceCoin` as unresolved until
a listing is supplied. ETH templates retain the base release's recorded native raise, not the planned update.

## Binding the setup

`--bindings PUBLIC_JSON` accepts these optional public fields; unknown keys and malformed values are refused:

| Field | Meaning |
| --- | --- |
| `owner` | Connected creator address; use the creator Safe for shops |
| `priceListing` | `{ "id": "9", "token": "0x…", "raise": "1000000000000000000" }`; replace the illustrative values with verified ones |
| `assets` | Test-coin addresses keyed by `TEST_USDC`, `TEST_GOLD`, `TEST_NVDA`, `TEST_LINK`, `TEST_FROG`, `TEST_PEPE`; the Alchemist needs `TEST_GOLD` for its separate pile |
| `collections` | Addresses keyed by `bent-cans`, `lost-cogs`, `split-boots`, `cracked-mugs`, `tangled-wires` |
| `alchemistRow` | Decimal-string ID of a mature compatible Alchemist directory row |
| `nativeRaise` | Verified native listing raise, a positive raw decimal string, for creator-buy conversion |
| `creatorBuy` | Freshly quoted raw price-coin amount, a decimal string (zero allowed), for a shop; overrides the original recipe's equivalent buy |

Listing IDs are uint32 decimal strings; raises and creator buys are bigint in logic and raw decimal strings in
JSON. ETH uses listing `"0"` and the zero token address; other kits require a nonzero listing ID and token.
Decimals come from the intended stand-in, never a guessed balance: USDC → tUSDC (6), NVDAon → tNVDA (18),
LINK → tLINK (18), PAXG/TEST_GOLD → tGOLD (18), TEST_FROG → tFROG (18), TEST_PEPE → tPEPE (18).
An asset binding for the price coin, when also supplied, must match the listing token. Supplying an address alone
does not resolve a listing. These are syntax checks, not RPC verification of a deployment or a burn capability.
The integrator verifies tFROG's `addWithBurn` listing and all addresses, raises, decimals and readiness.

Absent `creatorBuy`, a shop converts its original ETH-equivalent buy with
`ceil(buyEthEquivalent * priceRaise / nativeRaise)`, entirely in bigint. Missing `nativeRaise` remains unresolved.
Every creator buy must be below its selected raise. Junkyard's original 0.3-ETH-equivalent buy exceeds the planned
0.1-ETH native raise, so the founder must re-quote it and supply `creatorBuy`; the tool does not invent a quote.
Zero unresolved bindings means only that all required public values were supplied, not that launch checks passed.

One Dollar's pile is always in the price coin and holds exactly one whole unit in that listing's decimals.
Thus the unbound ETH template uses one ETH, and binding tUSDC produces 1,000,000 raw tUSDC. Load settings sees
`pileFollowsPrice` and keeps the relationship when the creator changes price. Dragon's Hoard keeps its ETH pile
and 5% leave-behind; The Alchemist keeps its separate tGOLD pile, zero seed and 5% leave-behind. Locked descriptions
are coin-neutral, so changing an editable price selection does not leave an incorrect immutable description.

Junkyard uses five Test Junk collections, ids 1 and 2 each, replacing the registry's local scrap keys. The
one-collection shop uses Bent Cans ids 3–12 and No curator. Both retain their seeds, give prices and weekly limits.
Load settings exists: enter these starter IDs when asked; the loader checks them against the committed ordered
set and checks each collection on chain. The public bundle includes `starter-set.json` with the ordered hashes.
`examples/boxes/junkyard/test-collections/settings.mjs` accepts its existing verified-binding envelope (plus optional
`creatorBuy`) and delegates to this same builder. It produces byte-identical BoxSpec contents, with the ticker
filename `trash-boxspec-v2.json`, starter provenance and a logo manifest whose extension matches its bytes.
Its `buildSettings` API is now asynchronous.

## Link Marines

For the Sepolia Link Marines example, build `link-marines-v2`: 420 open marines with MARINE as ticker.
Both fee sides pay rations in the selected price coin (tLINK on Sepolia), with inside shares going to the
box's own pool (Items/Depth). Its 420 distinct portraits retain each id's original rank and squad,
and include all nine traits. Models generated for review are excluded from publication.
The prior contract/browser evidence (SH-EX-LMV2) predates these new art commitments.
`link-marines` remains buildable as the archival version 1 Eat kit.

## Unique producer interface and models

`unique.mjs` owns the common interface. `await buildUniqueSet(id)` imports the kit's existing `unique/build.mjs`,
runs its fixed seed with Node 24.22.1 and resvg 2.6.2 into a fresh `.cache/tmp/kits-unique-*` directory, and returns:

```js
{
  count, seed, columns, modelPolicy, directory,
  items: [{ id, traits, picture: { path, sha256, bytes }, model: null /* or { path, sha256, bytes } */ }]
}
```

`count` and `id` are decimal strings; `bytes` is a file byte count. Items must already be ordered 1..N.
`traits` contains every column in the order below. `sha256` is lower-case `0x` hex, converted once at the
producer boundary. `path` is an input file path and never enters a public commitment or inventory.

| Kit | Count | Model policy | Complete CSV columns after `id` |
| --- | ---: | --- | --- |
| rent-free | 500 | 3d | house, door, window, post, plant, step |
| bag-holders | 420 | 3d | kind, trim, repair, tag, stitch |
| link-marines-v2 | 420 | 2d | Rank, Squad, Face, Eyes, Grooming, Collar, Mouth, Prop, Wall |
| exit-liquidity | 404 | 2d | sign, housing, route, repair, equipment, conduit |

`normalizeUniqueManifest` adapts Rent Free's `entries` and the other producers' `items`, including explicit and
implicit filenames. `verifyUniqueSet` checks the generated manifest against the committed reviewed manifest and
hashes every PNG and GLB (plus SVGs where the manifest records them). Missing/reordered ids, incomplete traits,
changed seeds/hashes and symlinks are refused. Only derived `picture-<id>.png` / `model-<id>.glb` filenames are
allowed; an explicit producer filename must match. No full edition is committed, and scratch is retained.

RF/BH (`modelPolicy` `3d`) build like every other kit, with no switch: each reviewed PNG goes to Create's own
reader as `<id>.png` and its reviewed GLB beside it as `<id>.glb` (the same self-contained GLB rules as the site's
model viewer), so Create's commitment puts each model hash in the leaf, root, list id and proofs, and Create's
download collector writes the settings' `models` list: each distinct GLB once, typed `model/gltf-binary`, its exact
bytes in base64. That is the path Create's Contents step and Load settings use: Load settings checks every model
by structure and exact SHA-256 and needs the numbered GLBs with the pictures. The commitments are byte for byte the
ones T02's offline bridge produced (`docs/evidence/SH-CREATE-ITEM-MODELS.md`). GLBs are also separate numbered
files and CAR blocks.

LMv2/EL always have zero model hashes and no exported models. Generating a review GLB never opts a kit into 3D.
Before Create, resolve every binding. T05 owns publication of the final post-Create list; an offline candidate list
does not prove that publication happened.

## Hidden plans

Frog Kiln exports a public template for 420 toads; Paper Certificates exports one for 1,929 specimen-0 certificates.
The tool reads the actual `plan.csv` through Create's plan parser and builds the sorted public trait table. It
never reads hidden item pictures or numbered assignments, and never generates or writes hidden salts or proofs.
The template root is a domain-separated public plan marker, **not a usable edition root**. The public pictures
are only the logo, cover, banner, promotional teasers and the kit's own `art/hidden.svg`, committed as one line in
the placeholders add-on. No `item` bytes or reveal list enter a public export.

Each settings download has `<id>-plan.json`, binding its SHA-256 to the plan path, SHA-256, count, specimen and
template marker. Bundles include `hidden-plan.json` and `plan.csv`, plus `hiddenPlan` in their inventory.

In Create, choose Load settings and pick the settings file and its `-plan.json` together, then the plan's twelve
variant pictures and `plan.csv`. Create checks the plan and its table, deals fresh numbers and salts, replaces the
marker root, and asks you to save the reveal file before Create. Keep that file private.
Do not submit the public template directly as create calldata.
Do not publish hidden images or reveal material in a CAR before reveal. The public bundle writer rejects hidden
item images, numbered items, salts/art state, proofs, reveal lists and non-template roots.

## Pictures and public CARs

Logo and collection cover use the page's `pictures/shrink.ts` WebP ladder and its first-fitting-step rule, with
`fitsFree(11155111, 107_520)` checking the **whole signed item**, including header and tags. The offline encoder
renders pixels with pinned resvg and encodes WebP through `cwebp` 1.6.0; it does not claim browser-identical bytes.
No paid or oversized fallback exists. The settings embed and hash those exact bytes. Banner/teasers retain the
existing resvg PNG path (1,600/1,024 px, at most one raw block). For noncollections the spec permits only a logo.

Open unique pictures retain their exact reviewed generated bytes, exported as `items/1.png` through `items/N.png`.
RF/BH also export `items/1.glb` through `items/N.glb`. Neither item PNGs nor GLBs are re-encoded.
`items/traits.csv` contains the complete traits above; archival Link Marines v1 retains Variant/Squad.
`reveal-list.json` uses the canonical public list format, hashed by `revealListId`;
`proofs.json` holds independently checked proofs. Public deterministic salts provide no concealment and never
apply to a hidden plan. External shop starter NFTs are not newly minted kit items.

`pictures.car` is CARv1 with raw SHA-256 blocks; every unique picture, approved model, list, proof, CSV and inventory
block is a pin root. Duplicate picture aliases share one block. Inventory maps
paths to exact hashes, sizes and CIDs. Picture extensions follow their actual PNG/WebP/JPEG content. Status is
`bindings-required`, `bound-offline` or `hidden-plan-template`.
After review, the operator can import the public CAR on our configured node:

```sh
docker compose exec -T kubo ipfs dag import --pin-roots=true < pictures.car
```

No import or publication is performed by this lane. Public art may be served publicly on our node; hidden art
stays private until reveal. The integrator runs browser loading, chain preflights and `pnpm verify` before merge.
