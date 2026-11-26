# How the Rent Free art is made

The mark, the banners, the cover, the houses and the scenes in `art/` were made with an image generator, in seven
runs, from written briefs. They are raster pictures, so there is no SVG source for them. The founder approved them,
and the kit keeps them byte for byte. `check.mjs` holds the SHA-256 of every file and fails if one changes. The only
brand picture this kit rebuilds is `art/logo-48.png`, which `preview.mjs` renders from the mark with `@resvg/resvg-js` 2.6.2.

The active NFT edition is built in [unique/](unique/README.md): 500 distinct front-view PNGs and 500 matching GLB
models. Its six visible traits are `house`, `door`, `window`, `post`, `plant` and `step`. It imports the twelve
base families from [models/](models/README.md) and keeps their geometry apart from centring translation.
The fixed seed, complete manifest, selected samples and labelled sheets stay unchanged. The generated full output
is uncommitted. `assign.mjs` consumes the shared verified build result; it never assigns a base reference PNG to an NFT.

The fee pies in `art/fees/` are different. They are vector drawings from the landing page, with every word outlined,
and their SVGs hold only shapes. They come unchanged from branch `sh-landing-rung1`.

## The look

- Little houses seen straight from the front, like flat stickers. One house per picture, standing on a short, slightly
  curved ground line.
- Thick forest outlines with round ends and soft corners, the same weight on every house.
- Flat fills from the palette in the [brand book](brand-book.md), with green walls, a darker green or clay roof, butter
  windows with four panes, dark or clay doors, clay chimneys. No gradients, no shadows, no texture beyond the light
  grain the generator leaves in a fill.
- A cream ground everywhere, with wide empty margins around each house.
- No people, faces, pets, words or numbers in the houses and the scenes. The only words are on the cover and the two
  banners, and they are part of the picture.

## How the runs were made

The first run made the mark from a written brief alone, with no picture to copy. Every later run was given the kit's
own earlier pictures as its guide, so the houses and the scenes share one look. Nothing was traced or downloaded, and
no outside picture went in. The runs used the built-in image generation tool (`image_gen.imagegen`) of the Codex agent
that made the first version of this kit, on branch `codex/sh-codex-1/kit-rent-free-af2`.

| Run | What it made | Its guide | Pictures cut from it |
| --- | --- | --- | --- |
| 1 | The mark, 1254 x 1254 | None, the brief only | `logo.png` 1024 x 1024 and `x-avatar.png` 400 x 400 |
| 2 | A sheet of six houses, 1536 x 1024 | The mark | Houses 01 to 06 |
| 3 | A sheet of six more houses, 1536 x 1024 | The mark | Houses 07 to 12 |
| 4 | Four story scenes in a 2 by 2 sheet, 1254 x 1254 | The mark | Scenes 01 to 04 |
| 5 | Four more scenes, 1254 x 1254 | The first sheet of scenes | Scenes 05 to 08 |
| 6 | A wide banner, 2172 x 724 | The mark | `x-banner.png` 1500 x 500 and `box-banner.png` 1800 x 600 |
| 7 | The cover, 1733 x 907 | The mark | `cover.png` 1200 x 630 |

Every picture keeps the untouched output of its run beside it, as `<name>-original.png`. Where one sheet gave several
pictures, each original is the whole sheet, so the same bytes appear more than once. Git stores them once.

Each picture was cut from its original with ImageMagick 7.1.2-21 in one command:

```sh
magick <original> [-crop <cell> +repage] -background '#FFF7E6' -alpha remove -alpha off \
  -filter Lanczos -resize <W>x<H>^ -gravity center -extent <W>x<H> -strip <picture>
```

The houses are 512 px cells of their sheets, three across and two down, read left to right and top to bottom: `+0+0`,
`+512+0`, `+1024+0`, `+0+512`, `+512+512`, `+1024+512`. The scenes are 627 px cells, two across and two down: `+0+0`,
`+627+0`, `+0+627`, `+627+627`, scaled up to 768 px, which makes them a little soft. The mark, the banners and the
cover are not cropped, only scaled and centered. Running the command again on the originals gives the same bytes. All
25 pictures came out identical when this kit was checked.

## Story symbols

| Symbol | Means | How it is drawn |
| --- | --- | --- |
| Sky blue circle | USDC | A plain sky circle with a forest outline |
| Clay hexagon | RENT | A plain clay hexagon with a forest outline. Small hexagons flying off it mean it is burning |
| Open cardboard box | The box, where houses wait | A card-colored box with its lid open and a square hole in its side |
| Envelope with a blue seal | A house's "rent", waiting for its owner | A card-colored envelope sealed with a sky circle |
| Fire in a green tray | A burn | Clay and butter flames in a shallow green tray |
| Empty green tray | The box's own pool, in scene 02 only | The same tray with no fire |
| Plain green circle | Square Hole's 3 parts (its platform and its buy-back), in scene 02 only | A house-green circle |
| Key | A house's owner | A pale key with a round head |
| Two turning arrows | A swap in the box's own pool | Two forest arrows chasing each other |
| Green wallet | The owner's own wallet, where a claim goes | A green wallet with a sky circle peeking out. It never shows an address or an amount |

## The 12 base house families

| Variant | Name | Roof | Windows and door | Extra |
| --- | --- | --- | --- | --- |
| 01 | Cottage | Dark green gable | One window, dark door | Clay chimney. The mark is this house |
| 02 | Townhouse | Flat, with a dark cap | Two windows stacked, clay door with a knob | Tall and narrow |
| 03 | Bungalow | Low dark roof | Two windows, dark door | Clay chimney, a plant pot by the door |
| 04 | A-frame | Steep dark A-shaped roof with wide eaves | Round window over a dark door | None |
| 05 | Awning | Gable drawn as a dark outline | One window, dark door with a knob | Clay chimney, scalloped clay awning over the door |
| 06 | Arch roof | Round arch drawn as a dark outline | Round window, dark door with a knob | Clay chimney |
| 07 | Clay roof | Clay gable with a diamond window | Two windows, dark door | None |
| 08 | Step gable | Stepped gable | Two tall narrow windows, dark door | None |
| 09 | Lean-to | One slope with a clay edge | One big window, clay door | Clay chimney |
| 10 | Clay dome | Round clay roof | One wide window, dark door | Clay chimney |
| 11 | Dormer | Dark green roof with a dormer window | One window, butter arched door | None |
| 12 | Roof garden | Flat, with a clay edge | One window, clay door | Three green bushes on the roof |

## The story pictures

These are generic fee illustrations. The houses on the cover, banners and in the scenes have no NFT id.
The unique contact and model sheets show real sample ids with all six traits, generated by `unique/lib/sheets.mjs`.
The older `models/renders/contact-sheet.png` compares the twelve family references and base models, labelled by family.

| Scene | What it shows | In the storybook |
| --- | --- | --- |
| 01 | A house just out of the open box, two small houses still inside | 01 · The box |
| 02 | A blue circle split three ways, to a green circle, an envelope and a tray | 02 · Fifteen parts |
| 03 | Two houses, each with its own sealed envelope | 03 · "Rent" day |
| 04 | A house in the box. Its blue circle turns into a clay hexagon over a fire | 04 · Houses still in the box |
| 05 | A clay hexagon goes into a fire | 05 · "Property tax" |
| 06 | A house with a key. Its envelope goes to a wallet | 06 · Claim |
| 07 | A house and its envelope ride on a cart between two keys | 07 · Moving day |
| 08 | A quiet night, a house and an open, empty mailbox | Not used. Its sky has a crescent, which reads as a hype sign in coin talk |

## Rules for new brand art

- Make new pictures the same way. Give the generator the mark (`art/logo-original.png`) as its guide, and a written
  brief that repeats the look above, with a flat front view, thick rounded forest outlines, a cream ground, green walls,
  butter windows, clay accents, and no gradients, shadows, texture, people, faces, words, numbers, coin symbols,
  brands or real buildings.
- One house per picture, centered with wide cream margins, at the same scale and line weight as the others.
- Look at every new picture at its real size, and at the mark at 48 px.
- Keep the generator's untouched output as `<name>-original.png` beside the picture cut from it. Add both files with
  their sizes and SHA-256 to `FILES` in `check.mjs`.
- Keep the active edition's seed, family mapping, trait counts, manifest and samples stable. Changing edition art
  needs a separate review. These brand-art rules do not change the unique generator or its assignment.
- The active edition already has generated SVG sources. The fee pies are separate vector illustrations with every
  word outlined.

## Rebuild and check

```sh
node examples/boxes/rent-free/preview.mjs
node examples/boxes/rent-free/check.mjs
node --test examples/boxes/rent-free/unique/unique.test.mjs
node --test examples/boxes/rent-free/models/models.test.mjs
```

Use Node 24.22.1 in this repository with the installed workspace dependencies. The shared unique builder and
`preview.mjs` use `@resvg/resvg-js` 2.6.2, pinned in `packages/cards`. Nothing is downloaded.
