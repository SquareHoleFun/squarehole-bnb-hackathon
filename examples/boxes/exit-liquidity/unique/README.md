# Exit Liquidity: 404 unique signs

**Active 2D edition, adopted under R74-ART.** The parent assignment, settings and public CAR use these
404 distinct pictures through `scripts/kits/unique.mjs`'s `buildUniqueSet` result. Every item has all six traits
and `model: null`. Review GLBs are verified during the build but excluded from the active assignment and bundle.
The original sign variant stays the base trait. Five physical trait layers make every combination unique.
No box is deployed or published by this adoption. The reviewed af1 correction restored each original sign's lettering and moved
the Route trait onto a small separate wall plate. No new words, numbers, names or claims appear in the art.

Review the [48 pictures and traits](contact-sheet.png) and the [24 picture/model comparisons](models-sheet.png).
The latter places each picture next to its front and three-quarter renders from the unchanged Rent Free renderer.

## Build and verify

From the repository root, with the existing workspace dependencies installed, no network:

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
node --version
node examples/boxes/exit-liquidity/assign.mjs > examples/boxes/exit-liquidity/assignment.json
node examples/boxes/exit-liquidity/check.mjs
node --test examples/boxes/exit-liquidity/assign.test.mjs
node examples/boxes/exit-liquidity/unique/deal.mjs
node examples/boxes/exit-liquidity/unique/build.mjs --out .cache/tmp/unique-exit-full
node examples/boxes/exit-liquidity/unique/check.mjs
node --test examples/boxes/exit-liquidity/unique/unique.test.mjs
```

`deal.mjs` prints the stable JSON. `build.mjs` writes 404 SVGs, 404 PNGs, 404 GLBs and a manifest to the supplied
directory. `check.mjs` builds a fresh full set under `.cache/tmp/`, checks the committed manifest and all limits,
and compares every committed sample, render and sheet with fresh bytes. The test builds **twice** into separate
temporary folders, compares every SVG, PNG and GLB byte for byte, verifies both builds and the committed samples,
and checks trait effects at 128 px. Temporary folders are retained for inspection, never removed automatically.

To compare regenerated review files without overwriting the reviewed manifest or samples, use fresh scratch
directories for both the full build and review output:

```sh
node examples/boxes/exit-liquidity/unique/build.mjs --out .cache/tmp/unique-exit-review-full --samples .cache/tmp/unique-exit-review
```

To rebuild just one id, including the final sign:

```sh
node examples/boxes/exit-liquidity/unique/picture.mjs 404 .cache/tmp/unique-exit-one
node examples/boxes/exit-liquidity/unique/model.mjs 404 .cache/tmp/unique-exit-one
```

The committed sample selection is fixed by the dealer. If changing that selection during later art development,
move the previous `samples/` folder to a fresh location under `.cache/trash/` before rebuilding; no tool deletes
old outputs. The checker rejects extra or stale sample files.

## Traits and counts

Each row below is an exact count, not a probability. Each layer totals 404. Every pair differs in at least
two traits; all traits affect the picture and the model. See [traits.md](traits.md) for visual meanings,
base-sign preservation, the dealing algorithm and proof; [traits.json](traits.json) is the machine vocabulary.

| Trait | Value | Meaning | Signs |
| --- | --- | --- | ---: |
| Original sign | `01` | Exit? | 34 |
| Original sign | `02` | Not found | 34 |
| Original sign | `03` | No exit | 34 |
| Original sign | `04` | Both ways | 34 |
| Original sign | `05` | Burnt out | 34 |
| Original sign | `06` | Backwards | 34 |
| Original sign | `07` | Down | 34 |
| Original sign | `08` | 404 | 34 |
| Original sign | `09` | Up | 33 |
| Original sign | `10` | Loop | 33 |
| Original sign | `11` | Error | 33 |
| Original sign | `12` | Try again | 33 |
| Housing | `plain` | Plain rim | 101 |
| Housing | `visor` | Rain visor indoors | 101 |
| Housing | `guards` | Corner guards | 101 |
| Housing | `fins` | Cooling fins | 101 |
| Route plate | `dogleg` | One more corner | 101 |
| Route plate | `switchback` | Long way round | 101 |
| Route plate | `fork` | Two wrong turns | 101 |
| Route plate | `coil` | Back to the start | 101 |
| Repair | `clean` | Still under inspection | 101 |
| Repair | `patch` | Spare plate | 101 |
| Repair | `staples` | Held together | 101 |
| Repair | `tape` | Temporary forever | 101 |
| Hallway equipment | `reel` | Cable to nowhere | 101 |
| Hallway equipment | `case` | Locked spare exit | 101 |
| Hallway equipment | `lamp` | Backup light | 101 |
| Hallway equipment | `tray` | Empty claim tray | 101 |
| Power feed | `left` | Left elbow | 101 |
| Power feed | `right` | Right elbow | 101 |
| Power feed | `twin` | Double feed | 101 |
| Power feed | `loop` | Service loop | 101 |

## Format, scale and disk

The seed is the public string `exit-liquidity/404-signs/no-way-out/v1`; it is unsuitable for a hidden reveal.
No entropy or identity comes from an id in the asset generator. Node **24.22.1** and resvg-js **2.6.2** are pinned.
The PNG renderer loads resvg-js directly through `packages/cards`, with system fonts disabled.

The picture imports the kit's palette, hallway, SVG builder, glow, light-box highlight and LED dots.
The shared scene imports the original variant records and `signBox` measurements. The picture delegates
lettering to the kit's own sign renderer; no external image, font or script is used. SVG titles/descriptions
supply accessible names. Review sheets add labels outside the art.
PNG pictures are **1024 × 1024**, 117,392–266,662 bytes, below the 400 KiB cap. The original sign lettering reads at
128 px; the separate route plate is secondary and small bolts and repair hardware are detail-view features.

Models are flat-colour hallway reliefs: a physical wall section, base, signs, supports, blocked openings,
raised lettering, separate route plate, repairs and equipment. Outlines are solid extrusions. They face
**+z**, stand on **y = 0**, have centred full bounds on x/z, and use **800 reference pixels per unit** across the whole edition. Every model
is 1 unit tall. The hatches are represented as upper/lower wall reliefs; the rear is a plain structural slab.
This interpretation keeps each sign's world together instead of leaving ceiling mounts floating in space.

The unchanged Rent Free GLB writer builds positions, flat normals and indexed triangles. A local material-slot
adapter replaces its house colours with Exit colours in linear RGB without mutating the imported palette.
GLBs contain one baked mesh, opaque matte materials, no textures, URIs, animations or extensions. All pass the
imported Rent Free `checkModel`: **960–3,640 triangles**, **52,840–194,428 bytes**, below 4,000 and 256 KiB.
Unlit LED substrate dots and soft glows stay in 2D; lit letters/arrows are raised six-sided dots or merged
block bars. The models use no glow shader. The face interiors of all 404 pictures are regression-checked
against the 12 original PNGs (12 px inset excludes rounded edges); GLB front surfaces are checked at every
glyph-grid cell of the twelve base signs, including spaces.

| Full set | Files | Bytes |
| --- | ---: | ---: |
| 1024 px pictures | 404 PNG | 74,048,759 |
| Models | 404 GLB | 44,465,740 |
| Regenerable picture sources | 404 SVG | 8,814,760 |
| Full manifest | 1 JSON | 210,304 |
| **Full build** | **1,213** | **127,539,563 (121.63 MiB)** |

PNG + review GLB output is **118,514,499 bytes (113.02 MiB)**; public item delivery uses only the **74,048,759 PNG bytes**.
These are file lengths, not filesystem allocation.
Only 48 picture PNGs, 24 GLBs, 48 model renders, two sheets and the full manifest are committed.
Model renders are the Rent Free renderer's native **512 × 512**, using its fixed front and front-left
three-quarter cameras, cream background, flat lighting and 2× antialiasing. Sheets are 1536 × 3072 and
1536 × 3456. Rendering does not open a browser, listener or network connection.

## Active assignment and publication

`await assignment()` in `../assign.mjs` exposes T02's common build result unchanged: count, seed, columns,
model policy, generated directory and ordered items. Each item has its decimal id, all six traits, verified
picture path/hash/size and a null model. The CLI prints the same data without the scratch directory, using
relative picture filenames for a stable `../assignment.json`. `variantFor(id)` remains the base-family helper
used by the dealer; it does not choose an active picture from the twelve-family library.

The shared interface always builds the fixed seed into fresh ignored scratch and verifies every PNG and review
GLB against `manifest.json`. The parent check also compares every id's full traits and picture hash, enforces
404 distinct pictures and no models, and retains the brand, library, scene, wording and link checks.

`node scripts/kits/bundle.mjs exit-liquidity` exports `items/1.png` through `items/404.png`, plus `items/traits.csv`
with `id,sign,housing,route,repair,equipment,conduit`. Settings, list, proofs, inventory and CAR are generated into
the kit's uncommitted `build/` directory. No GLBs are published and every model commitment stays zero.
Rent Free and Bag Holders have a separate 3D policy; Exit Liquidity and Link Marines v2 are 2D.

The kit remains open art with the same 404 ids and financial settings. Public bindings, the final list,
hosting and deployment remain integrator work. See the [shared tooling instructions](../../../../scripts/kits/README.md),
[adoption evidence](../../../../docs/evidence/SH-KITS-UNIQUE-T03-EL.md) and
[historical generator evidence](../../../../docs/evidence/SH-ART-UNIQUE-EXIT.md).

Rebuild determinism was verified on macOS arm64 with the pinned toolchain, not on another OS/CPU. There is
no marketplace or browser-viewer test in this adoption. The imported software renderer checks the actual review
GLB bytes; model presence does not authorize 3D publication. No seed, manifest, sample or visual revision is included.
