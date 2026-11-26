# One-collection shop

Load it: resolve the [public bindings](../../../scripts/kits/README.md#binding-the-setup), then choose `settings/one-collection-shop-boxspec-v2.json` in Create → Load settings. Enter Bent Cans ids 3–12 when asked for starters; No curator stays selected. The founder uses the creator Safe for launch.

A shop for one outside NFT collection. The coin is SHOP.

![A shop front with a striped awning, a door and one framed picture in the window.](art/logo.png)

The creator loads ten of their own NFTs and seeds SHOP worth two sell-backs.
After graduation anyone picks an NFT, and any holder of the collection can sell one back.
The list is fixed: no curator, no new collections. The last NFT stays.
Fees fill the shop up to a ceiling, then go to holders.

| Setting | Value |
|---|---|
| Collection | Test Junk Bent Cans (TA-40), ids 3 to 12 |
| Sell-back | 1,000,000 SHOP |
| Pick | 2x, 2,000,000 SHOP |
| Seed | 2,000,000 SHOP, two sell-backs |
| Sell-backs a week | one while the budget covers it; 2.5% of the week's budget once that is more |
| Starts taking sell-backs | 7 days after Create, and after graduation |
| Curator | none |
| Buyers' fees | to holders |
| Sellers' fees | into the shop up to twice the seed, then to holders |
| Price coin | ETH |
| Creator | a Safe, first buy 0.01 ETH |

In every shop, whoever picks the collections decides who can sell into a budget the fees pay for.
Here the creator picks one collection at Create, and nobody can add another.

This is a Sepolia test setup. It is not a live shop or a promise of payment.

## Before Create (founder)

1. Deploy TA-40's collections ([steps](../junkyard/test-collections/README.md)).
2. Run the owner-mint script below for Bent Cans ids 3 to 12 to the creator Safe and 13/14 to a separate tester. Ids 1 and 2 are the Junkyard's.
3. Bind the Safe and the collection: `node scripts/kits/settings.mjs one-collection-shop --bindings PUBLIC_JSON`.
4. Create, load and open as in the [Junkyard runbook](../../../docs/runbooks/junkyard-launch.md), with `--example one-collection-shop`. Approve each starter id, not the whole collection.

## Bent Cans owner mint

[mint-plan.json](mint-plan.json) maps ids 1–14 to the existing
[catalog](../junkyard/test-collections/catalog.json): odd ids use picture 1, even ids picture 2.
The new script only mints 3–14. Ids 3–12 are stock for this shop; 13/14 let a separate tester
try sell-backs after graduation and the seven-day delay. They are never starter-set entries.
All token ids and picture ids in the plan are decimal strings.

From `packages/contracts`, set public environment values `BENT_CANS_COLLECTION` (the verified
kind-0 deployment), `JUNK_DEPLOYER` (its immutable mint owner), `JUNK_SAFE` (the creator Safe),
and `BENT_CANS_TESTER` (a distinct, nonzero tester wallet or ERC-721 receiver). The creator Safe
route is the plan's default; no EOA-creator variant is needed. The mint owner remains the founder's
deployment sender, not the recipient Safe. Verify the Safe's owners, threshold and ERC-721 receipt
support separately; code presence alone does not verify those properties.

The integrator rehearses on Sepolia using a pinned block and the founder's public RPC selection:

```sh
JUNK_BROADCAST=false forge script script/sepolia-v2/BentCansMint.s.sol:BentCansMint \
  --rpc-url "$RPC" --fork-block-number "$BLOCK" --sender "$JUNK_DEPLOYER" \
  --hardfork amsterdam --gas-estimate-multiplier 110
```

This simulates twelve owner mints. `JUNK_BROADCAST=true` records twelve address-sender transactions
for review; it still sends nothing without Forge's explicit broadcast flag. Only the founder supplies
a signer and sends transactions, under the fee limits in the Sepolia runbook. This is a Forge script,
not a helper contract to deploy. It reads no key. Never mint directly to the ShopVault.

Before recording, it checks chain, owner, collection kind, recipients and that **all twelve ids are
unused**. The script applies the shared fork and per-transaction gas rules. Safe receipt failures
revert in simulation. Do not blindly retry or resume a partially sent sequence: reconcile receipts
and every occupied id first; a fresh run intentionally refuses any occupied target id.

After mining, check ids 1–12 belong to the creator Safe, ids 13/14 belong to the tester, and decoded
`tokenURI.image` matches the plan. This assumes the Junkyard's ids 1/2 have not yet been loaded.
Upload the public images with the [combined CAR exporter and byte checker](../../../infra/server/ipfs/README.md).

## Rebuild and check

From the repository root, with Node 24.22.1:

```sh
node examples/boxes/one-collection-shop/build-art.mjs
node examples/boxes/one-collection-shop/check.mjs
node --test examples/boxes/one-collection-shop/check.test.mjs
```

`build-art.mjs` draws the logo from plain shapes with the workspace's pinned `@resvg/resvg-js`; nothing is downloaded.
