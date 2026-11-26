# Test files that fail in this copy, and why

Measured on 27 November 2026 with `SH_TEST_TIMEOUT=60000 VITEST_MAX_WORKERS=10 pnpm test` in a fresh copy (Node
24.22.1, pnpm 10.29.1): 922 test files, 65 failed. 59 are listed here; the other six measure pictures that the copy
holds as grey placeholders and are listed in `hackathon/public/not-tested.md`.

## They read material that is not in this repository

The platform's internal notes and reference folders (`docs/`, the specification folders, research) stay private.
These test files read fixtures, runbooks or records from them, or a git branch of the platform's own repository,
and failed for that reason alone before the event began (the two marked "not in the copy" are left out of the
public copy, so 44 of these 46 run there):

- `packages/box-spec/src/conformance-m3.test.ts`
- `packages/box-spec/src/conformance.test.ts` (not in the copy)
- `packages/box-spec/src/conformance-v2.test.ts`
- `packages/box-spec/src/deployment-identities.test.ts`
- `packages/box-spec/src/f126-evidence.test.ts`
- `packages/box-spec/src/mainnet-runbook.test.ts` (not in the copy)
- `packages/box-spec/src/sepolia-open-at.test.ts`
- `packages/box-spec/src/sepolia-runbook-box0-candidate.test.ts`
- `packages/box-spec/src/sepolia-runbook-glamsterdam.test.ts`
- `packages/box-spec/src/sepolia-runbook.test.ts`
- `packages/box-spec/src/v1-freeze.test.ts`
- `packages/chain/src/core/v2/cq11-ownership.test.ts`
- `packages/chain/test/buy-v2.test.ts`
- `packages/chain/test/sepolia-listing-batch.test.ts`
- `packages/design/src/art/demo-avatars.test.ts`
- `packages/design/src/art/manifest.test.ts`
- `packages/design/src/art/misfits-art.test.ts`
- `packages/design/src/tokens.test.ts`
- `packages/domain/src/asset-registry.test.ts`
- `packages/domain/src/claims.test.ts`
- `packages/domain/src/core/intent-differential.test.ts`
- `packages/domain/src/core/manifest.test.ts`
- `packages/domain/src/core/metrics.test.ts`
- `packages/domain/src/core/policy.test.ts`
- `packages/domain/src/cursor.test.ts`
- `packages/domain/src/feed-golden.test.ts`
- `packages/domain/src/feed-reference.test.ts`
- `packages/domain/src/feed.test.ts`
- `packages/domain/src/launch-draft.test.ts`
- `packages/domain/src/pair-detail.test.ts`
- `packages/domain/src/schema-differential.test.ts`
- `packages/domain/src/schemas.test.ts`
- `packages/domain/src/vault-empty-policy.oracle.test.ts`
- `packages/domain/src/vault-examples.test.ts`
- `packages/domain/src/vault-oracle.differential.test.ts`
- `packages/domain/src/vault-trace.oracle.test.ts`
- `packages/domain/src/vault-trace.test.ts`
- `packages/indexer/test/core/sepolia-readonly/box0-art.test.ts`
- `packages/indexer/test/core/sepolia-readonly/sepolia-readonly.test.ts`
- `packages/keeper/test/jobs.test.ts`
- `packages/keeper/test/review-b3-fix.test.ts`
- `packages/providers/src/fixtures-m23.test.ts`
- `packages/providers/src/fixtures.test.ts`
- `apps/web/src/features/create/plan-guide.test.ts`
- `apps/web/src/features/examples/explainer-files.test.ts`
- `apps/web/src/features/legal/terms-production.test.ts`

## They need the full contract build

These compare generated ABIs and events with the compiled release contracts in `packages/contracts/out/`, which
only the full contract build writes (level 4, about 36 minutes). After that build they pass:

- `packages/chain/src/core/v2/abi-v2.test.ts`
- `packages/chain/src/core/v2/cq11-generated.test.ts`
- `packages/chain/src/core/v2/final/events.test.ts`
- `packages/chain/src/core/v2/final/round2/first-round.test.ts`
- `packages/chain/src/core/v2/final/round2/local-stack.test.ts`
- `packages/chain/src/core/v2/m2-63/coordinator-forward-double.test.ts`
- `packages/chain/src/core/v2/m2-events.test.ts`
- `packages/chain/src/core/v2/m3-events.test.ts`
- `packages/chain/src/core/v2/views-abi-v2.test.ts`
- `packages/indexer/test/final-oc/events.test.ts`
- `packages/indexer/test/final-round2/combined-events.test.ts`
- `packages/indexer/test/final-round2/fix-properties.test.ts`
- `packages/indexer/test/m2-63/agreement.test.ts`
- `packages/indexer/test/m3-63/agreement.test.ts`

`packages/chain/src/abi/abi-drift.test.ts` also reads `packages/contracts/out/Pool.sol/Pool.default.json`, an
artifact of a separate compiler profile that the default build does not write.
