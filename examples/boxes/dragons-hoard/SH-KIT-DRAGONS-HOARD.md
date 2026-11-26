# SH-KIT-DRAGONS-HOARD work record

Kit agent for box id `dragons-hoard` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree, from
base `53502231`. Every change is inside `examples/boxes/dragons-hoard/`. The brief limits work to this folder, so the
record sits here. The integrator can copy it to `docs/evidence/` as the project rules ask.

## Requirements and files

| ID | Requirement from the brief | Result |
| --- | --- | --- |
| DH-01 | Read the box settings, registry notes, research and founder notes | Read `dragons-hoard.json`, the registry README and validator, `core-v2-plan.md` section 5 and its catalog rows for the coin pile, the decision log (F86, F89, F109, F110, F118 to F135), the round 2b research that names the Hoard, the F89 check, the step 3 design and its evidence, the examples life test, counsel pack question 34, the create page's fee choices and templates, the keeper notes and the contracts listed below. Read the GPU Poor, Bag Holders and Exit Liquidity kits in this branch as the finished kits to match, and the Rent Free brand book on its branch (through `git show`, no checkout) to keep the looks apart |
| DH-02 | README with the file list | `README.md` lists every file and folder; `check.mjs` enforces it |
| DH-03 | Brand book | `brand-book.md`: name, ticker, joke, hook, cover line with its literal line, voice with eleven example lines, eleven colors, three OFL fonts with fallbacks, logo construction, clear space and round crop, do and don't, contrast table, homage and IP rules |
| DH-04 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each, same words as `src/scenes.mjs` |
| DH-05 | Details in plain words | `details.md`: every setting, where each fee goes, taking a share, what a holder gets, risks, what waits for counsel, v2.1, the site and the launch |
| DH-06 | Art notes | `art-notes.md`: the look, the gilt alphabet, the hoard and its tail, story symbols, scenes, brand pieces, rules for extending |
| DH-07 | Clean vector art with local PNG exports | 12 SVG and PNG pairs plus `art/logo-48.png`, rendered by `@resvg/resvg-js` 2.6.2 with system fonts off |
| DH-08 | Item variants and assignment for a collection box | Not a collection box, so none were made, and `check.mjs` refuses them |
| DH-09 | `check.mjs` that verifies files and pixel sizes, and run it | Done; see results |
| DH-10 | Original art, no promise words, no names of the platform's own token or collection, plain writing | Word and shape scan in `check.mjs`, a palette scan of every SVG, plus a manual read of every doc |

## Decisions

1. **The look.** A lair of deep lapis lit by a pile of coins, drawn like a page from an old ledger of hoards, with
   flat colors, ink outlines, gold glints and a gold page frame with inward-curved corners. Lapis, gold, jade and
   vermilion are far from GPU Poor's heat camera, Bag Holders' plum pegboard, Exit Liquidity's dark green hallway
   and Rent Free's cream houses.
2. **The dragon is never drawn.** Only its tail shows, sweeping out from behind the pile and around its front to a
   spade tip, with spikes along its back. No head, face, eyes, wings or claws, so it is no character or mascot and
   copies no known dragon. Early drafts curled the tail all the way around the pile, which read as a bowl or a boat.
   The tail now comes from behind one side only.
3. **HOARD is a jade token covered in scales.** A single scale shape read as a shield or a map pin. A round jade
   token with rows of scale arches reads as a token and ties HOARD to the tail, which wears the same arches. The
   price coin is a plain gold coin with no letters, symbol or picture, so the art copies no coin logo and works for
   any price coin, which fits F89's wish for this box as a template.
4. **Own letters.** Every letter in the art comes from a gilt alphabet drawn for this kit, with even strokes, square
   ends, thin serifs, an ink outline, a bevel and a shine. Live text names three OFL families (Cinzel, Alegreya Sans,
   Inconsolata). No font was downloaded, so their license files were not read here. The integrator checks them when
   self-hosting.
5. **The joke and the cover line.** The joke is on the dragon, and the dragon is the box. "A dragon so stingy that even
   when you take your share, it keeps one coin in twenty." The cover line "Buyers feed the pile. Sellers feed the fire." is
   always paired with its literal line, and `check.mjs` requires both in the brand book.
6. **One coin in twenty.** The 5% leave-behind is told as one coin in twenty, which a ten-year-old can picture. Scene
   06 shows a share of twenty coins, nineteen going to a pouch and one ringed coin going back onto the pile.
7. **Waiting fees are a chest.** Both fee sides wait until graduation. The closed chest stands for them, and the
   details page says plainly that fees still waiting count for nobody's share until someone moves them.
8. **The share counts all HOARD.** The pile divides by the token's whole supply, so the HOARD in the box's own pool
   counts too. Scene 05 shows it, and the details page says it. The last-holder rule is stated once, with the plain
   note that nobody holds all HOARD while the pool holds some.
9. **The seed amount is in words, in one place.** The seed is a setting, so `details.md` names it ("one ETH") next to
   the registry's raw value. No picture or post line names an amount, and the raise repeats no number (F123 and the
   registry notes).
10. **The guild-bank homage names nothing.** The brand book describes the idea, leaving at any time with a share of a
    shared bank, and names no project, club or person. `check.mjs` refuses the project's name and its word for
    leaving, and the names of well-known story and game dragons.
11. **Square Hole's 3 of 15 parts are one line.** The kit says "3 parts go to Square Hole (its platform and its
    buy-back)" and does not split that share further. A legal read asked the line to say where the share goes. In the
    Terms and in the code, 2 of the parts go to Square Hole's buy-back and 1 to its platform. What a failed box has left
    when its claims close goes to that buy-back, and the kit says so. It never names what the buy-back buys.
12. **Exact bytes.** `check.mjs` compares every SVG and PNG with a fresh build. `.gitattributes` in the kit marks
    `art/**` as `-text`, so a checkout cannot convert line endings and break that check.

## Facts read in the code

Paths are under `packages/contracts/src/box-v2/` unless they say otherwise.

| Fact used in the kit | Where |
| --- | --- |
| Fee split into 10, 2 and 3 parts of 15 (2 and 1 to Square Hole); rounding dust carried to the next fee on the same side | `BoxReceiverV2Base.sol:339`, `:345`, `:350`, `:351`, `:352` |
| To the pile books the 10 parts as pending pile fees; Burn books them as buy-back money | `BoxReceiverV2Base.sol:358`, `:361`; `BoxFactoryV2Parts.sol:307`, `:322` |
| Collect tip of at most 5%, set aside only from buyers' fees, under a cap | `BoxReceiverV2.sol:48`, `:75`, `:76`; `BoxReceiverV2Base.sol:469`, `:472`; `interfaces/ReleaseConstantsV2.sol:34` |
| Moving fees onto the pile: anyone, only after graduation, never after failure, a refusal restores them, no tip | `BoxReceiverV2.sol:163`, `:168`, `:169`, `:179`, `:184` |
| Burn steps: after graduation, one protocol step per block, a minimum, the bought token burned, a tip | `BoxReceiverV2.sol:87`, `:96`, `:97`, `:100`, `:112`, `:114`, `:116`, `:117`, `:118` |
| Each buy step stops 49 ticks from the current price and runs in the box's own pool | `interfaces/ReleaseConstantsV2.sol:28`; `libraries/ReceiverViews.sol:22`; `BoxReceiverV2Extension.sol:125` |
| A refused burn can be retried by anyone | `BoxReceiverV2.sol:203`; `BoxReceiverV2Base.sol:509` |
| A share is the pile times the HOARD burned over the whole supply, rounded down, less the leave-behind; one burn of the whole supply takes the whole pile | `PileVaultV2.sol:115`, `:125`, `:183`, `:184`, `:185`, `:186` |
| Shares only after graduation; the HOARD is pulled and burned; a minimum; any recipient but zero or the pile | `PileVaultV2.sol:122`, `:123`, `:130`, `:131`, `:132`, `:138` |
| The leave-behind can only be 0 or 500 basis points | `PileVaultV2.sol:72`, `:174` |
| The seeder is the creator; an ETH seed is sent by the seeder with the exact amount before the box opens; loading it opens the gate | `PileVaultV2.sol:76`, `:85`, `:92`, `:99`; `stubs/BoxCoordinatorV2M2Stubs.sol:12`; `BoxCoordinatorV2.sol:540`, `:555` |
| ETH reaches the pile only from the PoolManager after graduation | `PileVaultV2.sol:178` |
| On failure the seed goes back to the seeder, and waiting pile fees and burn money join the closing pot | `PileVaultV2.sol:151`; `BoxReceiverV2.sol:291`, `:297`; `interfaces/FailureTableV2.sol:47`, `:48`, `:52` |
| 1% fee on buys (ETH in) and on sales (ETH out); outside liquidity, removals and donations refused | `BoxHookV2.sol:25`, `:171`, `:185`, `:239`, `:249`, `:255` |
| Deepen: anyone after graduation, 49.75% buys the box token, a tip of at most 5% | `BoxHookV2Extension.sol:92`, `:279`, `:108`; `BoxHookV2Base.sol:170` |
| Launch window of 384 seconds in 32 steps of 12 seconds, tax from 931,974 down to 80,565 millionths, the tax to the pool after graduation | `BoxHookV2.sol:32`, `:123`; `BoxLaunchRouterV2.sol:259`, `:290`, `:369`, `:191`; `../box/BoxSpecV1.sol:42`, `:44` |
| Failure: after the deadline, 7 days after a filled curve closes, or 14 days after the planned opening while the gate holds; the deadline counts from the real opening; claims for 365 days | `BoxCoordinatorV2.sol:212`, `:216`, `:220`, `:227`, `:311`, `:80`; `interfaces/ReleaseConstantsV2.sol:56`; `interfaces/IBoxCoordinatorV2.sol:32` |
| Graduation moves the coordinator's HOARD into the pool, so the whole supply includes the pool's HOARD | `BoxCoordinatorV2.sol:239`, `:247` |
| HOARD has no owner, pause, blocklist, mint or upgrade | `BoxTokenV2.sol:34` |
| The create page offers no To the pile choice and no leave-behind; its Coin pile template burns both sides | `apps/web/src/features/create/v2/recipes.ts:6`, `:19`, `:20`; `apps/web/src/features/create/v2/templates.ts:51` |
| The keeper collects, alternates burn and deepen steps, moves pile fees with no tip, never takes shares for anyone and never sends an ETH seed | `packages/keeper/README.md:14`, `:16`, `:107`, `:114`, `:124` |
| The example life finds the fees waiting after graduation, moves them, and pays exactly 95% of a share | `apps/web/e2e/core-v2-chain/examples/forge/ExampleLives.t.sol:421`, `:429`, `:437`, `:443` |
| Step 3 of v2.1 is merged into the v2.1 integration line and asks for a cross-review and a fresh security review before the main line | commit `09c3e50f`; `docs/evidence/SH-V21-03-PILE-FEES.md` |

## Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node build-art.mjs` | Exit 0: built 12 SVG and PNG pairs and `art/logo-48.png`, about 0.4 s |
| `node build-art.mjs` again, then a SHA-256 of every file in `art/` | All 25 hashes match the first build, so the build is byte-for-byte repeatable |
| `node check.mjs` before the docs existed | Exit 1 as expected, with only the missing docs failing. It also caught the X banner's second line touching the avatar corner by a few pixels and the cover's name sitting too close to the top edge, both fixed in the source |
| Mutation runs of `node check.mjs` | Eighteen runs, each changing one thing: a promise word, an em dash, a coin amount, a year, a three-sentence caption, a hand-edited SVG, a wrong PNG size, the price coin named in an SVG description, a stray `art/items` folder, a changed cover line, the platform collection's name, a missing scene, a color outside the palette in the source, a label pushed to the edge, a glint in the avatar corner, the mark moved into its clear space, the homage project named, and a registry value missing from `details.md`. Each exit 1 with the expected FAIL line. The first round missed the changed cover line, because the brand book carries it twice, so the check now requires it in both places and refuses any other quoted cover line. Every file was restored from a copy after each run, and a SHA-256 of the whole folder matched the one taken before |
| `node check.mjs` final | Exit 0: 384 checks passed (7 scenes, a coin pile with no items) |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/dragons-hoard` (repository root) | Exit 0 |
| `pnpm lint` (repository root, once) | Exit 0 |
| `pnpm check:handoff` (repository root) | Exit 0: both handoff folders match their hashes |
| `gitleaks dir examples/boxes/dragons-hoard` (repository root) | Exit 0, no leaks found (gitleaks 8.30.1) |

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest, Forge, `pnpm verify` and E2E were not
run. No server was started.

## Visual review

- The logo at a real 48 px still reads as a pile of coins with a green tail. In a round crop the whole mark sits
  inside the circle, and `check.mjs` proves it pixel by pixel.
- On the X banner, the corner at x 0 to 420 and y 270 to 500 holds only bare ground, the frame leaves it out, and a
  preview with a round avatar over it showed no clash.
- All seven scenes were checked at 800 px for labels, arrows and overlaps. The floor was raised so the tail never
  leaves the page, the pool became a wide shallow basin after it read as a bucket, scene 04 got room between the
  small fire and the pile, and scene 06 got separate arrows for the share leaving the pile and the one coin going back.
- No browser, X upload or platform crop test was done.

## Limits and open points

- The founder's example-boxes doc was not read. Its note on Dragon's Hoard comes from F89 in the decision log.
- F110 chose no leave-behind for piles. Step 3 later added a fixed choice of 0% or 5%, and this registry row picks 5%.
  The founder confirms the 5% for this box.
- The site's create page cannot pick To the pile or the leave-behind yet. The examples branch `sh-v21-ex3` (commit
  `cb75056c`, not in this base) marks this row pending on a site step for its browser life while keeping its contract
  life. If that change lands, `check.mjs` asks `details.md` to name the pending step.
- Counsel still has to look at the pile and its share rule, the name and ticker, and the kit's publication license.

## Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-DRAGONS-HOARD.md` when merging.
2. When the site offers To the pile and the leave-behind, show the pile, the fees waiting and the 5% rule in live text
   on the box page, as `details.md` asks.
3. Choose the open-source license for the kit collection before publishing it.

## Check fix for the files an operating system adds

`check.mjs` failed when Finder added a `.DS_Store` file to a folder of the kit, and a `Thumbs.db` or `desktop.ini`
from Windows would have failed it the same way. Every folder listing in it now skips those files, and nothing deletes
them. The change is in commits `fdd30c10` and `0e7ccdc2`, made on the same branch from `fd586423` for all nine kits,
inside `check.mjs` only. The second commit adds `.directory`, `.AppleDouble`, `.Trash-` folders and `__MACOSX`. All
commands ran with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node check.mjs` before the change | Exit 0: 384 checks passed |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the change | Exit 1: 9 problems, such as `art/scenes holds files that are not scene-NN.svg or .png`. All nine kits failed |
| The same on a fresh copy after the change | Exit 0: 384 checks passed, the same count as in the tree. All nine kits passed |
| A fresh copy with `.directory`, `.AppleDouble`, `.Trash-1000` and `__MACOSX` added too, after the second commit | Exit 0: 384 checks passed. |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` (repository root) | Exit 0 |
| `node check.mjs` final | Exit 0: 384 checks passed |

## Word-free reference pictures

The explainer pipeline needs each kit's world as a reference picture with no words in it. `build-art.mjs --no-words`
writes `art/reference/cover.png`, `art/reference/box-banner.png` and `art/reference/scenes/scene-01.png` to
`scene-07.png`: the same pictures with every word, number and sign of the gilt alphabet left out. `withoutWords` in
`src/type.mjs` lets `lettering` measure as always but draw nothing and put nothing in `DRAWN`, so the stone plate keeps
its size and place, blank. Only PNGs are written, because the SVG titles and descriptions name words that are no
longer drawn. All commands ran from the kit folder with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node build-art.mjs`, then `git status --short`, before the change | No file changed: the committed art is a fresh build |
| `node build-art.mjs` after the change, then `git status --short` | Only the two source files changed. The sha256 of all 25 art files match commit `aa22b629` |
| `node check.mjs` | Exit 0: 384 checks passed after the build change, as before; 385 with these docs, whose new README link it also checks |
| `node build-art.mjs --no-words`, twice | Exit 0: 9 PNGs, the same bytes both times |
| `node build-art.mjs --nowords` | Exit 1: unknown option, nothing written |
| `DRAWN` after building the normal cover, box banner and scenes, then after `references()` | 31 blocks of lettering, then none |
| OCR net from the explainer playbook: `tesseract <png> - --psm 11 tsv`, tokens of 2 or more letters, digits, dollar or percent signs at confidence 70 or more | The 9 normal pictures: 49 hits, such as HOARD, FEED, PILE and BURN. The 9 word-free ones: 3, all read into shapes that give the same hits in the normal scenes: `OO` on the two ringed tokens of scene 06, `aq` on the pile and `KA` on the tail of scene 07 |
| Each word-free picture looked at next to its normal one | No lettering left; every other shape in place |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/dragons-hoard` (repository root) | Exit 0 |
