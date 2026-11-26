# Five hundred little houses, each its own

This is the trait design for the active Rent Free edition. [traits.json](traits.json) is the machine-readable count
contract; [manifest.json](manifest.json) is the resulting deal. Every house receives one value from each of six
traits. Every pair differs in at least two traits. The id is never a trait or an invisible image/model salt.

## The street's vocabulary

The [brand book](../brand-book.md) asks for calm, empty houses with lit windows, thick forest outlines, green
walls and clay accents. “500 little houses. No spare keys.” supplies the door joke; “Little houses. Big door
energy.” gives the door insert a clear place in every silhouette. The postman's voice and the story's waiting
envelopes supply the post furniture. Plants continue the original bungalow's pot and the roof garden's foliage.
A low step keeps each house on its own short ground line.

There are no people, faces, pets, text, numbers, badges, sale signs or coins in an NFT picture. The kit's
characters are its invented houses; these traits do not introduce residents. Post furniture is empty and
decorative. Its shape says nothing about a house's current fee share or claim state. Every house still gets
the same part of the fees. Trait counts are a design balance, with no ranked tiers or economic meaning.

## Exact counts

| Trait | Value | Houses |
| --- | --- | ---: |
| House | 01 · Cottage | 42 |
| House | 02 · Townhouse | 42 |
| House | 03 · Bungalow | 42 |
| House | 04 · A-frame | 42 |
| House | 05 · Awning | 42 |
| House | 06 · Arch roof | 42 |
| House | 07 · Clay roof | 42 |
| House | 08 · Step gable | 42 |
| House | 09 · Lean-to | 41 |
| House | 10 · Clay dome | 41 |
| House | 11 · Dormer | 41 |
| House | 12 · Roof garden | 41 |
| Door | Plain panel | 100 |
| Door | Twin panels | 100 |
| Door | Stable panel | 100 |
| Door | Diamond pane | 100 |
| Door | Round pane | 100 |
| Window | Bare frame | 125 |
| Window | Clay sill | 125 |
| Window | Side shutters | 125 |
| Window | Rain hood | 125 |
| Post | Quiet post | 100 |
| Post | Pillar post | 100 |
| Post | Round post | 100 |
| Post | Wall post | 100 |
| Post | Parcel post | 100 |
| Plant | Two leaves | 100 |
| Plant | Fan leaves | 100 |
| Plant | Clover pot | 100 |
| Plant | Tall sprig | 100 |
| Plant | Twin pots | 100 |
| Step | Clay step | 125 |
| Step | Butter step | 125 |
| Step | Twin step | 125 |
| Step | Round step | 125 |

Each trait column totals exactly 500: house is 8 × 42 + 4 × 41; door, post and plant are 5 × 100;
window and step are 4 × 125. Counts in JSON are decimal strings and count arithmetic uses bigint.
The unconstrained combination space is 12 × 5 × 4 × 5 × 5 × 4 = 24,000. We select 500 with exact marginal
counts and at least two differences between any pair, including pairs across different house types.

## What changes visibly

| Trait | Construction in the picture and model |
| --- | --- |
| House | Import the approved variant's complete mesh. Keep its roof, windows, door, chimney, side/back details and any original plants. The house value is exactly `((id - 1) mod 12) + 1`, padded to two digits. |
| Door | One inset, paired insets, a diagonal-braced stable insert, a diamond pane or a round pane. Insets contrast against the original door material. Knobs and surrounds remain visible. |
| Window | Keep the original frame, add a projecting clay sill, two side shutters or a shallow rain hood. This changes the principal front window; other original windows stay intact. |
| Post | A low empty tray, a box on a pillar, a round box on a pillar, a wall-mounted box or a taller parcel box. The wall box extends back to the facade. |
| Plant | Two broad leaves, a fan with a central leaf, three rounded clover clusters, a tall sprig or two small pots. Pots stand on the ground, with extruded leaves and stems. |
| Step | A clay tread, butter tread, two staggered treads or a deeper tread with a rounded front elevation. |

All six traits affect visible pixels and geometry; the tests exercise every value on all twelve house
families at 128 px. The single-step variations are deliberately quieter than doors and plants. Minimum
two-trait separation prevents a pair from differing only by a tiny tread. Some front props overlap the
house edge by design; the original house's complete geometry remains underneath.

## Palette and scale

Flat cream `#FFF7E6` surrounds each picture. The imported palette retains forest `#173D32`, house green
`#73B98C`, roof green `#3A6D51`, butter `#F3CA66` and clay `#DA795B`. The approved cottage gable
`#569B70` and roof-garden foliage `#6BA361` remain. New details use only forest, house green, butter and clay.
The kit's sky and card colours belong to its narrative symbols; they are not added as arbitrary item
backgrounds.

Forest outlines are physical volumes, inherited or built around detail faces. There are no texture outlines.
The shared scale stays at 350 reference pixels per unit, with y = 0 at the ground and the front toward +z.
Adding props changes the complete bounding box, so the result is translated to centre x and z, never resized.

The SVG uses the same geometry, projected straight on with flat palette fills. Surface splitting puts
intersecting faces in the right order, including the curved dome; a two-pixel same-colour path stroke closes
raster seams between triangles at 1024 px. This stroke does not replace the forest outline geometry.

## Dealing and review selection

The fixed seed is:

```text
Rent Free / 500 little houses / no spare keys / proposal 1
```

`deal.mjs` builds exact value decks, shuffles each with a separate HMAC-SHA256 counter stream and unbiased
Fisher–Yates, then deals in id order. A separate repair stream swaps cosmetic values between rows to remove
pairs with fewer than two differences. Swaps preserve all counts and never move the house type. The repair
is bounded and followed by an independent pairwise and histogram check. Nothing reads the clock or process
randomness. The command always uses this fixed seed; the exported function accepts another seed for testing.

The 48 picture samples give four examples of each house. Selection greedily covers unseen trait values,
then unseen values within that house, with id order breaking ties. All 35 values are covered. The first two
selection rounds supply 24 models, two per house. These are coverage samples, not a judgement of importance.
