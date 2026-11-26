# Files whose picture checks are not part of this copy's tests

Each file below carries the digest of a picture that this copy holds as a grey placeholder (or leaves out), so a
check that compares the file with the picture cannot pass in this copy.

- `apps/landing/scripts/art.sh`
- `apps/web/build/examples-manifest.json`
- `apps/web/e2e/fixtures/core-local/life.json`
- `apps/web/e2e/fixtures/sepolia-readonly/indexer-answers.json`
- `apps/web/e2e/sepolia-readonly/sepolia-fixture.ts`
- `apps/web/src/features/boxes/bundled-pictures.ts`
- `apps/web/src/share/share-data.test.ts`
- `packages/artwork/src/fit-picture.ts`
- `packages/artwork/src/fit-picture.bnb.ts`
- `packages/artwork/src/test-support/c2pa.ts`
- `packages/box-spec/fixtures/box-0-misfits.json`
- `packages/box-spec/src/generated/fixtures.v1.ts`
- `packages/chain/scripts/local-art/catalog.json`
- `packages/contracts/script/config/box0-spec.11155111.json`
- `packages/contracts/script/config/box0-spec.11155111.rehearsal.json`
- `packages/contracts/script/config/box0-spec.11155111.rehearsal.sepolia-safe.json`
- `packages/contracts/script/config/box0-spec.11155111.safe.json`
- `packages/contracts/script/local/CoreV2Local.t.sol`
- `packages/contracts/script/local/CoreV2LocalGenesisArt.t.sol`
- `packages/contracts/script/local/LocalBoxArt.sol`
- `packages/contracts/test/box/audit/U9/`
- `packages/contracts/test/box/sepolia/SepoliaBox0Spec.t.sol`
- `packages/contracts/test/vectors/box-spec/box-spec-v1.json`
- `packages/design/art/fit/manifest.json`
- `packages/design/art/misfits/manifest.json`
- `packages/indexer/test/fixtures/core-local-life.json`

Tests that measure those pictures themselves (sizes, bytes, colours), so they fail on the grey placeholders:

- `packages/design/src/art/fit-icon.test.ts`
- `packages/artwork/src/c2pa.test.ts`
- `apps/web/src/features/boxes/bundled-pictures.test.tsx`
- `apps/web/src/features/create/art-files.test.ts`
- `apps/web/src/features/fit-pair/fit-format.test.ts`
- `apps/web/src/bnb-variants.test.ts`
