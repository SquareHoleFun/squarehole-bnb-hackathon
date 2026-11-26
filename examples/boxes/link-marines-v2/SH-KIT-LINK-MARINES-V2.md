# SH-KIT-LINK-MARINES-V2 work record

Kit agent for version 2 of the Link Marines box (Claude Opus 5.5), on branch `sh-kit-link-marines-v2` in the
`wt-kits-lm2` worktree, from base `36efa916`. The kit lives in `examples/boxes/link-marines-v2/`. Three small changes
outside it are part of the task: the registry row `packages/box-spec/examples/v2/link-marines-v2.json` with its line in
`registry.test.mjs` and the two schema rules the row needs, and the old fixture ticker in the create page's test data,
which the follow-up put back to MARINE. The brief limits work to the kit folder, so the record sits here. The
integrator can copy it to `docs/evidence/`.

Version 1 in `examples/boxes/link-marines/` is untouched: `git diff kit-link-marines-v1 -- examples/boxes/link-marines`
is empty, and its own check still passes.

## The founder's request

The founder saw that another LINK-paired marines token already exists on another chain and asked for "another version,
just better using our platform". He chose the recipe "Rations for the marines" and changed one part of it: "I would do
'marine still in the box' -> liquidity pool of the box. I think that is stronger than locking the LINK somewhere and
it is still very unique with the two different options."

## The follow-up: MARINE and the review

After the first pass the founder decided on the ticker: "we can make the ticker $MARINE as well, that is no
problem", and "there is no trademark on a ticker." A review of the first pass found one medium and three low points.
The follow-up made these changes, in their own commits.

| What changed | Why | Measured |
| --- | --- | --- |
| The registry row, `check.mjs` and every doc say MARINE where they mean the ticker. The word ration stays | The founder's decision | `check.mjs` passes 907 checks; the registry tests pass 3 of 3 |
| The brand book has a section "The ticker": the reason, one plain line that a token on another chain has used the same ticker since mid-September, and the rule that every live page and post shows the chain and the full contract address. Public texts never name or attack that token | The follow-up brief | The check allows that chain's name once, in that section only, with one date, and refuses it in every other file and line |
| `check.mjs` and `lettering()` stop refusing MARINE. Every other rule from the research's never list stays | The founder's decision | A doc line with MARINE alone passes, and MARINE lettered on a sign builds |
| No picture changed for the ticker | No picture letters it: the art writes RATION only as the word, in THE SAME RATION FOR ALL 420., SAME RATION FOR ALL 420 and RATIONS, and the dog tags carry no letters | A rebuild after the ticker change left all 49 art files byte-identical |
| The create page's test data says MARINE again for Link Marines | The founder allows MARINE, so the EATIT change is undone | `git diff 36efa916` of the file is empty |
| `details.md` says "all in LINK", "counted in it" and "in another coin" where it said `paid in` | Review, medium: lines 25 and 120 said rations and claims are `paid in` LINK | The ban widens from `paid in LINK` to any `paid in`. On the old text it flags exactly the paragraphs at lines 25, 74, 119 and 122 |
| Speech bubbles fit their words like signs, with 30 px to spare on each side, and scene 04's bubble is 470 px wide, so the motto keeps its size | Review, low: NOT SELLING. touched its bubble outline | Gap from the letters to the outline 3.0 px before, 26.5 px after; the signs keep 27.0 px |
| The jar's highlight sits near the glass's left side and stops above the coins | Review, low: the bar crossed the C of CLOSING | It touched the letters and the coins before. Now it is 17 px from the C, 11 px from the glass outline, 60 px from the coins and 37 px from the orange arrow |
| The tureen's light crescent hugs the bowl's left side | Found while checking every lettered picture: it ran under the R of RATIONS, the same kind of crossing as the jar's | Gap to the R 0.0 px before, 9.8 px in scene 02 and 11.1 px in scene 07 after |
| The crate keeps one stencil unit free inside its braces when it fits its words | Found the same way: the corner of the 4 in 420 touched the left brace in scenes 01 and 05 | Gap 0.0 px before, 18.0 px after. SQUARE HOLE on scene 02's crate goes from 18.0 px to 21.0 px |
| Open point 4 says "a fan poster" | Review, low | |

The tureen and crate rows go past the review's list. They are the same kind of fault the review found, inside the
kit, so they are fixed in two commits of their own that can be dropped on their own.

The commits, in order: `a56bfe64` the fixture ticker, `262523f7` the ticker MARINE, `1ce003f3` the wording and its
ban, `ca41e9c7` the bubble, `4c3c0bd6` the jar, `86ba7540` the tureen and `d548bd60` the crate. This record comes
last.

## What changed from version 1, and why

| Area | Version 1 | Version 2 | Why |
| --- | --- | --- | --- |
| Recipe | Eat on both sides: the LINK is locked at an address nobody has a key for | Rations: ten of fifteen parts to the marines in LINK. An owned marine's share is claimed by its owner. A marine still in the box sends its share to the box's own pool | The founder's recipe and his change to it |
| What a marine gets | Nothing | The same share as every other marine, claim-only | The founder's rule that both sides are the same (F82 LM2), claim-only payouts (F127) |
| Setting | A field mess hall: olive tiles, steel helmets, olive shirts | Mess night: panelled walls in walnut, khaki, crate wood and ration paper, white peaked caps, dress-navy mess jackets, a white tablecloth, candles | The founder's dress navy with white caps; the research's mess night |
| The 12 pictures | Roles, from Private to Night watch | The community's ranks, from Private to General, 35 of each | The task; rank is only the picture |
| Story symbols | Bitten coin, mess tin, bell, footlocker with no key | A plate with one coin, a cloche, a tureen, a depth post, a rules plaque with a padlock | Nothing is eaten any more |
| Ticker | EATIT | MARINE | The founder's decision in the follow-up; the first pass proposed RATION. Another token uses MARINE, so pages show the chain and the full contract address |
| Royalties | Off in the row | 2.5% into the fees | The founder's "royalties feeding back to the box" (F82 LM5); the create page's own Link Marines test data uses the same rate and destination |
| Color rule | No blue at all | Blue as cloth only, inside the research's colour fence | The founder's dress navy, with the price coin project's blues kept out |
| Mark | The helmeted Private biting a coin, on olive | The Private in a white cap, on a khaki patch, on walnut | No eating; the research's v2 mark idea, with the Private in place of the General |
| Check | Version 1's rules | The same, plus the fence, cloth-only letters, one plaid, one seven, the ranks, two registry states, prose read in paragraphs and never-named words | The new look and recipe need their own guards |

## What the platform does here

The founder asked for a better version on Square Hole. These six points are what the box does by its rules. The
public texts state them plainly and never name or attack any other token. Each rests on the code listed under
"Facts read in the code".

1. **Real LINK.** The box is meant for Ethereum and priced in LINK itself, so the fees, the rations and the pool are
   all LINK. A test network has no real LINK and uses a stand-in.
2. **420 marines that carry their own rations.** Each marine's share is booked on that marine and follows it when it
   changes hands.
3. **Claims nobody can stop.** Only the current owner claims, one marine at a time, with no minimum, no tip and no
   time limit, and the item ledger has no administrator.
4. **Rules nobody can change.** The coordinator, collection, token, vault, launch router, registry, royalty router,
   factory and item ledger have no owner or admin with any power. The collection names an address as `owner()` for
   marketplaces only.
5. **A deeper pool while marines wait.** The share of a marine still in the box goes into the box's own pool. This
   is step 5 of v2.1, being built now.
6. **A box that fails safely.** After 90 days without a full raise, anyone can fail the box. The waiting rations and
   any royalty LINK join the closing pool, and holders claim their part for a year.

## Requirements and files

| ID | Requirement | Result |
| --- | --- | --- |
| LM2-01 | Read the kit brief, version 1 and the community research with its fact-check | Read the brief, every file of version 1, and the research's recommendation, its fact-check and its five summaries and findings. Findings the fact-check marks weak or wrong are not stated as fact (decision 16) |
| LM2-02 | Same structure and care as version 1 | README, brand book, storybook, details, art notes, `art/` as SVG and PNG at the exact sizes, 12 rank pictures, `assign.mjs` and `assignment.json`, 7 scenes, `check.mjs`, this record |
| LM2-03 | Price coin LINK, 420 marines, 10/15 to the marines on both sides, owned marines claim, marines in the box feed the pool, 90 days, no creator buy, royalties to the box | The registry row and every doc |
| LM2-04 | Step 5 named in one line in details.md, the row pending until then | One line under "For a v2.1 step"; the row is `pending` on `V21-05` with Keep as the stand-in |
| LM2-05 | The six platform points in the record and the story, with no other token named | "What the platform does here" above; the story hook, the "What this box does" table and scenes 03 to 07 |
| LM2-06 | Dress navy `#1F2B47` with white caps, never the project's blue, the colour fence in `check.mjs` | Blue only as cloth; the fence runs on every color (decision 2) |
| LM2-07 | Mess night, the 12 ranks, 35 each, "Rank is only the picture" | Done; the line is in the README, brand book, details and `assignment.json` |
| LM2-08 | The motto made true, every joke with its literal line | "Not selling." with its literal line; a table pairs every joke with one |
| LM2-09 | One flannel touch and one quiet seven | The cook's shirt in scene 03; seven candles on the box banner; both counted by the check |
| LM2-10 | The research's never list in full | The brand book's avoid list, the check's word list and the lettering guards, less the ticker MARINE, which the founder allowed |
| LM2-11 | Propose a ticker, check it on the web, pick a default | RATION in the first pass; MARINE since the founder's decision (decision 10) |
| LM2-12 | Rations and claims, never the other token's words, no prices, dates or addresses, plain sentences | The check's word and shape rules, read as whole paragraphs |
| LM2-13 | Registry row, its line in `registry.test.mjs` | Added; the row needed two schema rules (decision 12) |
| LM2-14 | The old fixture ticker in `example-configurations.ts` becomes EATIT | Done in the first pass, then put back to MARINE in the follow-up (decision 15) |
| LM2-15 | Run `check.mjs` and the registry tests until green | See "Commands and results" |

## Decisions

1. **The look.** Mess night in a panelled mess hall, in version 1's screen-print style: flat inks, a boot-black
   outline, halftone dots, stencil letters. The brand pieces sit on dark walnut panels with cap-white letters and a
   gold line, the rank pictures rotate khaki, crate wood and ration paper, and the story uses ration paper. Navy never
   becomes a ground, so the kit stays clear of Dragon's Hoard's navy and gilt and of the price coin project's blue.
2. **Blue as cloth only, inside the fence.** Dress navy and flannel slate are the only blues. `check.mjs` refuses any
   vivid blue (hue 190 to 250, HSL saturation above 0.45), any color within ΔE 8 (CIEDE2000) of the nine fenced colors
   from the research, any blue that is not a cloth color, any blue darker than dress navy, any blue wall ink, and any
   word lettered in blue, and it renders every picture to prove its wall corners are not blue. Dress navy is the
   closest color to the fence, ΔE 9.74 from the other token's dark ground; flannel slate is ΔE 15.52 away. The mask
   black that cuts stencil bridges is never painted; the check proves it appears inside masks only.
3. **Generic dress.** The research's fact-check warns that a full dress-blues look next to the word marines points
   toward one real service. So the caps carry no emblem, only the kit's own plain gold coin; there is no red stripe,
   no chevron, no medal and no high collar. The marines wear open mess jackets with a bow tie, which many services
   and black-tie dinners share. Counsel sees the look before any public use.
4. **Rank on a place card.** The research suggested rank pips made of coins. Coins are rations here, and more coins
   for a higher rank would contradict equal shares, so each picture names its rank on a folded place card instead.
   Officers' caps are wider with a khaki cord and the General's visor has a khaki edge; nothing else changes with
   rank. Every picture has the same plate with the same one coin.
5. **Nobody eats.** No mouth holds a coin and the bitten coin is gone. The ration waits on the plate, and the props
   are cutlery, cups, a jug, a menu card and a bell, never food piled up.
6. **The motto made true.** "Not selling." is the community's own motto. Here it belongs to a marine that keeps its
   rations, and its literal line says what the rules do: a marine keeps its rations until its owner claims them, and
   nobody else can take them. The first half of the community's longer motto is left out, because the risk lines
   must be read.
7. **One flannel touch.** The research's in-joke shirt is worn by the cook in scene 03, once, as a navy-and-cream
   plaid in dress navy, flannel slate and ration paper. The cook has two braids and freckles and looks like nobody
   real. It is not given to any rank, least of all the General, since the community's top general is a real person.
8. **One quiet seven.** Seven candles stand on the box banner's table. The kit never says why a seven: the
   fact-check rates "seven is the community's lucky number" as an inference. Three sevens in a row are refused.
9. **The Private on the mark.** The research proposed the General. The Private keeps the mark on the equal ration
   and away from any one person.
10. **The ticker MARINE.** The first pass proposed RATION: it says what the box does, it is short, and an
    exact-ticker search found no RATION token (see "Ticker search"). The founder then decided: "we can make the
    ticker $MARINE as well, that is no problem", and "there is no trademark on a ticker." So the ticker is MARINE.
    A LINK-paired token on another chain has used MARINE since mid-September, and the research also lists two MARINE
    tokens on Ethereum, read as data and not checked here. The brand book's ticker section says so once, names that
    chain once and never the token, and asks every live page and post for the chain and the full contract address.
    On Ethereum only the address tells the tokens apart. MARINE and the noun marine share a word, so the brand book
    keeps "the box token MARINE" and "a marine" apart: holding MARINE gives no ration and is not owning a marine.
11. **Royalties 2.5% to the fees.** The founder said royalties feed back to the box (F82 LM5) and named no rate. The
    create page's test data for Link Marines already uses 250 basis points with the destination `fees`
    (`example-configurations.ts:15`, `configurations.ts:59` and `:60`), so the row does the same. A royalty in LINK
    is then split like a buyers' fee.
12. **The registry row.** `link-marines-v2.json` is `pending` on `V21-05` with Keep on both sides as the stand-in,
    template Collection, the four properties of a Keep collection, and royalties 250 to `fees`. The schema refused
    the row twice, so two rules changed in `registry.mjs`, with `schema.json` regenerated as its README says: an id
    part after the first may now hold digits (`link-marines-v2`), and `V21-05` joined the pending steps. The README's
    list of pending steps names it. `V21-05` follows `V21-02` and `V21-03`; the step 5 job is `V21-05-ITEMS-POOL`.
13. **Two registry states.** `check.mjs` accepts the row as it is today, or ready with one inside rule other than
    Keep and Burn on both sides, the shape step 5 adds. It then asks `details.md` to name that rule's value, so the
    docs move with the row.
14. **Words.** Rations and claims, never the words of pay. The other token is never named: the check holds the
    launchpad, chain and site names, and the co-founder's names, as hash prefixes and refuses them everywhere, the
    avoid list included. Prose is read as whole paragraphs, so a phrase broken over two lines is still caught. One
    exception since the follow-up: the brand book's ticker section names that token's chain once, with the day the
    token began, as the follow-up brief asked. The check allows exactly that one name and one date there, and
    nowhere else. The ban on `paid in LINK` became a ban on any `paid in`.
15. **The fixture ticker.** The first pass changed the create page's test data for Link Marines from MARINE to EATIT
    (`08920208`). The follow-up undoes it, since the founder allows MARINE, and the file matches the branch base
    again. Version 1's registry row also says MARINE while version 1's brand book says EATIT, so two registry rows
    now carry MARINE. The registry has no rule against that, and version 1 stays untouched, so it is left as a
    finding (open point 6).
16. **Research marked weak or wrong.** The fact-check corrects where the name began and when the rank ladder came,
    calls the lucky seven an inference, finds the flannel's dating weak, and finds two of the blue-uniform readings
    wrong. The kit states none of these as fact: it says only that the community uses the name, the ranks and the
    motto, and treats the seven and the flannel as nods.
17. **Exact bytes.** `.gitattributes` marks `art/**` and `assignment.json` as `-text`, as in version 1.

## Facts read in the code

| Fact used in the kit | Where |
| --- | --- |
| Fee split into 10, 2 and 3 parts of 15 (2 and 1 to Square Hole); the Items choice books the 10 parts | `packages/contracts/src/box-v2/BoxReceiverV2Base.sol:343`, `:350`, `:351`, `:352`, `:360` |
| The marines' parts are held until graduation, then shared out | `BoxReceiverV2Base.sol:379`, `:395`, `:397` |
| Keep pays the whole share to the item ledger; Burn keeps the inside share for its buy-back | `BoxReceiverV2Base.sol:405`, `:410` |
| A royalty in the fees is split like a buyers' fee | `BoxReceiverV2Base.sol:372`, `:376`; `packages/contracts/src/box/interfaces/BoxTypes.sol:62` |
| Royalty LINK before graduation waits, after it is split, after a failure goes to Square Hole's buy-back; other coins go to the conversion Safe | `packages/contracts/src/box-v2/BoxReceiverV2.sol:18`, `:321`, `:333`, `:334`, `:335`, `:337`; F123 |
| Every item gets the same share of a funding | `packages/contracts/src/box-v2/ItemLedgerV2.sol:249` |
| Claims: current owner only, one id, only outside the vault, no minimum, tip or expiry, credit follows the NFT | `ItemLedgerV2.sol:26`, `:417`, `:426`, `:435`, `:438`, `:444`, `:450` |
| The catch-up step and the leftover flush, open to anyone; no administrator | `ItemLedgerV2.sol:185`, `:393`, `:505`, `:28` |
| Waiting item shares and royalty LINK join the closing pool at failure | `packages/contracts/src/box-v2/interfaces/FailureTableV2.sol:46`, `:48` |
| No owner, admin or setter | `BoxCoordinatorV2.sol:56`, `BoxCollectionV2.sol:37`, `BoxTokenV2.sol:34`, `BoxVaultV2.sol:51`, `BoxLaunchRouterV2.sol:41`, `BoxRegistryV2.sol:21`, `BoxRoyaltyRouterV2.sol:39`, `BoxFactoryV2.sol:40` |
| The collection's `owner()` is a marketplace address with no power | `BoxCollectionV2.sol:129`; `libraries/BoxCollectionV2Args.sol:44` |
| 1% fee on buys and on sales, the sale fee rounded up; the 384-second window | `BoxHookV2.sol:25`, `:32`, `:185` |
| Launch tax from 931,974 to 80,565 millionths in 12-second steps | `BoxLaunchRouterV2.sol:259`, `:290`, `:365`, `:369` |
| Deepen buys the box token with 49.75%; tips at most 5% | `interfaces/ReleaseConstantsV2.sol:31`, `:34` |
| The vault opens at graduation; take-out price rounded up, 1% pick fee burned; the last marine stays | `BoxVaultV2.sol:679`, `:685`, `:686`, `:698`; `libraries/VaultViews.sol:20`, `:21` |
| Put-back by the owner only, rounded down, 5% fee burned | `BoxVaultV2.sol:88`, `:726`, `:732`, `:733`, `:750`; `libraries/VaultViews.sol:27` |
| Anyone fails a box after its deadline, or 7 days after a filled raise closes | `BoxCoordinatorV2.sol:211`, `:212`; `interfaces/ReleaseConstantsV2.sol:56` |
| Failure claims for 365 days | `BoxCoordinatorV2.sol:80` |
| The create page's Collection template | `apps/web/src/features/create/v2/templates.ts:49` |
| Registry royalty destinations | `packages/box-spec/examples/v2/registry.mjs:26` |
| Pending rows are skipped in the browser life | `apps/web/e2e/core-v2-chain/examples.spec.mjs:13` |
| The contract test accepts creator royalties only | `apps/web/e2e/core-v2-chain/examples/forge/ExampleLives.t.sol:150`, `:152` |
| Collections start at id 1 | `packages/box-spec/src/generated/box-spec.v2.ts:27` |

The step 5 job's ticket, read as data, adds a third inside rule, Depth, that sends the share of items still in the
vault into the pool the way Grow does, keeps held items money going to the closing pool on failure, and leaves the
registry folder to this job. The kit follows it and states no more than that.

## Ticker search

Exact-ticker lookups on public trackers, read as data, on the day of this kit's commits. They were run for the first
proposal, RATION. The follow-up ran no search for MARINE; decision 10 cites the research for the tokens that already
use it.

| Ticker | Where | Result |
| --- | --- | --- |
| RATION | DexScreener search for RATION | 32 pairs, none with the symbol RATION or RATIONS |
| RATION | DexScreener search for RATIONS | 16 pairs, none with either symbol |
| RATION | CoinGecko search for ration | No coin with the symbol RATION |
| RATION | GeckoTerminal pool search for ration | 9 pools, none with the symbol; several tokens named Rational |
| RATION | Blockscout search on Ethereum | 16 tokens, none with the symbol RATION; one token named Ration Finance uses the symbol RATIO |
| RATION | Web search for the ticker | No token with that ticker found |
| CHOW | DexScreener search for CHOW | Four live pairs of a token with the symbol CHOW on one chain |
| CHOW | Web search for the ticker | Two more CHOW tokens listed on trackers, one of them on another chain |
| MESS | DexScreener search for MESS | 32 pairs, none with the symbol MESS |

An empty search is not clearance: a token can appear any day, and no trademark search was run.

## Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node examples/boxes/link-marines/check.mjs` (repository root, version 1, before and after) | Exit 0: 649 checks passed both times |
| `node build-art.mjs`, twice, with a SHA-256 of every file in `art/` after each | Built 24 SVG and PNG pairs and `art/logo-48.png`; all 49 hashes match, so the build is repeatable |
| `node assign.mjs > assignment.json` | 420 marines in 35 squads; every rank 35 times; id 1 a Private, id 420 a General |
| `node check.mjs` before the docs existed | Exit 1 as expected: 141 problems, all missing docs and the entries they carry, and one real finding, the mask black near a fenced dark, now exempt and proven unpainted |
| `node check.mjs` final | Exit 0: 905 checks passed (12 ranks, 7 scenes, 420 marines) |
| 36 mutation runs of `node check.mjs`, and one control | Each mutation exit 1 with the expected FAIL line, the control exit 0; see the list below. A scratch script saved every touched file, restored it byte for byte, and a SHA-256 of the whole kit folder matched the one taken before |
| `gitleaks dir` on the kit, the registry folder and the fixture folder (repository root) | Exit 0 each, no leaks found |
| `pnpm check:handoff` (repository root) | Exit 0: both handoff folders match their hashes |
| `git diff kit-link-marines-v1 -- examples/boxes/link-marines` (repository root) | Empty: version 1 is byte for byte its tag |
| `node --test packages/box-spec/examples/v2/registry.test.mjs` (repository root) | Exit 0: 3 of 3 tests pass with the new row; 3 of 3 before it |
| `./node_modules/.bin/vitest run --project web apps/web/src/features/create/v2` (repository root) | 166 of 167 pass with EATIT, and the same 166 of 167 with the old ticker put back; the one failure is the frozen-enum test for `Dest`, below |
| `./node_modules/.bin/eslint examples/boxes/link-marines-v2 packages/box-spec/examples/v2` (repository root) | Exit 0, after removing four unused names it first flagged |

The mutations: a banned word, an em dash, a pay word, the other token's phrase for payouts, the other token's
ticker on its own, a never-named person, a mascot's name outside the avoid list, a vivid blue shade, a darker navy, a blue wall ink, a
word lettered in navy, a second flannel, a second count of seven candles, three sevens lettered, the rank line left
out, a changed motto line, a hand-edited SVG, a changed assignment, a three-sentence caption, a wrong contrast number,
a coin amount, a year, a not-this-but-that turn, a missing scene, the ranks out of order, a doc link to a missing file,
words too close to an edge, the mark pushed into its clear space, a candle in the avatar corner, a palette color
missing from the brand book, a named color, a color defined outside `src/palette.mjs`, and through
`LINK_MARINES_V2_REGISTRY` a row with Burn on one side, another ticker, no royalties, and the step 5 shape, which
passes the state rule and then asks `details.md` for its new value.

**A red that is not this kit's.** `apps/web/src/features/create/v2/spec-types.test.ts` fails on this branch's base:
`packages/contracts/src/box-v2/interfaces/RecipeTypes.sol:9` names `Dest` 7 `BudgetOrPile`, and
`apps/web/src/features/create/v2/spec-types.ts:17` names it `RESERVED_7`. With the old fixture ticker put back, the
same single test fails, so the ticker change is not its cause.

No contract or app source changed, so Forge, `pnpm typecheck`, `pnpm verify` and E2E were not run. No server was
started, nothing was downloaded, and nothing was pushed.

### The follow-up's commands and results

| Command | Result |
| --- | --- |
| `node check.mjs` before the follow-up (control) | Exit 0: 905 checks passed, with `paid in it` still in `details.md` |
| `node build-art.mjs` after the ticker change, with a SHA-256 of every file in `art/` before and after | All 49 hashes identical |
| `node build-art.mjs` after the picture fixes | 10 files changed, the SVG and PNG of scenes 01, 02, 04, 05 and 07; the other 39 are identical. A second build matched all 49 hashes |
| `node check.mjs` final | Exit 0: 907 checks passed (12 ranks, 7 scenes, 420 marines). The ticker section adds three checks, and the refusal of a lettered MARINE is gone |
| A scratch clearance tool over all 36 blocks of lettering | Each block is rendered alone to know its own pixels, and an exact distance transform gives the free gap to the nearest other boot black and to the highlight colors. The numbers before and after are in "The follow-up" above. Every block now keeps at least 10 px, except CLAIM, whose pointer touches it (1.0 px) because it presses the button |
| 51 runs of `node check.mjs` with one change each | 49 mutations each exit 1 with the expected FAIL line, and 2 controls exit 0: a doc line with MARINE alone, and the unchanged row. The earlier ones that still apply, 31 file changes and 4 row changes, fail as before: the one for the other token's ticker on its own went with its rule, the coin amount now uses MARINE, and the row's other ticker is now RATION. New, as 14 file changes: `paid in` put back twice, the other chain named in `details.md`, in this record and twice in the ticker section, the launchpad named there, the chain left out, the section missing, a second date in it, a date elsewhere in the brand book, the address rule left out, RATION back in the brand book and in `details.md`, and MARINE lettered on a sign, which builds and fails only as a changed SVG. A SHA-256 of the kit folder and the row matched before and after |
| `node --test packages/box-spec/examples/v2/registry.test.mjs` (repository root) | Exit 0: 3 of 3 |
| `./node_modules/.bin/vitest run --project web apps/web/src/features/create/v2` (repository root) | 166 of 167 pass with MARINE back; the one failure is the same frozen-enum test for `Dest` |
| `node examples/boxes/link-marines/check.mjs` and `git diff kit-link-marines-v1 -- examples/boxes/link-marines` (repository root) | Exit 0 with 649 checks, and the diff is empty |
| `./node_modules/.bin/eslint` on the kit, the registry folder and the fixture file (repository root) | Exit 0 |
| `gitleaks dir` on the kit, the registry folder and the fixture folder (repository root) | Exit 0 each |

The frozen-enum red is inherited: `git diff 36efa916` of `RecipeTypes.sol`, `spec-types.ts` and `spec-types.test.ts`
is empty on this branch.

## Visual review

- All 12 rank pictures were compared on contact sheets: one family, each told apart by face, hair and prop. The
  first build hid every pair of eyes under the visor; the visor was raised and the eyes moved down. The Captain's
  teapot and the Major's jug first covered faces and were made smaller.
- All seven scenes were checked at full size. The cook's flannel first sat behind the table and the cook was raised;
  the cook's sleeve then showed slate below the cloth and now starts behind it, in the same plaid. The cloche in
  scene 04 first covered the Lieutenant's face and now lifts to the side. A sign's words first ran past its board,
  so signs now shrink their words to fit.
- The logo at a real 48 px still reads as a white cap with a gold dot, a face and a navy jacket on a khaki patch.
- On the X banner, the corner at x 0 to 420 and y 270 to 500 holds only bare wall, proven pixel by pixel.
- No browser, X upload or platform crop test was done.
- In the follow-up, the five changed scenes were checked at full size and in close crops. NOT SELLING. sits inside
  its bubble with room on both sides at its old size. The jar's highlight is a short bar near the glass's left side,
  clear of CLOSING, the coins and the dog tag's arrow. The tureen's crescent follows the bowl, clear of the R. The
  crate's 420 is a little smaller and clear of both braces. The other 19 pictures are byte-identical to the first
  pass.

## Limits and open points

1. The ticker. Default: MARINE, the founder's decision. Counsel has not looked at it, and other tokens already use
   it (decision 10).
2. The royalty rate. Default: 2.5% into the fees, as the create page's test data has it.
3. The look next to the word marines. Default: keep dress navy and white caps with no emblem, and show counsel the
   cover and one marine first.
4. Dress navy sits ΔE 3.4 from the navy of a fan poster. Default: keep `#1F2B47` as chosen, since navy is a generic
   dress color and nothing else from that poster appears.
5. The step id. Default: `V21-05`; rename it on merge if the step 5 job names its step otherwise.
6. Version 1's registry row carries MARINE, which is now version 2's ticker, while version 1's brand book says EATIT.
   Default: change version 1's row to EATIT when version 1 is next touched, with version 1's brand book.
7. No guard in `check.mjs` holds the inner padding; the follow-up measured it with a scratch tool. Default: leave it.
   A later pass can let signs, bubbles, crates and the jar record their inner boxes, as `lettering()` records its
   words, so the check can hold a set gap.
8. CLAIM's pointer touches the bottom of its letters (1.0 px) in scene 04. Default: keep it, since the pointer presses
   the button.

- Counsel cleared the name only, as the founder reports it. The joke, the look, the "not affiliated" line, the item
  payouts, the ticker and the kit's license still need counsel.
- Step 5 is not built yet. Until it lands, the row stays pending and the real recipe has no test life.
- The registry still points at the local test pictures. Using this art needs the metadata and hosting step, with the
  deployed collection on ids 1 to 420.

## Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-LINK-MARINES-V2.md` when merging.
2. When step 5 lands, set the row ready with its inside rule on both sides, add `pool-growth` if its life proves the
   deeper pool, and name the new value in `details.md`; `check.mjs` then passes again.
3. Let the example lives' contract test accept royalties to `fees` before the row turns ready.
4. Merge the registry change with care on the v2.1 line: there the test file expects no pending rows at all.
5. When wiring the art, build the metadata from `assignment.json` and confirm the collection ids run 1 to 420.
6. Check the three font licenses when the site self-hosts them, and choose the open-source license for the kits.
