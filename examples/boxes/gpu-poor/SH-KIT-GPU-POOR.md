# SH-KIT-GPU-POOR work record

Kit agent for box id `gpu-poor` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree. Version 1
was built from base `b50a9096` and stays at the git tag `kit-gpu-poor-v1` (commit `1fc90d71`). Version 2 was built
in place on the same branch from `5122eb32`. Every change is inside `examples/boxes/gpu-poor/`. The brief limits work
to this folder, so the record sits here. The integrator can copy it to `docs/evidence/` as the project rules ask.

## Word-free reference pictures

The explainer pipeline needs each kit's world as a reference picture with no words in it. `build-art.mjs --no-words`
writes `art/reference/cover.png`, `art/reference/box-banner.png` and `art/reference/scenes/scene-01.png` to
`scene-07.png`: the same pictures with every word, number and sign of the tube alphabet left out. `withoutWords` in
`src/type.mjs` lets `lettering` measure its box as always but draw and record nothing, so plates and named coins keep
their size and place. Only PNGs are written, because the SVG titles and descriptions name words that are no longer
drawn. All commands ran from the kit folder with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node build-art.mjs`, then `git status --short`, before the change | No file changed: the committed art is a fresh build |
| `node build-art.mjs` after the change, then `git status --short` | Only the two source files changed. The sha256 of all 27 art files match commit `aa22b629` |
| `node check.mjs` | Exit 0: 486 checks passed after the build change, as before; 487 with these docs, whose new README link it also checks |
| `node build-art.mjs --no-words`, twice | Exit 0: 9 PNGs, the same bytes both times |
| `node build-art.mjs --nowords` | Exit 1: unknown option, nothing written |
| `recordLettering` around the normal cover, box banner and scenes, then around `references()` | 32 lines of lettering, then none |
| OCR net from the explainer playbook: `tesseract <png> - --psm 11 tsv`, tokens of 2 or more letters, digits, $ or % at confidence 70 or more | The 9 normal pictures: 30 hits, such as POOR, $NVDA, VRAM, FEE and BURN. The 9 word-free ones: none |
| Each word-free picture looked at next to its normal one | No lettering left; every other shape in place |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/gpu-poor` (repository root) | Exit 0 |

## Version 2 review fixes

A review of version 2 asked for four fixes in this kit and one in the check of every kit. They were made in place on
the same branch from `fd586423`. The kit's changes are inside `examples/boxes/gpu-poor/`. The registry change is in
`packages/box-spec/examples/v2/`, in commits of its own. GP-20 replaces the 44 px coin rule wherever the version 2
sections below give it, and GP-22 settles the version 1 points on the fixture ticker GPU. An independent read-only
review of the round came back with no wrong check result and a few gaps, and the second pass closed the ones inside
this brief.

### Requirements and files

| ID | Finding | Result |
| --- | --- | --- |
| GP-19 | The storybook names $NVDA, Nvidia and Ondo and lacked the two legal lines | It now ends with a short note below a rule that carries "The stock coin may not be offered to US persons." and "Nvidia and Ondo did not make, approve or endorse this box." `check.mjs` requires both lines in storybook.md |
| GP-20 | $NVDA on the small trade coins of scenes 01 and 05 did not read at post size, 400 to 600 px wide, and in scene 05 it nearly touched the coin's ring | A coin letters $NVDA only from a radius of 80 px. Scenes 01 and 05 write $NVDA in ice under their trade coins, and scene 01 writes VRAM in orange under its chip, the way the fee loop names its coins. Both scenes were re-rendered, and `check.mjs` checks the size of every word in a post |
| GP-21 | details.md lacked the issuer line | The risk bullet about Ondo now opens with "Ondo can pause the stock coin. Then this box waits too.", and `check.mjs` requires it in details.md |
| GP-22 | The registry row had the ticker GPU, while the kit uses VRAM, the founder's default | The row, its README line and a registry test say VRAM. The kit's README, brand book and details.md no longer speak of a fixture ticker |
| GP-23 | `check.mjs` failed when Finder added a `.DS_Store` file to a folder | Every folder listing in the check skips the files an operating system adds, such as `.DS_Store`, `Thumbs.db` and `desktop.ini`. Nothing deletes them |

### What changed

| Part | Change |
| --- | --- |
| `storybook.md` | The closing note. The alt text of scene 01 says "labeled $NVDA" and "labeled VRAM", and that of scene 05 "labeled $NVDA". The intro says which coin carries the name and that some pictures write the names under the coins and chips |
| `src/props.mjs` | `TICKER_COIN_R` is 80 in place of 44, and `NAME_LABEL` makes the labels under small coins and chips 28 px tall |
| `src/scenes.mjs` | `nameUnder()` writes the names under the trade coins of scenes 01 and 05 and under the chip of scene 01. In scene 01 both arrows now meet the coin and the chip below their labels |
| `src/type.mjs` | `recordLettering(draw, { sizes: true })` also gives the cap height of each word |
| `art/scenes/scene-01`, `scene-05`, `.svg` and `.png` | Re-rendered. The other twelve PNGs are byte for byte the same |
| `details.md` | The issuer line in the risk about Ondo. The name row says `VRAM`, and the counsel list no longer waits for the registry row |
| `brand-book.md`, `art-notes.md`, `README.md` | The coin rule at 160 px wide, the labels under small coins, the size check, and no fixture ticker |
| `check.mjs` | See the next section |

### The check after the fixes

- **The storybook's note.** The scenes end at a line of three dashes. After it comes one note of at most three
  sentences, with no heading and no picture. The note must carry the US persons and not-affiliated lines.
- **The issuer line.** details.md must carry it word for word in its risks, and the other two lines on the page.
- **Size in a post.** A post often shows a scene or the cover, both 1200 px wide, 500 px wide. Every word they letter
  must be at least 7.5 px tall there. The smallest today is the ticker on the big fee coin of scene 02, at 7.9 px.
  The labels under small coins are 11.7 px.
- **The fixture ticker.** While the registry row and the kit carry different tickers, the README and the brand book
  must say so. Once they agree, as now, no doc may still speak of a fixture ticker.
- **Files the operating system adds.** Folder listings skip `.DS_Store`, `._` files, `Thumbs.db`, `desktop.ini`,
  `.directory`, `.AppleDouble`, `.Trash-` folders, `__MACOSX` and the other names in `OS_FILE`. A stray file of any
  other name still fails.

### Decisions in the review fixes

1. **7.5 px at 500 px wide.** That is about the cap height of 11 px text. The ticker on the big coin of scene 02 is
   7.9 px there and still reads, so that coin keeps its letters. The smallest labels the scenes had are 10.8 px
   there, on the SQUARE HOLE plate, and the 1% labels are 11.7 px.
2. **Labels, as the fee loop does.** A name under a small coin reads better than letters squeezed onto it, and the
   cover and both banners already name their coins that way. Scene 01 is the first picture, so it names both the
   coin and the chip. Scene 05 names only its coins, so the dashed fee arrows keep their room.
3. **A rule before the note.** A heading would make an eighth section. The rule keeps the seven scenes, and the
   legal lines come where a reader finishes.
4. **The registry test pins VRAM with NVDAon,** like the test line for One Dollar is all you need.

### Commands and results (review fixes)

All commands run with Node 24.19.0, from the repository root unless they name the kit's own files.

| Command | Result |
| --- | --- |
| `node check.mjs` before any change (control) | Exit 0: 446 checks passed |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the check fix | Exit 1: 8 problems, such as `README.md does not list Thumbs.db` and `src/.DS_Store is not described in README.md or art-notes.md`. All nine kits failed |
| The same on a fresh copy after the check fix | Exit 0: 446 checks passed, the same count as in the tree. All nine kits passed with their own counts |
| `node check.mjs` after each step | 450 with the storybook note, 451 with the issuer line, 480 with the size check, 478 after the registry change (the two checks for differing tickers stop), 483 with the fixture ticker rule |
| 10 runs of `check.mjs` on scratch copies of the kit, with the repository linked beside it, never on the kit itself | The control exits 0 with 483 checks. Each of the 9 mutations exits 1 with the expected FAIL line: the note without the US persons line, without the not-affiliated line, without its rule, with a fourth sentence and with a heading; details.md without the issuer line; coins lettered from 44 px again (4.8 px in scene 01, 5.0 px in scene 05); labels 14 px tall (5.8 px); and a fixture ticker note back in the README. Mutations of the source were rebuilt first |
| `node --test packages/box-spec/examples/v2/registry.test.mjs` | 4 of 4 pass before and after the change. With the row set back to GPU on purpose, the new test line fails with `actual: [ 'GPU', 'NVDAon' ]`, and the row was set back to VRAM |
| `node --test` on the examples runner's `registry.test.mjs`, `support.test.mjs` and `wallet.test.mjs` | 11 of 11 pass before and after |
| `node build-art.mjs` twice on a scratch copy, then a SHA-256 of all 27 files in `art/` | The tree, the first build and the second build are identical |
| `git diff fd586423 HEAD` over every PNG | 2 changed, scenes 01 and 05. The other 12 are byte for byte the same |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` and the same for `packages/box-spec/examples/v2` | Exit 0 |
| `gitleaks dir examples/boxes/gpu-poor` and `gitleaks dir packages/box-spec/examples/v2` (8.30.1) | Exit 0, no leaks found |
| `pnpm check:handoff` | Exit 0 |
| 3 runs after the review, on scratch copies | The control exits 0 with 486 checks. Moving the two legal lines from the note into the intro, and the issuer line from the risks into the intro of details.md, each exits 1 with the placement FAIL line |
| The fresh copy of every kit with `.directory`, `.AppleDouble`, `.Trash-1000` and `__MACOSX` added | Exit 0 for all nine kits after the second filter commit. With the earlier filter, this kit stopped with `EISDIR` on `src/.AppleDouble` |
| `node check.mjs` final | Exit 0: 486 checks passed (7 scenes, 1024 later GPUs, no items) |

The contract life and the browser life with the ticker VRAM did not run here. `offline.mjs` needs the contract
submodules, which are empty in this worktree, and fetching them would touch a remote. Both lives read the ticker from
the registry row. No server or browser was started.

### Commits (review fixes)

| Commit | What |
| --- | --- |
| `fdd30c10` | The check of all nine kits skips the files an operating system adds |
| `8212cb54` | The storybook's closing note and its check |
| `8eaf2935` | The issuer line in details.md and its check |
| `2e5c2c3d` | $NVDA under the small trade coins, the size check, scenes 01 and 05 re-rendered |
| `171372d7` | The registry row, its README line and its test say VRAM |
| `f6195593` | The kit's docs drop the fixture ticker, and the check refuses it |
| `d0436930` | This record, first pass |
| `0e7ccdc2` | The check of all nine kits skips `.directory`, `.AppleDouble`, `.Trash-` folders and `__MACOSX` too |
| `5b9b23dc` | The legal lines must stand in the storybook's note and the issuer line in the risks |
| `adebd465` | The registry README says VRAM is the token GPU Poor burns, in place of `the token its fees buy and burn` |
| This commit | This record, second pass |

### Visual review (review fixes)

- Scenes 01 and 05 were checked at full size and at 500 px wide. At 500 px the labels read, and so does the ticker on
  the big coin of scene 02.
- Measured on the lettering boxes, the labels start 12.7 to 12.9 px below the coin's shadow. In scene 01 they end
  28.4 px above the start of the ice arrow and 34.4 px above the tip of the orange one. In scene 05 they stay 35.8 and
  40.8 px from the dashed fee arrows. The scene 01 label starts 78.8 px from the left edge.
- With no letters, the building on the trade coins of scene 05 sits well inside the ring again.
- No browser, X upload or platform crop test was done.

### Open points (review fixes)

- **The ticker GPU outside the registry.** Two fixtures still use it, the site's example configurations
  (`apps/web/src/features/create/v2/test-support/example-configurations.ts:17`) and the launch skill's stock-priced
  configuration (`skills/square-hole-launch/references/v2/configurations/stock-priced.json:14`). Default: leave them
  to their owners, since neither reads the registry.
- **The burn lines.** Fixed in a follow-up. Every line that had the whole fee buy VRAM and burn it now gives the share,
  ten of 15 fee parts, and `check.mjs` refuses the old wording (486 checks pass). The X bio has 158 characters and no
  room left for $NVDA.
- **The contract life with VRAM.** Default: run `pnpm e2e:examples` where the contract submodules are present, before
  the box goes to a test network.

## Version 2

### What the founder asked

After version 1 the founder asked to name the stock. His words:

> "I would use their logo as the stock that is used, we really use that stock, we are not faking anything here. We
> are giving their stock a new use case. ... They are using the $NVDA ticker everywhere ... But I have to admit,
> they don't use the logo. So we can probably also use $NVDA as the stock but not use the logo itself. Can you
> adjust that?"

The decisions that came with the request:

- Name the stock. Text writes $NVDA the way people do, and Nvidia where a sentence needs the company. The setting
  stays exact: details.md and every settings table say NVDAon and explain it in one line as Ondo's tokenized Nvidia
  stock.
- $NVDA may appear in the art as lettering in the kit's own alphabet, so a viewer sees at once which stock it is.
- Never Nvidia's logo or any part of it, its brand green as a brand color, its product names as branding, its CEO's
  name or likeness, or Ondo's logo. The kit's own art and palette stay.
- A plain not-affiliated line names both companies. The US persons line and the issuer-pause line stay.
- Everything else stays: the name, the ticker VRAM, the founder's headline, the story and the look.

### Requirements and files

| ID | Requirement for version 2 | Result |
| --- | --- | --- |
| GP-11 | Name the stock in text, with NVDAon exact in the settings | The brand book's identity, story, voice lines and IP rules, details.md, README.md and the storybook say $NVDA and Nvidia. details.md says "NVDAon is Ondo's tokenized Nvidia stock" in its settings table, and the brand book's identity gives the same setting |
| GP-12 | $NVDA lettering in the art, in the kit's alphabet | A dollar sign in the tube alphabet. Stock coins of radius 44 px or more letter $NVDA (scenes 01, 02 and 05). The cover and both banners name $NVDA and VRAM under the fee loop |
| GP-13 | No logo, no green, no product names, no CEO, no Ondo logo | Rules in the brand book, art notes and README, and `check.mjs` refuses them in the docs, the SVG descriptions and the drawn words |
| GP-14 | A not-affiliated line naming both | "Nvidia and Ondo did not make, approve or endorse this box." in the voice table, README.md, details.md and the X bio, required by `check.mjs` |
| GP-15 | Keep the US persons and issuer-pause lines | "The stock coin may not be offered to US persons." and "Ondo can pause the stock coin. Then this box waits too." in the voice table and README.md, the first also in details.md and the X bio |
| GP-16 | Keep the name, ticker, headline, story and look | Unchanged. The PNGs of the mark, the avatar, `logo-48.png`, the later GPU preview and scenes 03, 04, 06 and 07 are byte for byte version 1's |
| GP-17 | Update the brand book, storybook, details, art notes, README, this record and `check.mjs` | Done, in the seven commits listed below |
| GP-18 | Run `check.mjs` until green and re-render every changed PNG | Exit 0 with 446 checks. Six PNGs re-rendered: cover, X banner, box banner, scenes 01, 02 and 05 |

### What changed

| Part | Version 2 |
| --- | --- |
| `src/type.mjs` | A dollar sign: a smaller S, 4.5 units tall and 3.6 wide, with one bar through the full height. `recordLettering` lists the words a picture draws |
| `src/props.mjs` | `stockCoin` letters $NVDA in deep ice `#174E70` from radius 44 px, under the building shrunk to 60% and moved up |
| `src/brand.mjs` | The fee loop names $NVDA in ice and VRAM in orange. The cover loop is now at 0.9 scale, the X banner loop at 0.86 and moved up, and on the box banner the name sits 25 px further left and the loop 20 px further right and 10 px higher |
| `src/scenes.mjs`, `storybook.md` | Captions of scenes 01, 02 and 03 and alt text of scenes 01, 02, 03, 05 and 06 say $NVDA. Scene 01 adds "Nvidia's stock" |
| `brand-book.md` | Identity, story hook, a paragraph on naming the stock, voice rules, new example lines (not a share, not affiliated) and the X bio and pinned post with both legal lines, the avoid list, palette notes, logo rule, do and don't, a contrast row, homage and IP |
| `details.md` | $NVDA in the text, NVDAon explained in one line, Ondo named as the issuer, the not-a-share, US persons and not-affiliated lines, a counsel point on the names, and a note that a test network's stand-in is not NVDAon |
| `art-notes.md`, `README.md` | The dollar sign, the named coin, the names under the loop and the recorder; the version note, the lines to add and the test-network note |
| `check.mjs`, `build-art.mjs` | See the next section. `build-art.mjs` exports `builders()`, so the check can record each picture's words |

### The check in version 2

- **Names.** Nvidia, $NVDA, NVDAon and Ondo pass in exactly those forms. Any other form fails, such as `NVIDIA`, a
  bare `NVDA`, `$NVDAon` or `ONDO`.
- **Still refused.** No word from the version 1 list passes, and neither do other chip makers or card brands, a list
  of Nvidia's product names, or its CEO's name and look.
- **Logo sentences.** A sentence that names Nvidia, Ondo, $NVDA or NVDAon next to a logo, wordmark, emblem, badge,
  eye, swirl, green, face, photo, likeness or the CEO must also say never, no, not, nor, none, neither, without,
  avoid or a word ending in n't. Sentences are read across line breaks, with bold marks and code removed.
- **No green.** No palette color and no hex code in the docs may have a hue from 70 to 170 degrees with saturation of
  at least 25% and lightness from 10% to 92%. Nvidia's brand green falls inside that range, so it can never pass.
- **Drawn words.** Each picture is built once through `recordLettering`. Its words pass the same scan as the docs, a
  picture may letter $NVDA and never Nvidia, Ondo or NVDAon, and the mark and the avatar letter nothing.
- **Descriptions.** The titles and descriptions of both the committed SVGs and a fresh build may name no Nvidia,
  Ondo, NVDAon, logo but the kit's own, or green.
- **Lines.** The three lines word for word in the voice table and README.md, two of them in details.md, the one-line
  explanation of NVDAon, an X bio within 160 characters that holds both legal lines, and $NVDA lettered and described
  on the cover and both banners.
- **Contrast.** Every row of the contrast table gives the real ratio to two places and passes 4.5:1.

### Decisions in version 2

1. **Building and ticker on the coin.** The coin keeps the version 1 building, so the look stays, and adds $NVDA
   under it where the letters can be read. At radius 44 px the letters are 10.1 px tall. Smaller coins keep the full
   building and no letters.
2. **Names under the fee loop.** The coins on the cover and banners are 29 to 31 px in radius, too small for
   letters, so the loop names its two coins underneath, $NVDA in ice and VRAM in orange. Read with the headline, the
   loop shows which stock is sold and which memecoin burns.
3. **The mark stays.** The logo and avatar are the token, VRAM, and carry no letters. $NVDA never goes on the chip.
4. **One spelling for each name.** The founder wrote Nvidia, so the kit writes Nvidia and refuses the capitalized
   form, which is the company's own styling. The ticker is always the cashtag, $NVDA.
5. **The X bio holds the legal lines.** It names $NVDA, so it carries the US persons and not-affiliated lines and
   still opens with the joke, in 156 characters. Every page or post that names $NVDA, Nvidia or Ondo carries both
   lines. The box page also carries the issuer line.
6. **A not-a-share line.** Naming the stock makes it easier to read VRAM as a piece of Nvidia. The line "VRAM is a
   memecoin. It is no share in Nvidia and no claim on one." follows the round 2b research, which reminds that the
   token is not the share (`docs/research/round2b-stonks-rwa-memes-defi.md:97`, counsel question 8 there). NVDAon is
   called a token that follows Nvidia's stock.
7. **A note for test networks.** The art says $NVDA, and a test network can only use a stand-in coin with the same
   symbol. A test page that shows the art says that the coin is a stand-in.
8. **Version 1 decision 7 is replaced.** Version 1 called the price coin "the stock coin" and named no company.
   Version 2 names Nvidia and Ondo in text and letters $NVDA in the art. The other version 1 decisions stand.

### Commands and results (version 2)

All commands run with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node check.mjs` on version 1, before any change (control) | Exit 0: 316 checks passed |
| `node check.mjs` after the new word scan, on the version 1 docs and art | Exit 0: 402 checks passed. Version 1 contains none of the newly refused forms |
| 34 mutation runs of `check.mjs` on a scratch copy of the kit with the repository linked beside it, never on the kit itself | The 2 controls (no edit, and Nvidia, $NVDA, NVDAon and Ondo in their set forms) exit 0. The 32 others exit 1 with the expected FAIL line: `NVIDIA`, a lowercase `nvidia`, a bare `NVDA`, `$NVDAon`, `ONDO`, a card brand, a product name, the CEO's name, a phrase about his look across a line break, a logo sentence, a logo sentence across a line break, a logo sentence after a bold sentence, green by name, a green hex in the docs, a green palette color, Nvidia in a source description, Nvidia in a committed SVG description, a logo in a scene description, `NVIDIA` lettered in a picture, letters on the mark, a `not X, but Y` turn, a $NVDA amount, `$NVDAon` in the identity, the not-affiliated line missing from the README, a changed US persons line, the issuer line missing from the README, an X bio over 160 characters, an X bio without the US persons line, a cover without $NVDA, a wrong contrast number, coin lettering below 4.5:1, and details.md without the one-line setting |
| `node check.mjs` on the brand book draft | Exit 1, 1 problem: an explanatory sentence named Nvidia's logo without refusing it. Reworded to say the kit never uses them |
| `node check.mjs` on this record's first draft | Exit 1, 14 problems: the record quoted the refused forms in plain text, one sentence used the `not X, but Y` shape inside a case list, and two sentences named Nvidia with green or the CEO without refusing. The forms are now cited as code, which the scan skips, and the two sentences refuse |
| `node build-art.mjs` twice, then a SHA-256 of all 27 files in `art/` | Both builds identical |
| `git diff kit-gpu-poor-v1 HEAD` over every PNG | 6 changed (cover, X banner, box banner, scenes 01, 02 and 05). 8 are byte for byte version 1 (logo, `logo-48.png`, avatar, scenes 03, 04, 06 and 07, the GPU preview) |
| `./node_modules/.bin/eslint examples/boxes/gpu-poor` (repository root) | Exit 0 |
| `gitleaks dir examples/boxes/gpu-poor` (8.30.1, repository root) | Exit 0, no leaks found |
| `pnpm check:handoff` (repository root) | Exit 0 |
| `node check.mjs` final | Exit 0: 446 checks passed (7 scenes, 1024 later GPUs, no items) |

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest, Forge, `pnpm verify` and E2E were not run.
No server or browser was started.

### Commits (version 2)

| Commit | What |
| --- | --- |
| `f7abbeab` | The dollar sign and the lettering recorder in the tube alphabet |
| `36efa916` | The word scan accepts the set name forms and refuses the rest, the drawn words and the green check |
| `2924d889` | $NVDA on the coin and under the fee loop, the captions and alt text, six PNGs re-rendered |
| `63df05e9` | The brand book |
| `1e762ce7` | details.md, art-notes.md and README.md |
| `c5bca74b` | The check requires the lines, the named pieces and the contrast table |
| This commit | This record |

### Visual review (version 2)

- All six changed pictures were checked at full size. The ticker reads on the coins in scenes 01, 02 and 05, and
  under the fee loop on the cover and both banners.
- The X banner's avatar corner, x 0 to 420 and y 270 to 500, is the same as in version 1: 0 of 96,600 pixels differ
  (Pillow). Its brightness stays between 11.8 and 18.7 of 255.
- The names under the fee loop sit 65.9 px from the nearest edge on the X banner, 71.6 px on the cover and 185.4 px
  on the box banner, measured on the lettering boxes.
- On the box banner the name ends 104.9 px before $NVDA. In version 1 it ended 76.8 px before the coins.
- No browser, X upload or platform crop test was done.

### Open points (version 2)

- **Counsel on the names.** Version 2 names Nvidia and Ondo and letters $NVDA in the art. Question 32 of the counsel
  pack already lists trademarks of stock names in box names. Default: keep the kit as built for review, and launch
  nothing until counsel answers, together with the version 1 counsel points.
- **The legal lines on X.** Every page or post that names $NVDA carries the US persons and not-affiliated lines.
  Default: keep it. The founder can allow short replies to leave them out, since the bio and the pinned post carry
  both.
- **The mark.** The logo and avatar stay the VRAM chip with no letters. Default: keep it, so the token keeps its own
  face.

## Version 1

The record of version 1 follows as it was written, with its headings one level down. Its decision 7 and the "no
company names" part of GP-10 are replaced by version 2's decision 8 and GP-11 to GP-15.

### Requirements and files

| ID | Requirement from the brief | Result |
| --- | --- | --- |
| GP-01 | Read the box settings, registry notes, research and founder notes | Read `gpu-poor.json`, `gpu-poor-miners.json`, the registry README and schema, `core-v2-plan.md` section 5, the decision log (F88, F89, F106, F109, F118 to F135), the GPU Poor idea and both judges' scores in the round 2b research, counsel pack questions 32 and 33, the examples life test evidence, the step 2 design and evidence, and the contracts listed below. Read the Exit Liquidity kit in this branch as the finished kit to match, and the Rent Free brand book on its branch (through `git show`, no checkout) to keep the looks apart |
| GP-02 | README with the file list | `README.md` lists every file and folder; `check.mjs` enforces it |
| GP-03 | Brand book | `brand-book.md`: name, ticker, the founder's headline, joke, hook, voice with eleven example lines, eleven colors, three OFL fonts with fallbacks, logo construction and clear space, do and don't, contrast table, homage and IP rules |
| GP-04 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each, same words as `src/scenes.mjs` |
| GP-05 | Details in plain words | `details.md`: every setting, where each fee goes, the launch window, what a holder gets, risks, what waits for counsel, v2.1 and the launch |
| GP-06 | Art notes | `art-notes.md`: heat camera, tube alphabet, mark, symbols, GPU card, the later GPU rule, rules for extending |
| GP-07 | Clean vector art with local PNG exports | 13 SVG and PNG pairs plus `art/logo-48.png`, rendered by `@resvg/resvg-js` 2.6.2 with system fonts off |
| GP-08 | Item variants and assignment for a collection box | Not a collection box, so none were made, and `check.mjs` refuses them. The look extends to the later GPUs through `src/gpu.mjs` and `art/later/gpu-preview.png` |
| GP-09 | `check.mjs` that verifies files and pixel sizes, and run it | Done; see results |
| GP-10 | Original art, no promise words, no names of the platform's own token or collection, no company names, plain writing | Word and shape scan in `check.mjs`, plus a manual read of every doc |

### Decisions

1. **The look.** The world seen through a heat camera, on night violet. Cold things are ice blue, warm things climb a
   fixed ramp from violet through magenta, orange and amber to white-hot, and a heat scale sits on every picture.
   It ties the three parts of the joke together. GPUs run hot, the fee path goes from a cold stock coin to a hot
   burn, and the box burns VRAM to stay warm. It is far from Exit Liquidity's green hallway and Rent Free's cream
   houses. There is no green anywhere, so nothing points at a chip maker's colors.
2. **The joke is the missing GPU.** The box has no GPU, so pictures show a dashed outline over an empty slot. The
   later GPU items can fill that outline from the same parts.
3. **The mark is a VRAM chip that runs hot.** A square chip with pins and a banded flame reads at 48 px and in a
   round crop, and it is the token the box burns.
4. **Own letters.** Every letter in the art comes from a single-stroke tube alphabet drawn for this kit, so the
   pictures need no font file. The hot headline lettering is the same strokes drawn five times along the heat ramp.
   Live text names three OFL families (Quicksand, Inter, DM Mono). No font was downloaded.
5. **The founder's headline stays word for word.** "Sell a stock to prop up a memecoin" is on the cover and in the
   brand book, always with the literal line `In plain words, the fee buys VRAM and burns it.` It is a counsel point.
6. **Ticker VRAM.** The registry's fixture ticker is GPU. The brief, the research and the art all name the token
   VRAM, and the registry notes call tickers fixture choices. The kit uses VRAM, records the registry value in
   `details.md`, and `check.mjs` makes both docs say so while the two differ.
7. **The price coin is "the stock coin".** The symbol NVDAon appears in plain text only where a setting needs it
   and never in a picture. The kit names no company, neither the chip maker nor any card brand nor the stock
   coin's issuer. `check.mjs` refuses those names.
8. **A rule for the later GPUs, no items now.** GPU Poor has no items. For the later step, `gpuParts(id)` maps ids
   1 to 1,024 through a fixed reversible shuffle onto five parts with four choices each, so every mix appears once and
   every choice on 256 GPUs. The preview shows twelve ids picked so every choice shows three times.
9. **No raise number in the kit.** F123 lets a listing change its raise for future boxes, the registry notes say
   fixture raises must never become quotes, and the brief keeps prices out.
10. **The launch window is in the details.** Every v2 box has the 6.4-minute window with its falling launch tax, so
    the plain-words page says so.
11. **Exact bytes.** `check.mjs` compares every SVG and PNG with a fresh build. `.gitattributes` in the kit marks
    `art/**` as `-text`, so a checkout cannot convert line endings and break that check.

### Facts read in the code

| Fact used in the kit | Where |
| --- | --- |
| Fee split into 10, 2 and 3 parts of 15; rounding dust carried to the next fee on the same side | `packages/contracts/src/box-v2/BoxReceiverV2Base.sol:339`, `:345`, `:350` |
| Burn choice books the 10 parts as buy-back money | `BoxReceiverV2Base.sol:361` |
| Buy-back only after graduation, one protocol step per block, a minimum, a tip, then the bought token is burned | `BoxReceiverV2.sol:87`, `:96`, `:97`, `:100`, `:114`, `:116` |
| Tip at most 5% of what a step spends, under the box's cap | `BoxReceiverV2Base.sol:469`; `interfaces/ReleaseConstantsV2.sol:34` |
| Each buy step stops at a price limit 49 ticks from the current price, about half a percent | `ReleaseConstantsV2.sol:28`; `libraries/ReceiverViews.sol:22` |
| The buy runs in the box's own pool | `BoxReceiverV2Extension.sol:125` |
| A refused burn can be retried by anyone | `BoxReceiverV2.sol:203`; `BoxReceiverV2Base.sol:509` |
| On failure, waiting buy-back money goes to the closing pot | `BoxReceiverV2.sol:297`; `interfaces/FailureTableV2.sol:48` |
| 1% fee on buys (stock coin in) and on sales (stock coin out) | `BoxHookV2.sol:171`, `:185` |
| Outside liquidity and removals refused | `BoxHookV2.sol:239`, `:249` |
| Deepen: about half the money buys the box token, then both sides are added | `BoxHookV2Extension.sol:92`, `:279`; `ReleaseConstantsV2.sol:31` |
| Launch window of 384 seconds, buys only through the launch router | `BoxHookV2.sol:32`, `:123` |
| Launch tax from 931,974 down to 80,565 millionths in 32 steps; the tax goes to the pool after graduation | `BoxLaunchRouterV2.sol:257`, `:259`, `:290`, `:189` |
| Failure: anyone after the deadline, or 7 days after a filled curve closes; claims for 365 days, then a sweep | `BoxCoordinatorV2.sol:212`, `:80`, `:803`; `ReleaseConstantsV2.sol:56` |
| The local test life prices in an 18-decimal stand-in stock coin | `packages/contracts/script/local/LocalQuoteMocks.sol:158` |
| The site's template is called Burn, "Token · Burn" | `apps/web/src/features/create/v2/templates.ts:46` |
| The keeper runs buy-back and deepen steps in turn after graduation | `packages/keeper/README.md:16` |
| Step 2, items paid in the box token, is merged into the v2.1 integration line | commit `94725177`; `docs/evidence/SH-V21-02-PAY-IN-T.md` |

### Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node build-art.mjs` | Exit 0: built 13 SVG and PNG pairs and `art/logo-48.png`, about 0.3 s |
| `node build-art.mjs` again, then a SHA-256 of every file in `art/` | All 27 hashes match the first build, so the build is byte-for-byte repeatable |
| `node check.mjs` before the work record existed | Exit 1 as expected. It also caught that the registry's ticker is GPU, which led to decision 6 |
| Thirteen mutation runs of `node check.mjs` (a banned word, an em dash, a company name, a coin amount, a year, a three-sentence caption, a hand-edited SVG, a wrong PNG size, the price coin's symbol in an SVG description, a stray `art/items` folder, a changed headline, the platform token's name, a missing scene) | Each exit 1 with the expected FAIL line. Every file was restored from a copy afterwards, and a SHA-256 of the whole folder matched the one taken before |
| One more mutation run, a green fill in `src/heat.mjs` | Exit 1: a color outside the palette in the scene, a color defined outside `src/palette.mjs`, and a stale SVG. Restored from a copy |
| `node check.mjs` final | Exit 0: 316 checks passed (7 scenes, 1024 later GPUs, no items) |
| `./node_modules/.bin/eslint examples/boxes/gpu-poor` (repository root) | Exit 0, after removing two unused imports it first flagged |
| `pnpm lint` (repository root, once) | Exit 0 |
| `pnpm check:handoff` (repository root) | Exit 0: both handoff folders match their hashes |
| `gitleaks dir examples/boxes/gpu-poor` (repository root) | Exit 0, no leaks found |

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest, Forge, `pnpm verify` and E2E were not
run. No server was started.

### Visual review

- The logo at a real 48 px still reads as a chip with a flame. In a round crop the pins sit inside the circle.
- On the X banner, the corner at x 0 to 420 and y 270 to 500 holds only plain ground, and the frame leaves that
  corner out.
- All seven scenes were checked at 800 px for labels, arrows and overlaps. Scene 06 was redrawn so the coins leave an
  open jar under a full raise bar, scene 05 got a link from each trade to its fee coin, and the cold scene got coals
  and a smoke wisp.
- The twelve preview GPUs were compared on one sheet. All are different, and all are one family.
- No browser, X upload or platform crop test was done.

### Limits and open points

- The founder's example-boxes doc was not read. Its notes on GPU Poor come from F89 in the decision log.
- Counsel still has to look at the headline, the stock coin as the price coin, the name and ticker, and the kit's
  publication license.
- The registry still points at the local test pictures and still carries the fixture ticker GPU.
- For the later GPUs, the registry's pending row is a separate box with ticker MINERS and 100 GPUs paid in its own
  token. The research idea had 1,024 GPUs paid in VRAM. The founder picks the form.

### Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-GPU-POOR.md` when merging.
2. If the founder keeps VRAM, change the registry row's ticker in a separate, reviewed change.
3. Choose the open-source license for the kit collection before publishing it.
