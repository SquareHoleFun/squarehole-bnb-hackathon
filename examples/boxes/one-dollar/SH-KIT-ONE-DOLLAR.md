# SH-KIT-ONE-DOLLAR work record

Kit agent for box id `one-dollar` (Claude Opus 5.5), on branch `sh-example-kits` in the `wt-kits` worktree. Version 1
was built from base `48c3d676` and stays at the git tag `kit-one-dollar-v1` (commit `cad030b3`). Version 2 was built
in place on the same branch from `0b46a61c`. The kit's changes are inside `examples/boxes/one-dollar/`. The founder's
decisions also asked for changes in the example registry, `packages/box-spec/examples/v2/`, made in two commits of
their own. The integrator can copy this record to `docs/evidence/` as the project rules ask.

## Version 3: no dollar sign (TA-24)

The founder's word rule for every kit: the ticker is 1, and no text writes it with a dollar sign in front. On the
integration line (`sh-026-kits-merge`) the kit was reworded to follow it.

- The cover line is now "The token is 1. The dollar is in the box." and the art letters THE TOKEN IS 1, THE TOKEN 1
  and BURN TOKENS where it lettered the ticker with a dollar sign. The ticker is lettered as the digit 1, in rose.
- The salon alphabet no longer has a dollar sign, so no picture can letter one. Every PNG was rebuilt with
  `node build-art.mjs` and `node build-art.mjs --no-words`.
- `check.mjs` refuses every dollar sign in the docs, the SVG titles and descriptions and the lettered words, and
  checks that no text writes the ticker with a dollar sign, even inside code or an exempt block.
- The founder block in the brand book no longer quotes him; it says what he chose.
- Older sections below describe versions 1 and 2. Where they named the ticker with a dollar sign, they now say the
  token or the ticker 1.

## Word-free reference pictures

The explainer pipeline needs each kit's world as a reference picture with no words in it. `build-art.mjs --no-words`
writes `art/reference/cover.png`, `art/reference/box-banner.png` and `art/reference/scenes/scene-01.png` to
`scene-07.png`: the same pictures with every word, number and sign of the salon alphabet left out, the bill's 1 and
ONE included. `withoutWords` in `src/type.mjs` lets `lettering` lay out and measure as always but draw nothing and put
nothing in `DRAWN`, so placards, the plaque and the bill keep their size and place. Only PNGs are written, because the
SVG titles and descriptions name words that are no longer drawn. All commands ran from the kit folder with Node 24.19.0.

| Command | Result |
| --- | --- |
| `node build-art.mjs`, then `git status --short`, before the change | No file changed: the committed art is a fresh build |
| `node build-art.mjs` after the change, then `git status --short` | Only the two source files changed. The sha256 of all 25 art files match commit `aa22b629` |
| `node check.mjs` | Exit 0: 722 checks passed after the build change, as before; 731 once the nine PNGs exist, because the phrase check reads every file in the kit; 732 with these docs, whose new README link it also checks |
| `node build-art.mjs --no-words`, twice | Exit 0: 9 PNGs, the same bytes both times |
| `node build-art.mjs --nowords` | Exit 1: unknown option, nothing written |
| `DRAWN` after building the normal cover, box banner and scenes, then after `references()` | 58 blocks of lettering, then none |
| OCR net from the explainer playbook: `tesseract <png> - --psm 11 tsv`, tokens of 2 or more letters, digits, dollar or percent signs at confidence 70 or more | The 9 normal pictures: 59 hits, such as DOLLAR, TOKEN, BURN and POOL. The 9 word-free ones: 3, all read into shapes: `AN` on the wave border of the bill in the box banner, `ee` on two coins in scene 02 and `al` on the cold fireplace in scene 07. The normal scenes 02 and 07 give the same two |
| Each word-free picture looked at next to its normal one | No lettering left; every other shape in place |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/one-dollar` (repository root) | Exit 0 |

## Version 2 review fixes

A review of version 2 asked for three fixes in this kit and one in the check of every kit. They were made in place on
the same branch from `fd586423`, and every change is inside `examples/boxes/one-dollar/`. OD-23 replaces OD-16 below,
version 1 decision 6, and the version 1 limits on the founder's question. The question's words no longer sit
anywhere in the kit. An independent read-only review of the round came back with no wrong check result and a few
gaps, and the second pass closed the ones inside this brief.

### Requirements and files

| ID | Finding | Result |
| --- | --- | --- |
| OD-23 | The founder block in the brand book quoted the founder's private question word for word, and the kit will be published | The block opens with "The founder's idea is a satire box that holds exactly one dollar of a stable coin as its coin pile." and keeps only his words on the name, the ticker and the bill. The brand book no longer mentions the question, and no file of the kit quotes or retells it. The history sections of this record still say that the founder asked a question, never what it was. The avoid list drops its key phrase, and `check.mjs` refuses that phrase in every file of the kit |
| OD-24 | The X bio, "Every fee buys the token and burns it.", and the literal line next to the cover line overstated the burn | Both now say "ten of every 15 fee parts buy the token and burn it". The other parts go to the box's own pool and to Square Hole (its platform and its buy-back). The X bio has 159 characters, and the literal line is two short sentences |
| OD-25 | "No fee ever goes into the box" read as a contradiction next to the pool's 2 parts | Scene 07's caption, the story hook, the pinned post, the README and details.md say that no fee goes into the coin pile, so fees never add to the dollar |
| OD-26 | `check.mjs` failed when Finder added a `.DS_Store` file to `art/scenes` or `src` | Every folder listing in the check skips the files an operating system adds, such as `.DS_Store`, `Thumbs.db` and `desktop.ini`. Nothing deletes them |

### What changed

| Part | Change |
| --- | --- |
| `brand-book.md` | The founder block without the question, the avoid list without its phrase, a sentence on the phrase check, the X bio, the literal line, the story hook and the pinned post |
| `src/brand.mjs` | `LITERAL_LINE` says ten of every 15 fee parts. The art does not draw it, so no picture changed |
| `src/scenes.mjs`, `storybook.md` | Scene 07's first caption. Captions are not drawn, so no picture changed |
| `README.md`, `details.md` | The share of each fee that buys the token and burns it, and the coin pile in place of the box. In details.md the holder list says "No holder is paid fees." |
| `check.mjs` | `NEVER_PHRASE` and `checkNeverPhrase()`, and the files an operating system adds |

### The check after the fixes

- **The phrase.** `checkNeverPhrase()` reads every file of the kit, whatever its name or type, byte for byte as
  Latin-1, so a text chunk inside a PNG counts too. It also reads every word the pictures letter, with the lines of
  a word lettered on two lines joined by a space. The pattern is put together from its two words, so `check.mjs`
  does not hold the phrase. It finds the two words with a space, a dash, an underscore or nothing between them, in
  any case, and leaves longer words that only end in the first word alone. It skips folders named `node_modules` and
  `.git`, which a copied kit may hold and which are not its own text. The BANNED line that held the phrase before is
  gone.
- **Files the operating system adds.** Folder listings skip `.DS_Store`, `._` files, `Thumbs.db`, `desktop.ini`,
  `.directory`, `.AppleDouble`, `.Trash-` folders, `__MACOSX` and the other names in `OS_FILE`. A stray file of any
  other name still fails.

### Decisions in the review fixes

1. **The neutral line takes the question's place.** The block keeps the founder's words on the name, the ticker
   and the bill, which the brief did not ask to remove. It drops everything about the question, the working title
   that came with it included. `how far` stays in the avoid list as plain value talk.
2. **Ten of every 15.** The X bio needed room for the share, so its last sentence now reads "After graduation, burn
   the token for its slice of the dollar.", in the voice of the line for taking a slice. The story hook, the README and the
   holder list in details.md said what the bio said, so they changed too.
3. **The coin pile.** "Fees never add to the dollar" says what the settings do. A gift of USDC sent to the pile still
   becomes part of the dollar, and details.md keeps saying so.

### Commands and results (review fixes)

All commands run with Node 24.19.0, from the repository root unless they name the kit's own files.

| Command | Result |
| --- | --- |
| `node check.mjs` before any change (control) | Exit 0: 663 checks passed |
| `node check.mjs` on a scratch copy of every kit, with `.DS_Store`, `._README.md`, `Thumbs.db`, `desktop.ini` and an `Icon` file in all 45 kit folders, before the check fix | Exit 1: 9 problems, such as `art/scenes holds files that are not scene-NN.svg or .png` and `README.md does not list Thumbs.db`. All nine kits failed |
| The same on a fresh copy after the check fix | Exit 0: 663 checks passed, the same count as in the tree. All nine kits passed with their own counts |
| `node check.mjs` after the phrase check | Exit 0: 709 checks passed. The 46 new checks are 33 text files, 12 pictures, and one check that the scripts and docs are read |
| 13 runs of `check.mjs` on scratch copies of the kit, with the repository linked beside it, never on the kit itself | The 2 controls exit 0 with 709 checks. Each of the 10 mutations exits 1 with the expected FAIL line: the phrase in the founder block, in the avoid list, in the bill rules, in this record, in a source comment, in `check.mjs` itself, in an SVG description and in a source constant, then a literal line that drifted from the brand book and an X bio over 160 characters. One more run puts a longer word that only ends in the first word into details.md, and it passes as it should |
| 5 more runs of `check.mjs` on scratch copies after the folder guard | The control exits 0 with 709 checks. The phrase in a `.git/info` file passes, and in a new `notes` or `.notes` folder it fails as it should. With a `node_modules` folder in the kit, the phrase check stays quiet and the check still fails, on the older README rule that the README must list every top-level folder |
| `git diff fd586423 HEAD` over the art | No SVG or PNG changed |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes` | Exit 0 |
| `gitleaks dir examples/boxes/one-dollar` (8.30.1) | Exit 0, no leaks found |
| `pnpm check:handoff` | Exit 0 |
| 5 runs after the review, on scratch copies | The control exits 0 with 722 checks. The phrase in a new `LICENSE`, in `art/NOTES.TXT`, lettered on two lines on the cover, and in a text chunk added to `art/logo-48.png` each exits 1 with the phrase FAIL line |
| `node check.mjs` after the second pass | Exit 0: 722 checks passed. The 13 more are the PNGs, which the phrase check now reads too |
| `node check.mjs` final | Exit 0: 722 checks passed (7 scenes, a coin pile with no items) |

No server or browser was started.

### Commits (review fixes)

| Commit | What |
| --- | --- |
| `fdd30c10` | The check of all nine kits skips the files an operating system adds |
| `85a2c654` | The founder block without the question, and the phrase check |
| `8631414e` | The X bio, the literal line, the story hook, the README and the holder list say ten of every 15 fee parts |
| `f184279f` | No fee goes into the coin pile, in scene 07's caption, the story hook, the pinned post, the README and details.md |
| `d0436930` | This record, first pass |
| `a52f5f2d` | The phrase check skips `node_modules` and `.git` |
| `3aac34e8` | This record's note on that guard |
| `41043a0d` | The phrase check reads every file, PNGs included, and joins lettered lines |
| `0e7ccdc2` | The check of all nine kits skips `.directory`, `.AppleDouble`, `.Trash-` folders and `__MACOSX` too |
| `b4f7bb1a` | The literal line as two short sentences |
| This commit | This record, second pass |

### Open points (review fixes)

- **The question in the history.** The commits `5b7e1b51` and `d59c5977` and the tag `kit-one-dollar-v1` still hold
  brand books that quote it. Default: publish the kit collection from a fresh copy of its files, never with this
  branch's history, or let the integrator squash the kit commits before the branch is shared.
- **The founder's other words.** The block still quotes his words on the name, the ticker and the bill, word for
  word. Default: keep them, since the brief named only the question. The founder can cut the block down to the
  neutral line before the kit is published.
- **This record in the collection.** Its history sections say that the founder asked a question, never what it was.
  Default: keep the records with the kits, as the founder reviews every kit before anything is published.

## Version 2

### What the founder asked

The founder chose a new name and a new ticker, and asked whether the dollar could be a note instead of a coin. His
words are quoted in the founder block of the brand book. The decisions for version 2:

- The box is called One Dollar is all you need, 26 bytes of the contract's 32. The ticker is 1. (Version 2 also wrote
  it with a dollar sign in front; the founder dropped that in TA-24, see the top of this record.) The trade-offs are written down once, plainly, without arguing.
- The star of the box is a cartoon one-dollar bill. The coin pile holds exactly one USDC, and the bill stands for that
  dollar under the museum glass, like the first dollar a shop frames on its wall. The bill follows rules written into
  the brand book's homage and IP section.
- For this kit only, the version 1 ban on a banknote is lifted, within those rules. The rule that
  the token is not a dollar and never equals or follows one stays, and becomes the joke: "The token is 1. The dollar is in
  the box."
- The founder's question from version 1 is still never answered or asked in public.
- The registry gets the new name and ticker, its schema takes a ticker that starts with a digit, and a registry test
  pins the ticker 1. Code that needs a ticker to start with a letter gets fixed.
- Everything in the kit is updated, an X handle of at most 15 characters is suggested as an open point, and
  `check.mjs` runs until green.

### The ticker's trade-offs

The founder chose the ticker 1 knowing these. [details.md](details.md) has the same four lines.

- On X a cashtag must start with a letter, so the ticker 1 cannot be a cashtag.
- Wallets show amounts as `500,000 1`.
- Chart sites may put a dollar sign in front of the ticker, where it reads as a price.
- A bare 1 in a post can read as a number, so every post says what the token 1 is.

### Requirements and files

| ID | Requirement for version 2 | Result |
| --- | --- | --- |
| OD-11 | The name and the ticker | `One Dollar is all you need` and `1` in the registry, the brand book's identity, details.md, every SVG title and the lettered name. `check.mjs` ties the art's two name lines to the registry name and keeps the name within 32 bytes and the ticker within 11 capitals or digits |
| OD-12 | The trade-offs, once, in details.md and in this record | Four lines, word for word in both. `check.mjs` requires each exactly once in details.md and in this record |
| OD-13 | A cartoon one-dollar bill as the star, under museum glass | `src/bill.mjs` draws the bill and `src/exhibit.mjs` frames it under glass in a deep brass frame with a velvet box, hung from a hook. It replaces the silver coin and the glass dome in the logo, the avatar, both banners, the cover and scenes 01, 03, 05, 06 and 07 |
| OD-14 | The bill rules in the brand book's homage and IP section | A marked block there lists them. `check.mjs` refuses the real note's words in the docs outside that block, in every SVG title and description and in every lettered word, and lets the mark letter nothing but the bill's 1 and ONE |
| OD-15 | The banknote allowed for this kit, and the token is not a dollar as the joke | Version 2 lettered the ticker with a dollar sign, in rose; version 3 letters the digit 1 in rose and the alphabet has no dollar sign. The cover line is "The token is 1. The dollar is in the box." The voice rules and `check.mjs` refuse every dollar sign and a number right before the ticker |
| OD-16 | The founder's question stays out of public lines | It stays in the founder block. `check.mjs` still refuses its words everywhere else, and now also `how far` |
| OD-17 | The registry's name, ticker and README line | Commit `f26e3ad4` |
| OD-18 | The schema's ticker pattern `^[A-Z0-9]{1,11}$` and a registry test for 1 | Commit `792089f7`. The pattern lives in `registry.mjs`, and `schema.json` is generated from it |
| OD-19 | The box-spec tests, the site's unit tests that read the registry, and any letter-first code | See the registry and site code section below |
| OD-20 | Brand book, storybook, details, art notes, README, scenes, every art file, this record and `check.mjs` | Done, in the commits listed below |
| OD-21 | An X handle of at most 15 characters | The first open point below |
| OD-22 | `check.mjs` green | Exit 0 with 663 checks passed |

### What changed

| Part | Version 2 |
| --- | --- |
| `src/bill.mjs` | New. The cartoon bill: paper, a border of crossing waves, fine lines, a medallion with a big 1, the word ONE in a panel on each side, strips, the dashed outline of strips taken, and taken strips on their own |
| `src/exhibit.mjs` | The plinth, the stand and the glass dome are gone. `framedBill()` frames the bill under glass in a deep brass frame with a velvet box, hung from a hook, and `exhibit()` hangs it on the wall under the spotlight, behind the rope. The museum label can be centred |
| `src/coins.mjs` | The silver dollar and its slices are gone. Plain coins stay for the USDC on the move |
| `src/type.mjs` | Version 2 added a dollar sign and its kerning pair; version 3 removed both |
| `src/palette.mjs` | Green and deep green join the brand colors, and four bill shades join the fixed mixes |
| `src/props.mjs` | `roseTicker()` letters the ticker 1 in rose. The envelope is open, so taken strips stand in it |
| `src/brand.mjs` | The name on two lines, the new cover line and literal line, and the framed bill in every piece. The logo's frame is slimmer, so the bill reads at 48 px |
| `src/scenes.mjs`, `storybook.md` | Scenes 01, 03, 05, 06 and 07 show the bill, with new captions and alt text. Scenes 02 and 04 keep their pictures and lose the old ticker from their alt text |
| `brand-book.md` | Identity, story, the founder block, the cover and literal lines, voice rules for the ticker, example lines, the avoid list, palette, logo, do and don't, three new contrast rows, a screen reader note, and homage and IP with the bill rules |
| `details.md` | The new name and ticker, the trade-offs, the token 1 and tokens in place of the old ticker, the bill as a drawing of the one USDC, counsel points on the ticker and the bill, and site points on the ticker's labels |
| `art-notes.md`, `README.md` | The bill, the frame, the dollar sign and the new pieces |
| `check.mjs` | See the next section |

### The check in version 2

- **Dollar sign.** Version 2 allowed a dollar sign only in front of the ticker. Version 3 refuses every dollar sign,
  in the docs, in every SVG title and description, and in every lettered word.
- **Price reading.** An amount of the token, such as `500 1`, fails outside code.
- **The bill.** The real note's words fail outside the bill rules block. No picture letters a word of the real note,
  and the mark and the avatar letter only the bill's 1 and ONE.
- **The name.** The art's two name lines equal the registry name in capitals, the name fits 32 bytes, the ticker fits
  11 capitals or digits, and the brand book says that people write the ticker 1. The words "all you need" are now
  allowed, because they are the name.
- **Posts.** The X bio and the pinned post each say "The token is 1.", and the X bio fits in 160 characters.
- **Trade-offs.** The four lines stand once in details.md and in this record.
- **Contrast.** Every row of the contrast table gives the real WCAG ratio to two places and passes 4.5:1.
- **Kept from version 1.** File sizes, freshness, clear space, round crop, the avatar corner, margins, palette,
  storybook, registry values, links, README, the promise words and the founder's question.

### Decisions in version 2

1. **A framed bill.** The founder's two pictures were the museum glass and a shop's framed first dollar. A deep brass
   frame with glass in front, a shadow box, gives both, and it is a box, so the joke "the dollar is in the box" has a
   picture. The frame hangs from a hook on the wall, under the spotlight, behind the velvet rope. The glass dome and
   the plinth are gone.
2. **Our own bill.** The bill is 2.2 times as wide as it is tall, stockier than a real note, with a border of crossing
   waves, a round medallion of fine lines with a big 1, and ONE in a panel on each side. It carries nothing else. Its
   pale green paper and deep green ink make it the only green thing in the claret room.
3. **Dark velvet behind the bill.** With an ivory mat, the pale bill blurred into its mat at 48 px. A box lined with
   dark red velvet makes the bill the lightest thing in the mark, and the 1 still reads at 48 px.
4. **Slices are strips.** The coin's wedges become upright strips of the bill, counted from the left. Yours are ringed
   in ivory, taken strips leave a dashed outline, and in scene 06 the two taken strips stand in an open envelope.
5. **The ticker in rose, the dollar in green.** The art letters the ticker 1 in rose, the token's color, and every word
   about the dollar in green. A token never carries a 1, so no picture shows a one-dollar coin.
6. **The cover line is the founder's joke.** "The token is 1. The dollar is in the box." The literal line next to it
   says what the token is, what the box holds and what the fees do. "The dollar just sits there." stays as the line for a box
   with no trades.
7. **Writing the ticker so it does not read as a price.** Posts say "The token is 1." first, counts use the word
   tokens, and nothing puts a number right before the ticker. The storybook names the token 1 in scenes 01, 03 and 06 and
   says tokens elsewhere, so a child can follow it. A screen reader may read a bare 1 as a number, so pages give the
   ticker the accessible name "the token 1".
8. **The name on two lines.** ONE DOLLAR is the big line and IS ALL YOU NEED the smaller one, so the name reads as one
   meme and fits the banners and the cover.
9. **Version 1 decisions.** Decisions 2, 3 and 5 are replaced by decisions 1, 2 and 6 above. Decisions 4 and 8 stand,
   with the ticker 1 in place of the old ticker. The other version 1 decisions stand.

### Registry and site code

- `registry.mjs:14` held the only ticker rule that needs a first letter, `^[A-Z][A-Z0-9]{0,11}$`, and
  `schema.json:24` is generated from it. Both now take `^[A-Z0-9]{1,11}$`. The contract takes a symbol of 1 to 11
  bytes, each a printable character other than a double quote or a backslash (`BoxSpecV2.sol:29`, `:254`, `:706`), so
  the registry's capitals and digits sit inside its rule.
- No site unit test reads the example registry. `git grep` for `loadExamples`, `examples/v2/`, `registry.mjs` and
  `one-dollar` finds no file under `apps/web/src`. The registry's readers are the examples E2E files under
  `apps/web/e2e/core-v2-chain/`: `examples.spec.mjs`, `examples/run.mjs`, `examples/offline.mjs`,
  `examples/replay.test.mjs` and `examples/forge/ExampleLives.t.sol`.
- No site code needs a ticker to start with a letter. The create page checks the ticker only for its 1 to 11 bytes and
  its characters (`reason-copy.ts:328`, `:367`, `BasicsStep.tsx:82`), and a downloaded spec's file name keeps digits
  (`create-model.ts:673`, `v2/model.ts:161`). The other first-letter patterns found are for identifiers, policy ids
  and NFT manifest symbols, not box tickers (`model-v2.mjs:54`, `ids.ts:40`, `scripts/nft/schema/manifest.schema.json:26`).
- Two places take the bare ticker and still work with 1, and are left for their owners. The coin pile panel reads
  `Per 1`, `1 out` and `1 to redeem` (`CoinPileV2.tsx:76`, `:77`, `:82`). The examples E2E checks that the page
  header contains the ticker (`life.mjs:33`), which any 1 in the header passes, so for this box that check no longer
  proves the ticker is shown.

### Commands and results (version 2)

All commands run with Node 24.19.0, from the repository root unless they name the kit's own files.

| Command | Result |
| --- | --- |
| `node check.mjs` on version 1, before any change (control) | Exit 0: 421 checks passed |
| `node --test packages/box-spec/examples/v2/registry.test.mjs` before any change (control) | 3 of 3 pass |
| `pnpm exec vitest run packages/box-spec` before any change (control) | 1 of 35 files fails, `src/v1-freeze.test.ts` with 4 tests, because `packages/contracts/lib` has no submodules in this worktree ("submodules not initialised?"). 1678 pass and 1 is skipped |
| The same Vitest run after the ticker rule | The same 4 failures in the same file, 1678 pass and 1 is skipped |
| `node --test packages/box-spec/examples/v2/registry.test.mjs` after the rule and after the rename | 4 of 4 pass |
| The new registry test against the old rule, then against a 12-character rule, on a scratch copy | Both runs fail as they should: a ZodError on 1, then a missing error for `GUZZLERSTOKE` |
| A scratch Vitest test of the generated BoxSpecV2 checks (`check-spec-v2.mjs` with `generated/box-spec.v2.ts`), deleted after the run | 3 of 3 pass: the new name with the ticker 1 is valid, and a 12-character ticker and a 46-byte name fail with `LENGTH_OUT_OF_RANGE` |
| `pnpm e2e:examples --list` | Exit 0: 11 Node tests pass and Playwright lists 13 lives, `one-dollar · Coin pile` among them. List mode starts no server and no browser, and nothing listened on ports 5410 to 5412 or 8576 afterwards |
| `node apps/web/e2e/core-v2-chain/examples/offline.mjs` | Not run. It needs the contract submodules, which are empty in this worktree, and fetching them would touch a remote. So the One Dollar contract life with the new name and ticker, and `replay.test.mjs` after it, have not run here |
| `node build-art.mjs` twice, then a SHA-256 of every file in `art/` | All 25 hashes match, so the build is byte-for-byte repeatable |
| The PNGs against the tag `kit-one-dollar-v1` | 11 changed. Scenes 02 and 04 are byte for byte version 1's |
| `node check.mjs` during the work | It caught a ticker used as a count in the palette table, and a false coin amount in this record's first draft, a big 1 followed by the word ONE. Both were reworded |
| 26 runs of `check.mjs` on a scratch copy of the kit, with the repository linked beside it, never on the kit itself | The control exits 0 with 663 checks. Each of the 25 mutations exits 1 with the expected FAIL line: three misplaced dollar signs, three ticker-as-price phrases, `500 1`, a note word in the art notes, a note word outside the bill block, `how far`, a trade-off line missing, a trade-off line twice, a trade-off line missing from this record, an X bio without "The token is 1.", an X bio over 160 characters, a wrong contrast number, a contrast row below 4.5:1, the brand book without its line on how people write the ticker, a lettered name that differs from the registry, a picture lettering a wrong amount after BURN, the bill lettering `NOTE`, the mark lettering a word besides the bill, an SVG description naming the coin, a hand-edited SVG, and a color outside the palette in the bill. Mutations of the art source were rebuilt first, so the freshness check could not be what caught them. The first round missed the double-sign run, because the runner's own text replacement turned two signs into one. The runner was fixed and every run repeated. A SHA-256 of the kit folder matched before and after |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/one-dollar packages/box-spec/examples/v2` | Exit 0 |
| `pnpm check:handoff` | Exit 0 |
| `gitleaks dir examples/boxes/one-dollar` and `gitleaks dir packages/box-spec/examples/v2` (8.30.1) | Exit 0 for both, no leaks found |
| `pnpm exec vitest run packages/box-spec` on the final registry | The same as the control: `src/v1-freeze.test.ts` fails 4 tests for the missing submodules, 1678 pass and 1 is skipped |
| `node check.mjs` final | Exit 0: 663 checks passed (7 scenes, a coin pile with no items) |

No contract or app file changed. `pnpm typecheck`, the web app's Vitest, Forge, `pnpm verify` and the browser E2E were
not run. No server or browser was started.

### Commits (version 2)

| Commit | What |
| --- | --- |
| `792089f7` | The registry takes tickers of 1 to 11 capitals or digits, the regenerated schema, a test for 1 |
| `f26e3ad4` | The registry entry is One Dollar is all you need, ticker 1, with its README line |
| `904f2a5a` | The dollar sign in the salon alphabet |
| `5c36fe5a` | The bill, its frame under glass, the two greens, the open envelope and `roseTicker()` |
| `4ff0e2fc` | The framed bill in every piece and scene, the two name lines, the new cover line, the captions and alt text, eleven PNGs re-rendered |
| `7da6149d` | The check for the version 2 rules |
| `d59c5977` | The brand book |
| `4408290f` | The storybook, details.md and the art notes |
| `855ac945` | The README |
| This commit | This record |

### Visual review (version 2)

- The eleven changed pictures were checked at full size, and scenes 02 and 04 are byte for byte version 1's. The
  bill reads as our own cartoon with a big 1 in every piece. In the 48 px logo, enlarged eight times with no
  smoothing, it still reads as a green bill with its 1 in a gold frame.
- The X banner with a round avatar over its corner, at about X's proportions, shows no clash. The corner's
  brightness stays between 17 and 50 of 255, and `check.mjs` proves it is bare ground.
- Fixed along the way: an ivory mat that let the bill blur into it at 48 px, now dark velvet; the heap hiding the
  rope's right post in scene 01; and in scene 07, the rope's posts standing in the fireplace and the jar, and the jar's
  lid crossing the frame.
- No browser, X upload or platform crop test was done.

### Open points (version 2)

- **The X handle.** Default: `@DollarInTheBox`, 14 characters. It is the joke's second half and holds no price.
  The fallback is `@TheFramedDollar`, 15 characters. Neither was checked on X.
- **Counsel on the name, the ticker and the bill.** Default: keep the kit as built for review, and launch only after
  counsel has looked at them (details.md, for counsel).
- **The ticker on the site.** The coin pile panel shows `Per 1`, `1 out` and `1 to redeem`. Default: ask the site
  owner to name the token in words there, with the accessible name "the token 1".

### Limits (version 2)

- The One Dollar contract life and its browser life have not run with the new name and ticker. The spec check twin and
  the registry tests accept them, and the contract life reads both from the registry (`ExampleLives.t.sol:119`,
  `:120`).
- No X upload, platform crop or browser test of the art was done.

## Version 1

The record of version 1 follows as it was, apart from its headings, one level lower. Version 2 settles one of its
open points: the working title is now the box's name.

### Requirements and files

| ID | Requirement from the brief | Result |
| --- | --- | --- |
| OD-01 | Read the box settings, registry notes, research and founder notes | Read `one-dollar.json`, the registry README and validator, `core-v2-plan.md` sections 2 and 5 (the coin pile block and the one-dollar scale-test row), the decision log (F109, F110, F118 to F123, F127, F130, F131, F133), the examples test record, counsel pack questions 20 and 34, the create page's templates and pile step, the box page's coin pile panel and its actions, the site's issuer-power lines, the keeper notes and the contracts listed below. Read the Dragon's Hoard kit (the other coin pile) as the finished kit to match, looked at the covers of the other four kits in this branch, and read the Rent Free kit on its branch through `git show` (no checkout) to keep the looks apart |
| OD-02 | README with the file list | `README.md` lists every file and folder; `check.mjs` enforces it |
| OD-03 | Brand book | `brand-book.md`: name, ticker, joke, hook, the founder's idea, cover line with its literal line, voice with twelve example lines, twelve colors, three OFL fonts with fallbacks, logo construction, clear space and round crop, do and don't, contrast table, homage and IP rules |
| OD-04 | Storybook in 5 to 7 scenes | `storybook.md`: seven scenes, one picture and two short sentences each, the same words as `src/scenes.mjs` |
| OD-05 | Details in plain words | `details.md`: every setting, where each fee goes, the dollar's own rules, taking a slice, what a holder gets, risks, what waits for counsel, v2.1, the site and the launch |
| OD-06 | Art notes | `art-notes.md`: the look, the salon alphabet, the dollar and the exhibit, story symbols, scenes, brand pieces, rules for extending |
| OD-07 | Clean vector art with local PNG exports | 12 SVG and PNG pairs plus `art/logo-48.png`, rendered by `@resvg/resvg-js` 2.6.2 with system fonts off |
| OD-08 | Item variants and assignment for a collection box | Not a collection box, so none were made, and `check.mjs` refuses them |
| OD-09 | `check.mjs` that verifies files and pixel sizes, and run it | Done; see results |
| OD-10 | Original art, no promise words, no names of the platform's own token or collection, plain writing | Word and shape scan in `check.mjs`, a palette scan of every SVG, a no-dollar-sign rule, plus a manual read of every doc |

### Decisions

1. **The look.** A claret gallery at night with one spotlight, a silver dollar under a glass dome on a marble plinth
   behind a velvet rope, lettered in high-contrast salon capitals and drawn with thin ink lines like an engraving. The
   dollar is the hero, so it is shown the way a museum shows a masterpiece, and the satire is that it is one dollar.
   Claret, silver, rose and teal are far from GPU Poor's heat camera, Bag Holders' plum pegboard, Exit Liquidity's
   green dot sign, Link Marines' olive stencil, Dragon's Hoard's lapis and gold and Rent Free's cream houses.
2. **Silver, round and under glass.** Four of the five kits in this branch draw gold coins. The dollar is silver,
   stands on a stand inside a round dome, and never sits in a square opening.
3. **No dollar sign, no banknote, no blue coin.** The brief rules out real currency notes and coin logos, and the price
   coin's own mark is a blue disc with a white dollar sign. The dollar is a silver coin with a raised 1. The salon
   alphabet has no dollar sign, and `check.mjs` refuses one, and refuses the coin's name in any SVG title or
   description.
4. **ONE is a rose token with a rosette.** It can never pass for the dollar or for a plain USDC coin. A heap of rose
   tokens next to one small silver coin is the joke picture. It says "a billion ONE share one dollar" without any
   talk of prices or value.
5. **The cover line.** "Every fee burns ONE. The dollar just sits there." The lazy dollar is the joke, and it is
   exactly what the settings do, since both sides burn and no fee reaches the pile. The literal line always goes next
   to it, and `check.mjs` requires both in two places and refuses a drifted copy. In the art, ONE is set in rose
   inside a line so the ticker never reads as the word one.
6. **The founder's question stays out of public lines.** The brief relays the idea with a working title and a
   question from the founder. Both sit in one marked block in the brand book. Every public line, post and picture
   leaves them out, and `check.mjs` refuses their words anywhere else.
7. **Small slices, told plainly.** One ONE is a billionth of the dollar at the start, it takes a thousand ONE to make
   USDC's smallest unit, a smaller burn pays nothing unless a least amount is set, and gas can cost more than a slice.
   Reading the site's coin pile panel showed that its Per ONE figure rounds to zero for this box, so `details.md`
   names a site step for it.
8. **ONE is not a dollar.** A token named One Dollar and priced in a dollar stable coin can be misread. The voice rules,
   the README, the first risk and the counsel list all say that ONE is a token, not a dollar and not a stable coin.
9. **Burns enter the fireplace from the side.** Early drafts let falling tokens pass through the marble mantel. The
   arrows now curve around the fireplace and enter its opening.
10. **Own letters.** Every letter in the art comes from a salon alphabet drawn for this kit, with stems, hairlines,
    oval rings, pen curves, balls, serifs and beaks. Live text names three OFL families (Bodoni Moda, Instrument Sans,
    IBM Plex Mono). No font was downloaded, so their license files were not read here. The integrator checks them
    when self-hosting.
11. **Square Hole's 3 of 15 parts are one line.** The kit says "3 parts go to Square Hole (its platform and its
    buy-back)" and does not split that share further. A legal read asked the line to say where the share goes. In the
    Terms and in the code, 2 of the parts go to Square Hole's buy-back and 1 to its platform. What a failed box has left
    when its claims close goes to that buy-back, and the kit says so. It never names what the buy-back buys.
12. **Exact bytes.** `check.mjs` compares every SVG and PNG with a fresh build. `.gitattributes` in the kit marks
    `art/**` as `-text`, so a checkout cannot convert line endings and break that check.

### Facts read in the code

Paths are under `packages/contracts/src/box-v2/` unless they say otherwise.

| Fact used in the kit | Where |
| --- | --- |
| Fee split into 10, 2 and 3 parts of 15 (2 and 1 to Square Hole); Burn books the 10 parts as buy-back money; for a box without item or holder sources the rounding dust waits for the next fee on the same side | `BoxReceiverV2Base.sol:284`, `:343`, `:344`, `:345`, `:350`, `:351`, `:352`, `:361` |
| Collect tip of at most 5%, set aside only from buyers' fees above the batch minimum, under a cap | `BoxReceiverV2.sol:48`, `:74`, `:75`, `:76`; `BoxReceiverV2Base.sol:469`, `:470`, `:471`; `interfaces/ReleaseConstantsV2.sol:34` |
| Burn steps: after graduation, one protocol step per block, a minimum, the bought token burned, a tip, a retry | `BoxReceiverV2.sol:87`, `:96`, `:97`, `:100`, `:112`, `:116`, `:117`, `:118`, `:203`; `BoxReceiverV2Base.sol:509`, `:514` |
| Each buy step stops 49 ticks from the current price | `interfaces/ReleaseConstantsV2.sol:28`; `libraries/ReceiverViews.sol:25` |
| The pool's parts are released once graduation settles; deepen after graduation buys with 49.75% and tips at most 5% | `BoxReceiverV2Base.sol:363`, `:366`; `BoxHookV2Extension.sol:92`, `:96`, `:108`, `:278`, `:279`; `interfaces/ReleaseConstantsV2.sol:31` |
| 1% fee on buys (USDC in) and on sales (USDC out); outside liquidity, removals and donations refused | `BoxHookV2.sol:25`, `:171`, `:185`, `:239`, `:249`, `:255` |
| Launch window of 384 seconds in 32 steps of 12 seconds, buys only through the launch router, tax from 931,974 down to 80,565 millionths, swept to the pool after graduation or to the failure pot | `../box/BoxSpecV1.sol:42`, `:44`, `:46`; `BoxHookV2.sol:123`; `BoxLaunchRouterV2.sol:259`, `:290`, `:187`, `:188` |
| The creator is the seeder; an ERC-20 seed is pulled exactly from the seeder before the box opens, by any caller; loading it opens the gate | `PileVaultV2.sol:76`, `:85`, `:88`, `:95`, `:99` |
| A slice is the live balance times the token burned over the whole supply, rounded down; one burn of the whole supply takes everything; no leave-behind when none is set | `PileVaultV2.sol:117`, `:128`, `:129`, `:174`, `:183`, `:184`, `:185`, `:186` |
| Slices only after graduation; a recipient other than zero or the pile; a least amount; the token pulled and burned | `PileVaultV2.sol:122`, `:123`, `:130`, `:131`, `:132` |
| Gifts of the pile's coin join every slice; no rescue; failed surplus and other tokens stay | `PileVaultV2.sol:23`, `:24`, `:117` |
| On failure the seed goes back to the seeder, in a call anyone can make | `PileVaultV2.sol:151`, `:153`, `:155`, `:156` |
| Failure: after the deadline, 7 days after a filled curve closes, or 14 days after the planned opening while the gate holds; the deadline counts from the real opening; claims for 365 days | `BoxCoordinatorV2.sol:212`, `:216`, `:220`, `:227`, `:230`, `:313`, `:80`; `interfaces/IBoxCoordinatorV2.sol:32`; `interfaces/ReleaseConstantsV2.sol:56` |
| Graduation moves the coordinator's tokens into the pool, so the whole supply includes the pool's ONE | `BoxCoordinatorV2.sol:239`, `:245`, `:247` |
| On failure the waiting burn money and the pool's parts go to the closing pot, and the pile's seed back to its seeder | `BoxReceiverV2.sol:274`, `:295`, `:297`; `interfaces/FailureTableV2.sol:47`, `:48`, `:52` |
| ONE has 18 decimals, one billion issued once, and no owner, pause, blocklist, mint or upgrade | `BoxTokenV2.sol:34`, `:38`; `../box/BoxSpecV1.sol:22`; `BoxFactoryV2Parts.sol:94` |
| The keeper collects, alternates burn and deepen steps, retries burns, loads an approved ERC-20 seed without paying it, and has no pile redemption job | `packages/keeper/README.md:14`, `:16`, `:107`, `:122`, `:124` |
| The create page's Coin pile template burns on both sides; its pile step takes a seed coin and an exact seed loaded by the creator | `apps/web/src/features/create/v2/templates.ts:51`; `apps/web/src/features/create/v2/PileStep.tsx:28`, `:29` |
| The box page's pile panel: Per ONE is balance times 10^18 over supply, rounded down; Redeem needs a quote above zero, uses it as the least amount, and needs an approval first | `apps/web/src/features/core/v2/m3-data.ts:110`, `:111`; `apps/web/src/features/core/v2/CoinPileV2.tsx:69`, `:84`, `:85`; `apps/web/src/features/core/v2/m3-actions.ts:131`, `:137` |
| The site's issuer line for USDC: the issuer can freeze addresses, including the pool | `apps/web/src/features/create/v2/listings.ts:17`; `apps/web/src/features/create/v2/issuer-powers.ts:12` |
| The example life: exact one-USDC seed, graduation, the slice rule, supply burns; contract life passes, browser lives blocked by a refused port | `docs/evidence/SH-V21-EXAMPLES-E2E.md:38`, `:106`, `:284`; `apps/web/e2e/core-v2-chain/examples/life.mjs:187` |

### Commands and results

All commands run from the kit folder with Node 24.19.0 unless noted.

| Command | Result |
| --- | --- |
| `node build-art.mjs` | Exit 0: built 12 SVG and PNG pairs and `art/logo-48.png`, about 0.6 s |
| `node build-art.mjs` again, then a SHA-256 of every file in `art/` | All 25 hashes match the first build, so the build is byte-for-byte repeatable |
| `node check.mjs` before the docs existed | Exit 1 as expected, with the missing docs failing. It also caught the X banner's second cover line reaching into the avatar corner (1,654 pixels), fixed by raising the text block |
| `node check.mjs` after the first draft of the docs | Exit 1. It caught two false coin amounts (`raised 1, ONE` and `reads 0 USDC`) and the word `returns` in the art notes, all reworded |
| Mutation runs of `node check.mjs` | Twenty-two runs, each changing one thing: a promise word, an em dash, a coin amount, a year, a three-sentence caption, a hand-edited SVG, a wrong PNG size, the coin named in an SVG description, a stray `art/items` folder, a changed cover line, the platform collection's name, a missing scene, a color outside the palette in the source, a label pushed to the edge, a token in the avatar corner, the mark moved into its clear space, a registry value missing from `details.md`, the founder's question in a public line, a dollar sign added to the alphabet, the raise amount repeated, a founder block outside the brand book, and a drifted literal line. The first round missed two. The literal line sits in two places and only one copy was required, so the check now requires both and refuses a drifted copy. The clear-space run moved the mark too little to reach the band, so it was rerun with a larger move. The final round: every run exits 1 with the expected FAIL line, every file was restored from a copy after each run, and a SHA-256 of the whole folder matched the one taken before |
| `node check.mjs` final | Exit 0: 421 checks passed (7 scenes, a coin pile with no items) |
| `./node_modules/.bin/eslint --max-warnings 0 examples/boxes/one-dollar` (repository root) | Exit 0 |
| `pnpm lint` (repository root, once) | Exit 0, about 15 s |
| `pnpm check:handoff` (repository root) | Exit 0: both handoff folders match their hashes |
| `gitleaks dir examples/boxes/one-dollar` (repository root) | Exit 0, no leaks found (gitleaks 8.30.1) |

No TypeScript, contract or app file changed, so `pnpm typecheck`, Vitest, Forge, `pnpm verify` and E2E were not run.
No server was started, and nothing was downloaded.

### Visual review

- The logo at a real 48 px, enlarged eight times with no smoothing, still reads as a silver coin with a 1 under a
  dome. In a round crop the whole mark sits inside the circle, and `check.mjs` proves it pixel by pixel.
- The X banner with a round avatar over its corner, at X's proportions, shows no clash. The corner holds only bare
  ground, the frame leaves it out, and the avatar echoes the exhibit on the right.
- All seven scenes were checked at 800 px for labels, arrows and overlaps. Fixed along the way: the heap hiding the
  rope's right post in scene 01, arrows that fell through the mantel (now routed into the opening from the side),
  spotlight lamps hanging in mid-air in scenes 05 and 06, the YOUR SLICE label crossing its arrow, the jar's lid cut by
  the frame in scene 07, coins leaving the jar from its mouth in scene 04, and the seam between the two slices taken
  in scene 06. On the box banner the rope's posts crossed the bottom frame, so the exhibit now stands a little higher.
- No browser, X upload or platform crop test was done.

### Limits and open points

- The founder's example-boxes doc is on the old account and was not read. The idea and the founder's question come
  from the kit brief, and the core plan's scale-test row confirms the box as a USDC pile.
- The working title and the founder's question stay out of every public line. Default: keep them out. The founder can
  decide that the working title becomes a second line on X.
- The name One Dollar with USDC pricing can be read as a dollar token. Default: keep the name, with "ONE is a token. It
  is not a dollar." near the top of every live page, and counsel confirms.
- The site's Per ONE figure reads zero for this box at the start. Default: a site step shows "less than a millionth of
  a USDC" when the pile is not empty.
- The browser life of this box has not run yet, because the local port was refused. Its contract life passes.

### Requests for the integrator

1. Copy this record to `docs/evidence/SH-KIT-ONE-DOLLAR.md` when merging.
2. Ask the site owner for the Per ONE step above, and for the line "ONE is a token. It is not a dollar." near the top
   of the live box page.
3. Choose the open-source license for the kit collection before publishing it.
