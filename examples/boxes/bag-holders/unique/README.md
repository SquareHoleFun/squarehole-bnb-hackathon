# 420 unique Bag Holders

This is the active Bag Holders edition under R74-ART: every ID has its own picture and 3D model, while keeping
the original kind of bag. [assign.mjs](../assign.mjs), the parent check, settings and CAR tooling consume the
shared `scripts/kits/unique.mjs` interface. All five traits retain their exact lower-case names and values.
No deployment or publication is claimed. Create's model reader and settings envelope carry every model.

The reviewed bytes stay fixed. The seed's `proposal 1` text, the manifest's `proposal: true` marker and the GLB
node name `Bag Holders proposal` record the original build's provenance. They do not select the active edition;
the shared interface's explicit `3d` policy does. Renaming those fields would change reviewed hashes.

Start with the [48-picture contact sheet](contact-sheet.png) and the [24-model comparison sheet](models-sheet.png). The latter puts each picture beside the model's front and three-quarter views. Labels belong to these review sheets. The bags retain only their original kit prints: TOTE, PAPER, TEA, SAND and CHIPS. No new words, numbers, names or claims are added.

## Reproduce offline

Run from the repository root, with the existing workspace dependencies installed. Node and resvg versions are checked, not downloaded. `@resvg/resvg-js` 2.6.2 resolves from `packages/cards`.

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
node --version
node examples/boxes/bag-holders/unique/deal.mjs
node examples/boxes/bag-holders/unique/build.mjs --out .cache/tmp/bag-holders-full
node examples/boxes/bag-holders/assign.mjs > examples/boxes/bag-holders/assignment.json
node examples/boxes/bag-holders/check.mjs
node --test examples/boxes/bag-holders/unique/unique.test.mjs
```

`deal.mjs` prints the ordered 420 trait assignments. The build writes `picture-1.svg` through `picture-420.svg`,
matching 1024 × 1024 PNGs, `model-1.glb` through `model-420.glb` and `manifest.json` to the explicit destination.
Use a fresh destination. `assign.mjs` independently builds in fresh ignored scratch through `buildUniqueSet`,
which validates the generated manifest and every SVG, PNG and GLB against the reviewed bytes. The saved
assignment uses paths relative to the full output directory, and includes all traits, SHA-256 hashes, byte
lengths and model policy. Full generated output stays uncommitted.

`samples.mjs` is the original review artifact builder. Its CLI overwrites committed review artifacts and must
not be run for this adoption. The tests reproduce and compare those artifacts in memory without updating them.

The test suite includes the complete checker. To run only that checker instead:

```sh
node examples/boxes/bag-holders/unique/check.mjs
```

Both commands launch two independent Node build processes in fresh `.cache/tmp/bag-holders-unique-*` directories, compare all 1,261 files byte for byte, validate every asset, compare the committed manifest to the fresh one, then recreate and compare every sample, render and sheet. Temporary builds are retained, never deleted. Allow roughly 160 MiB for each pair of full builds, plus rendering memory. Run either command for routine verification; running both repeats the full build check.

`pictureSvg(traits)` and `modelGlb(traits)` are the generator APIs. They accept only the five declared traits. IDs, time and environment state do not enter the artwork. JSON formatting, field order and the fixed seed form part of the reproducible output. Reproducibility was checked with Node 24.22.1 and resvg 2.6.2 in this workspace; other platforms were not tested.

## Traits and counts

| Trait | Values | Bags per value | Total |
| --- | --- | ---: | ---: |
| kind | `01` (Tote), `02` (Paper bag), `03` (Tea bag), `04` (Sandbag), `05` (Bean bag), `06` (Punching bag), `07` (Sleeping bag), `08` (Gift bag), `09` (Duffel bag), `10` (Backpack), `11` (Bag of chips), `12` (Bag of lemons) | 35 | 420 |
| trim | Tomato (`tomato`), Aqua (`aqua`), Leaf (`leaf`), Gold (`gold`), Canvas (`canvas`) | 84 | 420 |
| repair | Square patch (`square`), Round patch (`round`), Twin patches (`twin`), Diagonal darn (`slash`), Ladder mend (`ladder`), Corner patches (`corners`), Patch pocket (`pocket`) | 60 | 420 |
| tag | Clipped ticket (`ticket`), Round tag (`round`), Swallowtail tag (`swallowtail`) | 140 | 420 |
| stitch | Running stitch (`running`), Cross stitch (`crossed`) | 210 | 420 |

Each trait independently totals 420. See [traits.md](traits.md) for the world rationale, correlations and uniqueness proof; [traits.json](traits.json) is the canonical vocabulary and seed. Every kind gets all 35 trim/repair pairs. There is no rejection sampling, background-only uniqueness, or ID printed on the bag.

## Files and size

| File | Purpose |
| --- | --- |
| `deal.mjs`, `traits.json`, `traits.md` | Exact edition and documented vocabulary |
| `picture.mjs`, `model.mjs` | SVG and GLB generators from the same traits |
| `lib/details.mjs` | Shared patch, stitch and tag shapes; imported original bag options |
| `lib/prints.mjs` | Raised lettering from the original item SVG paths, colours and transforms; rounded joins and caps |
| `lib/mesh.mjs` | Solid panels, continuous outline joins, straps, hooks and faceted lemons |
| `lib/export.mjs` | Reuses Rent Free's GLB writer, replacing only its fixed material table with kit colours |
| `build.mjs` | Full build into an explicitly chosen output directory |
| `manifest.json` | All 420 IDs, traits, SHA-256 hashes, encoded sizes and triangle counts |
| `samples.mjs`, `samples.json` | Deterministic sample selection and review artifact builder |
| `samples/` | 48 pictures, 24 models, 48 renders; 120 files total |
| `contact-sheet.png`, `models-sheet.png` | Labelled founder review sheets |
| `check.mjs`, `unique.test.mjs` | Full build, uniqueness, geometry and freshness verification |

The selector greedily covers missing trait values, breaks ties by numeric ID, and caps each kind at four picture samples and two model samples. Both selected sets cover all 29 trait values. For this seed, the result is picture IDs 1–48 and model IDs 1–24. The 24 models' pictures are included in the 48.

All 48 model renders use the existing Rent Free software renderer, its fixed front/three-quarter cameras and antialiasing, at 512 × 512. The cream render background is a review surface, not a model texture; the NFT pictures retain the plum pegboard.

| Full generated set | Encoded bytes |
| --- | ---: |
| 420 SVGs | 3,021,603 |
| 420 PNGs | 26,839,984 |
| 420 GLBs | 53,273,624 |
| Manifest | 260,057 |
| **Full build, 1,261 files** | **83,395,268 (79.53 MiB)** |
| PNG + GLB delivery payload only | 80,113,608 (76.40 MiB) |
| Committed sample directory, 120 files | 6,543,889 (6.24 MiB) |

These are file byte lengths, not filesystem allocation. No full set of generated SVGs, PNGs or GLBs is committed. The two sheets and source files are additional to the sample directory's size.

All PNGs are 1024 × 1024 and 43,951–93,753 bytes (limit strictly below 400 KiB). GLBs are 69,200–206,772 bytes and 1,384–3,852 triangles (limits 256 KiB and 4,000). Grounded model heights are 0.978–1.040 units at the one shared scale. All 420 pass the imported Rent Free `checkModel`: binary glTF 2.0, baked transforms, valid normals/indices/bounds, no textures, no URIs, centred x/z, y = 0 and matte opaque colours. Geometry is low poly and stylised; these are not hollow fabric simulations or rigged characters.

The original 2D lettering is drawn by the kit unchanged, with at least 16 reference pixels of clear space. Tote repairs sit on the pocket, paper/chips repairs above their labels and sand repairs below the stamp. The TEA tag stays aqua and the CHIPS label stays tomato. In 3D, all five prints fit as raised solid strokes, including the CHIPS ink outline; no print is omitted for budget reasons.

## Active integration and remaining launch work

`await buildUniqueSet('bag-holders')` is the common producer boundary. It supplies ordered decimal IDs 1 to 420,
the fixed seed, `kind`, `trim`, `repair`, `tag`, `stitch`, exact PNG/GLB bytes and their `0x` SHA-256 hashes.
The parent assignment only makes those file paths relative for a portable record; it does not normalize traits
or hashes again. The parent check compares every ID with this manifest and separately checks the twelve-family
input library and generic fee illustrations. The storybook never claims to depict a particular NFT.

Settings and CAR generation preserve all five traits and every model commitment, through Create's own model
reader. Build with `node scripts/kits/bundle.mjs bag-holders`. The settings embed the PNGs and, in `models`, every
GLB; the GLBs are also separate numbered files and CAR blocks, which Load settings takes with the pictures.
T05 publishes the final post-Create list and proofs against the actual commitment. Hosting and deployed metadata
still need verification; a local filename is not a live URL.
See the [shared builder instructions](../../../../scripts/kits/README.md).

The original twelve-picture [kit record](../SH-KIT-BAG-HOLDERS.md) and
[art proposal evidence](../../../../docs/evidence/SH-ART-UNIQUE-BAGS.md) remain historical evidence.
The [adoption evidence](../../../../docs/evidence/SH-KITS-UNIQUE-T03-BH.md) records this integration and its limits.
