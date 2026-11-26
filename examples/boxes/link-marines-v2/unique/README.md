# Link Marines: 420 unique portraits

This folder supplies the active 420-portrait edition under the founder's R74-ART decision. Kit assignment,
settings and bundles use the shared `buildUniqueSet` result from `scripts/kits/unique.mjs`.
The model policy is explicitly `2d`: every published item has a unique picture and no model. Review GLBs remain
available here for comparison only. Each id keeps exactly the Rank and Squad computed by `../ranks.mjs`;
the General still gets exactly the same ration as the Private. Adoption does not change the fixed seed or art bytes.

Start with [the 48 portraits](contact-sheet.png) and [24 models beside their portraits](models-sheet.png).
Individual 1024 × 1024 pictures, GLBs and 512 × 512 front/three-quarter renders are in [samples/](samples/).
Every portrait retains its original rank plate and the kit's stencil lettering; no new words, names, numbers or
claims are added to either asset. Sample ids and trait captions belong to the sheets. 2D is the edition policy;
the 3D samples are for comparison. [manifest.json](manifest.json) records all 420 ids,
traits and SHA-256 hashes, byte sizes and triangle counts. The complete asset set is rebuilt into scratch space,
not committed. [The original art evidence](../../../../docs/evidence/SH-ART-UNIQUE-MARINES.md) records its historical review.
[The adoption evidence](../../../../docs/evidence/SH-KITS-UNIQUE-T03-LM.md) records the active integration.

## Rebuild and check

Run from the repository root, with the existing locked dependencies installed. No command below needs the network.
Use Node **24.22.1**, pnpm **10.29.1** and the locked `@resvg/resvg-js` from `packages/cards`.

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
node --version
node examples/boxes/link-marines-v2/unique/deal.mjs
node examples/boxes/link-marines-v2/unique/build.mjs --out .cache/tmp/unique-marines-full
node examples/boxes/link-marines-v2/unique/check.mjs --dir .cache/tmp/unique-marines-full
node --test examples/boxes/link-marines-v2/unique/unique.test.mjs
```

The test builds all 420 SVGs, PNGs and GLBs twice in fresh child processes, in separate temporary folders under
`.cache/tmp/unique-marines-test-*`. It checks every file against the committed manifest, compares both builds
byte for byte, checks unique decoded pixels at 1024 and 128 px and unique model geometry, and recreates the sample
renders and sheets. It also compares every portrait's table pixels to the original picture for its assigned rank,
including the stencil, plate shape, colours, placement and clearance from the ration. Scratch builds are retained.
`check.mjs` without `--dir` builds and checks a fresh temporary set itself.

Only a separately reviewed visual change should regenerate committed samples or the manifest:

```sh
node examples/boxes/link-marines-v2/unique/samples.mjs --from .cache/tmp/unique-marines-full
```

This updates the 48 pictures, 24 GLBs, 48 renders, both sheets, `samples.json` and `manifest.json`. Review every
picture and render again, then run the test. A stale manifest deliberately fails the check; never edit hashes by hand.

## Traits and exact counts

The fixed seed is `Link Marines / mess night / same ration / proposal 1`. [traits.json](traits.json) is the exact
vocabulary; [traits.md](traits.md) explains the cast and deterministic dealing. Each row independently totals 420.

| Trait | Values | Count per value | Total |
| --- | --- | ---: | ---: |
| Rank | Private, Specialist, Corporal, Sergeant, Staff Sergeant, Master Sergeant, Sergeant Major, Lieutenant, Captain, Major, Colonel, General | 35 each | 420 |
| Squad | Every integer from 1 through 35 | 12 each | 420 |
| Face | Round, Long, Square, Pear, Broad | 84 each | 420 |
| Eyes | Dots, Wide, Happy, Sleepy, Squint, Wink | 70 each | 420 |
| Grooming | Clean, Freckles, Sideburns, Black moustache, White moustache, Single braid, Twin braids | 60 each | 420 |
| Collar | Bow tie, Napkin | 210 each | 420 |
| Mouth | Smile, Grin, Surprise, Cheer | 105 each | 420 |
| Prop | Spoon, Fork, Teacup, Bell, Salt, Menu | 70 each | 420 |
| Wall | Khaki, Crate, Paper | 140 each | 420 |

The complete Face × Eyes × Grooming × Collar product gives 420 different characters before Mouth, Prop or Wall
is added. Uniqueness does not depend on id, Rank, Squad or Wall. The 48 pictures cover every value of every trait;
the 24 models cover every non-Squad value, including all 12 ranks. Squad has 35 values, so full model-sample
coverage is impossible in 24 slots. The exact selection and sample hashes are in [samples.json](samples.json).

## Asset format and disk size

`picture.mjs` imports the existing SVG document, marine, cap, face, prop, wall, tablecloth, ration and rank plate builders.
`lib/spec.mjs` is the shared mapping from traits to the kit's parts. The existing resvg loader resolves through
`packages/cards`. No fonts, remote inputs or new bitmap sources are used. Major outlines remain 10 px at 1024 px.

`model.mjs` builds the same character as a standing figure, facing +z, on y = 0, with centred x/z bounds.
All figures use one scale, with no per-model resizing; measured heights are 0.96454–0.99422 units. They use flat, opaque, matte palette colours and inverted
ink shells as geometry outlines. No shader outline, texture, URI, animation, extension or skeleton is needed.
`lib/mesh.mjs` imports the Rent Free GLB encoder unchanged, then partitions its index stream into marine colour
ranges; it does not copy the encoder. Samples use the Rent Free software renderer unchanged.
`lib/rank-plate.mjs` adds a cream rank plate on a small mess table below the ration hand. It samples the original
stencil at its 26 px cap height and merges the ink into flat triangles, preserving the stencil bridges and line
breaks. This approximates curves on a 1 px grid; no alternate alphabet, font or texture is stored in the GLB.

| Full set component | Files | Minimum bytes | Maximum bytes | Total bytes |
| --- | ---: | ---: | ---: | ---: |
| PNG portraits, 1024 × 1024 | 420 | 133,877 | 163,864 | 61,482,421 |
| Source SVG portraits | 420 | 16,847 | 23,342 | 8,230,399 |
| Binary glTF 2.0 models | 420 | 129,124 | 177,208 | 62,746,116 |
| Manifest | 1 | 350,389 | 350,389 | 350,389 |

The full build is **132,809,325 bytes (126.66 MiB)** of file contents; filesystem block allocation varies.
Pictures plus models alone total **124,228,537 bytes (118.47 MiB)**. The models have **2,554–3,552 triangles**,
below 4,000, and each is below 256 KiB. Every portrait is below 400 KiB. Committed samples and sheets total
12,950,967 bytes, excluding their JSON records and the full manifest.

## Active kit integration

`../assign.mjs` builds and verifies the edition through `buildUniqueSet`, then prints `../assignment.json`.
The JSON keeps all nine traits, canonical ids, generated picture filenames, the shared interface's 0x hashes and
byte counts, and `model: null`. Filenames are relative to the full build directory; temporary paths are omitted.
`../check.mjs` checks every assigned id against this folder's manifest and retains all base library and brand checks.

```sh
node examples/boxes/link-marines-v2/assign.mjs > examples/boxes/link-marines-v2/assignment.json
node examples/boxes/link-marines-v2/check.mjs
node scripts/kits/bundle.mjs link-marines-v2
```

Assignment/check builds stay under `.cache/tmp/kits-unique-link-marines-v2-*`. Bundles go into the kit's ignored
`build/`, with numbered `items/1.png` through `items/420.png`, `items/traits.csv`, settings, public list and proofs.
The shared builder validates review GLBs against the manifest but omits them from its 2D result. Neither settings
nor the CAR attaches these models. Rent Free and Bag Holders use `3d`; Link Marines and Exit Liquidity use `2d`.
Full generated output stays uncommitted. No launch or publication is implied by this adoption.

The storybook and brand pieces remain generic fee/rank illustrations. Both contact sheets use real selected ids
and trait captions from `samples.mjs` and `samples.json`; only the portrait sheet represents the active assets.

## Limits

Byte determinism is verified with Node 24.22.1 on this machine using two fresh processes and the pinned resvg
dependency; another OS/architecture was not exercised. Models pass the imported Rent Free model checks and were
reviewed through its front and three-quarter renderer, not a browser or a separate glTF validator. The original art review inspected all 48 picture
samples and 48 renders beside the original picture of their rank, plus the portraits at 128 px; the remaining 372 pictures are
machine checked. The retained review models are static figures with the
same pose; the portrait Wall is environmental and is intentionally absent from the portable model.
