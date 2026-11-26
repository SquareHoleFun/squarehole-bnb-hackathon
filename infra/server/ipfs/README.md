# Public example art on IPFS

SH-EX-L2 prepares public files locally. It does not upload, start Kubo or send chain transactions.
Use Node 24.22.1 and the installed workspace dependencies, from the repository root:

```sh
node --experimental-transform-types --no-warnings=ExperimentalWarning \
  infra/server/ipfs/export-examples.mjs .cache/example-public-art
```

The destination must be new. Interrupted output is retained; retry with a new destination.
The exporter calls the existing kit builders serially and exports:

- Ten individual raw-block CARs under `test-junk/`, one per distinct picture in the Junk catalog.
- One `pictures.car` for each of the eleven open kits, including the five open collections (Link Marines in both
  versions) and both shops.
- `pins.json`: the deduplicated image inventory, relative local paths, expected lengths, SHA-256s and raw CIDs.

The ticket asks for “12 Junk pictures”; this base has ten distinct Junk pictures, five collections
with two each. All ten are exported. Bent Cans ids 1–12 reuse its two pictures; ids 13/14
are separate tester stock. See [the mint plan](../../../examples/boxes/one-collection-shop/mint-plan.json).

Frog Kiln and Paper Certificates are excluded by the open-kit allowlist. No hidden art, private plan,
seed or reveal file is read. Never import an entire working directory or private hidden-art export.

These are the existing builders' exact bytes; no image is re-encoded by this exporter. Every CAR
block is a root so `--pin-roots=true` retains it. The kit CARs also contain their public inventory,
proofs/traits and starter data. Metadata returned by the NFT contracts is embedded on chain;
the byte checker only requests the raster images the gateway can serve. It does not request JSON.

The builders also emit setup files with unresolved bindings. They are **not a release-ready deployment
bundle**. Link Marines launches as version 2 (F151): the export includes its kit `link-marines-v2` beside the archival
version 1 kit; compare its final image hashes with this inventory before publishing.
If another lane changes committed picture bytes, regenerate the export and repeat the checks.

## Import and check after integration

The operator performs this on a local Kubo, outside the network-disabled lane. Set `SH_ART` to the
reviewed export directory, verify its inventory, and import only its listed public CARs:

```sh
SH_ART=.cache/example-public-art
(
  set -e
  for SH_CAR in "$SH_ART"/test-junk/*.car "$SH_ART"/*/pictures.car; do
    ipfs dag import --pin-roots=true "$SH_CAR"
  done
  node scripts/ipfs/check-gateway.mjs "$SH_ART/pins.json" http://127.0.0.1:8080
)
```

Require every import to succeed and the checker to exit 0. For the server stack, import through
`docker compose -f infra/server/compose.yaml exec -T kubo ipfs dag import --pin-roots=true < "$SH_CAR"`
instead. Its Kubo ports are not published; check the same inventory through the configured public
HTTPS image origin (for example, `https://images.example.org`, replaced with the actual origin).
Do not expose Kubo's administrative API to run a probe.

The checker preflights all records, requires a canonical raw CID derived from each SHA-256, then
checks every image length and digest. It accepts loopback HTTP or HTTPS, refuses redirects and
credentials in the URL, bounds reads to 1 MiB and times out each request after ten seconds. It prints
no upstream error bodies. An unavailable or mismatched image fails the command; there is no upload
or fallback to a different provider. Restart Kubo and repeat the check to verify persistent pins.

## Offline verification

```sh
node --experimental-transform-types --no-warnings=ExperimentalWarning --test \
  scripts/ipfs/public-examples.test.mjs
```

The tests parse all CAR frames independently, check every block digest and root, compare the Junk
catalog and mint plan, and run the gateway verifier with in-memory responses. That proves local
bytes and failure handling; it is not evidence of a running Kubo or a reachable public gateway.
