# Mainnet box 0 spec

**For the founder's final edition use `scripts/box/lib/edition-spec.mjs`** ([mainnet launch step 4](../../../../docs/runbooks/mainnet-launch.md#4-pick-the-time-and-write-the-mainnet-spec--founder-picks-claude-checks)).
It takes N from the sealed edition commitment (F129) and writes outside every Git worktree; copy the checked public
file here as `box0-spec.1.json`, where `DeployCoreV1` may read it. The writer described below is the older one:
it accepts only N = 4,269 at depth 13 and checks no edition digest.

No `box0-spec.1.json` exists yet. Readiness plan step 7 supplies the generator; the founder supplies the sealed
commitment and launch choices later. Run from the repository root with Node 24.22.1:

```sh
node packages/box-spec/scripts/write-mainnet-box0-spec.mjs \
  --commitment <box0-commitment.public.json> \
  --table <trait-table.json> \
  --inputs <launch-inputs.json>
```

The default output is `packages/contracts/script/config/box0-spec.1.json`. `--out <new-spec.json>` selects another
file. Its directory must exist and the file must not exist; an earlier spec is never overwritten. The command reads
public JSON only, uses no keys or network, and prints no input values or paths. Exit 0 means written; exit 1 means
refused. It performs no deployment. Do not use a secret record/archive file as an input.

## Inputs and checks

The commitment is `squarehole.box0-commitment/1`, as the exporter on `sh-box0-commitment-exporter` writes it.
It supplies `root`, `n` (4269), `depth` (13), `metadataTable.{hash,bytes,valueOrderHash}`, `generatorHash`,
`generatorTree`, `renderGeneratorTree`, `encoding` and `archive.escrowIntent`. The public file carries table hashes
and length, not the table bytes. Supply the exporter's separate public `squarehole.box-trait-table/1` file, with
`table` as hex, `types` as `{name,list}` entries and optional `description`. The generator cross-checks its exact
bytes, hash, length, lists and value order. Finalize the neutral description before export; a later description
change requires an updated public commitment matching the archived table.

The launch inputs file has these fields (no sample values are release inputs):

| Field | Input or default |
|---|---|
| `generatorHash` | Required bytes32. R31A stays a founder choice: a sealed tree id left-aligned in bytes32, or explicitly zero. Must match the export. |
| `openAt` | Required UTC time with `Z`, or Unix seconds as a decimal string/integer. R31B/F80: inclusively 45 minutes to 14 days after the generator's clock; zero is refused. |
| `safe` | Required nonzero Ethereum address; becomes `marketplaceOwner` and `platform`. Set the deployment's platform Safe to the same address. |
| `logoSha256` | Required nonzero bytes32 digest of the selected PNG (F115). The old fixture SVG digest is refused. |
| `encoding` | Optional full expected encoding object; defaults below. Must agree with the export. |
| `escrowIntent` | Defaults to `trustees-2-of-3` (F115); alternatives `zama-plus-floor` or `floor-only` require an explicit input matching the export. |

Default expected encoding (F115/MF-9/MF-10):

```json
{
  "image": { "format": "webp", "size": 512, "quality": 90 },
  "avatar": { "format": "webp", "size": 256 },
  "model": { "format": "glb" }
}
```

Image and avatar format, size and quality are parameters. Formats may be `webp`, `png` or `jpeg`; omitting quality
leaves that quality unconstrained (the exporter does this for the avatar by default). Supply quality to pin it.
An explicit `avatar: null` requires an export without avatars. Defaults require an image and avatar in every record;
the exporter checks their per-id hashes before producing this public file. This tool cannot reconstruct private
leaves from the public summary. Model format remains GLB.

Both the generator and DeployCoreV1's chain-1 guard reject zero roots, all six exported `KNOWN_TEST_ROOTS`, all
four known fixture/test generators, a zero Safe, and the four test tables. These pins include the exporter fix1
vectors (commit `c81400c8`). Table checking ignores the description,
so changing its copy cannot hide test trait values. A zero committed generatorHash is allowed only as an explicit
input with a matching zero export and null generatorTree; its renderGeneratorTree must still be nonzero and not a
known fixture. A nonzero generator must match both the committed and rendering tree ids.

The generated file has chainId 1, build `mainnet`, an ABI-encoded BoxSpecV1 and its canonical specHash. The generator
validates it with the existing BoxSpecV1 library, retaining box 0's edition size, raise, layouts, streams, specials,
royalties, cover and banner. Raw economic amounts stay bigint internally and decimal strings in JSON.

## Remaining launch work

R31A/R31B, the actual Safe, sealed root/table and PNG digest remain inputs. Legal/curation, full review, trustee
delivery and hosting decisions stay with F115 and the readiness plan; this tool does not infer their completion.
`archive.escrowIntent` is an intent, not proof of a split, delivery or recovery. The exporter's parallel fixes and
trustee recovery must be reviewed before a real ceremony. Unknown public fields are omitted from the output.
Exporter fix1 currently refuses trustee exports until verified recovery exists; a synthetic public-input test here
does not establish that the founder's selected trustee ceremony can run.

The generator's clock check is not a chain-time attestation. DeployCoreV1 retains its existing run-time opening
check (15-minute minimum, maximum 14 days), chain/build/platform checks and broadcast approval gate. Compare the
generated hash with the mainnet dry run before deployment; verify the Safe, committed art bytes and archive recovery
separately. No production inputs, secrets, actual mainnet spec, fork run or broadcast are part of this ticket.
