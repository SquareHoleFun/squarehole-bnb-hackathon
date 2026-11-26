# SH-KIT-FROG-KILN work record

Kit agent for box id `frog-kiln` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree, from base
`cad030b3`. The brief limits work to `examples/boxes/frog-kiln/`, and the task added one exception. The box had no
registry row, so this agent created `packages/box-spec/examples/v2/frog-kiln.json`. The registry's own test pins the
set of pending rows, so one line of `packages/box-spec/examples/v2/registry.test.mjs` names the new row too. Nothing
else outside the kit folder changed. The record sits here, and the integrator can copy it to `docs/evidence/` as the
project rules ask.

## Requirements and files

| ID | Requirement | Result |
| --- | --- | --- |
| FK-01 | Read the box settings, registry notes, research and founder notes | Read the registry README, schema, validator and test, every row, and the v2.1 line's registry (`sh-v21-fe12`); the Frog Kiln entry in the round 2b research; F89, F109 and the later decisions in the decision log; the Occam check; the step 1 and step 2 designs; the counsel pack (questions 8, 31 and 34); the contracts and keeper code listed below; the create page's hidden-art, templates, specials and art-file code. Read the Link Marines kit as the finished kit to match, and looked at all six finished covers to keep the looks apart |
| FK-02 | A registry row in the same format, pending if it cannot run today | `frog-kiln.json`: valid against `registry.mjs`; `pending` on `V21-02` with a reason naming the v2.1 site and the listing; LINK, Burn and items paid in LINK as stand-ins |
| FK-03 | README with the file list | `README.md` lists every file and folder, the counts and the seed rules; `check.mjs` enforces the list |
| FK-04 | Brand book | `brand-book.md`: name, ticker, joke, cover line and its literal line, hook, voice with fifteen example lines, thirteen colors, three OFL fonts with fallbacks, logo construction and clear space, the hidden picture, do and don't, a contrast table the check recomputes, homage and IP rules |
| FK-05 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each, the same words as `src/scenes.mjs` |
| FK-06 | Details in plain words | `details.md`: every setting with its stand-in, where each side's fees go, burned or locked, the buy step for the toads, tickets, draws, picks and reveals, what a holder and a toad owner get, risks, and what waits for counsel, v2.1, the listing and the launch |
| FK-07 | Art notes | `art-notes.md`: the look, the studio and kiln, the loop-tool alphabet, how a toad is built, the twelve toads, story symbols, scenes and brand pieces, the hidden picture, rules for extending |
| FK-08 | Clean vector art with local PNG exports | 25 SVG and PNG pairs plus `art/logo-48.png`, rendered by `@resvg/resvg-js` 2.6.2 with system fonts off |
| FK-09 | 8 to 12 variants and a deterministic assignment | 12 variants; `assign.mjs` deals them to ids 1 to 420 from a seed; `assignment.json` is the example under a public seed |
| FK-10 | `check.mjs` that verifies files and pixel sizes, and run it | Done; see results |
| FK-11 | Original art, no promise words, no names of the platform's own token or collection, plain writing | Word, shape and name scans in `check.mjs`, a palette scan of every SVG, plus a manual read of every doc |
| FK-12 | The price coin is "the frog coin" in all kit texts, and no known frog character is drawn or named | The coin is a plain green coin; `check.mjs` refuses the coin's name and known frog names by SHA-256 fingerprint in every doc, SVG text, drawn word and source file |

## Decisions

1. **The look.** A potter's studio, with a warm bisque limewashed wall, a brick kiln with a steel strap, a plank floor,
   and glazed clay toads with soot outlines and flat glaze shading. Letters are cut with a loop tool, carved through a
   dark glaze or brushed in soot. It is the only light-ground kit so far, far from Link Marines' olive print, Bag
   Holders' plum pegboard, One Dollar's maroon salon, Dragon's Hoard's navy and gilt, Exit Liquidity's green LED and GPU
   Poor's neon. Other kits have flames too, so the fire here stays inside the kiln's door.
2. **The frog coin has no face.** It is drawn as a plain green coin, never lettered, and every kit text calls it the
   frog coin. The research names the coin, and the kit does not. `check.mjs` keeps the first 16 hex digits of the
   SHA-256 of each name it refuses, so not even the check spells them.
3. **Toads, not a character.** The toads are animal figurines with golden toad eyes, no lips, no eyebrows, no human
   face and no clothes. The icon long list of Square Hole's own collection notes that the best-known meme frog's
   creator enforces his copyright, and the homage rules follow from that. A first draft gave one toad a puffed throat
   that read as an open mouth, and it was replaced by a singing face.
4. **Hidden art needs a secret order.** The box is hidden until drawn, and the create page commits each picture to its
   id with a secret salt. A public rule such as id mod 12 would tell everyone which number holds which toad. So
   `assign.mjs` ranks ids by SHA-256 of a seed and the id and deals the variants down the ranking. The kit's
   `assignment.json` uses the public seed `frog-kiln-example`. The real list needs a secret seed of at least 32
   characters, and `--folder` writes the create page's `1.png` to `420.png`, `traits.csv` and the private list outside
   the kit, never to the terminal. A guessable seed would let anyone who sees a few reveals work out the rest.
5. **A few cracked toads.** Nine glazes of 44 and three cracked toads of 8: 24 of 420, about one in eighteen. The
   create page's special series takes the label "Cracked" and the count 24. Every toad gets the same part of the fees.
6. **The registry row.** This branch's registry has no `eat` or `items-t` choice and no frog coin. The row is
   `pending` on `V21-02`, the later of the two steps the recipe needs (step 2 builds on step 1), and its reason names
   the v2.1 site and the listing, as the task asked. LINK stands in for the frog coin (an 18-decimal listed coin), Burn
   for Eat, and items paid in LINK with the inside share burned for items paid in KILN. The template is Collection
   that burns, the label `Toads`, the art `hidden`, the pick fee 1%, the deadline 30 days, royalties off. The registry
   README already says "current" collections use open art, and this row is not current, so the README is unchanged.
7. **The registry test.** It pins the exact pending set, so adding the row made it fail. One line now names
   `frog-kiln` with `V21-02`. `pnpm e2e:examples --list` discovers twelve cases and will skip this one as pending.
8. **Burned, through the listing.** The eat step burns only a coin listed with its burn checked. The kit says the frog
   coin's listing must record its burn, or the box would lock its coins at the dead address.
9. **The fired counter.** The founder's "frog coin fired" counter is the eaten total, which the v2.1 site line's box
   page shows, marked Burned. The art draws a FIRED plaque over number wheels that show no number.
10. **The hidden picture.** Every unopened toad and ticket shows one picture on chain, at most 4,096 bytes of
    printable ASCII. `src/hidden.mjs` draws the wrapped toad by hand in whole numbers, 1,897 bytes. Today's create
    page fills the field with its own default, so the file waits for a custom-picture option.
11. **Own letters, named fonts.** Every letter in the art is drawn by the kit. Live text names three OFL families
    (Fraunces, Figtree, Azeret Mono). No font was downloaded, so their license files were not read here. The integrator
    checks them when self-hosting.
12. **No raise number and no address.** The kit repeats no raise and writes out no address. KILN is not cleared.
13. **Square Hole's 3 of 15 parts are one line.** The kit says "3 parts go to Square Hole (its platform and its
    buy-back)" and does not split that share further. A legal read asked the line to say where the share goes. In the
    Terms and in the code, 2 of the parts go to Square Hole's buy-back and 1 to its platform. What a failed box has left
    when its claims close goes to that buy-back, and the kit says so. It never names what the buy-back buys.
14. **Exact bytes.** `check.mjs` compares every SVG and PNG with a fresh build. `.gitattributes` marks `art/**` and
    `assignment.json` as `-text`.

## Facts read in the code

| Fact used in the kit | Where |
| --- | --- |
| Fees in the price coin on both sides, 1% | `packages/contracts/src/box-v2/BoxHookV2.sol:25` |
| 15 parts: 2 and 1 to Square Hole, 2 to the pool, dust to the pool while live | `BoxReceiverV2Base.sol:343`, `:348`, `:350`, `:351`, `:352` |
| Eat books the buyers' 10 parts; items in the box token book them for the buy step | `BoxReceiverV2Base.sol:357`, `:359` |
| The inside share is kept back and burned; the outside share goes to the item ledger as KILN | `BoxReceiverV2Base.sol:410`, `:413`, `:415`; `BoxReceiverV2.sol:138` |
| The eat step: anyone, after graduation only, no tip; a checked burn must lower the supply exactly; otherwise the dead address; restores on refusal | `BoxReceiverV2.sol:160`, `:169`, `:177`, `:186`; `BoxReceiverV2Extension.sol:85` to `:94` |
| The buy step: after graduation, one protocol step a block, a minimum, a tip of at most 5% of what it spends, a 49-tick price limit | `BoxReceiverV2.sol:87`, `:96`, `:97`, `:100`, `:140`; `interfaces/ReleaseConstantsV2.sol:28`, `:34` |
| Failure sends both sides' waiting coins to the closing pool | `BoxReceiverV2.sol:287`, `:294` |
| The checked-burn listing and its 10,000-unit test burn, lister only | `ListingRegistry.sol:84`, `:85`, `:101` to `:105` |
| Equal parts; tickets count as out from their start; a handed-back ticket's part becomes burned leftover | `ItemLedgerV2.sol:306`, `:311`, `:334`, `:395` |
| Claims: current owner only, one id, only while out, no minimum, tip or expiry, unpaid credit follows the NFT | `ItemLedgerV2.sol:26`, `:421`, `:426`, `:435`, `:444`, `:450` |
| Draw and ticket fee 1%, put-back fee 5%, pick fee from the spec | `BoxVaultV2.sol:87`, `:88`, `:606` |
| Picks by number only for toads that left before and are revealed | `BoxVaultV2.sol:875`, `:876` |
| The last toad stays; prices round up for take-outs and down for put-backs | `libraries/VaultViews.sol:20`, `:21`, `:27` |
| Put-back of an unrevealed toad after its grace | `BoxVaultV2.sol:728`, `:773`; `BoxTicketsV2.sol:77` |
| Hand-backs during the raise pay the share less 5%; after a failure the frozen share with no fee for 14 days | `BoxVaultV2.sol:637` to `:645`; nothing in the box core calls `waiveHandBackFee` |
| Tickets during the raise only; draws after graduation with the random round's posting paid | `BoxTicketsV2.sol:141`, `:151`, `:245`, `:272` |
| Opening needs the reveal proof, or the owner's fallback after 30 days | `BoxTicketsV2.sol:72`, `:691` to `:703` |
| The 6.4-minute launch window and its tax table | `BoxHookV2.sol:32`; `BoxLaunchRouterV2.sol:259`, `:290` |
| Failing after the deadline or 7 days after a filled curve; claims for 365 days | `BoxCoordinatorV2.sol:80`, `:216`; `interfaces/ReleaseConstantsV2.sol:56` |
| The keeper runs the eat step, the buy step with the toads' budget, the burns and the leftover flush | `packages/keeper/src/plan.ts:146`, `:153`; `packages/keeper/src/pay-in-t-v21.ts:9`, `:20` |
| The create page: five fee choices on this branch, Collection that burns, hidden art with a reveal file, special series, the default hidden picture | `apps/web/src/features/create/v2/recipes.ts:6`; `v2/templates.ts:50`; `ContentsStep.tsx:364`; `create-model.ts:114`, `:118`, `:506` |
| Item files named `1.png` to `N.png`, each at most 1 MiB, and a CSV traits file | `apps/web/src/features/create/art-files.ts:4`, `:31`; `packages/artwork/src/attributes.ts:6` |
| The hidden picture's field: 1 to 4,096 bytes, characters 32 to 126 | `BoxSpecV2.sol:463`; `packages/box-spec/src/generated/box-spec.v2.ts:60` |
| The v2.1 registry has `eat` and `items-t` | `git show sh-v21-fe12:packages/box-spec/examples/v2/registry.mjs`, line 10 |
| The idea, the kiln, the toads, the specials and the counter | `docs/research/round2b-stonks-rwa-memes-defi.md:824` |
| The founder's notes and R25C; the simplification that removed both payouts | `docs/decisions/DECISION-LOG.md:104`, `:124`; `docs/reviews/OCCAM-CHECK-2026-10-08.md:308` |
| Counsel questions on draws, listings and item payouts | `docs/legal/counsel-pack-2026-10.md:1816`, `:2093`, `:2126` |

## Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node build-art.mjs` | Exit 0: 25 SVG and PNG pairs and `art/logo-48.png`, in under a second |
| `node build-art.mjs` twice, then a SHA-256 of every file in `art/` | All 51 hashes match, so the build is byte-for-byte repeatable |
| `node assign.mjs > assignment.json` | 420 items; nine variants of 44 and three of 8 |
| `FROG_KILN_SEED=<32 random bytes> node assign.mjs --folder <scratchpad>` | Exit 0: 420 PNGs, `traits.csv` and the private list; the right counts; 384 of 420 ids differ from the example; largest PNG 107,104 bytes |
| The create page's `parseAttributes` and `itemIdFromFileName` on that folder (Vitest, scratch config) | Pass: 420 trait rows and 420 item ids |
| `assign.mjs` with a short seed, and `--folder` without a seed | Both exit 1, and nothing is written |
| `node --input-type=module` with `validateExample` on the new row | Valid |
| `node --test packages/box-spec/examples/v2/registry.test.mjs` (repository root) | Fail before the test line (the pinned pending set), pass after it: 3 of 3 |
| `pnpm e2e:examples --list` (repository root) | Exit 0: the registry, support and wallet tests pass, and Playwright lists 12 cases with `frog-kiln · Collection that burns` |
| Thirty mutation runs of `node check.mjs` | Each exit 1 with the expected FAIL line, and a SHA-256 of the kit matched the one taken before. The first round caught 28 of 30 and showed two real gaps, both fixed (see below) |
| `node check.mjs` final | Exit 0: 755 checks passed (12 variants, 7 scenes, 420 toads) |
| `./node_modules/.bin/eslint examples/boxes/frog-kiln packages/box-spec/examples/v2/registry.test.mjs` (repository root) | Exit 0, after removing three unused imports, two unused parameters and a dynamic delete it flagged |
| `pnpm lint` (repository root, once) | Exit 0 |
| `pnpm check:handoff` (repository root) | Exit 0 |
| `gitleaks dir examples/boxes/frog-kiln` and `gitleaks dir packages/box-spec/examples/v2/frog-kiln.json` | Exit 0, no leaks found |

The mutations: a banned word, an em dash, a wrong PNG size, a changed assignment, a three-sentence caption, a
hand-edited SVG, the platform token's name, a coin amount, the price coin's name in a doc, a known frog character in
an SVG description, a color defined outside the palette, a stray color in an SVG, a gradient in the art, a hidden
picture over 4,096 bytes, a hidden picture with a line break, the mark pushed into its clear space, a toad in the avatar
corner, a missing scene, a doc link to a missing file, a palette color missing from the brand book, a wrong contrast
ratio, words too close to an edge, a `not X, but Y` turn, a short seed accepted, a private folder inside the kit
allowed, counts that do not add up, an id rule that accepts leading zeros, a year in a doc, a caption that differs from
its scene, and a registry row with another recipe (read through `FROG_KILN_REGISTRY`).

The two gaps from the first round:

- With the inside-kit rule removed, the check's own test wrote a private folder into the kit and left it there. The
  rule is now a pure function, `folderTarget()`, that the check asks directly, so a broken rule can never write into
  the kit. It also resolves links, so a route through `/tmp` cannot slip past it. The stray folder was moved to the
  scratchpad.
- `variantFor('01')` failed for the wrong reason, a lookup that found nothing. It now indexes by the parsed id, and the
  check expects the id error itself, so an id rule that accepts leading zeros is caught.

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest suites, Forge, `pnpm verify` and the E2E lives
were not run. No server was started, nothing was downloaded, and nothing was pushed.

## Visual review

- The logo at a real 48 px still reads as a brick dome with an orange door and a green toad. A first layout put the
  footing's corners outside 95% of a round crop. The kiln was narrowed to 20 modules and lowered 0.8 modules, and the
  check proves the crop.
- On the X banner, the corner at x 0 to 420 and y 270 to 500 holds only wall and floor, proven pixel by pixel. A first
  layout ran the cover line into the toads, and it now takes two lines.
- The twelve toads were compared on contact sheets. All are distinct, and all read as one family. Fixes after the first
  sheet: legs that read as long arms, pointed drips, a floating pot hat, features lost on dark glazes (now cut in clay,
  white or ember), and a stray stroke over the cobalt toad's head.
- All seven scenes were checked at full size. Fixes: wrapped toads that floated above the crock, toads that overlapped
  on the shelf in scene 5, smoke that ran into the IN tag, a peel that lay across the bowl, and the box banner's lower
  brackets sinking into the floor (now a standing ware rack).
- One toad's description used a word from the avoid list for its pot hat, and the check refused it. It now says
  "as a hat".
- No browser, X upload or platform crop test was done.

## Limits and open points

1. The registry form. On this branch the row is pending on `V21-02` with LINK, Burn and items in LINK standing in, and
   one test line names it. Default: keep it pending until the v2.1 line merges and the frog coin is listed with its
   burn checked, then switch to Eat and items in KILN, both of which `check.mjs` already accepts.
2. The cracked count. 24 of 420 cracked toads in three kinds. Default: 24, shown on the create page as the special
   series "Cracked".
3. Who posts the reveals. The creator keeps the reveal file, and toads show their pictures only when entries are
   posted. Default: the founder keeps the file and the seed offline, and a small reveal bot posts each entry when its
   toad is drawn.

- Counsel still has to look at the homage, the "not affiliated" line, paid random draws with cracked toads, the toads'
  part of the fees, listing the frog coin, the ticker and the kit's publication license.
- The registry still points at the local test pictures. Using this art needs the metadata and hosting step, with the
  deployed collection on ids 1 to 420.

## Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-FROG-KILN.md` when merging.
2. Keep the registry row and its test line together, and promote the row only with the v2.1 site, the steps and the
   frog coin's checked-burn listing. `check.mjs` passes with either form.
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
| `node check.mjs` before the change | Exit 0: 755 checks passed |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the change | Exit 1: 10 problems, such as `art/items holds files that are not variant-NN.svg or .png`. All nine kits failed |
| The same on a fresh copy after the change | Exit 0: 755 checks passed, the same count as in the tree. All nine kits passed |
| A fresh copy with `.directory`, `.AppleDouble`, `.Trash-1000` and `__MACOSX` added too, after the second commit | Exit 0: 755 checks passed. |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` (repository root) | Exit 0 |
| `node check.mjs` final | Exit 0: 755 checks passed |

## Word-free reference pictures

The explainer pipeline needs each kit's world as a reference picture with no words in it. `build-art.mjs --no-words`
writes `art/reference/cover.png`, `art/reference/box-banner.png` and `art/reference/scenes/scene-01.png` to
`scene-07.png`: the same pictures with every word and number of the loop-tool alphabet left out. `withoutWords` in
`src/type.mjs` makes `carved` and `brushed` draw nothing and put nothing in `DRAWN` while `measure` still sizes every
block, so the name plaque, the clay tags, the crate's label and the kiln counter keep their place, blank. Only PNGs are
written, because the SVG titles and descriptions name words that are no longer drawn. The toads stay in the
pictures, eyes and all. All commands ran from the kit folder with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node build-art.mjs`, then `git status --short`, before the change | No file changed: the committed art is a fresh build |
| `node build-art.mjs` after the change, then `git status --short` | Only the two source files changed. The sha256 of all 51 art files match commit `aa22b629` |
| `node check.mjs` | Exit 0: 755 checks passed after the build change, as before; 756 with these docs, whose new README link it also checks |
| `node build-art.mjs --no-words`, twice | Exit 0: 9 PNGs, the same bytes both times |
| `node build-art.mjs --nowords` | Exit 1: unknown option, nothing written |
| `DRAWN` after building the normal cover, box banner and scenes, then after `references()` | 21 blocks of lettering, then none |
| OCR net from the explainer playbook: `tesseract <png> - --psm 11 tsv`, tokens of 2 or more letters, digits, dollar or percent signs at confidence 70 or more | The 9 normal pictures: 20 hits, such as FROG, TRADE, FIRED, 420 and POOL. The 9 word-free ones: 1, `OA` on the front leg of the orange toad in scene 05, which the normal scene gives too |
| Each word-free picture looked at next to its normal one | No lettering left; every other shape in place |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/frog-kiln` (repository root) | Exit 0 |
