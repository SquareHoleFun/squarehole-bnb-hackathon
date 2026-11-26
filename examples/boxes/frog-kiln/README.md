# Frog Kiln

Public settings: `node scripts/kits/settings.mjs frog-kiln` writes `settings/frog-kiln-boxspec-v2.json` and its `-plan.json`. These carry the kit's public hidden picture, but no item pictures, assignment, salts or reveal data. In Create, choose Load settings and pick both files together, then the plan's twelve variant pictures and `plan.csv`. Create checks the plan and its table, deals fresh numbers and salts, and asks you to save the reveal file before Create. Keep that file private.

Every trade fires the kiln.

This is the brand kit for the Frog Kiln example box on Square Hole. The token is KILN. The box is priced in the frog
coin, a frog-themed meme coin with a real burn, and holds a new collection of 420 clay toads, hidden until drawn. Every
buy and every sale pays a small fee in the frog coin. After the box graduates, the buyers' share is burned with the
frog coin's own burn, and the sellers' share buys KILN for the toads. A toad out of the box keeps its part for its
owner. The part of a toad still inside the box is burned.

![Frog Kiln cover. FROG KILN carved into a dark clay plaque on a bisque wall, above the brushed line EVERY TRADE FIRES THE KILN. On the right, a brick kiln burns with green coins tumbling into its door and smoke rising from its chimney. A pale green clay toad sits in front of it.](art/cover.png)

The kit is ready for review. Nothing in it is deployed or posted, and the founder checks it before any use.

## Files

| File | What it is |
| --- | --- |
| [README.md](README.md) | This page |
| [brand-book.md](brand-book.md) | Name, ticker, joke, cover line, voice, palette, fonts, logo rules, the hidden picture, do and don't, accessibility, homage rules |
| [storybook.md](storybook.md) | The story in seven pictures, showing what the fees do |
| [details.md](details.md) | The box settings in plain words, what owners get, the risks, what still waits |
| [art-notes.md](art-notes.md) | How the art is built, so a creator can extend it |
| [assign.mjs](assign.mjs) | Deals the 12 toad pictures to the ids 1 to 420 from a seed, and writes a real collection's files |
| [assignment.json](assignment.json) | The output of `assign.mjs` with the public example seed |
| [plan.csv](plan.csv) | The plan for the create page: each toad picture's file name, its count and its glaze and crack. With it, the page picks the numbers itself ([the format](../../../docs/guides/hidden-collection-plan.md)) |
| [build-art.mjs](build-art.mjs) | Builds every SVG in `art/` from `src/` and renders each PNG |
| [check.mjs](check.mjs) | Checks every file and pixel size, fresh renders, the hidden picture's limits, the assignment and its seed rules, the clear space, the avatar corner, the margins, the palette, the contrast table, the storybook, the registry settings and the wording |
| [src/](src/) | The art source: palette, SVG builder, loop-tool alphabet, pen, studio wall, kiln, toads, coins, props, items, scenes, brand pieces and the hidden picture |
| `art/logo.svg`, `art/logo.png` | The mark, 1024 x 1024 |
| `art/logo-48.png` | The same mark at 48 x 48, to show it still reads |
| `art/x-avatar.svg`, `art/x-avatar.png` | X profile picture, 400 x 400 |
| `art/x-banner.svg`, `art/x-banner.png` | X header, 1500 x 500, with a bare corner for the avatar |
| `art/cover.svg`, `art/cover.png` | Link card, 1200 x 630 |
| `art/box-banner.svg`, `art/box-banner.png` | Box page banner, 2400 x 600, with all twelve toads on a ware rack |
| `art/hidden.svg`, `art/hidden.png` | The hidden picture, a toad still wrapped in paper, 1024 x 1024. The SVG fits the on-chain field as it is |
| `art/items/variant-01` to `variant-12`, `.svg` and `.png` | The 12 toad pictures, 1024 x 1024 each |
| `art/scenes/scene-01` to `scene-07`, `.svg` and `.png` | The storybook pictures, 1200 x 1200 each |
| `art/reference/cover.png`, `box-banner.png`, `scenes/scene-01.png` to `scene-07.png` | The cover, the box banner and the scenes with no lettering, as reference pictures of the kit's world. PNG only |
| [SH-KIT-FROG-KILN.md](SH-KIT-FROG-KILN.md) | Work record for the integrator, with decisions, facts, commands and results |
| `.gitattributes` | Keeps the art bytes exact, so the freshness check holds on every checkout |

Every PNG has its SVG next to it. The SVGs hold only shapes. They load no fonts, images or scripts.

## The 420 toads

There are nine glazes of 44 toads each and three cracked toads of 8 each. That makes 420, and 24 of them are cracked.
The counts are fixed. Which number holds which toad stays secret until each toad is drawn.

| Variant | Toad | Glaze | Crack | Toads |
| --- | --- | --- | --- | --- |
| 01 | Bisque | Bisque, no glaze | none | 44 |
| 02 | Celadon | Celadon | none | 44 |
| 03 | Tenmoku | Tenmoku | none | 44 |
| 04 | Shino | Shino | none | 44 |
| 05 | Oxblood | Oxblood | none | 44 |
| 06 | Ash | Ash | none | 44 |
| 07 | Cobalt | Cobalt | none | 44 |
| 08 | Honey | Honey | none | 44 |
| 09 | Speckle | Speckle | none | 44 |
| 10 | Gold seam | Celadon | Gold seam | 8 |
| 11 | Riveted | White | Riveted | 8 |
| 12 | Ember | Raku | Ember | 8 |

A cracked toad is one of a small special series. It gets the same part of the fees as any other toad, and its crack
changes nothing about the box.

**The rule.** `assign.mjs` gives every id from 1 to 420 a rank, the SHA-256 of the text `<seed>:<id>`. It sorts the
ids by rank and deals the toads down the sorted list in variant order, 44 ids each for 01 to 09, then 8 ids each
for 10, 11 and 12. The same seed always gives the same list, and any seed gives the same counts.

**The seed.** `assignment.json` is an example made with the public seed `frog-kiln-example`, so anyone can see the shape
of the list. The real collection needs its own seed of at least 32 characters of random text, kept with the reveal file
and shown to nobody until every toad is revealed. Anyone who knows or guesses the seed knows every hidden toad, so the
example seed must never be used for a real box.

To make the files the create page reads, keep the seed out of every file in the repository and run:

```sh
FROG_KILN_SEED=<secret> node examples/boxes/frog-kiln/assign.mjs --folder <private-folder>
```

It writes `1.png` to `420.png`, a `traits.csv` with each toad's glaze and crack, and the private `assignment.json`.
It refuses to run without a secret seed and refuses a folder inside this kit, and it never prints the list.

Square Hole collections start at id 1. Check that the deployed collection uses ids 1 to 420 before the files are used.

Or skip the numbered files: put the 12 PNG pictures from `art/items/` and [plan.csv](plan.csv) in one folder and add them together. The create page then picks the numbers itself, at random, and keeps the list only in the reveal file. No seed is needed.

## Rebuild and check

From the repository root, with Node 24 and the workspace installed:

```sh
node examples/boxes/frog-kiln/build-art.mjs
node examples/boxes/frog-kiln/assign.mjs > examples/boxes/frog-kiln/assignment.json
node examples/boxes/frog-kiln/check.mjs
```

`build-art.mjs` uses `@resvg/resvg-js`, which the workspace already pins in `packages/cards`. Nothing is
downloaded. The same source gives the same bytes every time, and `check.mjs` fails if any SVG or PNG differs from a
fresh build.

`node examples/boxes/frog-kiln/build-art.mjs --no-words` builds only `art/reference/`, the same pictures with no
lettering ([art-notes.md](art-notes.md#word-free-references)). `check.mjs` does not read that folder, so rebuild it
after any change to the cover, the box banner or a scene.

## Using the kit

- Show live text next to the pictures. The brand book has the lines, and the storybook has the captions.
- The kit calls the price coin the frog coin. The pictures draw it as a plain green coin with no letters and no face.
  A live page shows the coin's ticker from its listing, next to the chain and the full contract address.
- Every public page carries the "not affiliated" line from the brand book. The people behind the frog coin did not
  make, approve or endorse this box.
- Every live KILN page shows the chain and the full contract address. Other tokens may use KILN too. Until a contract
  exists, the line reads "Contract: not deployed".
- When Square Hole launches this box as one of its own, its address also goes on the list of Square Hole's own boxes,
  as decided in F133.
- The box's real recipe needs steps 1 and 2 of v2.1 (eat the price coin, pay items in the box token), a listing for the
  frog coin with its burn checked, and the v2.1 create page, which this line has. The registry row has the real fees with LINK standing in for the frog
  coin, and waits for its local lives.
  See [details.md](details.md).
- The example registry uses this kit's logo and cover. Wiring the rest of this art into a launch is a separate step,
  listed in [details.md](details.md).
- The kit grants no license yet. The open-source license for its code, text and art is still to be chosen.

## Local launch files

From the repository root, use `packages/chain/scripts/create-example-v2.mjs` with this example id and the
reviewed creator, factory and listing inputs. Omit `art` for a new hidden edition. The script checks the price
coin, creates a fresh secret seed and leaf salts, and saves everything below the gitignored `.cache/hidden-art/`.
The unsigned transaction names that local folder. No transaction is sent and no art is published.

The folder contains `items/1.png` through the last numbered item, `items/traits.json`, `secret.json`,
`reveal.json`, `proofs.json`, `commitments.json`, a size report and the ticker's `-boxspec-v2.json` file.
That settings file uses Create's own Download BoxSpec formatter, including its pictures, so it is private too.
Keep this entire folder backed up privately. Never commit it or pin unrevealed item pictures to IPFS.
Only the logo, collection cover and items already revealed may be published as raw blocks.

For a listener-free test with throwaway bindings, run:

```sh
node --experimental-transform-types apps/web/e2e/core-v2-chain/examples/prepare-hidden.mjs
# Use the relative index path printed by that command:
SH_HIDDEN_KITS=<index-path> node apps/web/e2e/core-v2-chain/examples/offline.mjs --hidden
```

The offline index and bindings are test inputs. For a launch, use the live listing's raise and the creator's
actual addresses. Load settings and its allowed editing controls remain the app integrator's responsibility.
See [SH-EX-LIFE](../../../docs/evidence/SH-EX-LIFE.md) for exact measurements and verification limits.
