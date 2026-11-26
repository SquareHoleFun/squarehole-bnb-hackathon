# Rent Free base model library

These twelve models are the unchanged base families used by the [500-house unique edition](../unique/README.md).
The edition adds visible traits to each family's geometry and assigns a distinct PNG and GLB to every id.
This library's variant numbers label families, not numbered NFTs. Nothing here is deployed or uploaded;
Create's model integration and final list publication remain separate gates.

[Compare the originals and both views](renders/contact-sheet.png). Each row shows the unchanged original,
the front render and the front-left three-quarter render, labelled with the variant number and name.
Individual renders are 512 × 512; the contact sheet is 1536 × 6720.

## Rebuild, render and check

Run from the repository root with Node **24.22.1**:

```sh
export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"
node --version
node examples/boxes/rent-free/models/build-models.mjs
node examples/boxes/rent-free/models/render-models.mjs
node examples/boxes/rent-free/models/check-models.mjs
node --test examples/boxes/rent-free/models/models.test.mjs
```

All four scripts use only Node built-ins. They need no browser, server, installed package, network, downloaded
asset or system font. Rendering also reads the twelve existing PNGs in `../art/houses/` for the contact sheet.
The generator rewrites the twelve GLBs and `manifest.json`; the renderer rewrites the 25 PNGs in `renders/`.
The generator uses no randomness or time. To build a comparison set elsewhere without changing these assets:

```sh
node examples/boxes/rent-free/models/build-models.mjs --out .cache/tmp/rent-free-models
```

The test builds twice into separate temporary folders under `.cache/tmp/`, retains those folders, and compares
both builds and the committed files byte for byte. It checks every manifest hash and exercises malformed GLBs,
unsupported resources/materials, false bounds, invalid indices, excessive triangles, displaced geometry and
wrong heights. The checker is for this generator's baked mesh profile, not an arbitrary glTF validator.

## What the models show

| Variant | Name | Front details |
| --- | --- | --- |
| 01 | Cottage | Dark edged green gable, right clay chimney, one left four-pane butter window, right forest door |
| 02 | Townhouse | Tall narrow walls, flat dark cap, two left windows stacked, right clay door with a forest knob |
| 03 | Bungalow | Broad low dark roof, right chimney, two windows around a dark door, clay pot with two leaves beside it |
| 04 | A-frame | Steep dark roof with wide eaves, round four-pane window above the centred dark door |
| 05 | Awning | Green gable with sloping forest outline, right chimney, left window, four scallops on a projecting clay awning, dark door with butter knob |
| 06 | Arch roof | Rounded roof, right chimney, round left window and right dark door with butter knob |
| 07 | Clay roof | Clay gable, butter diamond above two square windows, centred dark door |
| 08 | Step gable | Stepped green front parapet with a pitched roof behind, two tall narrow windows, centred dark door |
| 09 | Lean-to | Single roof slope descending to the right, clay fascia, left chimney, large left window and right clay door |
| 10 | Clay dome | Faceted clay dome with a curved dark eave, right chimney, wide left window and right dark door |
| 11 | Dormer | Dark green roof, projecting green dormer with four-pane window, left wall window and butter arched door |
| 12 | Roof garden | Flat roof with clay fascia, exactly three green bush crowns, left window and right clay door |

Each house has a small window on either side and one high back window, without duplicating the front door or its
arrangement. Chimneys have depth, clay faces and dark caps. The ground stroke becomes a shallow forest foundation.
The depth, back and side details are authored interpretations because the references only show the front.

## Geometry and colour

All houses face **+z**, stand on **y = 0**, and have their full geometry bounds centred on x and z.
All use **350 reference pixels per unit**, with no individual rescaling. Heights stay within 0.8–1.2 units.
The generator measures the complete model, including eaves, chimney, bushes and projecting awning, before centring.

Each GLB is one self-contained binary glTF 2.0 with one baked mesh, indexed triangles, float positions and flat
normals. There are no textures, images, external URIs, extensions, animations or Misfit-only anchors.
Forest `#173D32`, house green `#73B98C`, roof green `#3A6D51`, butter `#F3CA66` and clay `#DA795B` come from the
brand book. The cottage gable `#569B70` and foliage `#6BA361` approximate the corresponding picture fills.
The exporter converts these sRGB colours to linear `baseColorFactor` values. Every material is opaque,
`metallicFactor: 0`, `roughnessFactor: 0.9`.

The target is fewer than 2,000 triangles; the hard limits are **4,000 triangles and 256 KiB per file**.
The delivered set is 928–1,848 triangles and 46,048–104,620 bytes per file. `manifest.json` records variant,
name, filename, byte count, triangle count and SHA-256 for all twelve.

The software rasterizer reads the exported GLB bytes, uses a z-buffer and backface culling, flat normals,
ambient illumination plus one directional light, and 2× supersampling. Both orthographic cameras share a
340 pixels/unit scale and target `[0, 0.5, 0]`. Their directions from the target toward the camera are
`[0, 0, 1]` and `[-0.55, 0.28, 0.8]`. The background is cream `#FFF7E6`.
The dome's forest outline includes an inverted outer shell; its curved lower rim is geometry too.

These are faceted, flat-colour interpretations. They do not reproduce raster grain, soft brush edges, subtle
colour drift or the original curved ground strokes. Lighting in another glTF viewer will affect the colours.
The fixed cameras preserve street scale, so the different reference crops do not align pixel for pixel.

The [original ticket evidence](../../../../docs/evidence/SH-RENT-FREE-3D.md) records the library's visual corrections
and checks. The parent README now lists this library and the active unique edition separately. The library tests
continue to verify all twelve base models; the unique suite checks all 500 generated houses and their samples.
