# Quick Deck

The new card shop box on the second release: the live Card Shop's settings (the same kit tool), named Quick Deck
(QDECK), its own logo (`hackathon/demo-pictures/quick-deck.png`, sha256 `0x1b55c365…a71f`), gives open 600 s after
creation, sixteen starter cards = ids 9 to 12 of each of the four live collections (`97-cards.json`; free at block
144,928,655).

In order (hack-deployer for every send; each first dry):

1. `commands.txt`: the sixteen mints (the cards' owner mints ids 9 to 12 of every tier to itself).
2. The settings, once the second release's files are written: from `packages/contracts`,
   `node --experimental-transform-types --no-warnings=ExperimentalWarning script/bnb/quick-deck-settings.mjs --cards deployments/bnb-testnet/97-cards.json --extras <the second release's extras file> --factory <its factory> --listing-id <tUSDC's id in its registry> --out ../../.cache/quick-deck/settings-real`
   (a preview without `--factory` gave spec hash `0xf926486d…1dde5` with the first release's listing 1 and raise).
3. The box: `card-shop.mjs` with the release parameter, `--settings ../../.cache/quick-deck/settings-real
   --state ../../.cache/quick-deck/real-state.json`: create, load, graduate, each `--dry` first.
4. The logo on Arweave: `node packages/chain/scripts/bnb-boxes/publish-picture.mjs --file hackathon/demo-pictures/quick-deck.png --expect 0x1b55c3656ceabe2af41d434c779771cab8e55036e97daf9497bfecb04ad4a71f`, then `--send` (the orchestrator).
5. The upkeep the stack's keeper does not do for the second release (anyone may call; after graduation, a few times):
   `receiver.collect(0x0)`, `hook.sellFees()`, `receiver.collect(0x0)` again, `receiver.executeModule(true)` (the
   sellers' fees buy the coin for the shop, the keeper's `shopFees`), and the holder ledger's `settleBatch(id, steps)`
   for each closed batch (holders then claim their own).

What is filled in from the second release: the factory, tUSDC's listing id and raise in the second registry (the spec's pricing),
and the native raise the kit converts the creator's first buy with (listing 0 of the second registry).

Known: the generated spec validator (`packages/box-spec/src/generated/box-spec.v2.ts:818`) refuses a `listDelay` other
than 7, 14 or 30 days (reason 2 at field 30). card-shop.mjs does not call it; the site's Create, the kit tool's check
and any page that runs it would call this spec invalid.
