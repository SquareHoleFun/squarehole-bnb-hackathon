# How the Lake House art is made

The mark is drawn in code: `src/logo.mjs` writes the SVG, and `build-art.mjs` renders it with `@resvg/resvg-js`
2.6.2 (the version `packages/cards` pins), at 1024 and at 48 pixels. The SVG holds only shapes: no fonts, words,
pictures, scripts or outside references. Running the build twice gives the same bytes.

## The look

- A small wooden house on posts at the edge of a lake at night, with a moon, a few star glints and pines on the far
  shore. Flat fills with dark outlines, as the other example kits draw.
- The house's one window is the square hole of the platform tile in the reference pictures: a glowing square ring
  around a dark square. Its light shows on the water.
- No people, faces, animals, words, numbers, coins or documents. Nothing in it is a real place, brand or title.

## Where the colours come from (ADR-0004)

ADR-0004 and the founder's answer F03 make the handoff's approved reference pictures
(`square-hole-handoff/design/reference/`) the source of the platform's art. The cast crops cut from them, and the
brand look-alikes no crop may touch, are listed in `packages/design/art/manifest.json`.

Every colour of this logo is sampled from those reference pictures by `src/sample.mjs`: the average of a 5 x 5 pixel
patch, inside one approved crop and clear of every excluded one. `art/palette.json` records each colour's source
file and its SHA-256, the crop, the crop's box, the patch and what the colour paints. Three colours are mixed from the
samples in fixed integer steps (`src/palette.mjs`, `MIX`): the water, its ripples and the far pines.

| Colour | From the approved crop | Paints |
|---|---|---|
| sky `#13182B` | platform-tile (feed.png) | the night sky |
| hole `#090D32` | platform-tile (feed.png) | the outlines and the dark square of the window |
| glow `#93CFFA`, glowMid `#6F85DB`, glowDeep `#3744A5` | platform-tile (feed.png) | the window ring, its light, the glints |
| wood `#E3C1A4`, woodMid `#D1A78F`, woodDark `#624846` | square-hole-box (feed.png) | the walls, the moon, the planks, the door, the roof, the deck, the posts |
| pine `#2A6C43`, pineDark `#265D39` | shape-gem (feed.png) | the pines |
| lake `#1E4ACD`, lakeDeep `#193997` | shape-pyramid (feed.png) | the lake, mixed into the sky |

`check.mjs` samples the reference pictures again and fails if a colour, a source hash or a crop changes, or if a
patch leaves its crop or touches an excluded one.
