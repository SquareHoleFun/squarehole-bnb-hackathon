# Link Marines, version 2

At mess night the General gets exactly the same ration as the Private.

This is the brand kit for version 2 of the Link Marines example box on Square Hole. The token's ticker is MARINE, the
founder's choice. The box is priced in LINK and holds a new collection of 420 unique marines in twelve ranks, from Private
to General. Every buy and every sale pays a small fee in LINK. On both sides, ten of its fifteen parts are the
marines' rations, split into 420 equal shares, one for each marine. A marine that someone owns keeps its ration until
its owner claims it in LINK. A marine still in the box sends its ration into the box's own pool, so the pool gets
deeper while the marines wait.

![Link Marines cover. LINK MARINES in big stencil letters on a walnut panelled wall, with the line THE SAME RATION FOR ALL 420. On the right, a young marine in a white peaked cap and a dress-navy jacket sits at a table with a white cloth, behind a plate with one gold coin, next to a candle.](art/cover.png)

Version 1 of the kit, [Link Marines](../link-marines/README.md), stays as it is: the version where the marines eat the
fees. The kit is ready for review. Nothing in it is deployed or posted, and the founder checks it before any use.

## Files

| File | What it is |
| --- | --- |
| [README.md](README.md) | This page |
| [brand-book.md](brand-book.md) | Name, ticker, joke, cover line, motto, what the box does, voice, palette, fonts, logo rules, do and don't, accessibility, homage rules |
| [storybook.md](storybook.md) | The story in seven pictures, showing what the fees do |
| [details.md](details.md) | The box settings in plain words, what owners get, the risks, what still waits |
| [art-notes.md](art-notes.md) | How the art is built, so a creator can extend it |
| [assign.mjs](assign.mjs) | Builds and verifies the unique edition through the shared kit tooling, then prints its per-id pictures, full traits and 2D policy |
| [assign.test.mjs](assign.test.mjs) | Checks the active edition against its manifest and a fresh assignment run |
| [ranks.mjs](ranks.mjs) | The fixed twelve base ranks, their art library and the original rank/squad rule |
| [assignment.json](assignment.json) | The full output of `assign.mjs` |
| [build-art.mjs](build-art.mjs) | Builds every SVG in `art/` from `src/` and renders each PNG |
| [check.mjs](check.mjs) | Checks every file and pixel size, the assignment, the clear space, the avatar corner, the margins, the colour fence, the one flannel shirt and the one seven, the contrast table, the storybook, the registry settings and the wording |
| [unique/](unique/) | The active portrait generator, fixed traits, reviewed manifest, samples and labelled contact sheets; review models stay out of the edition |
| [src/](src/) | The art source: palette, stencil alphabet, pen, panelled wall, faces, caps, things to hold, marines, coins and plates, ranks, props, scenes, brand pieces |
| `art/logo.svg`, `art/logo.png` | The mark, 1024 x 1024 |
| `art/logo-48.png` | The same mark at 48 x 48, to show it still reads |
| `art/x-avatar.svg`, `art/x-avatar.png` | X profile picture, 400 x 400 |
| `art/x-banner.svg`, `art/x-banner.png` | X header, 1500 x 500, with a bare corner for the avatar |
| `art/cover.svg`, `art/cover.png` | Link card, 1200 x 630 |
| `art/box-banner.svg`, `art/box-banner.png` | Box page banner, 2400 x 600, with all twelve ranks at one table |
| `art/items/variant-01` to `variant-12`, `.svg` and `.png` | The 12 base rank pictures used as art inputs, 1024 x 1024 each |
| `art/scenes/scene-01` to `scene-07`, `.svg` and `.png` | The storybook pictures, 1200 x 1200 each |
| [SH-KIT-LINK-MARINES-V2.md](SH-KIT-LINK-MARINES-V2.md) | Work record for the integrator: what changed from version 1 and why, decisions, facts, commands and results, open points |
| `build/` | Ignored public settings, numbered pictures, traits, proofs and bundle output from the kit tooling |
| `.gitattributes` | Keeps the art bytes exact, so the freshness check holds on every checkout |

Every PNG in `art/` has its SVG next to it. These are the base rank library and generic brand and fee illustrations.
The SVGs hold only shapes. They load no fonts, images or scripts.

## The 420 marines

Each marine id from 1 to 420 has its own generated portrait, with a distinct picture hash and character.
All nine traits travel with the picture: Rank, Squad, Face, Eyes, Grooming, Collar, Mouth, Prop and Wall.
[The trait table](unique/traits.md) gives every value and exact count. The fixed seed and reviewed hashes live in
[unique/manifest.json](unique/manifest.json). The twelve base ranks still follow the original rule:

```
variant = ((id - 1) mod 12) + 1, written with two digits
squad   = ((id - 1) div 12) + 1
```

Marine 1 is a Private. Marine 12 is a General, and marine 13 starts again with a Private. 420 is 12 x 35, so the
marines form 35 squads of 12, every squad has one marine of each rank, and every rank appears exactly 35 times.
Marine 420 is the General of squad 35. Rank is only the picture. Every marine gets the same ration, and a rank or a
squad changes nothing about fees or the box.

| Variant | Rank | Variant | Rank | Variant | Rank |
| --- | --- | --- | --- | --- | --- |
| 01 | Private | 05 | Staff Sergeant | 09 | Captain |
| 02 | Specialist | 06 | Master Sergeant | 10 | Major |
| 03 | Corporal | 07 | Sergeant Major | 11 | Colonel |
| 04 | Sergeant | 08 | Lieutenant | 12 | General |

The model policy is `2d`: every active item's model is null. The models and model sheet in `unique/` are review
material only. Rent Free and Bag Holders use the separate `3d` policy; Link Marines and Exit Liquidity use `2d`.

The [portrait sheet](unique/contact-sheet.png) labels real sample ids and all their traits. The storybook, cover,
logo and banners illustrate ranks and fees with generic characters; they do not depict numbered NFTs.

Square Hole collections start at id 1. Check that the deployed collection uses ids 1 to 420 before the
assignment becomes metadata.

## Rebuild and check

From the repository root, with Node 24.22.1 and the locked workspace dependencies installed:

```sh
node examples/boxes/link-marines-v2/build-art.mjs
node examples/boxes/link-marines-v2/assign.mjs > examples/boxes/link-marines-v2/assignment.json
node examples/boxes/link-marines-v2/check.mjs
node --test examples/boxes/link-marines-v2/assign.test.mjs
node --test examples/boxes/link-marines-v2/unique/unique.test.mjs
node scripts/kits/bundle.mjs link-marines-v2
```

`build-art.mjs` uses `@resvg/resvg-js`, which the workspace already pins in `packages/cards`. Nothing is
downloaded. The same source gives the same bytes every time, and `check.mjs` fails if any SVG or PNG differs
from a fresh build. The parent check also builds the unique edition and compares every id's traits and picture
hash to its reviewed manifest, checks distinct pictures and enforces the 2D policy.

`assign.mjs` calls `buildUniqueSet` in `scripts/kits/unique.mjs`. Each call keeps a fresh full build under
`.cache/tmp/kits-unique-link-marines-v2-*`; the committed assignment contains stable filenames relative to that
build directory, with the shared interface's hashes and byte counts. No scratch paths enter the assignment.
Full sets stay uncommitted. `unique/README.md` documents a direct scratch build and the sample checks. Bundle
output in ignored `build/` includes `items/1.png` through `items/420.png`, all traits in `items/traits.csv`, settings,
reveal list, proofs and the public CAR. Review GLBs are excluded. Preserve the reviewed manifest, samples and seed.

## Using the kit

- Show live text next to the pictures. The brand book has the lines, and the storybook has the captions.
- The pictures never label the price coin. The coins are plain gold discs, so the art also fits a copy of this box
  priced in another community coin. Only the name lettering says LINK. Name the coin in live text.
- Every public page carries the "not affiliated" line from the brand book. The people behind LINK did not make,
  approve or endorse this box.
- Every live page and every post shows the chain and the full contract address, for the reason in the brand book's
  ticker section. Until a contract exists, the line reads "Contract: not deployed".
- When Square Hole launches this box as one of its own, its address also goes on the list of Square Hole's own boxes,
  as decided in F133.
- The box sends the ration of a marine still inside to its own pool, using the Depth policy from step 5 of v2.1.
  Its recorded contract and browser lives predate the unique art commitments; the registry row is ready. See [details.md](details.md).
- Build the Sepolia example with `node scripts/kits/bundle.mjs link-marines-v2`. The registry names this kit's own art.
  The build shrinks the logo and cover for the free tier and preserves all 420 unique portraits and their full traits.
  Use the public settings in `build/` with Load settings; bind the verified tLINK listing before launch.
- The kit grants no license yet. The open-source license for its code, text and art is still to be chosen.
