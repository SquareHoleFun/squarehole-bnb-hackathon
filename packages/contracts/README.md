# @squarehole/contracts

Square Hole's contracts (SH-B1, SH-B2, SH-E): **not audited, not deployed to any public network.** Local Foundry tests by
default; opt-in fork tests read public RPCs at pinned blocks and never broadcast; the local end-to-end run deploys only
to a throwaway anvil chain.

| Contract | Role |
|---|---|
| `src/SquareHoleToken.sol` | T of a collection launch: DN404 ERC-20/ERC-721 pair, F10 supply rule (always exactly 1,000,000,000 tokens, 18 decimals; the creator picks N, one NFT = 1e27 / N raw, exact: 1e27 % N == 0, 1 ≤ N ≤ 1e9, the template bounds N further), tokenURI = immutable baseURI + id + ".json", reward checkpoints on every balance write, fee-collector-only burn of its own balance, no transfer fee, no owner |
| `src/SquareHoleFungibleToken.sol` | T of a plain token launch: minimal 18-decimal ERC-20, the same fixed supply (exactly 1e9 whole tokens), same checkpoint and burn semantics |
| `src/base/LaunchTokenCore.sol` | the part both templates share (fixed supply, wiring checks, checkpoint, burn) |
| `src/RewardLedger.sol` | historical Q rewards: cumulative index at the fee event, per-account settlement at pre-change balances, role-based immutable exclusions, deferred (bootstrap) bucket, same-transaction flash-borrow guard (fail-closed: a fee event with holder Q after a take of T in the same transaction reverts); holds holder Q as Uniswap v4 ERC-6909 claims; `claim` (R = Q) and `claimFor(account, maxAmount)` (R = T converter, partial) |
| `src/FeeCollector.sol` | authenticated fee receipts (ERC-6909 claims pulled from the hook); burns 100% of native fee T; splits realized Q 1:2 protocol : holders with a carried remainder |
| `src/SquareHoleHook.sol` | the Uniswap v4 hook of every Square Hole pool (A1: static 3% LP fee, flags `0x2A60`, no return deltas): owns the locked launch position, collects each swap's fees in `afterSwap` and delivers them as claims to the collector; blocks foreign initialize/liquidity/donate |
| `src/SquareHoleLauncher.sol`, `src/deployers/LaunchDeployers.sol` | one-transaction launch: ledger → collector → T at predicted addresses, pool initialized and whole supply seeded through the hook, pair recorded; collections bounded by the template (N ≤ startFdvQ / minStartUnitValueQ, EIP-7825 NFT cap); no first buy, no creator allocation or fee |
| `src/SquareHoleRegistry.sol` | admitted quote assets with immutable launch templates (start FDV, NFT unit-value floor, spacing, range; checked against v4's per-tick liquidity cap; add/retire-only admin) and append-only pair records (`PairCreated` with every identity) |
| `src/SquareHoleClaimConverter.sol` | R = T claim settlement: `claimAsT(pairId, minTOut, deadline)` converts the caller's whole entitlement, `claimAsT(token, maxQIn, minTOut, deadline)` all or a slice, → T through the canonical pool, min-out and deadline, atomic; emergency settlement in Q only while the pool's range is sold out (`claimAsQWhenSoldOut`) |
| `src/testnet/MockTetherUSD.sol` | TESTNETS ONLY: "Test Tether USD (Square Hole mock)", `USDT-TEST`, 6 decimals; mainnet USDT's quirks (no return values, approve-from-non-zero reverts, uint256 decimals, max allowance kept, owner pause / sender blacklist / fund destruction / capped fee) and a public capped faucet (10,000 per call, 1 h per address, 1e9 lifetime) |
| `src/libraries/LaunchMath.sol` | template + supply → start price, tick range and liquidity (both token orders) |
| `src/v2/MisfitsCollection.sol`, `src/v2/libraries/MisfitsEncoding.sol`, `src/v2/interfaces/IMisfits*.sol` | core v2 T08 candidate (evidence `docs/evidence/SH-V2-T08.md`, `SH-V2-T08b-model.md`): ERC-721 "The Misfits", exactly 10,000 ids owned by the immutable vault from the constructor (implicit ownership, one ERC-2309 event); commit-reveal over a fixed-depth, index-directed Merkle root with the id in each leaf (traits, picture, avatar, 3D model and salt, F29), permissionless reveal once per id after its trigger (left the vault and/or unlocked by the vault); tokenURI built on chain (`data:` JSON, `ipfs://` raw CIDv1 image and GLB `animation_url` from the committed sha256s, fixed placeholder); an immutable `generatorHash` in `contractURI` (the generator version that rebuilds each model); direct sends to the vault (unless the vault pulls a return), to itself, the escrow or FIT revert; optional transfer checkpoint; a read-only `owner()` and fixed `contractURI()` (F26 4); no mint, burn, admin, base URI, setter or upgrade; since the genesis task the transfer checkpoint is fail-safe (≤ 100,000 gas, a failure is skipped with an event) |
| `src/v2/MisfitsVault.sol` | core v2 T07 candidate lock/release vault, with the genesis task's rules (evidence `docs/evidence/SH-V2-genesis.md`): a phase gate closed until the immutable launch coordinator opens it once (F30 Q3); named withdrawals only of revealed shelf ids; hidden ids only through the immutable adapter hook (F30 Q4, pending) |
| `src/v2/FitPoolHook.sol`, `src/v2/FitFeeCollector.sol`, `src/v2/BuybackBurner.sol`, `src/v2/FitBuybackBurner.sol` | the native-ETH / FIT pool hook (the curve's completion latch and floor guard, the migration to layout b′, outside liquidity after graduation with a 32-block hold, fail-safe fee notification with the swapper), the fee collector (ETH side to the executor, the executor's own fees without a treasury share, FIT side burned), the abstract buy-and-burn engine and its deployable form with the reviewed bounds hard-coded; shared with the Sepolia rehearsal, so their public names are neutral (`token()`, `totalBurned()`, `TokensBurned`, `TokenTransferFailed`; F30 Q2, evidence `docs/evidence/SH-V2-neutral-names.md`) |
| `src/v2/genesis/*.sol`, `src/v2/RehearsalToken.sol` | the genesis (`MisfitsGenesis`: FIT, collection, vault, hook, pool with the curve that raises exactly 4.206980085 ETH (798,137,969.32 FIT, F40 L6), collector, launch router and the burned bootstrap buy in one transaction, verified on chain; `completeGenesis` then creates the placeholder contract and the executor; then the launch coordinator, whose `graduate()` runs the hook's migration to layout b′, `docs/evidence/SH-V2-graduation.md`), the launch-shape constants, the creation-code libraries (EIP-3860), and the route-only Sepolia rehearsal with the placeholder token "Rehearsal Token" / RHT. `GenesisBootstrapBuyer.sol` is no longer created by either genesis (kept until its deletion is approved) |
| `src/v2/LaunchTaxRouter.sol` | the router-window sniper tax (F33, research `docs/research/sniper-tax.md` option C; evidence `docs/evidence/SH-V2-sniper-tax.md`): for the 32 blocks after the announced open the hook's `beforeSwap` gate (flags 0x2AE0, static 1% fee kept) lets only this router buy; it keeps ceil(value × table[b] ÷ 10^6) (a hard-coded 32-entry table from the curve's k, 93.20% → 8.06%) and swaps the rest exact-in with min-out and deadline; `sweep()` sends the held tax to the immutable treasury; it also runs the genesis's untaxed bootstrap buy; admin-free, refuses outside the window. `script-py/launch_tax_table.py --check` recomputes the table |

| Script | Role |
|---|---|
| `script/Deploy.s.sol` + `script/config/<chainId>.json` (31337, 11155111) | the per-chain deployment: (local: PoolManager from the pinned source, WETH/USDC mocks), mock USDT on testnets, the system with the mined hook (an identical hook already at the planned address is adopted), templates (WETH, USDC, USDT-TEST), launch 1 The Misfits (DN404, symbol FIT, 10,000 NFTs × 100,000 FIT, WETH, R = Q, baseURI on squarehole-7ua.pages.dev), the FIT template, then launch 2 ORCHARD (DN404, ORCH, 1,000 NFTs, quote FIT, R = T) when `launches.ORCHARD.enabled` / `SH_LAUNCH_ORCHARD`; metadata manifest hash = keccak256 of the manifest file, which must equal the config's pinned `manifestHash` (the pin is keccak256 of the metadata lane's reviewed manifest and stands in while the file is missing, for simulations and the local chain only; a public-chain broadcast requires the file; the finalizer refuses a source that differs from the on-chain commitment). Writes only its plan: `deployments/pending/<chainId>.json` with `--broadcast`, `deployments/dry-run/<chainId>.json` without (both gitignored). Key only from `DEPLOYER_PRIVATE_KEY`; a broadcast needs `SH_GIT_COMMIT`/`SH_GIT_DIRTY` (clean tree off chain 31337); refuses chain 1 |
| `script/v2/RehearseRouteSepolia.s.sol` + `script/v2/GenesisPlanning.sol` | the route-only Sepolia rehearsal of the genesis (`docs/v2/sepolia-rehearsal.md`): refuses every chain but 11155111; a plain run is a dry run; `--broadcast` is refused unless `SH_REHEARSAL_BROADCAST_APPROVED=true` and the signer is the testnet deployer (or `SH_REHEARSAL_DEPLOYER`); plans the genesis address and mines the hook salt |
| `script/DeployCoreV1.s.sol` + `script/lib/CoreV1Deployment.sol` | core v1 (slice S7, evidence `docs/evidence/SH-S7-factory.md`; with S8's per-Misfit stream since `docs/evidence/SH-misfits-line.md`): the implementations (the coordinator's first, naming the factory at its predicted address; then every other naming it, `BoxItemStream`'s included), the planner, the pinned DrandSource through the canonical CREATE2 deployer if the chain has none, `BoxFactoryV1` with its registry, then box 0 with its per-item stream through `createBox` with a mined hook salt; the same steps the tests run. Chains 1 and 11155111 only; a plain run is a dry run; `--broadcast` is refused unless `SH_CORE_V1_BROADCAST_APPROVED=true`, the signer is `SH_CORE_V1_DEPLOYER` and the spec is not the fixture (`SH_CORE_V1_SPEC_FILE`), and every Sepolia run (dry runs too) in the hour before Glamsterdam or after it unless `SH_CORE_V1_GLAMSTERDAM_ACK=true`; a spec whose marketplaceOwner is not `SH_CORE_V1_PLATFORM_SAFE` is refused first; no key is read. Box 0's Sepolia spec: `script/config/box0-spec.11155111.json` (runbook `docs/runbooks/sepolia-core-v1.md`) |
| `scripts/core-v1-simulate.sh` | dry runs of `DeployCoreV1` without `--broadcast`: `local` (anvil on `SH_S7_ANVIL_PORT`, 8550-8559, chain id 1, mainnet's PoolManager and WETH9 runtime placed with `anvil_setCode`) or `sepolia [--sender] [--spec] [--platform]` (a fork inside forge over the keyless public RPC), or `sepolia-replay [--life]` (an anvil fork of Sepolia on 8550-8558: the dry run, its transactions replayed with the sender impersonated by `scripts/core-v1-replay.py`, then the post-deploy verifier `BoxCoreConformanceDeployedTest` before the open and after the window; with `--life`, box 0's life on the same fork by `scripts/core-v1-life.py` and the verifier again; `docs/evidence/SH-sepolia-prep.md`). `--rehearsal`: the rehearsal build (F78) and its spec file `script/config/box0-spec.11155111.rehearsal.json` (`docs/evidence/SH-rehearsal-build.md`) |
| `FOUNDRY_PROFILE=rehearsal` | F78's rehearsal build of core v1 for testnets: `sh-box-build/` points at `src/box/build/rehearsal/` (generated from `packages/box-spec/build-profiles.v1.json`), so the raise is 0.4206980085 ETH and BOOTSTRAP_ETH, FEE_BATCH_MIN_ETH, FEE_BATCH_TIP_MAX_ETH, SWAP_STEP_MIN_Q, DEPTH_CONVERT_MIN_Q, PLATFORM_CAP_WEI and the creator-fee cap's presets are 1/10; its factory, planner and implementations refuse chain id 1 (`BoxBuildGuard`). Output in `out-rehearsal/`; the default build is byte-identical to the build before the profiles (`scripts/bytecode-hashes.py`) |
| `scripts/sepolia-open-at.sh <UTC time>` | Step 0 of the Sepolia runbook (F80 (4); `docs/runbooks/sepolia-core-v1.md`): the founder picks box 0's opening time (UTC only, `2026-10-06T11:00Z`); refused under 45 minutes or over 14 days after Sepolia's latest block (nothing written then); writes the three Sepolia spec files with their generator (`packages/box-spec/src/sepolia-box0-spec.test.ts`), then runs Step 2's dry run (read-only) and prints the spec hash and the hook it predicts. Its time check is tested in `packages/box-spec/src/sepolia-open-at.test.ts`; `docs/evidence/SH-open-at-final.md`. `--deployed <registry>` (ours, after the founder's Step 4): reads box 0's openAt from the chain and writes the three files for it, kept only if one has the registry's spec hash, so the repository's files (the verifier, `pnpm verify`) hold the deployed time |
| `scripts/core-v1-life-run.sh` (+ `scripts/drand-round.py`, `script/SepoliaBox0Reveal.s.sol`) | BC-071's life run of box 0 rehearsed on an anvil fork of Sepolia (8550-8558; every sender impersonated, nothing sent to Sepolia; `--rehearsal` first: F78's rehearsal build with every SepETH size at 1/10, the build the runbook's Z0 chooses, which `--runbook` requires; one buying wallet, wallet 1, does every buy, the placeholder, the draw and the trades, F80): the deploy replayed, the post-deploy verifier before the open, after the window, after graduation and at the end, a taxed window buy and a placeholder, D1 on a snapshot, the fill through Uniswap's `PoolSwapTest` with P1 as the limit, `graduate()` (a limit below its follow-ups' budget refused, `GasTooLow`), the keeper steps, the graduation word and a draw on real quicknet rounds (`drand-round.py` fetches and decompresses one for `postRound`), reveals from the Sepolia test set (`SepoliaBox0Reveal.s.sol` prints the `ItemReveal` argument), a fee batch, stream claims, `deepen()`'s conversion, FIT's executor, then the post-deploy verifier; `--runbook` runs the runbook's own blocks as a paste into zsh reads them (Step 0 too: refused 20 minutes and 14 days and a minute ahead, then written with the rehearsal's lead; the gate one second before the open and the window's tax steps to the second, F80) (`SH_LIFE_RUNBOOK_SHELL=bash` for bash), `--check-runbook` only checks that every sh block of the runbook pastes into zsh (no `#` notes, no open quote) and that every `postRound` first waits for the chain to reach its round's time (a gas estimate at the latest block refuses it before, `RoundNotYet`; a fork cannot show it); runbook § After the deploy and § After graduation; `docs/evidence/SH-life-run-rehearsal.md`, `docs/evidence/SH-sepolia-base.md` |
| `script/WriteManifest.s.sol` | read-only finalizer, run after the broadcast: checks forge's broadcast record and the plan against the chain, then writes `deployments/<chainId>.json` (`status: deployed`; blocks from the receipts and the live registry) |
| `script/VerifyManifest.s.sol` | read-only re-check of a deployed manifest against the chain (code hashes, hook bits, wiring, templates, every `registry.pair` field) |
| `scripts/deploy-sepolia.sh` | Stage E wrapper (FOUNDER-RUN): provenance, simulation, mainnet-collision guard, typed confirmation, `--broadcast --slow`, finalize, verify; `--simulate-only` needs no key and sends nothing |
| `script/DeploySquareHole.s.sol` | the system only (Build A; shares `SquareHoleSystemDeployer` with `Deploy`) |
| `scripts/local-e2e.sh` + `script/LocalE2E.s.sol`, `script/LocalE2EReport.s.sol`, `script/harness/ExternalSwapHarness.sol` | the local end-to-end run on anvil (port `SH_E2E_PORT`, default 8546): deploy, finalize and verify the manifest, external-style trades through the harness (v4-periphery V4Router, local only) on The Misfits (WETH → FIT) and ORCHARD (FIT → ORCH), fees, burns, R = Q claims in WETH, R = T conversions in ORCH, a USDT-TEST pair, then a read-only reconciliation report (incl. tokenURI and treasury WETH/FIT/USDT-TEST) and per-transaction gas |
| `scripts/local-hook-squat.sh` | review-round-B regression on anvil (port 8548): a broadcast without provenance is refused; a third party pre-deploys the hook; the deployment adopts it; finalize and verify accept it |

Design and rationale: [ADR-0010](../../docs/decisions/0010-contracts-core-design.md),
[ADR-0011](../../docs/decisions/0011-v4-hook-launcher-converter.md). Pins: [DEPENDENCIES.md](DEPENDENCIES.md).
Evidence: [SH-B1](../../docs/evidence/SH-B1-contracts.md), [SH-B2](../../docs/evidence/SH-B2-contracts.md),
[SH-E](../../docs/evidence/SH-E-contracts.md) (F10 supply rule, tokenURI, the Sepolia deploy plan and budget).

## Commands
```sh
export PATH="$HOME/.foundry/bin:$PATH"
git submodule update --init packages/contracts/lib/dn404 packages/contracts/lib/forge-std \
  packages/contracts/lib/v4-core packages/contracts/lib/v4-periphery          # not --recursive
git -C packages/contracts/lib/v4-core submodule update --init lib/solmate      # PoolManager's Owned (tests only)
cd packages/contracts
forge build --sizes
forge test                                             # unit, fuzz, differential, invariants, v4 integration, gas
FOUNDRY_PROFILE=deep forge test --match-contract Invariants   # longer invariant campaigns
FOUNDRY_PROFILE=rehearsal forge test --match-path 'test/box/{rehearsal,conformance/core}/*'   # F78's rehearsal build
python3 scripts/bytecode-hashes.py out > hashes.json   # every src/ contract's bytecode hashes (--compare a.json b.json)
SH_INVARIANT_AGGREGATE=true forge test --match-contract '^InvariantsPayoutQ$' -vv   # coverage summed over runs
forge snapshot --isolate --match-contract GasTest      # .gas-snapshot + snapshots/*.json (GasTest and V4GasTest;
                                                       # rerun after forge test or forge coverage: both rewrite them)
python3 script-py/gen_vectors.py --check               # vectors still match the reference model
SH_FORK_SEPOLIA=true forge test --match-contract 'Sepolia.*ForkTest'   # canonical Sepolia v4, every Universal Router
SH_FORK_MAINNET=true forge test --match-contract 'Mainnet.*ForkTest'   # mainnet PoolManager provenance, 3 routers, USDT
./scripts/local-e2e.sh                                  # anvil on :8546, deploy + finalize + trades + claims + report
./scripts/local-hook-squat.sh                           # anvil on :8548, the hook-squatting regression
./scripts/deploy-sepolia.sh --simulate-only --sender 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE
                                                        # Sepolia SIMULATION only (the deployer's public address, no
                                                        # key): planned addresses + budget line (x1.0 / x1.3)
python3 script-py/mutation_smoke_b2.py                  # 20 planted faults in the Build B / round B code
python3 script-py/check_src_licences.py                 # every file src/ imports is MIT
python3 script-py/rehearsal_name_scan.py --openchain    # after forge build: no FIT/Misfit/Square/Stonk hint in the
                                                        # rehearsal's ABIs, bytecode or known selector/topic names
```
The same commands are `pnpm --filter @squarehole/contracts build|test|test:deep|snapshot|coverage|vectors:check|
test:fork:sepolia|test:fork:mainnet|e2e:local|e2e:hook-squat|deploy:sepolia:simulate|mutation|licences`; the read-only
`manifest:finalize` and `manifest:verify` take `--rpc-url <RPC>`. Fork RPCs default to
`https://sepolia.gateway.tenderly.co` (serves historical state; publicnode and 0xrpc.io do not) and
`https://eth.drpc.org`; override with `SEPOLIA_FORK_RPC_URL` / `MAINNET_FORK_RPC_URL`.

Deployment keys: `script/Deploy.s.sol` reads a key only from the environment variable `DEPLOYER_PRIVATE_KEY` at run
time and refuses `--broadcast` without it; nothing reads key files. The local run derives anvil's public default keys
from its well-known mnemonic. No agent broadcasts to a public network (Stage E is the founder's funded deployer).

Stage E (founder-run, Sepolia): `DEPLOYER_PRIVATE_KEY=… ./scripts/deploy-sepolia.sh` (see its header and ADR-0011 §10).
By hand, the same steps are
```sh
export SH_GIT_COMMIT=$(git rev-parse HEAD) SH_GIT_DIRTY=$([ -n "$(git status --porcelain)" ] && echo true || echo false)
DEPLOYER_PRIVATE_KEY=… forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --slow
forge script script/WriteManifest.s.sol --rpc-url $SEPOLIA_RPC_URL     # read-only: deployments/11155111.json
forge script script/VerifyManifest.s.sol --rpc-url $SEPOLIA_RPC_URL    # read-only re-check
```
`--slow` matters: the hook and launcher addresses are planned from the deployer's nonces. A broadcast that stops
partway writes no deployment manifest; resume the same sequence with `--resume --interactives 1`, never from scratch.

## Layout
```text
src/                    contracts (MIT) + base/ + deployers/ + interfaces/ + libraries/
test/                   unit (*.t.sol), PoolOutflowGuard.t.sol, Differential.t.sol (both templates), Gas.t.sol,
                        LaunchMath.t.sol, invariant/ (handler, invariants, sequences; both templates),
                        integration/ (real v4 PoolManager: V4Integration, V4QuotesAndConverter, V4LaunchSystem,
                        V4EdgeCases, V4Invariants, V4Gas, V4ClaimConverter, V4MockTether), fork/ (opt-in:
                        ForkTests, UniversalRouterForks), script/ (Deploy, DeploySquareHole, Finalize), testnet/
                        (MockTetherUSD), utils/ (fixtures, routers, mocks)
script/                 Deploy.s.sol, WriteManifest.s.sol, VerifyManifest.s.sol, DeploySquareHole.s.sol, LocalE2E*.s.sol,
                        DeployCoreV1.s.sol (core v1 and box 0, S7),
                        config/ (per-chain JSON; *.manifest.placeholder.json are test fixtures), lib/ (manifest writer and verifier,
                        CoreV1Deployment),
                        local/ (local-only mocks, E2E base), harness/
scripts/                local-e2e.sh, local-hook-squat.sh, deploy-sepolia.sh (founder-run), core-v1-simulate.sh (S7 dry runs), core-v1-life-run.sh (BC-071 rehearsal)
deployments/            <chainId>.json deployed manifests (local, dry-run and pending plans are gitignored)
test/vectors/           reference-model vectors (generated; read-only to tests)
script-py/              gen_vectors.py (imports square-hole-handoff/reference/fee_policy_model.py in place),
                        mutation_smoke_b2.py, check_src_licences.py, rehearsal_name_scan.py (placeholder check)
snapshots/              named gas snapshots (isolate mode)
lib/                    pinned submodules: dn404, forge-std, v4-core (+ nested solmate), v4-periphery
```

Transient storage in tests: Foundry clears it after every call made at depth 1 (between top-level test calls,
between invariant calls, and between a handler's own calls in a fuzzed campaign). A scenario that must share one
transaction's transient storage, such as take → fee event → settle, runs inside one call: `test/utils/SameTransaction.sol`
for the stand-in fee source, or one `StepRouter.run` (one PoolManager unlock) against the real PoolManager.

The Uniswap v4 PoolManager (BUSL-1.1) is compiled from the pinned source for local tests only, with upstream's
settings; test files deploy it from its artifact and never import it (see DEPENDENCIES.md "Test-time settings").
