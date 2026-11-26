# Core v2 example registry

Each `<id>.json` is the canonical recipe for a local end-to-end life, a future
Sepolia launch, and a future “See it live” link. Consumers use `loadExamples()`;
they must not copy these recipes or turn a pending example into a current one.
No deployed addresses or public-network launch permission are implied here.
Future launch records should key their chain/address by this stable `id`.

`registry.mjs` validates the strict shape and cross-field rules. A ticker is 1 to
11 capitals or digits, so it may start with a digit; that is narrower than the
contract, which takes 1 to 11 bytes of JSON text (`BoxSpecV2.sol`, tokenSymbol).
`schema.json` is its generated JSON Schema; the validator test detects schema drift. Regenerate
it with `node --input-type=module` importing `jsonSchema` from `registry.mjs` and
writing `JSON.stringify(jsonSchema, null, 2) + '\n'` to `schema.json`.

Run `node --test packages/box-spec/examples/v2/registry.test.mjs` or
`pnpm e2e:examples` from the repository root. The latter validates the registry
before starting the real local stack and runs only `examples.spec.mjs`.

`pnpm e2e:examples --list` validates and discovers the cases without a listener.
For the supplemental contract-only checks, run
`node apps/web/e2e/core-v2-chain/examples/offline.mjs --json`. This runs only the
owned `ExampleLives.t.sol` with `FOUNDRY_FUZZ_RUNS=256`, offline, using a scratch
Foundry configuration under `.cache/examples-e2e/forge/`. It preserves release
compiler settings and adds read access to this registry and its committed art
(the shared `local-art` and `examples/boxes`, whose kit art a row may use).
It then replays the fresh EVM reads and receipts through the browser suite's
graduation and failure accounting helpers, including one-unit corruption checks.
The page-function checks pin exact ETH/P text against the current renderer's
label policy using locator doubles. They do not verify a rendered browser,
indexer, site-generated spec or transaction gas. `--json` keeps Foundry JSON on
stdout and sends the Node test report to stderr. The captured reads/receipts are
regenerated at `.cache/examples-e2e/contract-replay.json`; never substitute an old
capture for the combined command. `pnpm e2e:examples` requires this combined
check to pass before attempting browser startup.

Non-Junkyard offline runs generate private hidden kit fixtures in a fresh
`.cache/hidden-art/lives-…/` folder, with Link Marines version 2's kit download
(the kit tooling's settings file, read by the reviewed open reveal reader, with
every reveal call prepared from it; open art, nothing secret). The runner removes its own folder after
success or failure, including preparation and replay failures. Use
`--keep-hidden-art` (also accepted by `pnpm e2e:examples`) to retain it; the
runner prints the private folder's relative path on stderr. A caller-supplied
`SH_HIDDEN_KITS` index and its art are never removed by the runner. For a full run
(without `--hidden`), a caller's index must also name a `link-marines-v2` folder
with that kit's `download.json` and `attributes.json`. `prepare-hidden.mjs` writes
that folder (`writeKitDownload`), so an index it prints has one; without it,
`test_linkMarinesV2` stops and says which folder the index lacks.

The browser runner probes free loopback ports, starting at the caller's
`SH_EXAMPLES_PORTS` (a JSON object of `appPort`, `gatewayPort`, `artPort` and
`chainPort`) when it is set, else at web 5410, indexer 5411, art 5412 and Anvil
8576, and refuses the ticket's reserved ports. It never
reuses an existing service. Each test creates a fresh box; chain history remains
append-only for the indexer. Reports go to `.cache/examples-e2e/results.json`
and `results.md`, with raw transaction evidence attached to each Playwright test
(also written to `.cache/examples-e2e/evidence/<id>.json`) and screenshots/traces
under `.cache/examples-e2e/playwright/`. A startup failure
before Playwright runs is an execution failure, not a passing or skipped life.

All known monetary quantities, counts and basis points in data are decimal strings.
The Alchemist's pending registration row alone may leave its unresolved raise
as `null`; this is missing listing data, never an executable amount or quote.
Raise amounts pin the current local listing: 4.206980085 ETH, 8413.96017 USDC,
420.6980085 LINK, or 42.06980085 NVDAon. A different chain must supply and review
its own listings; these fixture raises must never silently become market quotes.
Deadlines are 30 days unless explicitly overridden. Creator buy is zero except in the
two shops: the Junkyard's Safe buys 0.3 ETH-equivalent and the one-collection shop's 0.01 ETH (details below).

Choices defined for this ticket: Exit Liquidity has 404 open-art signs; its
Liquidity token starting recipe is changed to a collection with sellers paying
items and burning the inside share. Rent Free keeps buyers paying items with
inside burn and changes sellers to Burn. Staking Snails has no items. All
collections other than Frog Kiln and Paper Certificates use open art; collections use a 1% pick fee. Gas Guzzlers asks 2.5%
royalties, booked like its buyers' fees (keep: 10/15 reaches its creator; R53 G-J
leaves fee handling as the only destination, F138). Link Marines version 2 asks 2.5% too,
booked the same way: the marines' rations, the inside shares to its own pool. Other royalties are off. One Dollar is all you need has
the ticker 1, is priced in USDC and is seeded with exactly 1 USDC. GPU Poor has the
ticker VRAM and is priced in NVDAon. Link Marines version 1 has the ticker MARINE and eats
LINK on both sides. Version 2 (`link-marines-v2`, F151, the Sepolia example) keeps MARINE:
on both sides the box's 10 of 15 parts go to the 420 marines in LINK, their owners
claim, and the share of marines still inside goes to the box's own pool (Depth).
Tickers are fixture choices, not name clearance.

Pictures come from two reviewed places only: the committed `local-art` PNGs, or
a kit's own top-level art, `examples/boxes/<id>/art/<name>.png`, where `<id>` must
be the row's own id (TA-24). Link Marines uses its kit logo; its earlier logo was
Square Hole's own coin mark and is not used by any example. Frog Kiln and Paper
Certificates use their kit logos and covers.

The committed `local-art` PNGs are reused as local test pictures (one numbered
copy per item); “cans”, “houses”, “bags” and “404 signs” describe intended
collections, not newly authored illustrations. No external art is downloaded.
The registry records the art mode, source and collection size independently.
Each runnable example has its own logo, and each collection its own cover and
item picture, so a box shown with another box's picture fails (the registry test
pins that every runnable logo and collection cover is a different picture).

The site re-encodes the logo and a collection's cover in the browser, and the
spec commits those bytes. Before `createBox`, the suite reads them (read-only)
from the page's draft, checks them against the decoded spec, and writes them
with the item picture to an example-only catalogue,
`.cache/examples-e2e/run/art/catalog.json`. Only the example stack's art
gateway reads it, with the committed catalogue's size, PNG and SHA-256 checks
repeated on every change; the stack starts it empty. The founder's local stack
serves the committed catalogue alone. `own-pictures` then requires the feed
card's logo and cover and the box page's cover to be decoded pictures whose bytes
hash to that box's own commitments.

The indexer audits every 32 heads and this chain mines only on sends. A page
check waits for the box's audited card at the head; while a listed box is still
unaudited, it mines empty blocks (no state change, one second of chain time
each, at most 64), which each life's evidence records as `emptyBlocks`.

`properties` are executable obligations, not descriptive tags. The life runner
must mark each assertion complete or fail; unknown properties are rejected.
Pending rows name `V21-01-EAT` (step 1, eat LINK), `V21-02` (step 2, item payouts
in the box token), or `V21-03` (step 3, fees into the pile), with a Playwright
skip reason; their recipes are starting points only. None of these is pending today: Link
Marines eats LINK (locked at 0xdEaD after graduation, `price-coin-eaten`), GPU Poor
Miners pays its items in its own token (bought after graduation, claimed with
claimT, `item-claim`) and Dragon's Hoard feeds its pile with a 5% leave-behind.

A kit step (`KIT_STEPS`; `EXAMPLE-LIFE`) marks a row whose kit and recipe are set
but whose lives still need implementation. Frog Kiln and Paper Certificates
are now `ready` and contract-ready: both hidden-art lives run offline. Their
Sepolia binding keys are `TEST_FROG` (Test Frog, `tFROG`) and `TEST_GOLD`
(Test Gold, `tGOLD`). Frog Kiln uses Eat for buyers and item payouts in KILN
with the inside share burned for sellers; Paper Certificates uses Burn for
buyers and item payouts in SCRIP with the inside share burned for sellers.
Their browser lives skip before page setup until the local stand-ins and
private draw/reveal integration exist. These bindings do not claim a mainnet
frog or gold listing.

Link Marines version 2 is `ready` too (SH-EX-LMV2). Its contract life
(`test_linkMarinesV2`) creates the box from its kit's own download, reveals all
420 marines from that download's list, and proves both sides' rations in LINK,
marine 1's owner claim, the inside shares and rounding going to the box's own pool,
and its 2.5% royalty booked like a buyers' fee. Its browser lives are the
registry life in `pnpm e2e:examples` and the kit case in `kit-open-load.spec.mjs`
(the kit's settings file bound to the local LINK listing, every marine revealed
from the created box's own download). Lake House waits on `EXAMPLE-LIFE` (below).

The Alchemist (`the-alchemist`, LEAD) is a Coin pile recipe with buyers choosing
`alchemist`, sellers choosing Burn, zero seed and a 5% leave-behind. The founder's
concept is PEPE as price coin and gold (XAUT as a candidate) in the pile, along
the fixed route idea PEPE -> WETH -> gold. Its Sepolia row uses `TEST_PEPE` and
`TEST_GOLD` as binding keys for **Test PEPE and Test Gold**, TA-30 test stand-ins;
these keys are not assertions about deployed symbols. TA-30 is absent from this
pinned base, so addresses, listing IDs, route pools and the raise remain
unresolved. Its price-coin decimals are the intended 18 and require confirmation.
Neither mainnet PEPE nor any mainnet gold coin is claimed to be listed.

`CHAIN_STEPS` adds `ALCHEMIST-REGISTRATION`: confirm TA-30 listings, deploy and
register a compatible module, verify its actual row and `readyAt`, then add the
contract/browser lives and unsigned creation support. Every `alchemist` choice
requires this pending gate and a different pile coin, even with a known raise;
it cannot be made runnable merely by changing `status` or selecting a site gate.
`contractReady()` excludes it. A reviewed follow-up must supply the chain
evidence and lives before relaxing the gate. The zero-seed exception covers
Alchemist and a pile both fee sides feed (Lake House, below); a pile that one side or none feeds still requires a
positive seed.
The generic `create-example-v2.mjs` writer does not yet support this choice or
these test binding keys. Do not use it to prepare an Alchemist launch yet.

The [kit](../../../../examples/boxes/the-alchemist/README.md) has an original
logo, cover, box banner and seven scenes in SVG and PNG. Its checker and
corruption tests run without a listener:

```sh
node examples/boxes/the-alchemist/check.mjs
node --test examples/boxes/the-alchemist/check.test.mjs packages/box-spec/examples/v2/registry.test.mjs
```

A site step (`SITE_STEPS` in `registry.mjs`; `FE12`, the create flow's Pile
choice and leave-behind preset) gates only the browser life. Its recipe is the
real one: `contractReady()` includes it, so its Solidity life, accounting replay
and page-unit check still run offline. FE12 delivered both controls, so Dragon's
Hoard is `ready` and runs in the browser; the step stays listed for later site
gates.

The pinned site's live create page downloads a BoxSpec but cannot send it.
The test drives the real form, connects its local wallet, verifies the downloaded
spec and sends that spec through its browser provider. This is an explicit
fallback until the frontend owner wires live Create. Details and execution
limitations: `docs/evidence/SH-V21-EXAMPLES-E2E.md`.

## Junkyard and unsigned creation (SH-JY-01-EXAMPLE)

Junkyard adds the twelfth life. Its creation uses the chain package directly;
its box page and the actor's gold claim still run in the browser. The local
stack provisions a separate controlled PAXG fixture (18 decimals, 0.5 PAXG per
fixture ETH), a contract-holder double owned by the actor, and five unrelated
ERC-721 faucets. The original menu's gold listing remains intact. Their actual
addresses and listing id are in `local-core-v2-chain.json` under `junkyard`.
The issuer is `accounts.deployer`: `setPaused`, `setFrozen` and `setFeeBps` are
issuer-only and start disabled. The double is **not a production Safe**.

The four initial `scrap-a` through `scrap-d` collections use tier 0; their
committed starter ids are in `junkyard.json` (ten total). Each collection also
mints ids 100–107 to the actor and 200–207 to the backup, including the fifth
`scrap-e` collection that the curator lists during the life. These are local
bindings, never public-network addresses. Graduated Square Hole collections
can use the same ordinary `addCollection` path; there is no privileged listing.

On Sepolia the row keeps PAXG and its local keys, and the kit settings map them
as One Dollar's USDC maps to Test USDC (`scripts/kits/catalog.mjs`): PAXG to the
Test Gold stand-in, and the four scrap keys to TA-40's five Test Junk collections
(`bent-cans`, `lost-cogs`, `split-boots`, `cracked-mugs`, `tangled-wires`; ids 1
and 2 each, tier 0). `examples/boxes/junkyard/test-collections/settings.mjs`
builds that Sepolia file from verified Test Gold, Safe and collection bindings.

Fixture choices left unspecified by the ticket: seed 180,000,000 TRASH; give tiers
1/2/4/8 million TRASH; ten starter items; four initially listed tier-0 collections
and one subsequent tier-0 collection. All raw amounts have 18 decimals. The
local raise is 2.1034900425 PAXG; the 0.3 ETH-equivalent creator buy is 0.15 PAXG. After the bootstrap and curve fee it buys
180,195,814.884384477544867602 TRASH. The Safe seeds 180,000,000 TRASH (18% of supply),
retaining 195,814.884384477544867602; the fee ceiling is 360,000,000 TRASH.
The Safe retains the buy, approves exactly the seed and starter NFTs, registers
itself for future holder payouts, and claims its own gold explicitly. Buyers pay holders in PAXG; sellers select Into the shop at 2× the seed. Fees count towards the
ceiling, purchases obey live room, and the rest pays original trade holders in PAXG. Named picks cost 2× and the last NFT cannot leave. The life also
checks failed-call rollback, the seven-day list delay, 10% total and 2.5% per
collection weekly limits, next-week pick receipts and the cheapest-give floor.

R47E removes the Junkyard humble cap, including its voluntary Safe policy. R48 offers Into the shop to every
shop: whoever picks the collections decides who can sell into a budget the fees pay for. Fees fill the shop up
to a ceiling, then go to holders. This is not profit accounting. The life proves fee filling, exact approval,
tail refunds, a pick receipt crossing the ceiling, and subsequent sellers' PAXG reaching holders. Collection
time chooses the weekly destination; pending fees are rechecked against live room when bought. Counsel reviews
this again before launch. See the [runbook](../../../../docs/runbooks/junkyard-launch.md).

Run the supplemental four offline EVM tests without listeners:

```sh
node apps/web/e2e/core-v2-chain/examples/offline.mjs --junkyard
```

This uses `.cache/examples-e2e/junkyard-forge/`, preserves the contracts owner's
outputs, and writes `junkyard-contracts.json` beside the original replay. The
normal `pnpm e2e:examples` runs both offline suites before starting its stack.
The Junkyard suite uses the real factory, curve, shop and holder ledger with
local gold/NFT/custody doubles; it does not certify Safe signing or public RPCs.

To prepare any registry example without the site, supply public inputs and an
explicit read-only RPC endpoint. The writer never signs or sends, and refuses
to overwrite an output file:

```sh
node packages/chain/scripts/create-example-v2.mjs --example junkyard --chain-id 11155111 --rpc "$RPC" --inputs public/junkyard-inputs.json --out public/junkyard-unsigned.json
```

The public input object requires `creator` (the actual Safe for Junkyard),
`factory`, and decimal-string `listingId`. For Junkyard it also requires
`collections`, mapping `scrap-a` through `scrap-d` to the intended collection
addresses (local keys; the Sepolia Junkyard uses the TA-40 exporter above); the listed starter ids must already belong to that Safe. For a coin
pile, supply `assets` mapping its seed symbol to its actual token address
(native ETH needs no binding). For a new collection, supply `art` with the
public `metadataTable`, `revealRoot`, `generatorHash` and `revealListId` produced
by the collection's commitment ceremony. No secrets or private art assignment
files belong in this input. A hidden kit without `art` is refused unless
`--generate-hidden-art` is explicit. That option prints the generated private
folder under `.cache/hidden-art/`; keep it and back it up privately, including
the reveal file, secret, numbered pictures and settings. Losing those files
can make the collection impossible to reveal. Creation never cleans that
folder. The source pictures remain the registry kit's authored art; a launch
with different pictures needs a reviewed registry change.

The script reads one block's listing, raise, native raise and factory Q
parameters, computes the creator buy with integer rounding up from the listing
raise ratio, mines creator-bound coordinator/hook salts, validates the complete
spec with the chain-compatible validator, and writes the exact `createBox`
calldata, `from`, `to`, decimal `chainId`/`value`, exact ERC-20 approval, spec hash,
predicted addresses and ordered starter commitment. The raise follows the
chosen chain's current listing, not the example's local fixture raise. The
0.3 ETH-equivalent amount uses that listing ratio, not a current market oracle.
Verify it against the operator's intended public launch amount before signing.

Chain id 1 is refused unless `--allow-mainnet` is explicitly added (G08); this
flag only allows preparation. Review the release/factory and Safe identity,
listing issuer powers, balances, commitments and all mainnet runbook gates.
Simulate the saved call at the current head before signing separately. A Safe
must execute the saved factory call itself, then clear the exact approval.
Creation is followed by committed text/table chunk loading and, where applicable,
seed/starter loading and completion. The creation output is not a deployment,
Safe signature, gas estimate, complete launch approval or proof of those steps.

## One-collection shop (SH-ONE-COLLECTION-SHOP)

The no-contract version of the existing-NFTs box: a shop over one outside ERC-721 collection, with a starter set
and no curator. `curator: "none"` encodes the zero `ShopConfigV2.curator`, a fixed list: nobody, the creator
included, can add a collection or name a successor (`IShopVaultV2.sol:20`). The row names TA-40's `bent-cans`
key itself, tier 0, with starter ids 3 to 12, the smallest full set (ids 1 and 2 are the Junkyard's). The seed,
2,000,000 SHOP, is exactly two sell-backs at 1,000,000 SHOP; picks cost 2x. The 10% and 2.5% weekly limits
stay the page's defaults; with one collection and this budget the floor of one cheapest give binds, so the shop
takes one sell-back a week until 2.5% of a week's budget is more. Buyers pay holders; sellers fill the shop up to
twice the seed, then pay holders. It is priced in ETH, so Sepolia needs no stand-in, and its creator is a Safe
whose first buy is 0.01 ETH (7,139,254.72 SHOP on the local twin, measured by the life; another raise buys another amount).

Its life runs on the local chain only (no `ExampleLives.t.sol` life): `one-collection-shop.mjs` deploys TA-40's own
`JunkCollection` code for the key on the local twin, mints ids 3 to 12 to the Safe double, creates through
`prepareExample` with a native-ETH value and no approval, approves each starter id (never the whole collection),
loads, funds and completes. After graduation it proves the zero curator, the seven-day delay, one sell-back a week
at the floor, an unlisted collection refused, sellers' fees up to the ceiling, picks at 2x and the last item staying.

## Lake House (SH-LAKE-HOUSE)

`lake-house` (HOUSE) is the mock rental example: a Coin pile priced in USDC (tUSDC on Sepolia, listing 2, raise
100 tUSDC) whose pile is the price coin and starts **empty** (seed `0`). Both fee sides choose To the pile, and
nothing stays behind on a hand-in (`leaveBehindBps` `0`). Payments into the box's inbox follow the buyers' side, so
10 of every 15 parts reach the pile. Its Sepolia creator is a company Safe, through the launch pack; the row has no
`creator` policy, which belongs to the shops. The validator lets a pile start empty only when The Alchemist or To the
pile on both fee sides fills it; Dragon's Hoard (one side) keeps its seed rule. The row is `pending` on
`EXAMPLE-LIFE`: its local contract and browser lives are not written, and `contractReady()` excludes it. Its raise
pins the local USDC listing, as One Dollar's does. Kit: [examples/boxes/lake-house](../../../../examples/boxes/lake-house/README.md).
