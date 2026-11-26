# SH-KIT-RENT-FREE work record

Kit agent for box id `rent-free` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree, from base
`562f87e8`. Every change is inside `examples/boxes/rent-free/`. The brief limits work to this folder, so the record
sits here. The integrator can copy it to `docs/evidence/` as the project rules ask.

## Requirements and files

| ID | Requirement | Result |
| --- | --- | --- |
| RF-01 | Read the box settings, registry notes, research and founder notes | Read `rent-free.json`, the registry README, the Rent Free entry of round 2b, plan § 5 (marked historical for v2), the decision log (F86, F89, F109, F118 to F135), `plain-words.v2.json`, the contracts below, two finished kits (Exit Liquidity and Frog Kiln) and the old texts on the art branch (read only, not reused) |
| RF-02 | Copy the approved art unchanged | 50 files from `codex/sh-codex-1/kit-rent-free-af2` (`9a23ade0`). Every blob equals the branch's, every SHA-256 equals that branch's manifest, and `check.mjs` pins them all |
| RF-03 | Copy the landing's fee pies into `art/fees/` and use their numbers | 4 files from `sh-landing-rung1` (`389dbe24`), blobs equal. `details.md` has the same numbers in its fee example, and `check.mjs` recomputes them |
| RF-04 | Keep `assign.mjs` and `assignment.json` if they work | Kept unchanged. `node assign.mjs` prints `assignment.json` byte for byte |
| RF-05 | README with the file list | `README.md` lists every file and folder, the art pieces and the twelve houses; `check.mjs` enforces it |
| RF-06 | Brand book | `brand-book.md`: name, ticker, joke, hook, voice with fifteen example lines, nine colors, three OFL fonts with fallbacks, logo construction and clear space, do and don't, contrast table, homage and IP rules |
| RF-07 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each |
| RF-08 | Details in plain words | `details.md`: every setting, where each fee goes with the fee pies, what a holder and a house owner get, risks, what waits for counsel, v2.1 and the launch |
| RF-09 | Art notes | `art-notes.md`: the look, the seven runs and their guides, the exact cutting recipe, symbols, the house and scene tables, rules for extending |
| RF-10 | `check.mjs`, and run it | Done, see the results below |
| RF-11 | No promise words, no names of the platform's own token or collection, never the pun, "rent" stays a joke | Enforced by `check.mjs` and read by hand, see decision 5 |

## Decisions

1. **The look is the approved art.** Flat sticker houses on cream, with thick forest outlines, green walls, butter
   windows and clay accents. The founder picked it ("This is really good. I like this one."). It is far from the
   other kits' looks, such as Exit Liquidity's dark hallway and Frog Kiln's potter's studio.
2. **Raster, with no SVG source.** The brief asks for vector art, and this art came from an image generator with the
   instruction to keep it unchanged. The kit says so plainly. It keeps each generated original beside its picture,
   writes down the cutting recipe (all 25 pictures came out byte for byte the same when re-made), and pins every file
   by SHA-256. The only picture made here is `art/logo-48.png`, rendered with the workspace's resvg like the other
   kits' pictures.
3. **The box banner stays 1800 x 600.** The brief asks for 2400 x 600. The box page shows a banner as a 4:1 strip with
   `object-fit: cover`, so this one loses 75 px at the top and the bottom, and `check.mjs` proves those strips are bare
   cream. The create page takes banners from 2:1. See open point 1.
4. **Seven scenes, not eight.** The brief caps the story at seven. Scene 08, a quiet night, has a crescent in its sky.
   The Exit Liquidity kit took a crescent out of its own art as a hype picture, and the brief bans the hype word, so
   the storybook leaves scene 08 out. Its message, that nothing moves when nobody trades, is in the storybook's
   opening paragraph. The file stays in `art/` unchanged. See open point 2.
5. **The joke words are always quoted.** The founder's rule is that "rent" stays a joke, and the research warns that
   the word can be read as a promise of money. Every "rent" and "property tax" in the prose is in quotes, with the
   plain words next to it. `check.mjs` refuses the joke words without their quotes and every word on the brand
   book's avoid list. That list holds the words about homes and pay, the three-letter name of the platform's token in
   every form (which also rules out the pun the brief forbids) and the collection's name. The check reads prose as
   whole paragraphs, so a phrase broken across two lines is still caught.
6. **Names never written.** Another token that uses the RENT ticker (the research names it), the board game with
   little green houses and red hotels, and brands that list, share or sell homes. `check.mjs` holds only their
   fingerprints, so not even the check spells them.
7. **The house pictures stay in `art/houses/`.** The brief calls the folder `items/`. The art, `assign.mjs` and the
   landing page all use `art/houses/`, so it stays.
8. **The fee numbers are recomputed.** `check.mjs` splits a fee of one USDC into fifteenths in USDC's smallest
   units with BigInt, as the landing's build does, rounds to three places and requires 0.667, 0.133 and 0.200 in the
   fee example of `details.md`. Those are the fee pies' numbers.
9. **No raise number in the kit.** F123 lets a listing change its raise for future boxes, the registry notes say
   fixture raises must never become quotes, and the brief keeps prices out.
10. **Square Hole's 3 parts are one line.** The kit says "3 parts go to Square Hole (its platform and its buy-back)",
    like the other kits, and does not split that share further. A legal read asked the line to say where the share goes.
    In the Terms and in the code, 2 of the parts go to Square Hole's buy-back and 1 to its platform. What a failed box
    has left when its claims close goes to that buy-back, and the kit says so. It never names what the buy-back buys.
    The fee pies come unchanged from the landing and still read "0.200 to Square Hole"; the fee table next to them names
    the platform and the buy-back.
11. **The wallet in scene 06 stays.** It is a plain symbol for where a claim goes, with no address and no amount. The
    other kits read the brief's "wallets do not appear" as wallet addresses, and so does this one. See open point 3.

## Facts read in the code

| Fact used in the kit | Where |
| --- | --- |
| 1% fee in USDC on buys (USDC in) and on sales (USDC out, rounded up) | `packages/contracts/src/box-v2/interfaces/ReleaseConstantsV2.sol:22`, `BoxHookV2.sol:136`, `:185` |
| Fifteen parts: 10 to the choice, 2 to the pool, 3 to Square Hole (its platform and its buy-back); dust to the pool while live | `BoxReceiverV2Base.sol:343`, `:348`, `:352`, `:360` |
| Buyers' house share held before graduation, then all of it to the buy step at graduation | `BoxReceiverV2Base.sol:395`, `:386`, `:410` |
| After graduation the inside share is houses inside times one 500th; the rest goes to the item ledger | `BoxReceiverV2Base.sol:410`, `:413` |
| Equal part per house, rounding leftovers sent to the pool | `ItemLedgerV2.sol:249`, `:261`, `:409`; `interfaces/IItemLedgerV2.sol:25` |
| Claims: current owner only, one house, only outside; credit kept when the house is put back | `ItemLedgerV2.sol:426`, `:435`, `:444`, `:353` |
| Anyone can run the catch-up | `ItemLedgerV2.sol:185` |
| Buy step: after graduation, one step a block, a minimum, a tip of at most 5%, the RENT burned | `BoxReceiverV2.sol:96`, `:97`, `:112`, `:116`, `:118`; `ReleaseConstantsV2.sol:34` |
| A step moves the price by at most 49 ticks, about half a percent | `ReleaseConstantsV2.sol:28` |
| The buy step pays the usual buyers' fee | `BoxHookV2.sol:107`, `:136` |
| Collect tip from a buyers' batch, capped per box, before the split | `BoxReceiverV2Base.sol:316`, `:328` |
| Pool step after graduation, about half buys RENT, tip at most 5% | `BoxHookV2Extension.sol:96`, `:108`; `ReleaseConstantsV2.sol:31` |
| Outside liquidity and removals refused | `BoxHookV2.sol:239`, `:249` |
| First buyers' fees up to one thousandth of the raise pay the graduation step; split as fees on a failure | `BoxHookV2Base.sol:73`, `:91`; `BoxCoordinatorV2.sol:253`, `:397`, `:617` |
| Launch window of 32 steps of 12 s, tax 93.2% down to 8.1%, to the pool or the failure claim | `BoxSpecV1.sol:42`, `:44`, `:46` (in `src/box/`); `BoxLaunchRouterV2.sol:259`, `:290`, `:369`, `:191` |
| Take out only after graduation, with the 1% pick fee; put back 5%; no draws without hidden art | `BoxVaultV2.sol:679`, `:686`, `:88`, `:716`, `:269` |
| Price of one house rounded up, put-back share rounded down, the last house stays | `libraries/VaultViews.sol:20`, `:21`, `:27` |
| Failure: deadline, or 7 days after a filled curve; claims for 365 days; held money to the closing pool | `BoxCoordinatorV2.sol:216`, `:221`, `:80`; `ReleaseConstantsV2.sol:56`; `BoxReceiverV2.sol:295`, `:297`, `:299` |
| Inside houses go back to the creator after a failure | `BoxVaultV2.sol:216` |
| Collections start at id 1 | `packages/box-spec/src/generated/box-spec.v2.ts:27` |
| The keeper plans collect, the pool step and the buy step | `packages/keeper/src/plan.ts:57`, `:58`, `:155` |
| Create page: an item picture of at most one raw block, banners from 2:1, shown at 4:1 | `apps/web/src/features/create/art-files.ts:29`, `:37`; `create.css:838`; `apps/web/src/features/boxes/BoxHeader.tsx:103` |

Paths without a folder are in `packages/contracts/src/box-v2/`.

## Commands and results

All commands ran with Node 24.19.0, from the worktree root unless the kit folder is named.

| Command | Result |
| --- | --- |
| `git checkout codex/sh-codex-1/kit-rent-free-af2 -- examples/boxes/rent-free/art examples/boxes/rent-free/assign.mjs examples/boxes/rent-free/assignment.json` | 52 files; for each, `git rev-parse <branch>:<path>` equals `git hash-object <path>` |
| `git show sh-landing-rung1:docs/marketing/explainers/examples/rent-free/<file> > examples/boxes/rent-free/art/fees/<file>`, four files | Each blob equals the branch's |
| SHA-256 of the 50 art files against the art branch's `art-manifest.json` | 25 pictures and 25 originals match |
| The 25 recorded ImageMagick 7.1.2-21 commands, re-run into a scratch folder | 25 of 25 pictures byte for byte the same |
| `node assign.mjs`, compared with `assignment.json` (kit folder) | Identical |
| `node preview.mjs` twice (kit folder) | Same `art/logo-48.png` both times |
| `node check.mjs` before the docs existed (kit folder) | Exit 1 as expected: 104 problems, all missing docs and their entries; 328 checks passed, including every art, calm-area, palette and assignment check |
| `node check.mjs` with the docs | Exit 1: it read the shell commands in code blocks as prose. Code blocks are now skipped, and prose is read as whole paragraphs |
| Mutation runs of `node check.mjs` | See the next table |
| `node check.mjs`, final (kit folder) | Exit 0 |
| `./node_modules/.bin/eslint examples/boxes/rent-free` | Exit 0 |

| Mutation, each on one file, restored from a copy afterwards | Result |
| --- | --- |
| A promise word in `README.md` | Exit 1, the word is named |
| The joke word without quotes in a caption | Exit 1, the quotes rule |
| The pun's verb in `brand-book.md` | Exit 1 |
| A phrase about homes broken across two lines | Exit 1, read as one paragraph |
| An em dash in `details.md` | Exit 1 |
| A coin amount outside the fee example | Exit 1 |
| 0.666 in place of 0.667 in the fee example | Exit 1, the fee line is named |
| A third sentence under a scene | Exit 1 |
| One byte added to a house picture | Exit 1, its SHA-256 |
| A stray file in `art/` | Exit 1 |
| A fingerprinted name in `art-notes.md` | Exit 1, without the check spelling it |
| One variant changed in `assignment.json` | Exit 1 |
| A stale `art/logo-48.png` | Exit 1, not a fresh render |

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest, Forge, `pnpm verify` and E2E were not run.
No server was started, nothing was fetched and no font was downloaded.

## Visual review

- The mark at a real 48 px, rendered by resvg, still shows the roof, the chimney, the lit window and the door.
- In a round crop the whole house sits inside 89% of the circle.
- The X banner with a round avatar laid over its bottom-left corner covers only bare cream.
- The box banner cut to 4:1 at its center keeps every word and every house.
- The twelve houses on one contact sheet are all different and one family. Three sit off center (03 within 15 px of
  the left edge, 07 within 12 px of the right, 10 within 22 px of the right), and none is cut off.
- The eight scenes were read at full size. Scene 01's box comes within 9 px of the right edge, and nothing is cut
  off. The scenes were scaled up from 627 px, so they are a little soft.
- The art has no people, faces, brands or known characters, and no word or ticker inside the houses or scenes.
- No browser, X upload or platform crop test was done.

## Open points

1. **Box banner size.** It is 1800 x 600, and the brief asks for 2400 x 600. Default: keep it. The box page's 4:1
   crop removes only bare cream, which `check.mjs` proves.
2. **Scene 08.** It is in `art/scenes/` unchanged but not in the story, because its sky has a crescent. Default: keep
   the file, unused. If the founder wants the folder to match the story, delete scene 08 and its original and drop them
   from `FILES` in `check.mjs`.
3. **The wallet in scene 06.** The brief says wallets do not appear, which the kits read as wallet addresses. Default:
   keep the scene. It shows where a claim goes, and no address or amount is on it.

## Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-RENT-FREE.md` when merging.
2. When wiring the art, build the metadata from `assignment.json` and confirm that the collection ids run 1 to 500.
   The registry row still points at local test pictures.
3. Choose the open-source license for the kit collection, and have counsel look at the rights to the generated
   pictures, before publishing it.

## Check fix for the files an operating system adds

`check.mjs` failed when Finder added a `.DS_Store` file to a folder of the kit, and a `Thumbs.db` or `desktop.ini`
from Windows would have failed it the same way. Every folder listing in it now skips those files, and nothing deletes
them. The change is in commits `fdd30c10` and `0e7ccdc2`, made on the same branch from `fd586423` for all nine kits,
inside `check.mjs` only. The second commit adds `.directory`, `.AppleDouble`, `.Trash-` folders and `__MACOSX`. All
commands ran with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node check.mjs` before the change | Exit 1: 1 problem, `art/ holds files the kit does not list: art/.DS_Store`, with 509 checks passed. Finder had put that file into `art/` |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the change | Exit 1: 4 problems, such as `README.md does not list Thumbs.db`. All nine kits failed |
| The same on a fresh copy after the change | Exit 0: 510 checks passed, the same count as in the tree. All nine kits passed |
| The fresh copy with a stray `art/stray.png` added | Exit 1: `art/ holds files the kit does not list: art/stray.png`. A file of any other name still fails |
| A fresh copy with `.directory`, `.AppleDouble`, `.Trash-1000` and `__MACOSX` added too, after the second commit | Exit 0: 510 checks passed. |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` (repository root) | Exit 0 |
| `node check.mjs` final | Exit 0: 510 checks passed |
