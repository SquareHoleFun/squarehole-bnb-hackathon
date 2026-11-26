/**
 * TEST ONLY (SH-TA-12): a scripted chain for the COMMITTED Sepolia manifest (packages/contracts/deployments/core-v1/
 * 11155111.json): core v1's box 0 at its deployed identities and core v2's release with an empty registry and the
 * native listing 0, so the indexer's own pipeline and gateway source produce the answers the test app reads (the web
 * e2e serves them; no test calls the live API or a Sepolia RPC).
 *
 * What is real and what is scripted:
 * - Real, from the repository's records of the chain: the manifest; box 0's row (registry, box id 0, template, the
 *   deployed spec bytes of the rehearsal Safe file, whose hash the registry holds; every role address, the pool id,
 *   creation block, openAt, raise, creator, Q and randomness from docs/evidence/SH-SEPOLIA-CORE-V1-DEPLOY/
 *   crosscheck.tsv, read from the chain); the DrandSource runtime the manifest pins; the native listing (id 0, its
 *   raise and bootstrap from the reviewed v2 plan); the block numbers, amounts and times the life record states
 *   (docs/evidence/SH-SEPOLIA-CORE-V1-LIFE.md: the bootstrap, F1's 0.003 and F3's 0.24 SepETH buys, the fill,
 *   F2's placeholder, graduation at block 11,966,812 with its pool share, dust and reward, items 69 and 3183, G5's
 *   0.055 SepETH round trip, the G7 deepens and buy-and-burns at their blocks, and T's supply at block 11,968,166).
 * - Scripted: block hashes and the times between the anchors the record gives; the clones' code (EIP-1167 runtimes of
 *   the manifest's implementations, so the row's code hashes are this chain's, not Sepolia's: the real runtimes are
 *   not in the repository); every amount the record does not state, computed with the layout library and v4's swap
 *   math (box-spec layout.ts, src/v4-math.ts); the wallets other than the keeper. The buy-and-burns are sized so T's
 *   supply at block 11,968,166 is the chain's read ([IN] § 3); nothing happens after it up to the manifest's evidence
 *   block, the head.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxCurve, boxGraduated, decodeBoxSpecV1, ISSUANCE } from '@squarehole/box-spec';
import { boxRowFromRecord, ROLE_NAMES, rolesRequired, type BoxRow, type RegistryRecord, type RoleName } from '@squarehole/chain';
import { backedSourceAbi, boxCollectionAbi, boxCoordinatorAbi, boxHookAbi, boxItemStreamAbi, boxLaunchRouterAbi, boxReceiverAbi, boxTicketsAbi, boxTokenAbi, boxVaultAbi, drandSourceAbi, fitBuybackExecutorAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { labelAddress, labelHash, registryLogs } from '@squarehole/chain/core/test-support';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, type Abi, type Address, type Hex } from 'viem';
import { parseCoreManifestV2, type DeployedCoreManifestV2 } from '../../../../chain/src/core/v2';
import { listingRegistryV2Abi } from '../../../../chain/src/core/v2/abi-v2';
import { LAUNCH_TAX_TABLE_PIPS } from '../../../src/shape';
import { computeSwapStepExactIn, getAmount0Delta, getSqrtPriceAtTick, mulDivRoundingUp, tickAtSqrtPrice, Q96 } from '../../../src/v4-math';
import type { RawLog } from '../../../src/events';
import type { BlockHeader } from '../../../src/model';
import { event, type PendingLog } from '../core-synth';
import { ScriptedCoreChain } from '../scripted-core-chain';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
export const SEPOLIA_MANIFEST_FILE = join(REPO, 'packages/contracts/deployments/core-v1/11155111.json');
const CROSSCHECK = join(REPO, 'docs/evidence/SH-SEPOLIA-CORE-V1-DEPLOY/crosscheck.tsv');
const SPEC_FILE = join(REPO, 'packages/contracts/script/config/box0-spec.11155111.rehearsal.sepolia-safe.json');
const DRAND_RUNTIME = join(REPO, 'packages/indexer/test/fixtures/f143-drand-runtime.json');
const PLAN = join(REPO, 'docs/evidence/SH-SEPOLIA-CORE-V2-DEPLOY/reviewed-plan.json');

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const FEE_PIPS = 10_000n;

// ------------------------------------------------------------------------------------------------ box 0's row

/** The deploy record's chain reads, by their check name (crosscheck.tsv: check, expected, read, verdict). */
function crosscheck(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(CROSSCHECK, 'utf8').split('\n')) {
    const [check, , read, verdict] = line.split('\t');
    if (check && read && verdict === 'ok') out.set(check, read);
  }
  return out;
}

function need(map: ReadonlyMap<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) throw new Error(`crosscheck.tsv has no ok row "${key}"`);
  return value;
}

/** The clone runtimes the indexer checks (BoxClones.isCloneOf / isReceivingCloneOf), with a few argument bytes. */
const CLONE_IMPL: Partial<Record<RoleName, string>> = { coordinator: 'coordinator', hook: 'hook', launchRouter: 'launchRouter', receiver: 'receiver', collection: 'collection', vault: 'vault', tickets: 'tickets', itemStream: 'itemStream', royaltyRouter: 'royaltyRouter' };
function runtimeOf(role: RoleName, implementations: Readonly<Record<string, { readonly address: Address }>>, args: string): Hex {
  const key = CLONE_IMPL[role];
  if (key === undefined) return `0x6001600255${args}` as Hex;
  const impl = (implementations[key]?.address ?? '').slice(2).toLowerCase();
  if (role === 'royaltyRouter') return `0x36600557005b363d3d373d3d3d363d73${impl}5af43d82803e903d91603157fd5bf3${args}` as Hex;
  return `0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3${args}` as Hex;
}

export interface SepoliaBox0 {
  readonly manifest: DeployedCoreManifestV2;
  readonly row: BoxRow;
  readonly record: RegistryRecord;
  readonly encodedSpec: Hex;
  readonly codes: ReadonlyMap<string, Hex>;
}

export function sepoliaBox0(): SepoliaBox0 {
  const manifest = parseCoreManifestV2(JSON.parse(readFileSync(SEPOLIA_MANIFEST_FILE, 'utf8')) as unknown);
  const version = manifest.versions[0];
  if (!version) throw new Error('the Sepolia manifest has no core v1 version');
  const reads = crosscheck();
  const specFile = JSON.parse(readFileSync(SPEC_FILE, 'utf8')) as { specHash: Hex; encoded: Hex };
  const encodedSpec = specFile.encoded;
  const spec = decodeBoxSpecV1(encodedSpec);
  const required = rolesRequired(spec);
  const roleAddress = (role: RoleName): Address => {
    if (required[role] !== true) return ZERO;
    const key = role === 'hook' ? 'box0.hook: registry.recordOf(0)' : `box0.${role}: runbook = registry.recordOf(0)`;
    return getAddress(need(reads, key));
  };
  const contracts = ROLE_NAMES.map(roleAddress);
  const codes = new Map<string, Hex>();
  const codeHashes = contracts.map((address, i) => {
    if (address === ZERO) return `0x${'0'.repeat(64)}` as Hex;
    const code = runtimeOf(ROLE_NAMES[i] as RoleName, version.implementations as never, address.slice(2, 18).toLowerCase());
    codes.set(address.toLowerCase(), code);
    return keccak256(code);
  });
  const drand = JSON.parse(readFileSync(DRAND_RUNTIME, 'utf8')) as { runtime: Hex };
  codes.set('0xbeece13fbdd67d0a696cb7cfd28103ed37ba79a6', drand.runtime);
  const templateId = version.supportedTemplates[0];
  if (!templateId) throw new Error('the Sepolia manifest supports no template');
  const record: RegistryRecord = {
    boxId: 0n,
    templateId,
    specHash: specFile.specHash,
    creator: getAddress(need(reads, 'registry.recordOf(0).creator')),
    q: getAddress(need(reads, 'registry.recordOf(0).q (native ETH)')),
    raise: BigInt(need(reads, 'registry.recordOf(0).raise (rehearsal build, F78)')),
    poolManager: manifest.chain.poolManager.address,
    poolId: need(reads, 'hook.poolId() = registry.recordOf(0).poolId') as Hex,
    creationBlock: BigInt(need(reads, 'registry.recordOf(0).creationBlock')),
    openAt: BigInt(need(reads, 'registry.recordOf(0).openAt')),
    randomness: getAddress(need(reads, 'registry.recordOf(0).randomness')),
    contracts,
    codeHashes,
  };
  const registry = version.registry.address;
  const row = boxRowFromRecord(record, encodedSpec, { chainId: manifest.chainId, registry, box0Registry: registry });
  return { manifest, row, record, encodedSpec, codes };
}

// ------------------------------------------------------------------------------------------------ the blocks

/** Block numbers of the life record (SH-SEPOLIA-CORE-V1-LIFE.md); the unrecorded ones are placed between them. */
export const BLOCKS = Object.freeze({
  creation: 11_960_339n,
  f1WindowBuy: 11_960_943n,
  f3Buy: 11_966_783n,
  f4Fill: 11_966_790n,
  f2Placeholder: 11_966_800n,
  graduation: 11_966_812n,
  rewardClaimed: 11_966_813n,
  g1Sweep: 11_966_820n,
  g2WordPosted: 11_966_825n,
  g2WordStored: 11_966_826n,
  g3Open: 11_966_830n,
  g4Draw: 11_966_835n,
  g4RoundPosted: 11_966_840n,
  g4Settled: 11_966_841n,
  g4Open: 11_966_845n,
  g5Buy: 11_966_850n,
  g5Sell: 11_966_852n,
  g5Batch: 11_966_855n,
  g6Claims: 11_966_860n,
  g6Gift: 11_966_861n,
  g7FirstDeepen: 11_967_112n,
  g7SecondDeepen: 11_967_461n,
  g7Skipped: 11_967_762n,
  supplyRead: 11_968_166n,
  v2ListingRegistry: 11_973_610n,
});
/** The 13 buy-and-burns of G7 (every 25 blocks from 11,967,137 to 11,967,412, then 11,967,737). */
export const BUY_AND_BURN_BLOCKS: readonly bigint[] = Object.freeze([...Array.from({ length: 12 }, (_, i) => 11_967_137n + 25n * BigInt(i)), 11_967_737n]);

/** Block times through the record's anchors (Unix seconds), linear between them; Sepolia misses slots, so not 12 s. */
const TIME_ANCHORS: readonly (readonly [bigint, bigint])[] = [
  [BLOCKS.creation, 1_792_560_492n], // 2026-10-21 05:28:12 UTC, the deploy's last transaction
  [BLOCKS.f1WindowBuy, 1_792_567_812n], // in box 0's window (07:30:00 to 07:36:24 UTC): step 1
  [BLOCKS.graduation, 1_792_639_032n], // graduatedAt, 2026-10-22 03:17:12 UTC
  [BLOCKS.v2ListingRegistry, 1_792_721_424n], // 2026-10-23 02:10:24 UTC
];
export function timeOf(n: bigint): bigint {
  const anchors = TIME_ANCHORS;
  let i = 0;
  while (i < anchors.length - 2 && n > (anchors[i + 1] as readonly [bigint, bigint])[0]) i += 1;
  const [b0, t0] = anchors[i] as readonly [bigint, bigint];
  const [b1, t1] = anchors[i + 1] as readonly [bigint, bigint];
  return t0 + ((n - b0) * (t1 - t0)) / (b1 - b0);
}

// ------------------------------------------------------------------------------------------------ the pool

/** Box 0's pool between swaps: price, tick and the liquidity at it. */
interface PoolState {
  sqrt: bigint;
  tick: number;
  liquidity: bigint;
}

/** An exact-input buy of T with `qIn` (ETH, currency0: zeroForOne) on one range; the fee is the pool's 1%. */
function buyExactIn(pool: PoolState, qIn: bigint, floor: bigint) {
  const step = computeSwapStepExactIn(pool.sqrt, floor, pool.liquidity, qIn, FEE_PIPS);
  return { qPaid: step.amountIn + step.feeAmount, tOut: step.amountOut, sqrt: step.sqrtPriceNextX96 };
}

/** The buy that moves the price to exactly `target` (the curve's fill): input with its fee. */
function buyTo(pool: PoolState, target: bigint) {
  const amountIn = getAmount0Delta(target, pool.sqrt, pool.liquidity, true);
  const gross = amountIn + mulDivRoundingUp(amountIn, FEE_PIPS, 1_000_000n - FEE_PIPS);
  const step = computeSwapStepExactIn(pool.sqrt, target, pool.liquidity, gross, FEE_PIPS);
  return { qPaid: gross, tOut: step.amountOut, sqrt: step.sqrtPriceNextX96 };
}

/** An exact-input sale of `tIn` T (oneForZero) on one range. */
function sellExactIn(pool: PoolState, tIn: bigint, ceiling: bigint) {
  const step = computeSwapStepExactIn(pool.sqrt, ceiling, pool.liquidity, tIn, FEE_PIPS);
  return { tPaid: step.amountIn + step.feeAmount, qOut: step.amountOut, sqrt: step.sqrtPriceNextX96 };
}

/** A buy of exactly `tOut` T (the executor's buy-and-burn), single range: the price after and the ETH in with its fee. */
function buyExactOut(pool: PoolState, tOut: bigint) {
  // token1 out at a falling price: sqrtNext = sqrt - tOut * Q96 / L, rounded down (SqrtPriceMath, rounding against).
  const next = pool.sqrt - (tOut * Q96 + pool.liquidity - 1n) / pool.liquidity;
  const amountIn = getAmount0Delta(next, pool.sqrt, pool.liquidity, true);
  return { qPaid: amountIn + mulDivRoundingUp(amountIn, FEE_PIPS, 1_000_000n - FEE_PIPS), sqrt: next };
}

// ------------------------------------------------------------------------------------------------ the world

export interface SepoliaWorld extends SepoliaBox0 {
  readonly headers: readonly BlockHeader[];
  readonly logs: readonly RawLog[];
  readonly head: bigint;
  readonly chain: ScriptedCoreChain;
  /** Figures the test checks against the life record. */
  readonly figures: { readonly f3TokensOut: bigint; readonly f1TokensOut: bigint; readonly poolShare: bigint; readonly dust: bigint; readonly supplyAtRead: bigint; readonly askLiquidity: bigint };
}

/** T's supply the chain reported at block 11,968,166 ([IN] § 3: FIT's totalSupply()). */
export const SUPPLY_AT_READ = 997_439_299_560_795_772_371_946_919n;

export function sepoliaWorld(): SepoliaWorld {
  const box = sepoliaBox0();
  const { manifest, row } = box;
  const c = row.contracts as Record<RoleName, Address | null>;
  const at = (role: RoleName): Address => {
    const address = c[role];
    if (!address) throw new Error(`box 0 has no ${role}`);
    return address;
  };
  const token = at('token');
  const pm = manifest.chain.poolManager.address;
  const keeper = row.creator;
  const wallet1 = labelAddress('sepolia-readonly:wallet-1');
  const router = labelAddress('sepolia-readonly:swap-router');
  const backed = manifest.chain.randomness.address;
  const drand = getAddress('0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6');
  const poolId = row.poolId;
  const spec = row.spec;
  const n = BigInt(spec.n);

  const headers: BlockHeader[] = [];
  const logs: RawLog[] = [];
  let tx = 0;
  const hashOf = (b: bigint): Hex => labelHash(`sepolia-readonly:block:${b}`);
  const blocks = new Map<bigint, PendingLog[][]>();
  const add = (b: bigint, ...groups: PendingLog[][]) => blocks.set(b, [...(blocks.get(b) ?? []), ...groups]);

  const ev = (abi: unknown, address: Address, name: string, args: Record<string, unknown>) => {
    const item = (abi as readonly { type: string; name?: string; inputs?: readonly { name: string }[] }[]).find((x) => x.type === 'event' && x.name === name);
    const missing = (item?.inputs ?? []).map((input) => input.name).filter((key) => !(key in args));
    if (!item || missing.length > 0) throw new Error(`event ${name}: ${item ? `missing ${missing.join(', ')}` : 'not in the ABI'}`);
    return event(abi as Abi, address, name, args);
  };
  const transfer = (from: Address, to: Address, amount: bigint) => ev(boxTokenAbi, token, 'Transfer', { from, to, amount });
  const swap = (pool: PoolState, sender: Address, amount0: bigint, amount1: bigint) =>
    ev(poolManagerAbi, pm, 'Swap', { id: poolId, sender, amount0, amount1, sqrtPriceX96: pool.sqrt, liquidity: pool.liquidity, tick: pool.tick, fee: Number(FEE_PIPS) });
  const modify = (sender: Address, tickLower: number, tickUpper: number, liquidityDelta: bigint) =>
    ev(poolManagerAbi, pm, 'ModifyLiquidity', { id: poolId, sender, tickLower, tickUpper, liquidityDelta, salt: `0x${'0'.repeat(64)}` });

  // The curve (layout library, the record's raise) and the pool at its start.
  const curve = boxCurve(row.raise, row.tIsCurrency0);
  const pool: PoolState = { sqrt: curve.sqrtPriceStartX96, tick: curve.tickStart, liquidity: curve.liquidity };
  const move = (sqrt: bigint) => {
    pool.sqrt = sqrt;
    pool.tick = tickAtSqrtPrice(sqrt);
  };
  let supply = 0n;
  const burn = (from: Address, amount: bigint) => {
    supply -= amount;
    return transfer(from, ZERO, amount);
  };

  // Creation (block 11,960,339): T minted to the coordinator, the edition into the vault, the pool and its curve, the
  // bootstrap buy (0.00015 SepETH: the rehearsal's bootstrap) burned, the registry's row.
  supply = ISSUANCE;
  const bootstrap = buyExactIn(pool, 150_000_000_000_000n, curve.sqrtPriceEndX96);
  const creation: PendingLog[] = [
    transfer(ZERO, at('coordinator'), ISSUANCE),
    ev(boxCollectionAbi, at('collection'), 'ConsecutiveTransfer', { fromTokenId: 1n, toTokenId: n, fromAddress: ZERO, toAddress: at('vault') }),
    ev(poolManagerAbi, pm, 'Initialize', { id: poolId, currency0: ZERO, currency1: token, fee: Number(FEE_PIPS), tickSpacing: 60, hooks: at('hook'), sqrtPriceX96: curve.sqrtPriceStartX96, tick: curve.tickStart }),
    modify(at('hook'), curve.tickLower, curve.tickUpper, curve.liquidity),
    transfer(at('coordinator'), pm, curve.curveT),
    ev(boxHookAbi, at('hook'), 'PoolLaunched', { poolId, tickLower: curve.tickLower, tickUpper: curve.tickUpper, liquidity: curve.liquidity, sqrtPriceX96: curve.sqrtPriceStartX96, tokenDeposited: curve.curveT }),
  ];
  move(bootstrap.sqrt);
  creation.push(
    swap(pool, at('launchRouter'), -bootstrap.qPaid, bootstrap.tOut),
    transfer(pm, at('coordinator'), bootstrap.tOut),
    ev(boxLaunchRouterAbi, at('launchRouter'), 'Bootstrapped', { recipient: at('coordinator'), qIn: bootstrap.qPaid, tokensOut: bootstrap.tOut }),
    burn(at('coordinator'), bootstrap.tOut),
    ev(boxCoordinatorAbi, at('coordinator'), 'BoxLaunched', { boxId: 0n, openAt: row.openAt, bootstrapTokensBurned: bootstrap.tOut, creatorBuyQ: 0n, creatorBuyTokens: 0n }),
  );
  const [created, specLog] = registryLogs({ spec: row.spec, record: box.record, encodedSpec: box.encodedSpec }, { registry: row.registry, blockNumber: 0n, blockHash: labelHash('x') });
  creation.push({ address: created.address, topics: [...created.topics], data: created.data }, { address: specLog.address, topics: [...specLog.topics], data: specLog.data });
  add(BLOCKS.creation, creation);

  // F1: wallet 1's taxed buy of 0.003 SepETH through the launch router, in the window (its step's tax first).
  const step = Number((timeOf(BLOCKS.f1WindowBuy) - row.openAt) / 12n);
  const qIn = 3_000_000_000_000_000n;
  const tax = (qIn * BigInt(LAUNCH_TAX_TABLE_PIPS[step] ?? 0) + 999_999n) / 1_000_000n;
  const f1 = buyExactIn(pool, qIn - tax, curve.sqrtPriceEndX96);
  move(f1.sqrt);
  add(BLOCKS.f1WindowBuy, [swap(pool, at('launchRouter'), -f1.qPaid, f1.tOut), transfer(pm, wallet1, f1.tOut), ev(boxLaunchRouterAbi, at('launchRouter'), 'TaxedBuy', { buyer: wallet1, recipient: wallet1, step: BigInt(step), qIn, tax, tokensOut: f1.tOut, refund: 0n })]);

  // F3: 0.24 SepETH after the window; F4: the buy that fills the curve, and its close.
  const f3 = buyExactIn(pool, 240_000_000_000_000_000n, curve.sqrtPriceEndX96);
  move(f3.sqrt);
  add(BLOCKS.f3Buy, [swap(pool, router, -f3.qPaid, f3.tOut), transfer(pm, wallet1, f3.tOut)]);
  const f4 = buyTo(pool, curve.sqrtPriceEndX96);
  move(f4.sqrt);
  add(BLOCKS.f4Fill, [swap(pool, router, -f4.qPaid, f4.tOut), ev(boxHookAbi, at('hook'), 'CurveClosed', { poolId, blockNumber: BLOCKS.f4Fill, sqrtPriceX96: pool.sqrt }), transfer(pm, wallet1, f4.tOut)]);

  // F2: one placeholder for 236,334 T (the vault's quote with its 1% fee, the fee burned).
  const principal = 233_994_120_036_028_158_665_116n;
  const placeFee = principal / 100n;
  const placeLogs = [
    ev(boxTicketsAbi, at('tickets'), 'Transfer', { from: ZERO, to: wallet1, tokenId: 1n }),
    ev(boxTicketsAbi, at('tickets'), 'PlaceholdersTaken', { taker: wallet1, firstTokenId: 1n, count: 1n, principal, fee: placeFee, firstSlot: 0n }),
    transfer(wallet1, at('tickets'), principal + placeFee),
  ];
  placeLogs.push(
    ev(boxVaultAbi, at('vault'), 'TicketsOpened', { count: 1n, principal, fee: placeFee, supplyAfter: supply - placeFee, escrowAfter: principal, insideAfter: n - 1n, hiddenAfter: n - 1n, ticketsAfter: 1n }),
    transfer(at('tickets'), at('vault'), principal + placeFee),
    burn(at('vault'), placeFee),
  );
  add(BLOCKS.f2Placeholder, placeLogs);

  // Graduation (block 11,966,812): the curve out, the graduated layout in at P1, the pool share (less its dust) into
  // the pool, the dust burned, the vault's gate open, the graduation word asked, the per-item stream started.
  const poolShare = ISSUANCE - curve.curveT;
  const layout = boxGraduated(curve, spec.gradLayout, row.raise, poolShare);
  const dust = poolShare - layout.ask.amount;
  const reward = 420_698_008_500_000n;
  const wordRound = 33_278_560n;
  const grad: PendingLog[] = [
    modify(at('hook'), curve.tickLower, curve.tickUpper, -curve.liquidity),
    modify(at('hook'), layout.bid.tickLower, layout.bid.tickUpper, layout.bid.liquidity),
    modify(at('hook'), layout.sentinel.tickLower, layout.sentinel.tickUpper, layout.sentinel.liquidity),
    modify(at('hook'), layout.ask.tickLower, layout.ask.tickUpper, layout.ask.liquidity),
    transfer(at('coordinator'), pm, layout.ask.amount),
    ev(boxHookAbi, at('hook'), 'Migrated', { poolId, qFromCurve: row.raise, tFromCurve: 0n, askLiquidity: layout.ask.liquidity, bidLiquidity: layout.bid.liquidity, sentinelLiquidity: layout.sentinel.liquidity, tokenPulled: layout.ask.amount, qDust: layout.qDust }),
    burn(at('coordinator'), dust),
    ev(boxVaultAbi, at('vault'), 'GateOpened', { coordinator: at('coordinator'), timestamp: timeOf(BLOCKS.graduation) }),
    ev(boxCoordinatorAbi, at('coordinator'), 'Graduated', { caller: keeper, blockNumber: BLOCKS.graduation, poolShare, tokenDustBurned: dust, reward }),
    ev(backedSourceAbi, backed, 'Requested', { consumer: at('tickets'), key: 0n, round: wordRound, bounty: 0n }),
    ev(boxTicketsAbi, at('tickets'), 'GraduationWordRequested', { requester: at('coordinator'), round: wordRound, bounty: 0n }),
    ev(boxItemStreamAbi, at('itemStream'), 'Started', { value: 0n }),
  ];
  pool.liquidity = layout.bid.liquidity;
  add(BLOCKS.graduation, grad);
  add(BLOCKS.rewardClaimed, [ev(boxCoordinatorAbi, at('coordinator'), 'RewardClaimed', { caller: keeper, to: keeper, amount: reward })]);
  add(BLOCKS.g1Sweep, [ev(boxLaunchRouterAbi, at('launchRouter'), 'Swept', { to: at('hook'), amount: tax, toDepth: true })]);

  // G2-G4: the word, placeholder 1 into item 69, a draw (ticket 1) into item 3183.
  const word = labelHash('sepolia-readonly:graduation-word');
  add(BLOCKS.g2WordPosted, [ev(drandSourceAbi, drand, 'RoundPosted', { round: wordRound, poster: keeper, randomness: labelHash('sepolia-readonly:round:word'), bounty: 0n })]);
  add(BLOCKS.g2WordStored, [ev(boxTicketsAbi, at('tickets'), 'GraduationWordStored', { word, placeholders: 1n, readyAt: timeOf(BLOCKS.g2WordStored) })]);
  const outsideSince = timeOf(BLOCKS.graduation);
  add(BLOCKS.g3Open, [
    ev(boxTicketsAbi, at('tickets'), 'Transfer', { from: wallet1, to: ZERO, tokenId: 1n }),
    ev(boxVaultAbi, at('vault'), 'TicketDelivered', { id: 69n, to: wallet1, ticketsAfter: 0n }),
    ev(boxCollectionAbi, at('collection'), 'Transfer', { from: at('vault'), to: wallet1, tokenId: 69n }),
    ev(boxTicketsAbi, at('tickets'), 'Opened', { tokenOrTicket: 1n, itemId: 69n, holder: wallet1, kind: 1, revealed: false, outsideSince }),
  ]);
  const drawRound = 33_278_700n;
  add(BLOCKS.g4Draw, [
    transfer(wallet1, at('tickets'), principal + placeFee),
    ev(boxVaultAbi, at('vault'), 'TicketsOpened', { count: 1n, principal, fee: placeFee, supplyAfter: supply - placeFee, escrowAfter: principal, insideAfter: n - 2n, hiddenAfter: n - 2n, ticketsAfter: 1n }),
    transfer(at('tickets'), at('vault'), principal + placeFee),
    burn(at('vault'), placeFee),
    ev(backedSourceAbi, backed, 'Requested', { consumer: at('tickets'), key: 1n, round: drawRound, bounty: 0n }),
    ev(boxTicketsAbi, at('tickets'), 'DrawRequested', { ticketId: 1n, drawer: wallet1, principal, fee: placeFee, round: drawRound, bounty: 0n }),
  ]);
  add(BLOCKS.g4RoundPosted, [ev(drandSourceAbi, drand, 'RoundPosted', { round: drawRound, poster: keeper, randomness: labelHash('sepolia-readonly:round:draw'), bounty: 0n })]);
  add(BLOCKS.g4Settled, [ev(boxTicketsAbi, at('tickets'), 'DrawSettled', { ticketId: 1n, itemId: 3183n, word: labelHash('sepolia-readonly:draw-word') })]);
  add(BLOCKS.g4Open, [
    ev(boxVaultAbi, at('vault'), 'TicketDelivered', { id: 3183n, to: wallet1, ticketsAfter: 0n }),
    ev(boxCollectionAbi, at('collection'), 'Transfer', { from: at('vault'), to: wallet1, tokenId: 3183n }),
    ev(boxTicketsAbi, at('tickets'), 'Opened', { tokenOrTicket: 1n, itemId: 3183n, holder: wallet1, kind: 2, revealed: false, outsideSince: timeOf(BLOCKS.g4Open) }),
  ]);

  // G5: a 0.055 SepETH buy in the graduated pool (below P1: the ask), the T sold back, the keeper's fee batch.
  pool.liquidity = layout.ask.liquidity;
  const minPrice = getSqrtPriceAtTick(layout.ask.tickLower);
  const maxPrice = getSqrtPriceAtTick(layout.bid.tickUpper);
  const g5 = buyExactIn(pool, 55_000_000_000_000_000n, minPrice);
  move(g5.sqrt);
  add(BLOCKS.g5Buy, [swap(pool, router, -g5.qPaid, g5.tOut), transfer(pm, wallet1, g5.tOut)]);
  const back = sellExactIn(pool, g5.tOut, maxPrice);
  move(back.sqrt);
  add(BLOCKS.g5Sell, [transfer(wallet1, pm, back.tPaid), swap(pool, router, back.qOut, -back.tPaid)]);
  // The batch: the pool's 1% fees of both trades; Q: 11/15 FIT, 2/15 the pool, 2/15 the platform (after the tip);
  // T: 13/15 to the per-item stream (its inside share burned), 2/15 to the pool.
  const qFees = g5.qPaid / 100n;
  const tFees = back.tPaid / 100n;
  const tip = 50_000_000_000_000n;
  const qSplit = qFees - tip;
  const qDepth = (qSplit * 2n) / 15n;
  const qPlatform = qDepth;
  const qFit = qSplit - qDepth - qPlatform;
  const tDepth = (tFees * 2n) / 15n;
  const tStream = tFees - tDepth;
  const perItem = tStream / n;
  const inside = tStream - perItem * 2n;
  const stream = at('itemStream');
  add(BLOCKS.g5Batch, [
    ev(boxHookAbi, at('hook'), 'Harvested', { poolId, qFees, tFees, qToReserve: 0n }),
    ev(boxReceiverAbi, at('receiver'), 'DepthFunded', { q: qDepth, t: tDepth }),
    ev(boxReceiverAbi, at('receiver'), 'PlatformCredited', { epoch: 0n, kept: qPlatform, toDepth: 0n, keptInEpoch: qPlatform }),
    ev(boxReceiverAbi, at('receiver'), 'Collected', { caller: keeper, tipTo: keeper, q: qFees, t: tFees, qToReserve: 0n, tip }),
    ev(boxReceiverAbi, at('receiver'), 'BatchSplit', { qReward: 0n, qFit, qDepth, qPlatform, tReward: 0n, tFit: 0n, tDepth, tBurned: 0n }),
    transfer(pm, stream, tStream),
    ev(boxItemStreamAbi, stream, 'Funded', { amount: tStream }),
    burn(stream, inside),
    ev(boxItemStreamAbi, stream, 'Burned', { amount: inside }),
    ev(boxReceiverAbi, at('receiver'), 'StreamFunded', { stream, amount: tStream }),
  ]);
  // G6: wallet 1 claims both items' shares, then gives item 3183 to the keeper.
  add(BLOCKS.g6Claims, [
    ev(boxItemStreamAbi, stream, 'Claimed', { account: wallet1, to: wallet1, amount: perItem * 2n }),
    transfer(stream, wallet1, perItem * 2n),
  ]);
  add(BLOCKS.g6Gift, [ev(boxCollectionAbi, at('collection'), 'Transfer', { from: wallet1, to: keeper, tokenId: 3183n })]);

  // G7: two deepen conversions (launch tax into T, the hook's own swaps, not volume), a skipped deepen, and the
  // executor's 13 buy-and-burns, sized so T's supply at block 11,968,166 is the chain's read.
  const converted = { q: 0n, t: 0n, tips: 0n };
  for (const [b, qUsed, deepenTip] of [[BLOCKS.g7FirstDeepen, 1_005_453_856_399_189n, 50_000_000_000_000n], [BLOCKS.g7SecondDeepen, 579_327_482_028_551n, 28_966_374_101_427n]] as const) {
    const before = pool.sqrt;
    const conv = buyExactIn(pool, qUsed, minPrice);
    move(conv.sqrt);
    converted.q += conv.qPaid;
    converted.t += conv.tOut;
    converted.tips += deepenTip;
    add(b, [
      swap(pool, at('hook'), -conv.qPaid, conv.tOut),
      ev(boxHookAbi, at('hook'), 'DepthConverted', { poolId, qIn: conv.qPaid, tOut: conv.tOut, referenceTick: pool.tick, sqrtPriceBeforeX96: before, sqrtPriceAfterX96: pool.sqrt, sqrtPriceLimitX96: minPrice }),
      ev(boxHookAbi, at('hook'), 'Deepened', { poolId, kind: 2, tickLower: 0, tickUpper: 0, liquidity: 0n, qUsed: conv.qPaid, tUsed: 0n, tip: deepenTip }),
    ]);
  }
  add(BLOCKS.g7Skipped, [ev(boxHookAbi, at('hook'), 'DeepenSkipped', { poolId, reason: 6 })]);
  // What the depth budget holds after them: the launch tax and the batch's pool share in Q, less what the
  // conversions spent and their tips; in T the batch's pool share and the conversions' T.
  const depthBudget = { q: tax + qDepth - converted.q - converted.tips, t: tDepth + converted.t };
  if (depthBudget.q < 0n) throw new Error('the scripted conversions spend more than the depth budget holds');
  const left = supply - SUPPLY_AT_READ;
  if (left <= 0n) throw new Error(`the scripted burns already reach ${supply}, below the chain's ${SUPPLY_AT_READ}`);
  const executor = at('executor');
  const chunk = left / BigInt(BUY_AND_BURN_BLOCKS.length);
  BUY_AND_BURN_BLOCKS.forEach((b, i) => {
    const bought = i === BUY_AND_BURN_BLOCKS.length - 1 ? left - chunk * BigInt(BUY_AND_BURN_BLOCKS.length - 1) : chunk;
    const buy = buyExactOut(pool, bought);
    move(buy.sqrt);
    add(b, [swap(pool, executor, -buy.qPaid, bought), transfer(pm, executor, bought), burn(executor, bought), ev(fitBuybackExecutorAbi, executor, 'TokensBurned', { bought, unsolicited: 0n })]);
  });
  if (supply !== SUPPLY_AT_READ) throw new Error(`scripted supply ${supply} is not the chain's ${SUPPLY_AT_READ}`);

  // Core v2: the listing registry's native listing 0, made with the registry (block 11,973,610); no v2 box.
  const release = manifest.releases[0];
  if (!release) throw new Error('the Sepolia manifest has no v2 release');
  const plan = JSON.parse(readFileSync(PLAN, 'utf8')) as { listings: Record<string, { raise: string; bootstrapQ: string; decimals: string; token: string }> };
  const native = plan.listings['0'];
  if (!native || native.token !== ZERO) throw new Error('the reviewed plan has no native listing 0');
  add(BLOCKS.v2ListingRegistry, [ev(listingRegistryV2Abi, release.listingRegistry.address, 'ListingAdded', { id: 0, token: ZERO, class: 1, kind: 1, raise: BigInt(native.raise) })]);

  // The headers: every block from the creation block to the manifest's evidence block (the head); logs in order.
  const head = BigInt(manifest.evidence.block.number);
  let parent = labelHash('sepolia-readonly:before-creation');
  for (let b = BLOCKS.creation; b <= head; b += 1n) {
    const header: BlockHeader = { number: b, hash: hashOf(b), parentHash: parent, timestamp: timeOf(b) };
    headers.push(header);
    parent = header.hash;
    let index = 0;
    for (const group of blocks.get(b) ?? []) {
      const transactionHash = labelHash(`sepolia-readonly:tx:${tx++}`);
      for (const log of group) logs.push({ ...log, blockNumber: b, blockHash: header.hash, transactionHash, transactionIndex: 0, logIndex: index++ });
    }
  }

  // Code answers: box 0's roles and the pinned DrandSource; the listing registry's `listing(0)` view at any block.
  const registryRow = { id: 0, token: ZERO, decimals: Number(native.decimals), class: 1, kind: 1, listedAt: timeOf(BLOCKS.v2ListingRegistry), raise: BigInt(native.raise), q: { bootstrapQ: BigInt(native.bootstrapQ), batchMinQ: 5_000_000_000_000_000n, tipMaxQ: 500_000_000_000_000n, swapStepMinQ: 5_000_000_000_000_000n } };
  const chain = new ScriptedCoreChain(
    manifest.chainId,
    headers,
    logs,
    (address) => box.codes.get(address.toLowerCase()),
    (to, data) => {
      // The display views the indexer reads at the head (audit.ts displaySpecs): the hook's depth budget, the stream's index.
      if (to.toLowerCase() === at('hook').toLowerCase()) {
        try {
          if (decodeFunctionData({ abi: boxHookAbi as Abi, data }).functionName === 'depthBudget') return encodeFunctionResult({ abi: boxHookAbi as Abi, functionName: 'depthBudget', result: [depthBudget.q, depthBudget.t] } as never);
        } catch {
          return undefined;
        }
        return undefined;
      }
      if (to.toLowerCase() === stream.toLowerCase()) {
        try {
          if (decodeFunctionData({ abi: boxItemStreamAbi as Abi, data }).functionName === 'index') return encodeFunctionResult({ abi: boxItemStreamAbi as Abi, functionName: 'index', result: perItem } as never);
        } catch {
          return undefined;
        }
        return undefined;
      }
      if (to.toLowerCase() !== release.listingRegistry.address.toLowerCase()) return undefined;
      let call: { functionName: string; args?: readonly unknown[] };
      try {
        call = decodeFunctionData({ abi: listingRegistryV2Abi, data }) as never;
      } catch {
        return undefined;
      }
      if (call.functionName === 'listing' && call.args?.[0] === 0) return encodeFunctionResult({ abi: listingRegistryV2Abi, functionName: 'listing', result: registryRow } as never);
      return undefined;
    },
  );
  return { ...box, headers, logs, head, chain, figures: { f1TokensOut: f1.tOut, f3TokensOut: f3.tOut, poolShare, dust, supplyAtRead: supply, askLiquidity: layout.ask.liquidity } };
}

