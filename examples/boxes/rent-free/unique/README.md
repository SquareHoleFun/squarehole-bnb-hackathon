# Rent Free: 500 unique houses

Each id has its own trait-built picture and 3D model. This is the active Rent Free edition under R74-ART.
The parent assignment and checker consume `scripts/kits/unique.mjs`'s `buildUniqueSet('rent-free')`, also used by
settings and bundles. All six traits and both asset hashes are preserved. Nothing here uploads or deploys art.

Model policy is **3d**, as for Bag Holders. Link Marines v2 and Exit Liquidity use **2d** and exclude their review
models from publication. Rent Free's settings and bundle commit every model through Create's own model reader, and
its settings file carries the models, so Load settings round-trips them; a model is never dropped.

Open [the 48-picture contact sheet](contact-sheet.png) and [the 24-model comparison sheet](models-sheet.png).
Each model row shows its picture, front render and three-quarter render. Captions list the id and all traits;
the NFT pictures themselves contain no text.

## Reproduce and check

Run from the repository root. Use the existing workspace dependencies, including `@resvg/resvg-js` **2.6.2**
resolved from `packages/cards`, and Node **24.22.1**. No command needs the network, a browser, a server or fonts.

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
node --version
node --test examples/boxes/rent-free/unique/unique.test.mjs
node examples/boxes/rent-free/unique/check.mjs
```

The eight tests include two complete builds in separate temporary folders under `.cache/tmp/`. They compare
every SVG, PNG, GLB and manifest byte, then compare all hashes against the committed manifest and regenerate
every sample render and both sheets. The checker independently makes another fresh full build by default.
Temporary outputs are retained.

To create a full set explicitly, choose a new or empty output directory. The build refuses nonempty directories:

```sh
node examples/boxes/rent-free/unique/build.mjs --out .cache/tmp/rent-free-unique-review
node examples/boxes/rent-free/unique/check.mjs --from .cache/tmp/rent-free-unique-review
```

To reproduce the committed sample package from that full set:

```sh
node examples/boxes/rent-free/unique/samples.mjs --from .cache/tmp/rent-free-unique-review
```

That last command writes this folder's manifest, 48 sample PNGs, 24 sample GLBs, 48 renders and two sheets.
Do not add a full output directory to Git. To inspect a single id or the deal:

```sh
node examples/boxes/rent-free/unique/deal.mjs
node examples/boxes/rent-free/unique/picture.mjs 1 .cache/tmp/rent-free-one/picture-1
node examples/boxes/rent-free/unique/model.mjs 1 .cache/tmp/rent-free-one/model-1.glb
```

The picture command writes an SVG and a 1024 × 1024 PNG. The model command writes binary glTF 2.0.
All generation commands use the seed in [traits.json](traits.json):

```text
Rent Free / 500 little houses / no spare keys / proposal 1
```

## Traits and exact counts

[traits.md](traits.md) explains the visual vocabulary and why each part belongs on this street. Each id has
one value per trait. House remains exactly `((id - 1) mod 12) + 1`; no id changes family. Every pair differs in
at least two traits, and all 500 decoded pictures and 500 model geometry buffers are distinct.

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

Each trait totals 500. Counts are exact decks, not probability targets. Ids and edition counts are decimal
strings in data. All houses keep the same share of fees; the art does not encode economic state.

## Files and rendering

| File | Role |
| --- | --- |
| `traits.json`, `traits.md` | Count contract and visual specification |
| `deal.mjs` | Fixed-seed exact dealing, collision repair and independent validation |
| `picture.mjs`, `lib/svg.mjs` | Flat SVG projection with correct surface order; PNG rasterization through resvg |
| `model.mjs`, `lib/scene.mjs`, `lib/geometry.mjs` | Import the approved house, add trait geometry, centre without rescaling, encode GLB |
| `build.mjs`, `manifest.json` | Full build and committed hashes, dimensions, byte counts and triangle counts for all 500 |
| `samples.mjs`, `lib/samples.mjs` | Deterministic coverage selection and sample publication |
| `lib/render.mjs`, `lib/sheets.mjs`, `lib/io.mjs` | Existing Rent Free renderer adapter, labelled review sheets and byte helpers |
| `check.mjs`, `unique.test.mjs` | Full validation and eight tests |
| `samples/` | Exactly 48 PNG pictures, 24 GLBs and 48 PNG renders |
| `contact-sheet.png`, `models-sheet.png` | 2048 × 7680 picture sheet; 1536 × 15360 picture/front/three-quarter sheet |
| `README.md` | Commands, delivery facts and future integration |

The supplied base has no `src/`, `art/items/` or `art/reference/` in this kit. Its approved pictures are
raster files in `../art/houses/`, with original generated sheets beside them. We import
`../models/lib/houses.mjs`, `../models/lib/glb.mjs`, `../models/lib/raster.mjs` and
`../models/check-models.mjs`; none is copied or changed. A test reconstructs the twelve original GLBs
byte for byte and proves their triangles remain unchanged apart from centring translation.

Models face +z, stand on y = 0, and share the approved 350-reference-pixels/unit scale. Heights are
0.825714–1.061429 units. They have flat normals, opaque matte materials, geometry outlines, no textures
and no external URIs. Pictures are flat front views of those same parts, with the kit palette on cream.
Renders read the exported GLBs through the Rent Free software renderer. Both camera directions and
the target are inherited; one shared 310 pixels/unit framing leaves room for the new props.
The SVG uses twice that framing at 1024 px. Lighting affects the model renders but not the SVG fills.

## Disk and limits

Logical file sizes for a full build, excluding filesystem allocation overhead:

| Output | Files | Bytes |
| --- | ---: | ---: |
| PNG pictures | 500 | 16,672,586 |
| SVG sources | 500 | 21,112,741 |
| GLB models | 500 | 51,734,748 |
| Manifest | 1 | 409,125 |
| **Full build** | **1,501** | **89,929,200 (85.76 MiB)** |

The PNG/GLB pair set alone is 68,407,334 bytes. The committed 120 sample files occupy 4,439,541 bytes;
the contact sheet is 378,781 bytes and the models sheet is 726,800 bytes.
Every NFT PNG is 1024 × 1024; the maximum is **42,581 bytes** against a limit below 400 KiB.
Models contain **1,420–3,000 triangles**, with a maximum of **156,480 bytes**, within 4,000 triangles
and 256 KiB. A clear 32-pixel picture border and both model camera margins are checked for every id.

## Active assignment and launch boundary

From the repository root:

```sh
node examples/boxes/rent-free/assign.mjs > examples/boxes/rent-free/assignment.json
node examples/boxes/rent-free/check.mjs
node --test examples/boxes/rent-free/assign.test.mjs
node scripts/kits/bundle.mjs rent-free
```

The shared builder makes a fresh full set under `.cache/tmp/`, compares it with this reviewed manifest and checks
every generated asset hash. `assign.mjs` only makes the shared result's paths relative to that output and leaves out
the temporary directory. Its JSON keeps `count`, `seed`, `columns`, `modelPolicy` and ordered `items` with `id`,
`traits`, `picture` and `model`. Each asset has `path`, `sha256` (lowercase `0x` hex) and `bytes`. It does not deal
traits or normalize hashes again. No item points to a repeated family PNG or the incomplete sample directory.

The trait CSV is exactly `id,house,door,window,post,plant,step`; house values remain the reviewed `01` through `12`,
with names in the table above. The offline bundle exports all 500 numbered PNGs and GLBs, the full trait CSV,
model-bearing commitments, reveal list, proofs and public CAR. Create's reader, settings envelope and Load
settings keep the model bytes and commitments; T05 owns publication of the final post-Create list. See the
[shared interface](../../../../scripts/kits/README.md#unique-producer-interface-and-models).

The literal seed suffix `proposal 1` and the manifest's `proposal: true` are retained historical fields in the
reviewed bytes. They do not select the active edition; the shared kit policy and founder decision do. Do not rewrite
the manifest or samples to rename them. The twelve faceted base shapes and raster references remain library inputs.

The [original art evidence](../../../../docs/evidence/SH-ART-UNIQUE-RENT.md) records the earlier review of all 48
pictures at full size and 128 px, and both views of all 24 models. The [adoption evidence](../../../../docs/evidence/SH-KITS-UNIQUE-T03-RF.md)
records the current checks. Remaining ids have automated checks. Cross-platform byte reproduction is not measured.
