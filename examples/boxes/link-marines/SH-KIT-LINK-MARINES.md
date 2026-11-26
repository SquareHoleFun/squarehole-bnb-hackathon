# SH-KIT-LINK-MARINES work record

TA-24 (integration line `sh-026-kits-merge`): the founder chose the ticker MARINE, so the kit moved from the working
ticker EATIT to MARINE, describes the registry row as it is on this line (ready, Eat on both sides), and the row's logo
is now this kit's own `art/logo.png`. The sections below are the original record.

Kit agent for box id `link-marines` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree, from base
`c07182d7`. Every change is inside `examples/boxes/link-marines/`. The brief limits work to this folder, so the record
sits here. The integrator can copy it to `docs/evidence/` as the project rules ask.

The folder already held an unfinished start when this agent began: `assign.mjs` and thirteen files in `src/`, never
committed, with no record of who wrote them. This agent read all of them, rendered them, kept the parts that held up
and changed the rest (see Decisions 3 to 5).

## Requirements and files

| ID | Requirement from the brief | Result |
| --- | --- | --- |
| LM-01 | Read the box settings, registry notes, research and founder notes | Read `link-marines.json` on this branch and on `sh-v21-fe12`, the registry README and validator, the founder's idea and Square Hole's notes in `scripts/builder-kit/content/projects/link-marines.md`, the spin-off research, `core-v2-plan.md` sections 2, 5 and 7, the decision log (F82, F83, F94, F95, F106, F118 to F135), the step 1 design and record, the counsel pack (part 6.2, questions 31 to 33), and the contracts listed below. Read the Bag Holders and Dragon's Hoard kits as the finished kits to match, and looked at all four finished covers to keep the looks apart |
| LM-02 | README with the file list | `README.md` lists every file and folder; `check.mjs` enforces it |
| LM-03 | Brand book | `brand-book.md`: name, working ticker, joke, cover line, hook, voice with twelve example lines, ten colors, three OFL fonts with fallbacks, logo construction and clear space, do and don't, a contrast table the check recomputes, homage and IP rules |
| LM-04 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each, same words as `src/scenes.mjs` |
| LM-05 | Details in plain words | `details.md`: every setting in both registry states, where each fee goes, the eat step, burned or locked, the stand-in recipe, the collect and pool steps, the launch window, what a holder and a marine owner get, risks, what waits for counsel, v2.1 and the launch |
| LM-06 | Art notes | `art-notes.md`: the look, the wall, the stencil alphabet, how a marine is built, the twelve marines, story symbols, scenes and brand pieces, rules for extending |
| LM-07 | Clean vector art with local PNG exports | 24 SVG and PNG pairs plus `art/logo-48.png`, rendered by `@resvg/resvg-js` 2.6.2 with system fonts off |
| LM-08 | 8 to 12 variants and a deterministic assignment | 12 variants; `assign.mjs` and `assignment.json` cover ids 1 to 420 in 35 squads of 12, each picture exactly 35 times |
| LM-09 | `check.mjs` that verifies files and pixel sizes, and run it | Done; see results |
| LM-10 | Original art, no promise words, no names of the platform's own token or collection, plain writing | Word and shape scan in `check.mjs`, a palette scan of every SVG with a ban on blue, plus a manual read of every doc |

## Decisions

1. **The look.** A field mess hall drawn like a screen-printed poster: flat olive, orange and khaki inks, a
   boot-black outline, halftone dots for shade, stencil letters, and a tiled wall behind everything. The marines are
   caricature busts with big round noses, and each one eats a gold coin. The warm olive poster is far from Bag
   Holders' plum pegboard, Dragon's Hoard's navy and gilt, Exit Liquidity's dark green LED hallway and GPU Poor's
   neon. There is no blue anywhere, and `check.mjs` refuses any, so nothing points at the price coin's own look.
2. **Eat means lock.** LINK has no burn that step 1 can check, so this box locks the eaten LINK at the dead address.
   Every doc says "eaten" or "locked" for LINK, never "burned", and never says LINK's supply goes down, as Square
   Hole's notes on the idea ask. The check enforces both.
3. **No sunburst.** The unfinished start put every marine on a 16-ray sunburst. Rays behind soldiers in helmets read
   too close to a well-known military flag, so the kit replaced them with a tiled mess hall wall, and the art notes
   keep rays, discs and bursts off the wall for good.
4. **No monocle, beret or knife.** The start gave the officer a monocle with his peaked cap. That pair is a known
   screen stereotype, so the officer wears a tucked-in napkin instead. An unused olive beret (a real unit's nickname)
   and an unused upright table knife (reads as a weapon) were removed from the source.
5. **A mixed squad.** The start's twelve marines were all men. The pilot and the mechanic now wear braids, and the alt
   texts use no "his". Every face stays ration paper, the unprinted paper of a print, so no marine stands for a real
   group of people.
6. **Own letters.** Every letter in the art comes from a stencil alphabet drawn for this kit. The pictures need no
   font file. Live text names three OFL families (Saira Stencil One, Barlow, Courier Prime). No font was downloaded,
   so their license files were not read here. The integrator checks them when self-hosting.
7. **The coins have no name.** The coins are plain gold discs with no letters, symbol or hexagon. Only the box's own
   name lettering says LINK, and `lettering()` refuses LINK anywhere else and the name of the project behind it
   everywhere. This also lets the same art serve a "Marines for X" copy in another coin.
8. **The ticker.** The kit uses EATIT, the working ticker from the founder's idea and the task. The registry's test
   file uses `MARINE`, and the plan lists EATIT, SARGE and DRNS. The art never writes a ticker, so a change touches
   only the docs. See open point 1.
9. **Both registry states.** On this branch the row is pending with Burn as a stand-in. On the v2.1 site line it is
   ready with Eat on both sides. The docs describe the box as it is meant to be, explain the stand-in, and show the
   values of both rows. `check.mjs` accepts either row and fails on any other, and `LINK_MARINES_REGISTRY` lets it read
   a row from another folder.
10. **Lock over pool.** F95 R19N had Link Marines send its LINK into its own pool. The later step 1 locks it at the
    dead address, and the v2.1 row and its life do the same. The kit follows step 1. See open point 3.
11. **Royalties stay as the row has them.** The founder's idea had royalties feeding back to the box (F82 LM5, F83 C3,
    F94 R18G), and the test row keeps them off. The kit describes the row and names the gap. See open point 2.
12. **No raise number and no address.** F123 lets a listing change its raise for future boxes, the registry notes say
    fixture raises must never become quotes, and the brief keeps prices and wallets out. The dead address is
    described, never written out.
13. **Square Hole's 3 of 15 parts are one line.** The kit says "3 parts go to Square Hole (its platform and its
    buy-back)" and does not split that share further. A legal read asked the line to say where the share goes. In the
    Terms and in the code, 2 of the parts go to Square Hole's buy-back and 1 to its platform. What a failed box has left
    when its claims close goes to that buy-back, and the kit says so. It never names what the buy-back buys.
14. **Exact bytes.** `check.mjs` compares every SVG and PNG with a fresh build. `.gitattributes` marks `art/**` and
    `assignment.json` as `-text`, so a checkout cannot change line endings and break that check.

## Facts read in the code

| Fact used in the kit | Where |
| --- | --- |
| Fee split into 10, 2 and 3 parts of 15 (2 and 1 to Square Hole); dust to the pool while live | `packages/contracts/src/box-v2/BoxReceiverV2Base.sol:343`, `:348`, `:350`, `:351`, `:352` |
| Eat books the 10 parts as waiting LINK at every collect | `BoxReceiverV2Base.sol:357` |
| The eat step: anyone, after graduation, never after failure; sends to the dead address; restores on a refused transfer; adds to the eaten total | `BoxReceiverV2.sol:160`, `:168`, `:169`, `:177`, `:179`, `:186` |
| A coin with no checked burn goes to the dead address | `BoxReceiverV2Extension.sol:87` |
| LINK, USDC and ETH are listed without a checked burn, so they lock | `docs/design/core-v21-step1-eat.md`, Admission; `docs/evidence/SH-V21-01-EAT.md`, Decisions |
| Failure sends the waiting LINK to the closing pool | `BoxReceiverV2.sol:294`; `interfaces/FailureTableV2.sol:22`, `:48` |
| Collect tip from buyers' batches, 5% under a cap | `BoxReceiverV2Base.sol:315`, `:469`; `interfaces/ReleaseConstantsV2.sol:34` |
| Deepen: anyone after graduation, 49.75% buys the box token, a tip of at most 5% | `BoxHookV2Extension.sol:92`, `:108`, `:279`; `BoxHookV2Base.sol:170`; `interfaces/ReleaseConstantsV2.sol:31` |
| 1% fee on buys (LINK in) and on sales (LINK out, rounded up) | `BoxHookV2.sol:25`, `:185` |
| Launch window of 384 seconds in 32 steps of 12 seconds, tax from 931,974 to 80,565 millionths | `BoxHookV2.sol:32`; `BoxLaunchRouterV2.sol:259`, `:290`, `:365`, `:369` |
| The vault opens at graduation | `BoxCoordinatorV2.sol:251`; `BoxVaultV2.sol:679` |
| Take-out price rounded up, 1% pick fee burned, the last marine stays | `BoxVaultV2.sol:685`, `:686`, `:698`; `libraries/VaultViews.sol:20`, `:21` |
| Put-back by the owner only, rounded down, 5% fee burned | `BoxVaultV2.sol:726`, `:732`, `:733`, `:750`; `libraries/VaultViews.sol:27` |
| Failure: anyone after the deadline, or 7 days after a filled curve closes; marines in the vault to the creator; holders hand in the box token, which is burned, for their part; claims for 365 days | `BoxCoordinatorV2.sol:212`, `:80`, `:749`, `:763`, `:764`, `:807`; `interfaces/ReleaseConstantsV2.sol:56`; `BoxVaultV2.sol:216` |
| The keeper runs the eat step whenever LINK is waiting | `packages/keeper/src/plan.ts:146` |
| The box page on this branch labels the choice "Eat the price coin" | `apps/web/src/features/core/v2/V2BoxPage.tsx:25` |
| The create page on this branch offers five choices and no Eat | `apps/web/src/features/create/v2/recipes.ts:21` |
| Royalty destinations are none, creator, fees and pool | `packages/box-spec/examples/v2/registry.mjs:26` |
| Collections start at id 1 | `packages/box-spec/src/generated/box-spec.v2.ts:27` |
| The local test life uses an 18-decimal LINK stand-in | `packages/contracts/script/local/LocalQuoteMocks.sol:96` |
| The v2.1 row: ready, Collection, Eat on both sides, `own-pictures` and `price-coin-eaten` | `git show fac4435c:packages/box-spec/examples/v2/link-marines.json` |

## Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node build-art.mjs` | Exit 0: built 24 SVG and PNG pairs and `art/logo-48.png`, under a second |
| `node build-art.mjs` again, then a SHA-256 of every file in `art/` | All 49 hashes match the first build, so the build is byte-for-byte repeatable |
| `node assign.mjs > assignment.json` | 420 items in 35 squads; every variant appears 35 times; id 1 gets 01 and id 420 gets 12 |
| `node check.mjs` before the docs existed | Exit 1 as expected: 134 problems, all missing docs and the entries they carry, and one real finding. The brand book was to list paper on orange for large text, and its 2.86:1 is below 3:1, so the pair became decoration only. Every art, palette, assignment, margin, mark and avatar corner check passed |
| `LINK_MARINES_REGISTRY=<copy of the v2.1 row> node check.mjs` | The registry checks pass with the ready row too |
| Twenty-five mutation runs of `node check.mjs` | Each exit 1 with the expected FAIL line; see the list below. A script in the scratchpad saved every touched file in memory, restored it byte for byte, and a SHA-256 of the whole folder matched the one taken before |
| `node check.mjs` final | Exit 0: 649 checks passed (12 variants, 7 scenes, 420 marines) |
| `./node_modules/.bin/eslint examples/boxes/link-marines` (repository root) | Exit 0, after removing two unused imports it first flagged |
| `pnpm lint` (repository root, once) | Exit 0 |
| `pnpm check:handoff` (repository root) | Exit 0: both handoff folders match their hashes |
| `gitleaks dir examples/boxes/link-marines` (repository root) | Exit 0, no leaks found |

The mutations: a banned word, an em dash, a wrong PNG size, a changed assignment, a three-sentence caption, a
hand-edited SVG, the platform token's name, a coin amount, the name of the price coin's project in a doc, the price
coin's name in an SVG description, a color defined outside `src/palette.mjs`, a blue shade in the palette, a coin in
the X avatar corner, the mark pushed into its clear space, a missing scene, a doc link to a missing file, a palette
color missing from the brand book, LINK called burned, a wrong contrast ratio, a registry row that eats on one side
only (read through `LINK_MARINES_REGISTRY`), words too close to an edge, a claim that a supply goes down, a "not X,
but Y" turn, an id rule that accepts leading zeros, and squads of the wrong size.

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest, Forge, `pnpm verify` and E2E were not
run. No server was started, nothing was downloaded, and nothing was pushed.

## Visual review

- The logo at a real 48 px still reads as an olive helmet, a face and a gold coin on a khaki patch. In a round crop
  the whole patch sits well inside the circle.
- On the X banner, the corner at x 0 to 420 and y 270 to 500 holds only bare wall, proven pixel by pixel.
- The 12 variants were compared on contact sheets: all distinct, all one family. The braid's tie first drew as a long
  stripe because of a path command bug, and the same bug was fixed in two hats.
- All seven scenes were checked at full size. The tray first covered the scout's face, the fork and spoon of the
  waiting marines first held coins, and their sleeves showed below the table; all three were fixed. The X banner's
  mess tin covered both faces and became a small heap of coins.
- No browser, X upload or platform crop test was done.

## Limits and open points

1. The ticker. Settled in TA-24: the founder chose MARINE, the registry's ticker, and the kit now uses it (it used the
   working ticker EATIT before).
2. Royalties. The founder's idea had royalties feeding back to the box, and the test row keeps them off. Default: keep
   them off for the test life, and decide the rate before the real box is created, with the destination `fees` so the
   royalty LINK is eaten too.
3. Lock or pool. F95 R19N sent this box's LINK into its own pool, and step 1 locks it at the dead address. Default:
   the lock, as the later decision and the v2.1 row have it.

- The founder's own words for step 1 are not in the decision log yet. The kit relies on the step 1 design and record
  and on the task's summary of them.
- Counsel still has to look at the joke, the "not affiliated" line, the price coin's listing, the ticker and the
  kit's publication license.
- The registry still points at the local test pictures. Using this art needs the metadata and hosting step, with the
  deployed collection on ids 1 to 420.

## Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-LINK-MARINES.md` when merging.
2. Merge the v2.1 registry row and site steps before or with this kit. `check.mjs` passes with either row.
3. When wiring the art, build the metadata from `assignment.json` and confirm the collection ids run 1 to 420.
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
| `node check.mjs` before the change | Exit 0: 649 checks passed |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the change | Exit 1: 10 problems, such as `art/items holds files that are not variant-NN.svg or .png`. All nine kits failed |
| The same on a fresh copy after the change | Exit 0: 649 checks passed, the same count as in the tree. All nine kits passed |
| A fresh copy with `.directory`, `.AppleDouble`, `.Trash-1000` and `__MACOSX` added too, after the second commit | Exit 0: 649 checks passed. |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` (repository root) | Exit 0 |
| `node check.mjs` final | Exit 0: 649 checks passed |

## Word-free reference pictures

The explainer pipeline needs each kit's world as a reference picture with no words in it. `build-art.mjs --no-words`
writes `art/reference/cover.png`, `art/reference/box-banner.png` and `art/reference/scenes/scene-01.png` to
`scene-07.png`: the same pictures with every word and number of the stencil alphabet left out. `withoutWords` in
`src/type.mjs` makes `lettering` draw nothing, add no stencil mask and put nothing in `DRAWN` while `measure` still
sizes every block, so the crates, the footlocker, the signs, the button and the mess tin keep their place, blank. The
three stamped lines on a dog tag are the token's mark, never a word, and stay. Only PNGs are written, because the SVG
titles and descriptions name words that are no longer drawn. The marines stay in the pictures, faces and all. All
commands ran from the kit folder with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node build-art.mjs`, then `git status --short`, before the change | No file changed: the committed art is a fresh build |
| `node build-art.mjs` after the change, then `git status --short` | Only the two source files changed. The sha256 of all 49 art files match commit `aa22b629` |
| `node check.mjs` | Exit 0: 649 checks passed after the build change, as before; 650 with these docs, whose new README link it also checks |
| `node build-art.mjs --no-words`, twice | Exit 0: 9 PNGs, the same bytes both times |
| `node build-art.mjs --nowords` | Exit 1: unknown option, nothing written |
| `DRAWN` after building the normal cover, box banner and scenes, then after `references()` | 24 blocks of lettering, then none |
| OCR net from the explainer playbook: `tesseract <png> - --psm 11 tsv`, tokens of 2 or more letters, digits, dollar or percent signs at confidence 70 or more | The 9 normal pictures: 20 hits, such as MARINES, RAISE, LOCKED and POOL. The 9 word-free ones: 1, `wy` in the box banner, read into the face of the marine in the peaked cap |
| Each word-free picture looked at next to its normal one, and the box banner's twelve marines at full size | No lettering left; every other shape in place |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/link-marines` (repository root) | Exit 0 |
