# SH-KIT-EXIT-LIQUIDITY work record

Kit agent for box id `exit-liquidity` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree,
from base `09c3e50f`. Every change is inside `examples/boxes/exit-liquidity/`. The brief limits work to this
folder, so the record sits here. The integrator can copy it to `docs/evidence/` as the project rules ask.

## Requirements and files

| ID | Requirement from the brief | Result |
| --- | --- | --- |
| EL-01 | Read the box settings, registry notes, research and founder notes | Read `exit-liquidity.json`, the registry README, `core-v2-plan.md` sections 2 and 5, the decision log (F72, F86, F89, F109, F118 to F135), the evidence of the examples life test, and the contracts listed below. Read the Rent Free kit on `codex/sh-codex-3/sh-kit-rent-free` as the only finished kit (via `git show`, no checkout). |
| EL-02 | README with the file list | `README.md` lists every file and folder; `check.mjs` enforces it |
| EL-03 | Brand book | `brand-book.md`: name, ticker, joke, hook, voice with ten example lines, nine colors, three OFL fonts with fallbacks, logo construction and clear space, do and don't, contrast table, homage and IP rules |
| EL-04 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each, same words as `src/scenes.mjs` |
| EL-05 | Details in plain words | `details.md`: every setting, where each fee goes, what a holder and a sign owner get, risks, what waits for counsel, v2.1 and the launch |
| EL-06 | Art notes | `art-notes.md`: module, alphabet, sign, hallway, symbols, variant table, rules for extending |
| EL-07 | Clean vector art with local PNG exports | 24 SVG and PNG pairs plus `art/logo-48.png`, rendered by `@resvg/resvg-js` 2.6.2 with system fonts off |
| EL-08 | 8 to 12 variants and a deterministic assignment | 12 variants; `assign.mjs` and `assignment.json` cover ids 1 to 404 |
| EL-09 | `check.mjs` that verifies files and pixel sizes, and run it | Done; see results |
| EL-10 | Original art, no promise words, no names of the platform's own token or collection, plain writing | Word and shape scan in `check.mjs`, plus a manual read of every doc |

## Decisions

1. **The look.** A hallway at night, lit only by its signs: LED panels and light boxes in green, mint, red and
   amber on near-black. The box's joke is an exit sign that cannot find the exit, and 404 is the web's own
   "not found". The dark, glowing hallway is far from Rent Free's cream houses.
2. **Own letters.** Every letter in the art comes from a 7-row pixel alphabet drawn for this kit, so the
   pictures need no font file and carry no font license. Live text names three OFL families (Barlow Condensed,
   Barlow, JetBrains Mono). No font was downloaded.
3. **Sign #404 shows the 404 sign.** The variants are ordered so that the plain 404 sign is 08, and the rule
   `((id - 1) mod 12) + 1` lands id 404 on it. Counts stay 34 and 33, with no rarity.
4. **No raise number in the kit.** F123 lets a listing change its raise for future boxes, the registry notes say
   fixture raises must never become quotes, and the brief keeps prices out.
5. **Square Hole's 3 of 15 parts are one line.** The kit says "3 parts go to Square Hole (its platform and its
   buy-back)" and does not split that share further. A legal read asked the line to say where the share goes. In the
   Terms and in the code, 2 of the parts go to Square Hole's buy-back and 1 to its platform. What a failed box has left
   when its claims close goes to that buy-back, and the kit says so. It never names what the buy-back buys.
6. **Stars, not a crescent, in the night scene.** The first check run flagged a banned hype word in that
   scene's alt text. The word is also a hype image, so the art now shows only stars.
7. **Exact bytes.** `check.mjs` compares every SVG and PNG with a fresh build. `.gitattributes` in the kit marks
   `art/**` and `assignment.json` as `-text`, so a checkout cannot convert line endings and break that check.

## Facts read in the code

| Fact used in the kit | Where |
| --- | --- |
| Fee split into 10, 2 and 3 parts of 15; dust to the pool while live when items are on | `packages/contracts/src/box-v2/BoxReceiverV2Base.sol:339`, `:284` |
| Pool and Grow claims released at graduation | `BoxReceiverV2Base.sol:366`, `:379` |
| Sellers' sign share held before graduation, then all of it buys back at graduation; after that the inside part buys back | `BoxReceiverV2Base.sol:395`, `:405`, `:410` |
| Buy-back buys EXIT and burns it | `BoxReceiverV2.sol:87` |
| 1% fee on buys (USDC in) and on sales (USDC out) | `BoxHookV2.sol:171`, `:185` |
| Outside liquidity and removals refused | `BoxHookV2.sol:233`, `:243` |
| Only the curve position is ever removed; the full-range position only grows | `BoxHookV2Extension.sol:192`, `:242`, `:298` |
| Deepen: anyone after graduation, 49.75% buys EXIT, both sides added | `BoxHookV2Extension.sol:92`, `:273`; `interfaces/ReleaseConstantsV2.sol:31` |
| Take out with a limit and deadline; put back with a minimum and deadline; 5% put-back fee | `BoxVaultV2.sol:370`, `:388`, `:88` |
| EXIT for one sign: active supply over signs inside, rounded up to take out and down to put back; the last sign stays | `libraries/VaultViews.sol:18`, `:25` |
| Pick fee from the spec, burned | `BoxVaultV2.sol:606` |
| Claims: owner only, one sign, outside signs only, credit kept on put-back | `ItemLedgerV2.sol:417`, `:441`, `:444`, `:353` |
| Failure: anyone after the deadline, or 7 days after a filled curve closes; claims for 365 days, then a sweep | `BoxCoordinatorV2.sol:212`, `:80`, `:803`; `ReleaseConstantsV2.sol:56` |
| Collections start at id 1 | `packages/box-spec/src/generated/box-spec.v2.ts:27`, `:530` |

## Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node build-art.mjs` | Exit 0: built 24 SVG and PNG pairs and `art/logo-48.png`, about 0.6 s |
| `node build-art.mjs` again, then `git status --short` | No art file changed: the build is byte-for-byte repeatable |
| `node assign.mjs > assignment.json` | 404 items; variants 01 to 08 appear 34 times, 09 to 12 appear 33 times; id 404 gets 08 |
| `node check.mjs` before the docs existed | Exit 1 as expected. The first run also flagged a banned word in a scene's alt text (fixed in the art). After the fix, 46 problems, all missing docs and README or storybook entries |
| Eight mutation runs of `node check.mjs` (banned word, em dash, wrong PNG size, changed assignment, three-sentence caption, hand-edited SVG, the platform token's name, a coin amount) | Each exit 1 with the expected FAIL line; every file restored from a copy afterwards |
| `node check.mjs` final | Exit 0; see the commit that adds the docs |
| `./node_modules/.bin/eslint examples/boxes/exit-liquidity` (repository root) | Exit 0 |
| `pnpm lint` (repository root, once) | Exit 0 |

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest, Forge, `pnpm verify` and E2E were not
run. No server was started.

## Visual review

- The logo at a real 48 px still reads 404. In a round crop the housing corners sit well inside the circle.
- On the X banner, the corner at x 0 to 420 and y 270 to 500 holds only plain wall and floor.
- The 12 variants were compared on a 300 px contact sheet: all distinct, all one family.
- All seven scenes were checked at 700 px for labels, arrows and overlaps; three placements were fixed.
- No browser, X upload or platform crop test was done.

## Limits and open points

- The founder's example-boxes Claude doc is on his old account and was not read. The quote "I like this this is
  fun" came with the task and is not in the repository.
- Counsel: the name and the joke, how a sign's fee share is described, the ticker, and the kit's publication
  license.
- The registry still points at the local test pictures. Using this art needs the metadata and hosting step,
  with the deployed collection on ids 1 to 404.

## Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-EXIT-LIQUIDITY.md` when merging.
2. When wiring the art, build the metadata from `assignment.json` and confirm the collection ids run 1 to 404.
3. Choose the open-source license for the kit collection before publishing it.

## Check fix for the files an operating system adds

`check.mjs` failed when Finder added a `.DS_Store` file to a folder of the kit, and a `Thumbs.db` or `desktop.ini`
from Windows would have failed it the same way. Every folder listing in it now skips those files, and nothing deletes
them. The change is in commits `fdd30c10` and `0e7ccdc2`, made on the same branch from `fd586423` for all nine kits,
inside `check.mjs` only. The second commit adds `.directory`, `.AppleDouble`, `.Trash-` folders and `__MACOSX`. All
commands ran with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node check.mjs` before the change | Exit 0: 339 checks passed |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the change | Exit 1: 3 problems, such as `README.md does not list Thumbs.db`. All nine kits failed |
| The same on a fresh copy after the change | Exit 0: 339 checks passed, the same count as in the tree. All nine kits passed |
| A fresh copy with `.directory`, `.AppleDouble`, `.Trash-1000` and `__MACOSX` added too, after the second commit | Exit 0: 339 checks passed. |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` (repository root) | Exit 0 |
| `node check.mjs` final | Exit 0: 339 checks passed |

## Word-free reference pictures

The explainer pipeline needs each kit's world as a reference picture with no words in it. `build-art.mjs --no-words`
writes `art/reference/cover.png`, `art/reference/box-banner.png` and `art/reference/scenes/scene-01.png` to
`scene-07.png`: the same pictures with every word, number and sign of the alphabet left out. `withoutWords` in
`src/type.mjs` keeps each block's columns and rows and lights no cell, so signs, counters, plates and buttons keep
their size and place, blank; the flicker dot goes too. The arrow on an EXIT square is the token's symbol and stays, as
do the diagram arrows and brackets. Only PNGs are written, because the SVG titles and descriptions name words that
are no longer drawn. All commands ran from the kit folder with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node build-art.mjs`, then `git status --short`, before the change | No file changed: the committed art is a fresh build |
| `node build-art.mjs` after the change, then `git status --short` | Only the three source files changed. The sha256 of all 49 art files match commit `aa22b629` |
| `node check.mjs` | Exit 0: 339 checks passed after the build change, as before; 340 with these docs, whose new README link it also checks |
| `node build-art.mjs --no-words`, twice | Exit 0: 9 PNGs, the same bytes both times |
| `node build-art.mjs --nowords` | Exit 1: unknown option, nothing written |
| OCR net from the explainer playbook: `tesseract <png> - --psm 11 tsv`, tokens of 2 or more letters, digits, $ or % at confidence 70 or more | The 9 normal pictures: 26 hits, such as EXIT, FEE, POOL and SELL. The 9 word-free ones: 1 hit, `O00` in scene 02, which is the row of three coins on the right and is there in the normal scene too |
| Each word-free picture looked at next to its normal one | No lettering left; every other shape in place |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/exit-liquidity` (repository root) | Exit 0 |
