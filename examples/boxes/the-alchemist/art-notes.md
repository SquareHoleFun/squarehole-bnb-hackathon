# Workshop art

An original paper workshop: grey lead, green fee liquid, pale intermediate
liquid and a warm gold pile. The lead-to-gold image is a metaphor for fees buying
another coin. No real company logo, coin issuer mark, borrowed mascot, photograph
or external font appears in the art. Every coin has a plain ring and highlight.

| Color | Hex | Role |
| --- | --- | --- |
| Paper | `#f3e5c3` | Warm page and flask glass |
| Ink | `#193833` | Shapes, lettering and dark banner |
| Gold | `#e5ac37` | Pile coin and output liquid |
| Light | `#ffda77` | Sparks and banner caption |
| Lead | `#84969c` | LEAD metaphor |
| Shade | `#516a71` | Furnace base |
| Green | `#65a38b` | Price-coin fees |
| Rust | `#c66540` | Sellers' burn |
| White | `#fff5db` | Highlights, book and WETH liquid |

The mark is a flask containing a grey ingot in gold liquid, set inside a circle.
It keeps generous margins for a round crop. The cover tells the lead-to-gold
metaphor in three objects. The wide banner puts the name beside the mark. Each
scene uses the same frame, scene number and workshop objects, with its own action.

| Asset | Pixels | Files |
| --- | --- | --- |
| Logo | 1024 x 1024 | [SVG](art/logo.svg), [PNG](art/logo.png) |
| Cover | 1200 x 630 | [SVG](art/cover.svg), [PNG](art/cover.png) |
| Box banner | 2400 x 600 | [SVG](art/box-banner.svg), [PNG](art/box-banner.png) |
| Seven scenes | 1200 x 1200 each | `art/scenes/scene-01` through `scene-07`, SVG and PNG |

`src/art.mjs` draws the geometry and a compact block alphabet made of paths and
rectangles. No SVG loads fonts, raster pictures, scripts or external references.
SVG title and description provide accessible names. PNG users need the live
captions and alt text in [storybook.md](storybook.md); color alone never explains
the accounting. Show the chain, full contract address and pending status in
live text beside published pictures. Until deployment, say “Contract: not deployed”.

`build-art.mjs` uses the existing `@resvg/resvg-js` 2.6.2 dependency in
`packages/cards`, with system fonts disabled. The committed SVGs and PNGs must
match a fresh render byte for byte. `check.mjs` verifies those bytes, every size,
art links, unique pictures, word rules and the pending recipe. `.gitattributes`
preserves art bytes across checkouts. Tests corrupt inputs in memory and keep
symlink scratch files under `.cache/tmp/`; no files are deleted.

To extend the art, edit the shapes and captions in `src/art.mjs`, update
`storybook.md`, run the builder, then the checker and its tests. Keep marks
generic, leave room around labels, and inspect the rendered PNGs. The twenty
coins in scene 06 illustrate the 5% rule; real exits use integer raw amounts
and rounding. This kit adds no collectible item pictures or assignments.
