# SH-KIT-PAPER-CERTIFICATES work record

Kit agent for box id `paper-certificates` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree,
from base `3c186c85`. The brief limits work to `examples/boxes/paper-certificates/`, and the task added one exception.
The box had no registry row, so this agent created `packages/box-spec/examples/v2/paper-certificates.json`. The
registry's own test pins the set of pending rows, so one line of `packages/box-spec/examples/v2/registry.test.mjs` names
the new row too. Nothing else outside the kit folder changed. The record sits here, and the integrator can copy it to
`docs/evidence/` as the project rules ask.

## Requirements and files

| ID | Requirement | Result |
| --- | --- | --- |
| PC-01 | Read the brief, the box's settings, the research and the founder's notes | Read the brief; the registry README, schema, validator, test and every row; the Paper Certificates entry and the gold notes of the round 2b research; the F89 check (its Paper Certificates check and its default for item payouts); F88, F89, F109, F122, F127 and F133; the Occam check; the step 2 design; the counsel pack (questions 8, 31, 32, 33, 34); the contracts, keeper and create page code listed below; the v2.1 site line's fee choices. Read the Frog Kiln kit as the finished kit to match, and looked at all seven finished covers to keep the looks apart |
| PC-02 | A registry row in the same format, pending where needed | `paper-certificates.json`: valid against `registry.mjs`; `pending` on `V21-02` with a reason naming the v2.1 site and the listings; LINK and items paid in LINK as stand-ins; Burn for the buyers as on the real box |
| PC-03 | README with the file list | `README.md` lists every file and folder, both editions, the twelve certificates with their counts, the dealing rule, the seed rules and the export; `check.mjs` enforces the list |
| PC-04 | Brand book | `brand-book.md`: both names, SCRIP, the joke, both cover lines with the literal line, the story hook, voice with eighteen example lines, seventeen colors, three OFL fonts with fallbacks, the seal's construction and clear space, the certificates, the hidden picture, do and don't, a contrast table the check recomputes, homage and IP rules |
| PC-05 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each, the same words as `src/scenes.mjs`, and a pointer to the paper edition's scenes |
| PC-06 | Details in plain words | `details.md`: every setting with its stand-in, where each side's fees go, what a SCRIP holder and a certificate owner get, risks, and what waits for counsel, v2.1, the listings and the launch |
| PC-07 | Art notes | `art-notes.md`: every source file, the look, the engraver's alphabet, the guilloche, the certificate's anatomy, the twelve certificates, story symbols, scenes and brand pieces, the hidden picture, rules for extending |
| PC-08 | Clean vector art with local PNG exports | 35 SVG and PNG pairs plus `art/logo-48.png`, rendered by `@resvg/resvg-js` 2.6.2 with system fonts off |
| PC-09 | 8 to 12 variants and a deterministic assignment | 12 variants; `assign.mjs` deals them to the ids 1 to 1,929 from a seed; `assignment.json` is the example under a public seed |
| PC-10 | `check.mjs` that verifies files and pixel sizes, and run it | Done; see the results |
| PC-11 | Original art, no promise words, no names of the platform's own token or collection, plain writing | Word, shape and name scans in `check.mjs`, a palette scan of every SVG, and a manual read of every doc |
| PC-12 | Both editions, the gold one first; never say a stock or gold is burned | The gold edition fills `art/`, the paper edition `art/paper/`; `check.mjs` refuses any sentence that burns a stock or the gold coin, and the price coins are never named |
| PC-13 | Joke companies, never real ones, with twelve blue chips | Nine invented companies, including the founder's two examples, and three blue chips that make actual blue chips; no real company, brand or exchange is named or drawn |

## Decisions

1. **The look.** An engraved share certificate drawn in code: cream paper, one ink per certificate, tone made of
   hatching and ruled lines, guilloche bands and rosettes for frames, a red wax seal or a gold foil seal. It is a light
   ground like Frog Kiln's, and the two still read apart at a glance, because this kit draws with fine engraved lines
   and colored frames where Frog Kiln uses flat glazes and soot outlines. The other kits are plum, maroon, olive, navy,
   green LED and neon.
2. **One choice per side.** The research's design split the buyers' side between a burn and the certificates and burned
   the sellers' side. Core v2 offers one fee choice per side. The F89 check's own default for the simpler form is
   followed: the buyers' coins buy SCRIP and burn it (`burn`), and the certificates are paid from the sellers' side
   (`items-t` with the inside share burned). So the sellers' SCRIP is burned only for the certificates still inside.
   This is open point 1.
3. **Never a stock or gold in the fire.** No fee choice that burns or `eat`s the price coin is used. Every kit text
   says "burned" only of SCRIP, and a few lines say plainly that no fee burns the gold coin. A scan in `check.mjs`
   makes sure no line says that a price coin or a stock is burned.
4. **Two editions, one kit.** Gold Certificates, priced in the gold coin, comes first; Paper Certificates, priced in
   the index coin, follows. A box's price coin is fixed at creation, so each edition is its own box. They share SCRIP,
   the seal, the hidden picture and the twelve certificates. Each has its own name, cover line ("Gold in, paper out."
   and "Stock in, paper out."), price coin in the pictures and frame color (gold or bond green). The registry row
   describes Gold Certificates.
5. **The price coins have no names.** The kit says "the gold coin" and "the index coin". The research names the coins,
   their issuers, the index and the fund, and the kit does not. `check.mjs` keeps the first 16 hex digits of the
   SHA-256 of each refused name, so not even the check spells them. The pictures draw the gold coin as a gold disc with
   a small bar, and the index coin as a steel disc with a basket.
6. **The certificates.** Nine companies are puns on trading words with a trade that fits (Bagholder & Sons and Exit
   Liquidity Partners LLP from the founder, then Long Wick Candle Works, Rumor Mill Flour Co., Sell the News Printing
   Co., Sideways Crab Shipping Co., Slippage Banana Co., Dip Buyers Fondue Co. and Margin Call Telephone Co.). The
   twelve blue chips are three companies that make actual blue chips (Blue Chip Chip Shop, Blue Chip Wood Chip Co.,
   Blue Chip Paint Chip Co.), 4 certificates each, printed in blue with a gold seal and a BLUE CHIP ribbon. Every
   certificate says THIS CERTIFIES NOTHING, the joke and the disclaimer at once.
7. **Hidden art needs a secret order.** The research shows the certificates as sealed envelopes until drawn, so the
   art mode is `hidden`. `assign.mjs` ranks the ids by the SHA-256 of a seed and the id, and deals 213 of each company
   and 4 of each blue chip down the ranking. The kit's `assignment.json` uses a public example seed. The real list needs
   a secret seed of at least 32 characters, and `--folder` writes the files outside the kit, never to the terminal.
8. **Each certificate has its own number.** The real files print each item id in red in the number box (Nº 1,929);
   the kit's variant pictures print the specimen number 0. `check.mjs` proves that a number changes only the number
   box, so the variant pictures stand for the real files. This makes `--folder` render each file instead of copying.
9. **A coupon is the picture of SCRIP.** Old certificates carried coupon sheets, so every certificate has five coupons
   and SCRIP is drawn as a lilac coupon. Every text that says coupon says SCRIP next to it. Counsel may prefer another
   word, as `details.md` says.
10. **The story's symbols.** An iron safe marked 1,929 is the box, a balance scale is the box's own pool (it holds both
    coins and swaps one for the other), a pot-belly stove burns SCRIP, a wooden collection box takes Square Hole's
    parts, and a tin cash box is the closing pool. Fire appears only in the stove and on a burning coupon.
11. **The registry row.** This branch's registry has no `items-t` choice and no gold coin. The row is `pending` on
    `V21-02`, and its reason names the v2.1 site and the listings. LINK stands in for the gold coin (an 18-decimal
    listed coin), and items paid in LINK with the inside share burned stand in for items paid in SCRIP. The template
    is Collection that burns, the label `Certificates`, the size `1929`, the art `hidden`, the pick fee 1%, the
    deadline 30 days, royalties off. The registry test pins the pending set, so its line now names the row.
12. **The hidden picture.** One picture shows on chain for every sealed certificate and ticket, at most 4,096 bytes of
    printable ASCII. `src/hidden.mjs` draws the sealed envelope by hand in whole numbers, 1,643 bytes.
13. **Own letters, named fonts.** Every letter in the art is drawn by the kit's engraver's alphabet: thin skeletons
    stroked with an oval pen under a stretched transform. Live text names three OFL families (Old Standard TT, Libre
    Franklin, Cutive Mono). No font was downloaded, so their license files were not read here.
14. **Size.** The art is about 15 MB: two editions, twelve detailed certificates and many fine lines. The security
    tint is one pattern tile that repeats without a seam, the scenes have no tint, and long curves use one decimal, which brought the art
    down from 22 MB.
15. **No raise number and no address.** The kit repeats no raise and writes out no address. SCRIP is not cleared.
16. **Square Hole's 3 of 15 parts are one line.** The kit says "3 parts go to Square Hole (its platform and its
    buy-back)" and does not split that share further. A legal read asked the line to say where the share goes. In the
    Terms and in the code, 2 of the parts go to Square Hole's buy-back and 1 to its platform. What a failed box has left
    when its claims close goes to that buy-back, and the kit says so. It never names what the buy-back buys.
17. **Exact bytes.** `check.mjs` compares every SVG and PNG with a fresh build. `.gitattributes` marks `art/**` and
    `assignment.json` as `-text`.

## Facts read in the code

| Fact used in the kit | Where |
| --- | --- |
| Fees in the price coin on both sides, 1% | `packages/contracts/src/box-v2/BoxHookV2.sol:25` |
| 15 parts: 10 for the choice, 2 and 1 to Square Hole, 2 to the pool | `BoxReceiverV2Base.sol:343`, `:350`, `:351`, `:352` |
| Dust to the pool while live in a box with item payouts, to Square Hole's buy-back after a failure | `BoxReceiverV2Base.sol:284` to `:287`, `:344` to `:349` |
| Burn is choice 2 and items in the box token choice 8 | `interfaces/RecipeTypes.sol:5` |
| Burn books the buyers' 10 parts for the buy step; items in the box token book them as pending price coin | `BoxReceiverV2Base.sol:359`, `:361` |
| The buy step: after graduation, one protocol step a block, a minimum, turns among the queues, burns what it bought | `BoxReceiverV2.sol:87`, `:96`, `:97`, `:100`, `:103`, `:116` |
| Items in the box token: the inside share kept back and burned, the outside share sent to the item ledger as SCRIP | `BoxReceiverV2.sol:138`, `:145`; `BoxReceiverV2Base.sol:410`, `:413`, `:415` |
| A refused burn waits, and anyone can run it again | `BoxReceiverV2.sol:203` to `:205`; `BoxReceiverV2Base.sol:509` |
| Tips at most 5% under a cap for each box; the collect tip only from buyers' batches | `BoxReceiverV2Base.sol:315`, `:469`; `interfaces/ReleaseConstantsV2.sol:34` |
| The 49-tick price limit and the 7-day escape | `interfaces/ReleaseConstantsV2.sol:28`, `:56` |
| The pool step: a tip, then 49.75% buys SCRIP and the rest goes in as liquidity | `BoxHookV2Extension.sol:278`, `:279` |
| Failure sends the pending item money, the burn budget and the pool share to the closing pool | `BoxReceiverV2.sol:287`, `:295`, `:297` |
| Equal parts, counted at each funding; tickets out from their start; a handed-back ticket's part burned | `ItemLedgerV2.sol:249`, `:257`, `:261`, `:306`, `:311`, `:395` |
| Claims: current owner only, one id, only while out, no minimum, tip or expiry, unpaid credit follows the NFT | `ItemLedgerV2.sol:26`, `:421`, `:426`, `:435`, `:444`, `:450` |
| Draw fee 1%, put-back fee 5%, fees burned, picks only for revealed ones that came back | `BoxVaultV2.sol:87`, `:88`, `:787`, `:788`, `:875`, `:876` |
| The last certificate stays; prices round up for take-outs and down for put-backs | `libraries/VaultViews.sol:20`, `:21`, `:27` |
| Reveal fallback and unrevealed put-back after 30 days | `BoxTicketsV2.sol:72`, `:77` |
| Draws after graduation, each paying the random round's posting, the first one for the round | `BoxTicketsV2.sol:245`, `:272` |
| The launch tax waits for graduation, or goes to the failure claim | `BoxLaunchRouterV2.sol:187`; the 6.4-minute window at `BoxHookV2.sol:32` |
| Failing after the deadline or 7 days after a filled curve; claims for 365 days | `BoxCoordinatorV2.sol:80`, `:211` |
| The keeper runs the buy step and the pool step in turn, the burns and the leftover burn | `packages/keeper/src/plan.ts:121`, `:151` to `:156`; `packages/keeper/src/pay-in-t-v21.ts:9`, `:10`, `:20` |
| The create page: five fee choices on this branch, Collection that burns, special series, four teasers, its own hidden picture | `apps/web/src/features/create/v2/recipes.ts:6`; `v2/templates.ts:50`; `create-model.ts:114`, `:116`, `:117`, `:511` |
| Item files `1.png` to `N.png`, each at most 1 MiB; up to 2,000 items in a traits file | `apps/web/src/features/create/art-files.ts:5`, `:31`; `packages/artwork/src/limits.ts:22` |
| The v2.1 site line offers "To items" paid in the box token | `git show sh-v21-fe12:apps/web/src/features/create/v2/recipes.ts`, lines 13, 33, 56 to 60 |
| The idea, the 1,929 certificates, joke companies, blue chips, sealed envelopes, the gold stand-in | `docs/research/round2b-stonks-rwa-memes-defi.md:546` to `:554` |
| No stock burned; buyers buy SCRIP and burn it; certificates paid from the sellers' side | `docs/research/core-v2-m1-inputs/f89-check.json`, `checks[1]` and `synth.coreDeltas[13].default` |
| The founder's notes and decisions | `docs/decisions/DECISION-LOG.md:103`, `:104`, `:124`, `:137`, `:142`, `:148` |
| Counsel questions on draws, listings, stock coins, issuers' powers and item payouts | `docs/legal/counsel-pack-2026-10.md:1816`, `:2093`, `:2102`, `:2118`, `:2126` |

## Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node --input-type=module` with `validateExample` on the new row (repository root) | Valid |
| `node --test packages/box-spec/examples/v2/registry.test.mjs` (repository root) | Fail before the test line (the pinned pending set), pass after it: 3 of 3 |
| `node build-art.mjs` | Exit 0: 35 SVG and PNG pairs and `art/logo-48.png`, in about two and a half seconds |
| `node build-art.mjs` twice, then a SHA-256 of every file in `art/` | All 71 hashes match, so the build is byte for byte repeatable |
| `node assign.mjs > assignment.json` | 1,929 items; nine variants of 213 and three of 4 |
| `PAPER_CERTIFICATES_SEED=<32 random bytes> node assign.mjs --folder <scratchpad>` | Exit 0 in 147 seconds: 1,929 PNGs, `traits.csv` and the private list; the right counts; 1,718 of 1,929 ids differ from the example; 558 MB in all, the largest PNG 326,392 bytes |
| The create page's `parseAttributes` and `itemIdFromFileName` on that folder (Vitest, scratch config) | Pass: 1,929 trait rows and 1,929 item ids |
| `node check.mjs` | Exit 0: 1,209 checks passed (12 variants, 7 scenes in each edition, 1,929 certificates), in about three seconds |
| Forty mutation runs of `node check.mjs` | Each exit 1 with the expected FAIL line, and the kit's SHA-256 matched before and after. The first round caught 34 of 38 and showed three gaps, all fixed (see below) |
| `./node_modules/.bin/eslint examples/boxes/paper-certificates packages/box-spec/examples/v2/registry.test.mjs` (repository root) | Exit 0, after fixing the four unused names it flagged |
| `pnpm check:handoff` (repository root) | Exit 0 |
| `gitleaks dir` on the kit, the registry row and the registry test | Exit 0 each, no leaks found |

The mutations: a word from the avoid list, an em dash, a wrong PNG size, a changed assignment, a three-sentence
caption, a hand-edited SVG, the platform token's name, a coin amount, the gold coin's name in a doc, the index's name
in a doc, an exchange's name in a certificate's lettering, a color defined outside the palette, a stray color in an SVG,
a gradient in an SVG, a hidden picture over 4,096 bytes, a hidden picture with a line break, the seal pushed into its
clear space, a coin in the avatar corner, a missing scene, a doc link to a missing file, a palette color missing from
the brand book, a wrong contrast ratio, words too close to an edge, a `not X, but Y` turn, a short seed accepted, a
private folder inside the kit allowed, counts that do not add up, an id rule that accepts leading zeros, a year in a
doc, a caption that differs from its scene, a registry row with another recipe (read through
`PAPER_CERTIFICATES_REGISTRY`), a sentence that puts the gold coin in the fire, the same sentence and an avoided phrase each wrapped over two lines, a
top-level await in `assign.mjs`, a number printed outside its box, an emoji, an address, a variant missing from the
README table, and a source file missing from the art notes.

The gaps from the first round, and one found before it:

- `assign.mjs --folder` failed on its first real run with an unsettled top-level await (exit 13). It awaited `main()`
  at the top level while `src/items.mjs`, which it loads for the render, imports `assign.mjs` back, so the module never
  finished loading. `main()` now runs without a
  top-level await. The check had passed, because it only tried the refusals. It now runs a real export with
  `--sample 2` and compares `1.png` with a fresh render, and the top-level await mutation is caught.
- A stray color or a gradient hand-edited into a committed SVG was only reported as stale. The palette check now also
  reads each committed SVG that differs from the fresh build.
- Counts that did not add up crashed the check with a stack trace. Dealing now stops with a clear message, and the check
  reports it as one failure.
- The first art-notes mutation renamed a file that is named twice in the notes, so the check rightly passed. The
  mutation now uses a file named once.
- This record's own first draft showed that the scan that keeps stocks and the gold coin out of the fire read one line
  at a time, so a sentence wrapped over two lines could slip through. Phrases and those sentences are now read across line breaks, and two wrapped
  mutations prove it.

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest suites, Forge, `pnpm verify` and the E2E lives
were not run. `pnpm e2e:examples --list` was not run either, to stay clear of anything that could start the local
stack; the registry test above and the `test.skip` for pending rows in `apps/web/e2e/core-v2-chain/examples.spec.mjs`
cover the new row. No server was started, nothing was downloaded, and nothing was pushed.

## Visual review

- The engraver's alphabet was tried with an upright and a tilted pen. The 15-degree tilt gives thick \ strokes and thin
  / strokes, as in an old Roman, and the letters were spaced wider after the first proof, where serifs touched.
- The certificates were compared on contact sheets at full size and at 400 px. All twelve read as one set and are told
  apart by ink, vignette and name. Fixes after the first sheet: rosettes with three lobes that looked like a play
  button, a wax seal rosette with the same problem, signatures that looked like grass (now slanted cursive loops), a
  banana bunch that looked like a fan of feathers, a banana peel that looked like a flower, a crab too small to read,
  a weak telephone, a ribbon whose words fell off its curve (now straight), and a signature that ran into a corner
  medallion.
- The seal's white lacework did not render at first. The guilloche band along a circle had straight parts of no
  length, which gave no direction, and they are now left out.
- All seven scenes were checked at full size in both editions. Fixes: an arrow that crossed the 1,929 on the safe, a
  tag that sat on an arrow, an arrow into the stove whose head hid behind the stove, a U-shaped arrow out of the scale,
  and arrows that crossed the SELLERS tag in scene 7 (the trays now stand on both sides of the cash box).
- The logo at a real 48 px still reads as a gold seal with a dark S. On both X banners, the corner at x 0 to 420 and
  y 270 to 500 holds only bare paper, proven pixel by pixel. On the cover, the name ran into the certificates, and the
  art moved right.
- No browser, X upload or platform crop test was done.

## Limits and open points

1. Which side pays the certificates. Core v2 has one fee choice per side, so the research's split cannot be built as
   written. Default: the buyers' coins buy SCRIP and burn it, and the sellers' coins buy SCRIP for the certificates with
   the inside share burned, as the F89 check proposed. The other way round (buyers pay the certificates, sellers burn)
   is one registry change and a few lines of text.
2. The second edition's ticker. Each edition is its own box. Default: Gold Certificates launches as SCRIP; if Paper
   Certificates later launches beside it, it takes its own ticker, such as STUB.
3. Who posts the reveals. The creator keeps the reveal file and the seed. Default: the founder keeps both offline, and
   a small reveal bot posts each entry when its certificate is drawn.

- Counsel still has to look at the joke certificates and the "not a share" line, the names Gold Certificates and Paper
  Certificates, the company names and SCRIP, the word coupon, paid random draws with blue chips, the certificates' part
  of the fees, the price coins and the kit's publication license.
- The registry still points at the local test pictures. Using this art needs the metadata and hosting step, with the
  deployed collection on ids 1 to 1,929. The real files take about 560 MB.
- The art is about 15 MB, more than the other kits, because it holds two editions.

## Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-PAPER-CERTIFICATES.md` when merging.
2. Keep the registry row and its test line together, and promote the row only with the v2.1 site, step 2 and the gold
   coin's listing. `check.mjs` passes with either form.
3. Make the real list with a secret seed through `assign.mjs --folder`, outside the repository, and never commit it.
4. Check the three font licenses when the site self-hosts them.
5. Choose the open-source license for the kit collection before publishing it.

## Check fix for the files an operating system adds

`check.mjs` failed when Finder added a `.DS_Store` file to a folder of the kit, and a `Thumbs.db` or `desktop.ini`
from Windows would have failed it the same way. Every folder listing in it now skips those files, and nothing deletes
them. The change is in commits `fdd30c10` and `0e7ccdc2`, made on the same branch from `fd586423` for all nine kits,
inside `check.mjs` only. The second commit adds `.directory`, `.AppleDouble`, `.Trash-` folders and `__MACOSX`. All
commands ran with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node check.mjs` before the change | Exit 1: 1 problem, `art/ holds files no source builds: art/.DS_Store`, with 1208 checks passed. Finder had put that file into `art/` |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the change | Exit 1: 12 problems, such as `src/Thumbs.db is not described in art-notes.md`. All nine kits failed |
| The same on a fresh copy after the change | Exit 0: 1209 checks passed, the same count as in the tree. All nine kits passed |
| The fresh copy with a stray `art/stray.png` added | Exit 1: `art/ holds files no source builds: art/stray.png`. A file of any other name still fails |
| A fresh copy with `.directory`, `.AppleDouble`, `.Trash-1000` and `__MACOSX` added too, after the second commit | Exit 0: 1209 checks passed. With the first filter, this kit stopped with `EISDIR` on `src/.AppleDouble`. |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` (repository root) | Exit 0 |
| `node check.mjs` final | Exit 0: 1209 checks passed |

## Word-free reference pictures

The explainer pipeline needs each kit's world as a reference picture with no words in it. `build-art.mjs --no-words`
writes the gold edition's `cover.png`, `box-banner.png` and `scenes/scene-01.png` to `scene-07.png` to
`art/reference/`, and the paper edition's to `art/reference/paper/`: the same pictures with every word, number and
mark of the engraver's alphabet left out. `withoutWords` in `src/type.mjs` makes `letter` and `shadowed` draw nothing
and put nothing in `DRAWN` while `measure` still sizes every block, so the tags, the safe's plate and the certificates
keep their place, blank. Only PNGs are written, because the SVG titles and descriptions name words that are no longer
drawn. The certificates' signatures appear only in the item pictures, which get no reference. `check.mjs` refused the
new files at first, because nothing may sit in `art/` that no source builds; its expected set now also holds every path
that `references()` in `build-art.mjs` builds. All commands ran from the kit folder with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node build-art.mjs`, then `git status --short`, before the change | No file changed: the committed art is a fresh build |
| `node build-art.mjs` after the change, then `git status --short` | Only the two source files changed. The sha256 of all 71 art files match commit `aa22b629` |
| `node check.mjs` with the 18 PNGs in place, before the check change | Exit 1: 1 problem, `art/ holds files no source builds:` and the 18 paths |
| `node check.mjs` after it | Exit 0: 1209 checks passed, the same count as before; 1210 with these docs, whose new README link it also checks |
| A copy of `cover.png` put in as `art/reference/scenes/scene-08.png`, then `node check.mjs` | Exit 1: `art/ holds files no source builds: art/reference/scenes/scene-08.png`. The copy was removed |
| `node build-art.mjs --no-words`, twice | Exit 0: 18 PNGs, the same bytes both times |
| `node build-art.mjs --nowords` | Exit 1: unknown option, nothing written |
| `DRAWN` after building both editions' normal covers, box banners and scenes, then after `references()` | 150 blocks of lettering, then none |
| OCR net from the explainer playbook: `tesseract <png> - --psm 11 tsv`, tokens of 2 or more letters, digits, dollar or percent signs at confidence 70 or more | The 18 normal pictures: 154 hits, such as CERTIFICATES, SIDEWAYS, CRAB and BUYERS. The 18 word-free ones: 2, `iN` in scene 02 of each edition, read into the pin, string and edge of the blank tag that held the 2 |
| Each word-free picture looked at next to its normal one, and the box banner's twelve certificates at full size | No lettering left; every other shape in place |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/paper-certificates` (repository root) | Exit 0 |
