# SH-KIT-BAG-HOLDERS work record

Kit agent for box id `bag-holders` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree, from base
`1fc90d71`. Every change is inside `examples/boxes/bag-holders/`. The brief limits work to this folder, so the record
sits here. The integrator can copy it to `docs/evidence/` as the project rules ask.

## Requirements and files

| ID | Requirement from the brief | Result |
| --- | --- | --- |
| BH-01 | Read the box settings, registry notes, research and founder notes | Read `bag-holders.json`, the registry README and validator, `core-v2-plan.md` section 5, the decision log (F82, F83, F89, F95, F118 to F135), the launch skill's Bag Holders example and its notes on Keep, the examples life test evidence, counsel pack questions 31 and 34, the create page's templates and fee step, and the contracts listed below. Read the Exit Liquidity and GPU Poor kits in this branch as the finished kits to match, and the Rent Free brand book on its branch (through `git show`, no checkout) to keep the looks apart |
| BH-02 | README with the file list | `README.md` lists every file and folder; `check.mjs` enforces it |
| BH-03 | Brand book | `brand-book.md`: name, ticker, joke, hook, voice with thirteen example lines, ten colors, three OFL fonts with fallbacks, logo construction and clear space, do and don't, contrast table, homage and IP rules |
| BH-04 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each, same words as `src/scenes.mjs` |
| BH-05 | Details in plain words | `details.md`: every setting, where each fee goes, the bags in and out of the vault, the raise, the collect step, the launch window, what a holder and a bag owner get, risks, what waits for counsel, v2.1 and the launch |
| BH-06 | Art notes | `art-notes.md`: the look, pegboard and hooks, sticker alphabet, the twelve bags, story symbols, scenes and brand pieces, rules for extending |
| BH-07 | Clean vector art with local PNG exports | 24 SVG and PNG pairs plus `art/logo-48.png`, rendered by `@resvg/resvg-js` 2.6.2 with system fonts off |
| BH-08 | 8 to 12 variants and a deterministic assignment | 12 variants; `assign.mjs` and `assignment.json` cover ids 1 to 420, each picture exactly 35 times |
| BH-09 | `check.mjs` that verifies files and pixel sizes, and run it | Done; see results |
| BH-10 | Original art, no promise words, no names of the platform's own token or collection, plain writing | Word and shape scan in `check.mjs`, a palette scan of every SVG, plus a manual read of every doc |

## Decisions

1. **The look.** A shop wall of plum pegboard, with every bag on a steel hook, drawn like a printed sticker sheet: flat
   colors, thick ink outlines and one flat shadow per hanging thing. The hook is the joke's "holder". The light,
   warm plum wall is far from Exit Liquidity's dark green hallway, GPU Poor's heat camera and Rent Free's cream
   houses. It avoids the platform's lavender and dark canvas, and there is no blue anywhere, so nothing points at the
   price coin's own colors.
2. **Own letters.** Every letter in the art comes from a sticker alphabet drawn for this kit: one round stroke per
   glyph on a 6-unit grid, an ink outline, and an optional tomato shadow for titles. The pictures need no font file.
   Live text names three OFL families (Lilita One, Rubik, Space Mono). No font was downloaded, so their license
   files were not read here. The integrator checks them when self-hosting.
3. **Twelve kinds of bag.** The collection's label is "Bags", so the variants are twelve kinds of bag, from the tote
   to a net of lemons, each hanging on the same wall. None copies a brand's bag, stripes, monogram, tag or print.
4. **The mark is a tote on a hook.** It reads at 48 px and in a round crop. `check.mjs` renders the logo and the
   avatar next to their bare walls and proves the 2-module clear space and the round fit.
5. **The price coin has no name in the pictures.** The task says to never draw or name the brand behind LINK. The
   coins are plain gold discs with no letters and no hexagon, and `lettering()` refuses to write the coin's name.
   Text names LINK only as the registry's price coin. This also lets the art serve any community coin, which fits
   F89's wish for Bag Holders as a template.
6. **The idea's line stays out.** The task quoted the idea as `the insult becomes the prize`. The kit keeps it out of
   pictures and posts, because its last word reads as a promise, and lists it in the brand book's avoid list. The
   public line is "420 bags share the fees." See open point 1.
7. **Keep on both sides means equal shares.** The ledger adds the same amount to every bag for each receipt, whether
   the bag is in the vault or out. So the kit says a bag's share never depends on when it was taken out, and the
   pick-before-collect timing gap that the launch skill discloses changes only who can claim, not how much a bag
   holds. Facts below.
8. **Hooks sit in holes.** `hangBag` takes the wall's hole grid and throws when a hook is off it, naming the nearest
   hole. Every hook in every picture sits in a hole.
9. **No raise number in the kit.** F123 lets a listing change its raise for future boxes, the registry notes say
   fixture raises must never become quotes, and the brief keeps prices out.
10. **Square Hole's 3 of 15 parts are one line.** The kit says "3 parts go to Square Hole (its platform and its
    buy-back)" and does not split that share further. A legal read asked the line to say where the share goes. In the
    Terms and in the code, 2 of the parts go to Square Hole's buy-back and 1 to its platform. What a failed box has left
    when its claims close goes to that buy-back, and the kit says so. It never names what the buy-back buys.
11. **Exact bytes.** `check.mjs` compares every SVG and PNG with a fresh build. `.gitattributes` in the kit marks
    `art/**` and `assignment.json` as `-text`, so a checkout cannot convert line endings and break that check.

## Facts read in the code

| Fact used in the kit | Where |
| --- | --- |
| Fee split into 10, 2 and 3 parts of 15 (2 and 1 to Square Hole); dust to the pool while live when items are on | `packages/contracts/src/box-v2/BoxReceiverV2Base.sol:339`, `:348`, `:350`, `:351`, `:352` |
| To items books the 10 parts for the bags; held before graduation, released to the bags at graduation | `BoxReceiverV2Base.sol:360`, `:395`, `:379`, `:386` |
| Keep sends every part to the item ledger; only BuyBackBurn retains | `BoxReceiverV2Base.sol:410`, `:416` |
| Collect tip from buyers' batches, 5% under a cap | `BoxReceiverV2Base.sol:315`, `:469`; `interfaces/ReleaseConstantsV2.sol:34` |
| Every receipt adds the same share to every bag, inside (stash) or outside (credit); the base at graduation too; the remainder to residue | `ItemLedgerV2.sol:232`, `:255`, `:257`, `:260`, `:261`, `:263` |
| Taking out and putting back keep the bag's credit and stash | `ItemLedgerV2.sol:341`, `:353`; `interfaces/IItemLedgerV2.sol:10` |
| Claims: current owner only, one bag, outside only, a recipient that is not zero or the vault, credit plus stash | `ItemLedgerV2.sol:426`, `:427`, `:435`, `:444`, `:447` |
| Claims wait for the records; anyone can run the catch-up | `ItemLedgerV2.sol:498`, `:505`, `:185` |
| Residue goes to the pool | `ItemLedgerV2.sol:398`, `:409` |
| The vault opens at graduation | `BoxCoordinatorV2.sol:251`; `BoxVaultV2.sol:679` |
| Take-out price rounded up, 1% pick fee burned, the last bag stays | `BoxVaultV2.sol:685`, `:686`, `:698`; `libraries/VaultViews.sol:20`, `:21` |
| Put-back by the owner only, rounded down, 5% fee burned | `BoxVaultV2.sol:726`, `:733`, `:750`, `:88`; `libraries/VaultViews.sol:27` |
| Open art has no draws: tickets need hidden items | `BoxVaultV2.sol:268`, `:269` |
| 1% fee on buys (LINK in) and on sales (LINK out); outside liquidity and removals refused | `BoxHookV2.sol:25`, `:171`, `:185`, `:239`, `:249` |
| Deepen: anyone after graduation, 49.75% buys TOTE, a tip of at most 5% | `BoxHookV2Extension.sol:92`, `:108`; `BoxHookV2Base.sol:170`; `interfaces/ReleaseConstantsV2.sol:31` |
| Launch window of 384 seconds, tax table from 931,974 to 80,565 millionths, tax to the pool after graduation | `BoxHookV2.sol:32`, `:123`; `BoxLaunchRouterV2.sol:259`, `:290`, `:190` |
| Failure: anyone after the deadline, or 7 days after a filled curve closes; held bag money to the pot; bags in the vault to the creator; claims for 365 days | `BoxCoordinatorV2.sol:212`, `:80`; `interfaces/ReleaseConstantsV2.sol:56`; `BoxReceiverV2.sol:299`; `BoxVaultV2.sol:216` |
| Collections start at id 1 | `packages/box-spec/src/generated/box-spec.v2.ts:27`, `:530` |
| The create page's Collection template is "NFTs · To items · Keep"; Keep's wording | `apps/web/src/features/create/v2/templates.ts:49`; `FeesStep.tsx:19` |
| The keeper collects once a batch reaches the coin's minimum and claims nothing for users | `packages/keeper/README.md:14`, `:23` |
| The local test life uses an 18-decimal LINK stand-in | `packages/contracts/script/local/LocalQuoteMocks.sol:96` |

## Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node build-art.mjs` | Exit 0: built 24 SVG and PNG pairs and `art/logo-48.png`, about 0.4 s |
| `node build-art.mjs` again, then a SHA-256 of every file in `art/` | All 49 hashes match the first build, so the build is byte-for-byte repeatable |
| `node assign.mjs > assignment.json` | 420 items; every variant appears 35 times; id 1 gets 01 and id 420 gets 12 |
| `node check.mjs` before the docs existed | Exit 1 as expected: 100 problems, all missing docs and README, storybook and art-notes entries. Every art, palette, assignment and avatar corner check passed |
| Seventeen mutation runs of `node check.mjs` | Each exit 1 with the expected FAIL line, or for the hook, the build's error naming the nearest hole; see the list below. Every file was restored from a copy, and a SHA-256 of the whole folder matched the one taken before |
| `node check.mjs` final | Exit 0: 477 checks passed (12 variants, 7 scenes, 420 bags) |
| `./node_modules/.bin/eslint examples/boxes/bag-holders` (repository root) | Exit 0, after removing two unused names it first flagged |
| `pnpm lint` (repository root, once) | Exit 0 |
| `pnpm check:handoff` (repository root) | Exit 0: both handoff folders match their hashes |
| `gitleaks dir examples/boxes/bag-holders` (repository root) | Exit 0, no leaks found |

The mutations: a banned word, an em dash, a wrong PNG size, a changed assignment, a three-sentence caption, a
hand-edited SVG, the platform token's name, a coin amount, the name of the price coin's project in a doc, the price
coin's name in an SVG description, a color defined outside `src/palette.mjs`, a bag moved into the X avatar corner,
the mark moved into its clear space, a missing scene, a doc link to a missing file, a palette color missing from
the brand book, and a hook moved off its hole (which stops the build with the nearest hole named).

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest, Forge, `pnpm verify` and E2E were not
run. No server was started.

## Visual review

- The logo at a real 48 px still reads as a bag with a red pocket on a hook. In a round crop the whole mark and its
  shadow sit inside 94% of the radius.
- On the X banner, the corner at x 0 to 420 and y 270 to 500 holds only bare pegboard, proven pixel by pixel.
- The 12 variants were compared on one contact sheet: all distinct, all one family. The sandbag's top was redrawn so
  it no longer looked like a crown, and the lemon net was opened up so the lemons show.
- All seven scenes were checked at full size for labels, arrows and overlaps. The bags standing in the box first
  looked like padlocks, so they were redrawn as wide bags with two straps each. The TOTE chip's little bag got the
  kit's V-shaped straps for the same reason. The pool got a ladder so it reads as a pool.
- No browser, X upload or platform crop test was done.

## Limits and open points

1. The idea's line, `the insult becomes the prize`, came with the task and is not in the repository. Default: keep
   it out of public copy and use "420 bags share the fees."
2. The price coin. The pictures never name it, and the text says LINK. Default: keep it that way, so the same art
   can serve a copy of this box in another community coin.
3. The template. F89 wants Bag Holders as a ready-made template, and today's Collection template is the same recipe.
   Default: offer this kit as that template's example look, with the name left to the founder.

- The founder's example-boxes doc was not read. Its note on Bag Holders comes from F89 in the decision log.
- Counsel still has to look at the name and the joke, how a bag's share is described, the price coin's listing, the
  ticker, and the kit's publication license.
- The registry still points at the local test pictures. Using this art needs the metadata and hosting step, with the
  deployed collection on ids 1 to 420.

## Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-BAG-HOLDERS.md` when merging.
2. When wiring the art, build the metadata from `assignment.json` and confirm the collection ids run 1 to 420.
3. Check the three font licenses when the site self-hosts them.
4. Choose the open-source license for the kit collection before publishing it.

## Check fix for the files an operating system adds

`check.mjs` failed when Finder added a `.DS_Store` file to a folder of the kit, and a `Thumbs.db` or `desktop.ini`
from Windows would have failed it the same way. Every folder listing in it now skips those files, and nothing deletes
them. The change is in commits `fdd30c10` and `0e7ccdc2`, made on the same branch from `fd586423` for all nine kits,
inside `check.mjs` only. The second commit adds `.directory`, `.AppleDouble`, `.Trash-` folders and `__MACOSX`. All
commands ran with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node check.mjs` before the change | Exit 0: 477 checks passed |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the change | Exit 1: 10 problems, such as `art/items: holds a file that is not a variant picture`. All nine kits failed |
| The same on a fresh copy after the change | Exit 0: 477 checks passed, the same count as in the tree. All nine kits passed |
| A fresh copy with `.directory`, `.AppleDouble`, `.Trash-1000` and `__MACOSX` added too, after the second commit | Exit 0: 477 checks passed. |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` (repository root) | Exit 0 |
| `node check.mjs` final | Exit 0: 477 checks passed |

## Word-free reference pictures

The explainer pipeline needs each kit's world as a reference picture with no words in it. `build-art.mjs --no-words`
writes `art/reference/cover.png`, `art/reference/box-banner.png` and `art/reference/scenes/scene-01.png` to
`scene-07.png`: the same pictures with every word, number and sign of the sticker alphabet left out. `withoutWords` in
`src/type.mjs` makes `lettering` draw nothing while `measure` still sizes every block, so plates, the button, the box
patches and the bag prints keep their place, blank. Only PNGs are written, because the SVG titles and descriptions name
words that are no longer drawn. All commands ran from the kit folder with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node build-art.mjs`, then `git status --short`, before the change | No file changed: the committed art is a fresh build |
| `node build-art.mjs` after the change, then `git status --short` | Only the two source files changed. The sha256 of all 49 art files match commit `aa22b629` |
| `node check.mjs` | Exit 0: 477 checks passed after the build change, as before; 478 with these docs, whose new README link it also checks |
| `node build-art.mjs --no-words`, twice | Exit 0: 9 PNGs, the same bytes both times |
| `node build-art.mjs --nowords` | Exit 1: unknown option, nothing written |
| OCR net from the explainer playbook: `tesseract <png> - --psm 11 tsv`, tokens of 2 or more letters, digits, $ or % at confidence 70 or more | The 9 normal pictures: 25 hits, such as HOLDERS, FEES, SQUARE and SOLD. The 9 word-free ones: 6, all read into peg hooks and tote straps (`ly` three times, `AX` twice, `AN` once). The normal scenes 03 and 07 give the same 5 hits there |
| Each word-free picture looked at next to its normal one | No lettering left; every other shape in place |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/bag-holders` (repository root) | Exit 0 |
