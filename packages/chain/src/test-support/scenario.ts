/**
 * A small scripted deployment on the fake chain, laid out like the finalized local manifest (FIT: fungible, R = Q,
 * quote WETH; The Misfits: DN404 collection, R = T, converter). The numbers are chosen so every identity the providers
 * check holds (Transfer replay = totalSupply, Σ eligible balances = eligibleSupply, burns = supply delta).
 */
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from 'viem';
import {
  dn404MirrorAbi,
  feeCollectorAbi,
  poolManagerAbi,
  rewardLedgerAbi,
  squareHoleClaimConverterAbi,
  squareHoleHookAbi,
  squareHoleRegistryAbi,
  squareHoleTokenAbi,
  stateViewAbi,
  v4QuoterAbi,
} from '../abi';
import { SEPOLIA_UNISWAP_V4 } from '../config/chains';
import { parseDeploymentManifest, type DeploymentManifest, type ManifestLaunch } from '../config/manifest';
import { poolStateSlot } from '../reads/reader';
import { FakeChain } from './fake-chain';
import { localManifestJson, syntheticSepoliaManifestJson } from './fixtures';

export const ALICE: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const BOB: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
export const HARNESS: Address = '0x00000000000000000000000000000000000a7e55';
export const LOCAL_QUOTER: Address = '0x0000000000000000000000000000000000004444';
export const LOCAL_STATE_VIEW: Address = '0x0000000000000000000000000000000000005555';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const E18 = 10n ** 18n;

export function eventLog(abi: Abi, eventName: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const item = abi.find((entry): entry is AbiEvent => entry.type === 'event' && entry.name === eventName);
  if (!item) throw new Error(`no event ${eventName}`);
  const topics = encodeEventTopics({ abi: [item], eventName, args } as Parameters<typeof encodeEventTopics>[0]) as Hex[];
  const inputs = item.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(inputs, inputs.map((input) => args[input.name as string]));
  return { topics, data };
}

export function recordOf(manifest: DeploymentManifest, launch: ManifestLaunch) {
  return {
    chainId: BigInt(manifest.chainId),
    pairId: launch.pairId,
    kind: launch.kind === 'collection' ? 1 : 0,
    token: launch.contracts.token.address,
    mirror: launch.contracts.mirror.address,
    ledger: launch.contracts.rewardLedger.address,
    collector: launch.contracts.feeCollector.address,
    hook: manifest.contracts.hook.address,
    poolId: launch.poolId,
    quote: launch.quote,
    rewardSide: launch.rewardSide === 'T' ? 1 : 0,
    converter: launch.converter,
    fractionsPerNft: BigInt(launch.fractionsPerNft),
    units: BigInt(launch.units),
    initialSupply: BigInt(launch.initialSupply),
    templateVersion: launch.templateVersion,
    startFdvQ: BigInt(launch.startFdvQ),
    minStartUnitValueQ: BigInt(launch.minStartUnitValueQ),
    tickSpacing: launch.tickSpacing,
    tickLower: launch.tickLower,
    tickUpper: launch.tickUpper,
    liquidity: BigInt(launch.liquidity),
    sqrtPriceX96: BigInt(launch.sqrtPriceX96),
    metadataManifestHash: launch.metadataManifestHash,
    creator: launch.creator,
    createdAtBlock: BigInt(launch.createdAtBlock),
  };
}

export interface ScenarioState {
  names: Record<string, { name: string; symbol: string }>;
  soldOut: boolean;
  quoteReverts: boolean;
  quoteOut: bigint;
  misfitsClaimable: Record<string, bigint>;
}

export interface Scenario {
  readonly chain: FakeChain;
  readonly manifestJson: Record<string, unknown>;
  readonly manifest: DeploymentManifest;
  readonly fit: ManifestLaunch;
  readonly misfits: ManifestLaunch;
  readonly state: ScenarioState;
}

function packSlot0(sqrtPriceX96: bigint, tick: number, lpFee: number): Hex {
  const tickBits = BigInt(tick < 0 ? tick + 0x1000000 : tick);
  const word = sqrtPriceX96 | (tickBits << 160n) | (BigInt(lpFee) << 208n);
  return `0x${word.toString(16).padStart(64, '0')}`;
}

export function buildScenario(options: { sepolia?: boolean } = {}): Scenario {
  const sepolia = options.sepolia === true;
  const manifestJson = sepolia ? syntheticSepoliaManifestJson() : localManifestJson();
  const manifest = parseDeploymentManifest(manifestJson);
  const fit = manifest.launches.FIT as ManifestLaunch;
  const misfits = manifest.launches.THE_MISFITS as ManifestLaunch;
  const chain = new FakeChain(40n);
  chain.chainId = manifest.chainId;
  const stateViewAddress = sepolia ? SEPOLIA_UNISWAP_V4.stateView : LOCAL_STATE_VIEW;
  const quoterAddress = sepolia ? SEPOLIA_UNISWAP_V4.v4Quoter : LOCAL_QUOTER;
  const state: ScenarioState = {
    names: {
      [fit.contracts.token.address.toLowerCase()]: { name: fit.name, symbol: fit.symbol },
      [misfits.contracts.token.address.toLowerCase()]: { name: misfits.name, symbol: misfits.symbol },
    },
    soldOut: false,
    quoteReverts: false,
    quoteOut: 400_000n * E18,
    misfitsClaimable: { [ALICE.toLowerCase()]: 5n * 10n ** 14n },
  };
  const pm = manifest.contracts.poolManager.address;
  const registry = manifest.contracts.registry.address;
  const converter = manifest.contracts.claimConverter?.address as Address;
  const hook = manifest.contracts.hook.address;
  const weth = fit.quote;
  const fitToken = fit.contracts.token.address;
  const misToken = misfits.contracts.token.address;
  const records = [recordOf(manifest, fit), recordOf(manifest, misfits)];

  // --- logs --------------------------------------------------------------------------------------------------------
  const transfer = (token: Address, from: Address, to: Address, amount: bigint, block: bigint) =>
    chain.addLog({ address: token, blockNumber: block, ...eventLog(squareHoleTokenAbi as Abi, 'Transfer', { from, to, amount }) });
  const initial = 10n ** 27n;
  for (const [launch, record] of [
    [fit, records[0]],
    [misfits, records[1]],
  ] as const) {
    const block = BigInt(launch.createdAtBlock);
    transfer(launch.contracts.token.address, ZERO, hook, initial, block);
    transfer(launch.contracts.token.address, hook, pm, initial, block);
    chain.addLog({
      address: registry,
      blockNumber: block,
      ...eventLog(squareHoleRegistryAbi as Abi, 'PairCreated', { pairId: launch.pairId, token: launch.contracts.token.address, quote: launch.quote, record }),
    });
  }
  const swap = (poolId: Hex, sender: Address, amount0: bigint, amount1: bigint, block: bigint) =>
    chain.addLog({
      address: pm,
      blockNumber: block,
      ...eventLog(poolManagerAbi as Abi, 'Swap', { id: poolId, sender, amount0, amount1, sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0, fee: 30_000 }),
    });
  // FIT (T = currency0): alice buys 5,000,000 FIT for 0.2 WETH; 1,000 FIT fee is later taken and burned.
  swap(fit.poolId, HARNESS, 5_000_000n * E18, -(2n * 10n ** 17n), 20n);
  transfer(fitToken, pm, ALICE, 5_000_000n * E18, 20n);
  transfer(fitToken, pm, fit.contracts.feeCollector.address, 1_000n * E18, 22n);
  transfer(fitToken, fit.contracts.feeCollector.address, ZERO, 1_000n * E18, 22n);
  chain.addLog({ address: fit.contracts.feeCollector.address, blockNumber: 22n, ...eventLog(feeCollectorAbi as Abi, 'FeeTBurned', { amount: 1_000n * E18, totalBurned: 1_000n * E18 }) });
  chain.addLog({ address: fit.contracts.rewardLedger.address, blockNumber: 30n, ...eventLog(rewardLedgerAbi as Abi, 'Claimed', { account: ALICE, recipient: ALICE, amount: 2n * 10n ** 15n }) });
  // The Misfits (T = currency0): alice buys 3 whole NFTs, then converts 1e14 Q into 90,000 T (a protocol swap).
  swap(misfits.poolId, HARNESS, 3_000_000n * E18, -(31n * 10n ** 14n), 25n);
  transfer(misToken, pm, ALICE, 3_000_000n * E18, 25n);
  const conversionTx = `0x${'c0'.repeat(32)}` as Hex;
  chain.addLog({ address: misfits.contracts.rewardLedger.address, blockNumber: 28n, txHash: conversionTx, logIndex: 0, ...eventLog(rewardLedgerAbi as Abi, 'Claimed', { account: ALICE, recipient: converter, amount: 10n ** 14n }) });
  chain.addLog({ address: pm, blockNumber: 28n, txHash: conversionTx, logIndex: 1, ...eventLog(poolManagerAbi as Abi, 'Swap', { id: misfits.poolId, sender: converter, amount0: 90_000n * E18, amount1: -(10n ** 14n), sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0, fee: 30_000 }) });
  chain.addLog({ address: misToken, blockNumber: 28n, txHash: conversionTx, logIndex: 2, ...eventLog(squareHoleTokenAbi as Abi, 'Transfer', { from: pm, to: ALICE, amount: 90_000n * E18 }) });
  chain.addLog({ address: converter, blockNumber: 28n, txHash: conversionTx, logIndex: 3, ...eventLog(squareHoleClaimConverterAbi as Abi, 'ClaimConverted', { token: misToken, holder: ALICE, qIn: 10n ** 14n, tOut: 90_000n * E18 }) });
  // Sepolia snapshots read the 'safe' block (head − 32 on the fake): keep every scripted log below it.
  chain.head = sepolia ? 80n : 40n;

  // --- contracts ---------------------------------------------------------------------------------------------------
  const zeroRecord = { ...records[0], token: ZERO, pairId: `0x${'00'.repeat(32)}` as Hex };
  chain.contract(registry, squareHoleRegistryAbi as Abi, {
    pairCount: (_args, block) => BigInt(records.filter((record) => record.createdAtBlock <= block).length),
    pairIds: ([begin, end], block) => records.filter((record) => record.createdAtBlock <= block).slice(Number(begin), Number(end)).map((record) => record.pairId),
    pair: ([id]) => records.find((record) => record.pairId === id) ?? zeroRecord,
    pairOfToken: ([token], block) => records.find((record) => record.token.toLowerCase() === String(token).toLowerCase() && record.createdAtBlock <= block) ?? zeroRecord,
    templateCount: () => 1,
    template: () => ({ quote: weth, startFdvQ: E18, minStartUnitValueQ: 10n ** 14n, tickSpacing: 60, rangeTicks: 69_060, shape: 1, active: true, addedAtBlock: 12n }),
    maxCollectionUnits: () => 10_000n,
    latestTemplateFor: ([quote]) => (String(quote).toLowerCase() === weth.toLowerCase() ? 1 : 0),
  });
  const tokenHandlers = (token: Address, supply: bigint, balances: Record<string, bigint>) => ({
    name: () => state.names[token.toLowerCase()]?.name ?? '',
    symbol: () => state.names[token.toLowerCase()]?.symbol ?? '',
    totalSupply: () => supply,
    balanceOf: ([account]: readonly unknown[]) => balances[String(account).toLowerCase()] ?? 0n,
    ownedIds: ([account, begin, end]: readonly unknown[]) => (String(account).toLowerCase() === ALICE.toLowerCase() ? [1n, 2n, 3n].slice(Number(begin), Number(end)) : []),
    baseURI: () => '',
  });
  chain.contract(fitToken, squareHoleTokenAbi as Abi, tokenHandlers(fitToken, initial - 1_000n * E18, { [ALICE.toLowerCase()]: 5_000_000n * E18 }));
  chain.contract(misToken, squareHoleTokenAbi as Abi, tokenHandlers(misToken, initial, { [ALICE.toLowerCase()]: 3_090_000n * E18 }));
  chain.contract(misfits.contracts.mirror.address, dn404MirrorAbi as Abi, {
    totalSupply: () => 3n,
    balanceOf: ([account]) => (String(account).toLowerCase() === ALICE.toLowerCase() ? 3n : 0n),
  });
  const excluded = (launch: ManifestLaunch) => [
    launch.contracts.rewardLedger.address,
    launch.contracts.token.address,
    launch.contracts.mirror.address,
    launch.contracts.feeCollector.address,
    manifest.treasury,
    launch.converter,
    manifest.contracts.launcher.address,
    pm,
    hook,
  ];
  chain.contract(fit.contracts.rewardLedger.address, rewardLedgerAbi as Abi, {
    eligibleSupply: () => 5_000_000n * E18,
    totalHolderQReceived: () => 4n * 10n ** 15n,
    totalHolderQIndexed: () => 4n * 10n ** 15n,
    totalClaimed: () => 2n * 10n ** 15n,
    bootstrapQ: () => 0n,
    excludedAccounts: () => excluded(fit),
    claimable: ([account]) => (String(account).toLowerCase() === ALICE.toLowerCase() ? 10n ** 15n : 0n),
    isExcluded: () => false,
  });
  chain.contract(misfits.contracts.rewardLedger.address, rewardLedgerAbi as Abi, {
    eligibleSupply: () => 3_090_000n * E18,
    totalHolderQReceived: () => 10n ** 15n,
    totalHolderQIndexed: () => 10n ** 15n,
    totalClaimed: () => 10n ** 14n,
    bootstrapQ: () => 0n,
    excludedAccounts: () => excluded(misfits),
    claimable: ([account]) => state.misfitsClaimable[String(account).toLowerCase()] ?? 0n,
    isExcluded: () => false,
  });
  for (const [launch, burned] of [
    [fit, 1_000n * E18],
    [misfits, 0n],
  ] as const) {
    chain.contract(launch.contracts.feeCollector.address, feeCollectorAbi as Abi, {
      totalTReceived: () => burned,
      totalTBurned: () => burned,
      pendingBurnT: () => 0n,
      totalQReceived: () => 6n * 10n ** 15n,
      totalQProtocol: () => 2n * 10n ** 15n,
      totalQHolders: () => 4n * 10n ** 15n,
    });
  }
  chain.contract(hook, squareHoleHookAbi as Abi, { LP_FEE: () => 30_000 });
  const slots = new Map<string, Hex>();
  for (const launch of [fit, misfits]) {
    const slot = poolStateSlot(launch.poolId);
    slots.set(slot.toLowerCase(), packSlot0(BigInt(launch.sqrtPriceX96), launch.tickLower, 30_000));
    slots.set(`0x${(BigInt(slot) + 3n).toString(16).padStart(64, '0')}`, `0x${BigInt(launch.liquidity).toString(16).padStart(64, '0')}`);
  }
  chain.contract(pm, poolManagerAbi as Abi, { extsload: ([slot]) => slots.get(String(slot).toLowerCase()) ?? `0x${'00'.repeat(32)}` });
  chain.contract(stateViewAddress, stateViewAbi as Abi, {
    getSlot0: ([poolId]) => {
      const launch = [fit, misfits].find((candidate) => candidate.poolId === poolId);
      return [BigInt(launch?.sqrtPriceX96 ?? 0), launch?.tickLower ?? 0, 0, 30_000];
    },
    getLiquidity: ([poolId]) => BigInt([fit, misfits].find((candidate) => candidate.poolId === poolId)?.liquidity ?? 0),
  });
  chain.contract(weth, erc20Abi as Abi, { symbol: () => 'WETH', decimals: () => 18 });
  chain.contract(converter, squareHoleClaimConverterAbi as Abi, { isSoldOut: () => state.soldOut });
  chain.contract(quoterAddress, v4QuoterAbi as Abi, {
    quoteExactInputSingle: () => {
      if (state.quoteReverts) throw Object.assign(new Error('execution reverted: NotEnoughLiquidity'), { code: 3, data: '0x' });
      return [state.quoteOut, 100_000n];
    },
  });
  return { chain, manifestJson, manifest, fit, misfits, state };
}
