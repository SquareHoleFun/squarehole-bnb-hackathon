# The indexer startup gap in 731c9f144

Frozen from commit `731c9f1440ebea43712190a8299b3f727c846674` on 13 November 2026.
The test removes the `.txt` suffix in memory. It never reads the current production tree for this fixture.

The TypeScript files are an import-graph projection. Retained statements are byte-for-byte parent statements at their original line numbers. Other statements are blanked. The entry reaches core-config, then both the chain root and v2 barrels, then open-reveal-batches-v2 and its validator. The four absent artwork files remain available to the analyser but are not copied into the image.

The manifests and loader are exact parent files. The lockfile keeps the five copied importers byte-for-byte and omits other importers and registry snapshots. Unreached domain and box-spec source placeholders retain their COPY directories. The Dockerfile keeps the parent's FROM, WORKDIR, package COPY, install and CMD lines. Compose is reduced to the indexer build. Artwork leaf files keep the parent's import statements. Functions, unrelated branches and non-module assets are omitted: this is a static traversal fixture, not executable service code.
