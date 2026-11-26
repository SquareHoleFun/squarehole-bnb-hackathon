# Paper Certificates

Public settings: `node scripts/kits/settings.mjs paper-certificates` writes `settings/paper-certificates-boxspec-v2.json` and its `-plan.json`. These carry the kit's public hidden picture, but no item pictures, assignment, salts or reveal data. In Create, choose Load settings and pick both files together, then the twelve specimen-0 variant pictures and `plan.csv`. Create checks the plan and its table, deals fresh numbers and salts, and asks you to save the reveal file before Create. Keep that file private; no numbered 776 MB upload is needed.

Gold in, paper out.

This is the brand kit for the Paper Certificates example box on Square Hole. The token is SCRIP, the old word for a
share certificate. The box holds a new collection of 1,929 joke share certificates, sealed until drawn. Their
companies never existed, from Bagholder & Sons to the Sideways Crab Shipping Co., and twelve of them are blue chips.

The kit has two editions. **Gold Certificates** comes first and is priced in the gold coin, a token backed by gold.
**Paper Certificates** follows when the index coin's pool is deep enough. It is priced in the index coin, a token that
follows a fund of a big stock index. Everything else is the same.

Every buy and every sale pays a small fee in the price coin. After the box graduates, the buyers' share buys SCRIP in
the box's own pool and burns it, and the sellers' share buys SCRIP for the certificates. A certificate out of the box
keeps its part for its owner. The part of a certificate still inside the box is burned. No fee ever burns the gold
coin or the index coin.

![Gold Certificates cover. GOLD CERTIFICATES engraved in black with a gold shadow inside an old certificate frame, above the line GOLD IN, PAPER OUT. On the right, a brown certificate of Bagholder & Sons and a blue certificate of the Blue Chip Chip Shop fan out behind a gold coin and a lilac SCRIP coupon.](art/cover.png)

The kit is ready for review. Nothing in it is deployed or posted, and the founder checks it before any use.

## Two editions

| Edition | Price coin | Cover line | Its own pieces |
| --- | --- | --- | --- |
| Gold Certificates | the gold coin | "Gold in, paper out." | `art/x-banner`, `art/cover`, `art/box-banner`, `art/scenes/` |
| Paper Certificates | the index coin | "Stock in, paper out." | `art/paper/x-banner`, `art/paper/cover`, `art/paper/box-banner`, `art/paper/scenes/` |

Both editions share the ticker SCRIP, the mark, the hidden picture and the twelve certificates. A box's price coin is
fixed when it is created, so each edition is its own box. The registry row describes Gold Certificates. See
[details.md](details.md) for what happens if both editions go live.

## Files

| File | What it is |
| --- | --- |
| [README.md](README.md) | This page |
| [brand-book.md](brand-book.md) | Name, ticker, joke, cover lines, voice, palette, fonts, logo rules, the certificates, the hidden picture, do and don't, accessibility, homage rules |
| [storybook.md](storybook.md) | The story in seven pictures, showing what the fees do |
| [details.md](details.md) | The box settings in plain words, what owners get, the risks, what still waits |
| [art-notes.md](art-notes.md) | How the art is built, so a creator can extend it |
| [assign.mjs](assign.mjs) | Deals the 12 certificates to the ids 1 to 1,929 from a seed, and writes a real collection's files |
| [assignment.json](assignment.json) | The output of `assign.mjs` with the public example seed |
| [plan.csv](plan.csv) | The plan for the create page: each certificate picture's file name, its count and its company, ink and series. With it, the page picks the numbers itself ([the format](../../../docs/guides/hidden-collection-plan.md)) |
| [build-art.mjs](build-art.mjs) | Builds every SVG in `art/` from `src/` and renders each PNG |
| [check.mjs](check.mjs) | Checks every file and pixel size, fresh renders, the hidden picture's limits, the assignment and its seed rules, the number box, the clear space, the avatar corners, the margins, the palette, the contrast table, the storybook, the registry row and the wording |
| [src/](src/) | The art source: palette, SVG builder, renderer, the engraver's alphabet and tools, the certificate, the twelve vignettes, coins, props, scenes, brand pieces, the editions and the hidden picture |
| `art/logo.svg`, `art/logo.png` | The mark, 1024 x 1024, the same for both editions |
| `art/logo-48.png` | The same mark at 48 x 48, to show it still reads |
| `art/x-avatar.svg`, `art/x-avatar.png` | X profile picture, 400 x 400 |
| `art/x-banner.svg`, `art/x-banner.png` | Gold Certificates X header, 1500 x 500, with a bare corner for the avatar |
| `art/cover.svg`, `art/cover.png` | Gold Certificates link card, 1200 x 630 |
| `art/box-banner.svg`, `art/box-banner.png` | Gold Certificates box page banner, 2400 x 600, with all twelve certificates |
| `art/hidden.svg`, `art/hidden.png` | The hidden picture, a sealed envelope, 1024 x 1024. The SVG fits the on-chain field as it is |
| `art/items/variant-01` to `variant-12`, `.svg` and `.png` | The 12 certificates, 1024 x 1024 each, printed with the specimen number 0 |
| `art/scenes/scene-01` to `scene-07`, `.svg` and `.png` | The storybook pictures with the gold coin, 1200 x 1200 each |
| `art/paper/x-banner.svg`, `art/paper/x-banner.png` | Paper Certificates X header, 1500 x 500 |
| `art/paper/cover.svg`, `art/paper/cover.png` | Paper Certificates link card, 1200 x 630 |
| `art/paper/box-banner.svg`, `art/paper/box-banner.png` | Paper Certificates box page banner, 2400 x 600 |
| `art/paper/scenes/scene-01` to `scene-07`, `.svg` and `.png` | The storybook pictures with the index coin |
| `art/reference/cover.png`, `box-banner.png`, `scenes/scene-01.png` to `scene-07.png` | The gold edition's cover, box banner and scenes with no lettering, as reference pictures of the kit's world. PNG only |
| `art/reference/paper/`, the same nine files | The same for the paper edition |
| [SH-KIT-PAPER-CERTIFICATES.md](SH-KIT-PAPER-CERTIFICATES.md) | Work record for the integrator, with decisions, facts, commands and results |
| `.gitattributes` | Keeps the art bytes exact, so the freshness check holds on every checkout |

Every PNG has its SVG next to it. The SVGs hold only shapes, lines and small pattern tiles. They load no fonts,
images, styles or scripts.

## The 1,929 certificates

There are nine joke companies of 213 certificates each and three blue chips of 4 each. That makes 1,929, and 12 of
them are blue chips. The counts are fixed. Which number holds which certificate stays secret until each one is drawn.

| Variant | Company | Ink | Series | Certificates |
| --- | --- | --- | --- | --- |
| 01 | Bagholder & Sons | Sepia | Company | 213 |
| 02 | Exit Liquidity Partners LLP | Teal | Company | 213 |
| 03 | Long Wick Candle Works | Vermilion | Company | 213 |
| 04 | Rumor Mill Flour Co. | Olive | Company | 213 |
| 05 | Sell the News Printing Co. | Slate | Company | 213 |
| 06 | Sideways Crab Shipping Co. | Crimson | Company | 213 |
| 07 | Slippage Banana Co. | Ochre | Company | 213 |
| 08 | Dip Buyers Fondue Co. | Plum | Company | 213 |
| 09 | Margin Call Telephone Co. | Green | Company | 213 |
| 10 | Blue Chip Chip Shop | Blue | Blue chip | 4 |
| 11 | Blue Chip Wood Chip Co. | Blue | Blue chip | 4 |
| 12 | Blue Chip Paint Chip Co. | Blue | Blue chip | 4 |

The blue chips are a small special series of companies that make actual blue chips, such as chips in a paper cone,
wood chips and paint chips. A blue chip gets the same part of the fees as any other certificate.

**The rule.** `assign.mjs` gives every id from 1 to 1,929 a rank, the SHA-256 of the text `<seed>:<id>`. It sorts the
ids by rank and deals the certificates down the sorted list in variant order, 213 ids each for 01 to 09, then 4 ids
each for 10, 11 and 12. The same seed always gives the same list, and any seed gives the same counts.

**The seed.** `assignment.json` is an example made with the public seed `paper-certificates-example`, so anyone can see
the shape of the list. The real collection needs its own seed of at least 32 characters of random text, kept with the
reveal file and shown to nobody until every certificate is revealed. Anyone who knows or guesses the seed knows every
sealed certificate, so the example seed must never be used for a real box.

**The numbers.** Each real certificate prints its own item id in red in its number box, like Nº 1,929. The pictures in
`art/items/` print the specimen number 0. A number changes nothing else in the picture, and `check.mjs` proves it.

To make the files the create page reads, keep the seed out of every file in the repository and run:

```sh
PAPER_CERTIFICATES_SEED=<secret> node examples/boxes/paper-certificates/assign.mjs --folder <private-folder>
```

It renders `1.png` to `1929.png`, each with its own number, and writes a `traits.csv` with each certificate's company,
ink and series, and the private `assignment.json`. It refuses to run without a secret seed and refuses a folder inside
this kit, and it never prints the list. The folder takes about 560 MB, and the render takes about two and a half
minutes on a laptop. Add `--sample 12` to render only the first twelve certificates and look at them first.

Square Hole collections start at id 1. Check that the deployed collection uses ids 1 to 1,929 before the files are used.

Or skip the numbered files: put the 12 PNG pictures from `art/items/` and [plan.csv](plan.csv) in one folder and add them together. The create page then picks the numbers itself, at random, and keeps the list only in the reveal file. No seed is needed. Every certificate then shows the specimen number 0, because the numbers are picked after the pictures are made.

## Rebuild and check

From the repository root, with Node 24 and the workspace installed:

```sh
node examples/boxes/paper-certificates/build-art.mjs
node examples/boxes/paper-certificates/assign.mjs > examples/boxes/paper-certificates/assignment.json
node examples/boxes/paper-certificates/check.mjs
```

`build-art.mjs` uses `@resvg/resvg-js`, which the workspace already pins in `packages/cards`. Nothing is downloaded.
The same source gives the same bytes every time, and `check.mjs` fails if any SVG or PNG differs from a fresh build.

`node examples/boxes/paper-certificates/build-art.mjs --no-words` builds only `art/reference/`, the same pictures of both
editions with no lettering ([art-notes.md](art-notes.md#word-free-references)). `check.mjs` lets those files sit in
`art/` but does not compare them with a fresh build, so rebuild them after any change to a cover, a box banner or a
scene.

## Using the kit

- Show live text next to the pictures. The brand book has the lines, and the storybook has the captions.
- The kit calls the price coins the gold coin and the index coin. The pictures draw the gold coin as a gold disc with
  a small bar on it, and the index coin as a steel disc with a basket. A live page shows the coin's ticker from its
  listing, next to the chain and the full contract address.
- Every public page carries the "not affiliated" line and the "not a share" line from the brand book.
- Every live SCRIP page shows the chain and the full contract address. Other tokens may use SCRIP too. Until a contract
  exists, the line reads "Contract: not deployed".
- When Square Hole launches this box as one of its own, its address also goes on the list of Square Hole's own boxes,
  as decided in F133.
- The real recipe needs step 2 of v2.1 (pay items in the box token), a listing for the gold coin and the v2.1 create
  page, which this line has. The registry row is the real gold edition and waits for its local lives. See
  [details.md](details.md).
- The example registry uses this kit's logo and cover. Wiring the rest of this art into a launch is a separate step, listed
  in [details.md](details.md).
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
