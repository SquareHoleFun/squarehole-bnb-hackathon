# Test junk for the Sepolia shop

Five owner-minted ERC-721 test collections, two original public pictures each, and
an unsigned deployment that mints ids **1 and 2 in every collection** to a supplied
deployed Safe. These are test stand-ins, with no real brands or issuer rights.

| Kind | Collection | Symbol | Binding key |
|---|---|---|---|
| 0 | Test Junk Bent Cans | tJCAN | bent-cans |
| 1 | Test Junk Lost Cogs | tJCOG | lost-cogs |
| 2 | Test Junk Split Boots | tJBOOT | split-boots |
| 3 | Test Junk Cracked Mugs | tJMUG | cracked-mugs |
| 4 | Test Junk Tangled Wires | tJWIRE | tangled-wires |

`catalog.json` records every raw-block CID, SHA-256 and PNG byte count.
`art/<binding-key>/1.png` and `2.png` are 512 px PNGs; their SVG sources and
optional `traits.json` sit beside them. Select the PNGs and traits when using a
collection art picker, leaving the SVG sources out. The shop itself has no new
collection of its own: these are external stock NFTs.

The fixed deployment sender owns minting. The Safe owns the starter NFTs. Later
owner calls to `mint(recipient,id,picture)` can use any unused positive id and
picture 1 or 2. Each minted picture is immutable. `tokenURI` embeds ERC-721 JSON
whose `image` is `ipfs://<raw picture CID>`; `imageURI` exposes that link directly.
JSON is not pinned, since the offline image gateway serves raster blocks.
Optional traits are Create-compatible import data, not contract metadata fields.

## Rebuild and export public art

From the repository root, Node 24.22.1 with the pinned workspace dependencies:

```sh
node examples/boxes/junkyard/test-collections/build-art.mjs --check
node examples/boxes/junkyard/test-collections/export-car.mjs .cache/ta40-cars
```

The destination must be new. This uses `infra/server/ipfs/export-kit.mjs`, writes
ten separate raw-block CARs and `pins.json`, and makes no network request. To
intentionally rebuild reviewed artwork, run `build-art.mjs` without `--check`;
it also regenerates `packages/contracts/src/test-coins/JunkCollectionCatalog.sol`.
Review any digest change before deployment. Exported CARs stay under ignored
`.cache/`; no large generated archive is committed. All this art is open/public.

For all example kits together, use the [public example exporter](../../../../infra/server/ipfs/README.md).
It includes these ten distinct pictures and every open kit's `pictures.car`, with a combined
inventory for the gateway byte check. Twelve Bent Cans token ids do not require twelve different
images: [the mint plan](../../one-collection-shop/mint-plan.json) fixes odd ids to picture 1 and
even ids to picture 2. No catalog or Solidity image digest changes are needed.

## Founder deployment and shop setup

Follow the full [TA-40 founder steps](../../../../docs/evidence/SH-TA-40.md).
From `packages/contracts`, set `JUNK_DEPLOYER` to the founder's sender and
`JUNK_SAFE` to the reviewed, deployed Sepolia Safe. With `JUNK_BROADCAST` unset
or false, `run()` simulates with that sender. With it true, it records five
CREATEs and ten mint transactions; it never reads a private key. The founder
alone supplies a signer and the explicit Forge `--broadcast` option.

A Safe must accept ERC-721 safe transfers. The script checks deployed code,
not Safe owners, threshold, implementation or fallback handler; the founder
checks those before running. Never mint directly to the ShopVault. Stock first
belongs to the Safe; the starter loader later pulls it through reviewed approvals.

Then follow the [Bent Cans owner-mint steps](../../one-collection-shop/README.md#bent-cans-owner-mint)
to prepare ids 3–12 for the one-collection shop and separate tester ids 13/14. The same immutable
collection owner sends those mints. Ids 1/2 remain the Junkyard's starter set.

New list entries wait seven days before gives work, including initial entries.
The shop must also graduate/open its gate. The immutable menu and weekly limits
still apply; list activation alone does not make every give payable.

## Exact Create settings file

After deployment and TA-30 Test Gold admission, save public bindings at one
verified Sepolia block in an ignored JSON file. Replace every placeholder below
with the actual public value; there are no guessed live addresses or listing ids:

```json
{
  "chainId": "11155111",
  "blockNumber": "VERIFIED_BLOCK_NUMBER",
  "safe": "DEPLOYED_SAFE_ADDRESS",
  "factory": "VERIFIED_V2_FACTORY_ADDRESS",
  "nativeRaise": "CURRENT_NATIVE_LISTING_RAW_RAISE",
  "testGold": {
    "address": "DEPLOYED_TEST_GOLD_ADDRESS",
    "name": "Test Gold",
    "symbol": "tGOLD",
    "decimals": "18",
    "listingId": "ACTUAL_LISTING_ID",
    "raise": "CURRENT_TEST_GOLD_RAW_RAISE"
  },
  "collections": {
    "bent-cans": "DEPLOYED_KIND_0_ADDRESS",
    "lost-cogs": "DEPLOYED_KIND_1_ADDRESS",
    "split-boots": "DEPLOYED_KIND_2_ADDRESS",
    "cracked-mugs": "DEPLOYED_KIND_3_ADDRESS",
    "tangled-wires": "DEPLOYED_KIND_4_ADDRESS"
  }
}
```

All amounts are raw decimal strings. Name, symbol and decimals must match the
TA-30 stand-in; labels supplied to an offline program are not onchain proof.
Verify collection names, kinds, owners, code and ids 1/2 against receipts too.

```sh
node --experimental-transform-types --no-warnings=ExperimentalWarning \
  examples/boxes/junkyard/test-collections/settings.mjs \
  .cache/ta40-bindings.json .cache/ta40-settings
node infra/server/ipfs/export-kit.mjs \
  .cache/ta40-settings/pin-manifest.json .cache/ta40-logo-cars
```

`trash-boxspec-v2.json` uses the Create page's actual `boxSpecFile` function:
`squarehole.boxspec/2`, spec hash, encoded spec, spec, exact picture bytes and
`revealList: null`. It includes the Junkyard logo after the shared kit picture
step (`scripts/kits/README.md`: the page's WebP shrink ladder, first step that
fits Sepolia's free Arweave item), hashed as exported. The exported logo's file
extension follows its bytes (`logo.webp` or `logo.png`). `starter.json` supplies the ten ordered loader entries
and suffix hashes. The starter picture CIDs are in the separate art catalog;
they do not belong in the shop's BoxSpec `pictures` array. The public logo has
its own pin manifest and CAR export.

The generator copies the Junkyard recipe, binds Test Gold, and uses all five
collections with ids 1/2 at tier 0. Seed, four prices, pick multiplier, limits,
seven-day delay, 30-day deadline and both fee choices remain the recipe's.
The creator buy uses the actual price/native listing raises with integer rounding.
After a raise update, pass a freshly quoted `creatorBuy` (a raw decimal string)
in the bindings instead. The builder is the shared async `buildKit('junkyard')`
from `scripts/kits/settings.mjs`, and it refuses a creator buy that is not below
the raise. No timestamp, collection, tier or price-menu override is accepted in
bindings.

Load it in Create → Load settings. Rebinding the creator Safe requires
rebuilding the starter/curator settings.

## Verification

```sh
node --experimental-transform-types --no-warnings=ExperimentalWarning --test \
  examples/boxes/junkyard/test-collections/art.test.mjs \
  examples/boxes/junkyard/test-collections/settings.test.mjs
```

Run both `JunkCollections*.t.sol` files separately with Forge on default and
`--hardfork amsterdam`, as recorded in the evidence. No local listener or chain
fork is needed. Tests retain their scratch outputs under `.cache/tmp/`.
