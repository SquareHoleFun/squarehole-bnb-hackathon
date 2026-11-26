import { royaltyRouterV2Abi } from '../../chain/src/core/v2/abi-v2';
export { royaltyRouterV2Abi };
import { parseAbi, type Abi } from 'viem';
import { drandSourceAbi } from '../../chain/src/abi/drandSource';
import { boxTicketsAbi } from '../../chain/src/abi/boxTickets';
export { drandSourceAbi };
/** Both versions implement IBoxTickets for these calls; keep the generated shared ABI as the source. */
export const drandTicketsAbi = boxTicketsAbi.filter(i => i.type === 'function' &&
  ['vault', 'source', 'coordinator', 'status', 'phase', 'requestGraduationWord', 'acceptGraduationWord', 'settle'].includes(i.name));
export const drandVaultAbi = parseAbi(['function gateOpenedAt() view returns (uint256)', 'function failureWindowEnds() view returns (uint256)']);
import type { Candidate, JobName } from './types';
import { itemLedgerV2Abi, coordinatorV2Abi, hookV2Abi, receiverV2Abi, receiverPileV21Abi, receiverModulesV21Abi, receiverEatV21Abi, registryV2Abi, launchRouterV2Abi, listingRegistryV2Abi } from '../../chain/src/core/v2/abi-v2';
export { coordinatorV2Abi, hookV2Abi, receiverV2Abi, receiverPileV21Abi, receiverModulesV21Abi, receiverEatV21Abi, registryV2Abi, launchRouterV2Abi, listingRegistryV2Abi };


/** Box 0 call types are kept separate: collect/deepen selectors survived but their v2 outputs changed. */
export const boxRegistryAbi = registryV2Abi;
export const coordinatorAbi = coordinatorV2Abi;

/** Box 0's BoxBackedSource (F143): whether a round's RANDAO backup started (then a drand post is ignored there). */
export const backedSourceAbi = parseAbi([
  'function backupOf(uint256 round) view returns (uint64 startedAt, uint64 targetBlock, uint64 fixedAt, bytes32 mix)',
  'function startBackup(uint256 round, uint256 headerBlock, bytes header) returns (uint256 target)',
  'function fixBackup(uint256 round, bytes header) returns (bytes32 mix)',
  'event BackupStarted(uint256 indexed round, uint256 targetBlock, address indexed by)',
  'event BackupFixed(uint256 indexed round, uint256 targetBlock, bytes32 mix, address indexed by)',
  'error RoundAlreadyPosted(uint256 round)', 'error BackupTooEarly(uint256 round, uint256 at)',
  'error BackupTooLate(uint256 round, uint256 until)', 'error BackupAlreadyStarted(uint256 round)',
  'error BackupAlreadyFixed(uint256 round)', 'error NoBackup(uint256 round)',
  'error HeaderUnavailable(uint256 blockNumber)', 'error WrongHeader(uint256 blockNumber)', 'error BadHeader()',
]);

export const coordinatorV1Abi = parseAbi(['function graduate() returns (uint256 reward)', 'function graduated() view returns (bool)',
  'function executor() view returns (address)', 'function tickets() view returns (address)', 'function randomness() view returns (address)']);

export const hookAbi = parseAbi([
  'function deepen(address tipTo) returns (uint8 kind, uint8 skip, uint256 qUsed, uint256 tUsed, uint256 tip)',
  'function closed() view returns (bool)',
  'function poolId() view returns (bytes32)',
  'function poolManager() view returns (address)',
  'function q() view returns (address)',
]);

export const receiverAbi = parseAbi([
  'function collect(address tipTo) returns ((uint256 q, uint256 t, uint256 qToReserve, uint256 tip) batch)',
  'function payFit() returns (uint256 amount)',
  'function payPlatform() returns (uint256 amount)',
  'function fitOwed() view returns (uint256)',
  'function platformOwed() view returns (uint256)',
  'function fitWaitingT() view returns (uint256)',
]);

export const priceSourceAbi = parseAbi([
  'function poke() returns (int24 recordedTick)',
  'function latestSampleTick() view returns (int24)',
  'function oracle() view returns ((int24 tick, uint32 time, int56 tickCumulative, uint8 head, uint8 filled))',
  'function checkpointAt(uint256 index) view returns ((uint32 time, int56 tickCumulative))',
]);

export const executorAbi = parseAbi([
  'function execute(uint256 maxChunks) returns (uint256 chunks,uint256 ethSpent,uint256 fitBurned)',
  'function budget() view returns (uint256)',
  'function batchThreshold() view returns (uint256)',
  'function twap() view returns (bool ready,int24 tick,uint32 window)',
  'function launchPhase() view returns (address)',
  'function fitGraduated() view returns (bool)',
  'function poolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
]);

export const poolManagerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32 value)']);

// M2-51: frozen Solidity interfaces are authoritative until M2-52 regenerates the shared ABI.
export const holderAbi = parseAbi([
  'function settleBatch(uint256 batchId,uint256 maxSteps) returns (bool complete)',
  'function flushResidue(uint256 batchId) returns (uint256 amountP)',
  'function batchState(uint256 batchId) view returns (bool complete,uint256 holderCursor,uint256 noticeCursor,uint256 residueP)',
]);
export const holderFundingAbi = parseAbi([
  'function holderLedger() view returns (address)',
  'function holderBatchClosed(uint256 batchId) view returns (bool)',
  // V2.1 pay-in-T reads; both views exist on v2.0 receivers too, where no side is HoldersT (choice 7).
  'function holderBatchPaid(uint256 batchId) view returns (uint256)',
  'function buyersChoice() view returns (uint8)',
  'function sellersChoice() view returns (uint8)',
]);
export const receiverCursorsAbi = parseAbi([
  'function allocationCursors() view returns (uint256 lastBuyer, uint256 lastSeller, uint256 openBuyer, uint256 openSeller)',
]);
export const holderBatchAbi = parseAbi([
  'function holderLedger() view returns (address)',
  'function currentTradeBatch(bool buyers) view returns (uint256 batchId)',
  'function tradeBatch(uint256 batchId) view returns ((uint256 tradeUnits,uint256 protocolUnits,uint256 netP,bool closed))',
]);
export const shopAbi = parseAbi([
  'function failedT() view returns (uint256)',
  'function collectionSize() view returns (uint256)',
  'function burnFailedT() returns (uint256 burned)',
  'function returnStarter(uint256[] indexes) returns (uint256 returned)',
]);

// M3 companion shapes; ABI_SOURCES pins these to compiled declarations until shared ABI regeneration.
export const itemAbi = parseAbi([
  'function sync(uint256 maxReceipts)',
  'function flushResidue() returns (uint256 p)',
  'function fundingCursor() view returns (uint256)',
  'function lifecycleCursor() view returns (uint256)',
]);
export const itemFundingAbi = parseAbi(['function itemFundingCount() view returns (uint256)']);
export const itemLifecycleAbi = parseAbi(['function itemLifecycleCount() view returns (uint256)']);
export const pileFactoryAbi = parseAbi(['function isPileVault(address candidate) view returns (bool)']);
export const pileAbi = parseAbi([
  'function loadSeed() payable', 'function returnSeed() returns (uint256 amount)',
  'function asset() view returns (address)', 'function seedAmount() view returns (uint256)',
]);

/** The ABI a job's call is encoded with. */
export const ABI_OF_JOB: Readonly<Record<JobName, Abi>> = {
  backupStart: backedSourceAbi, backupFix: backedSourceAbi,
  drandGraduationBounty: drandSourceAbi, drandPostRound: drandSourceAbi, drandWithdrawBounty: drandSourceAbi,
  drandRequestWord: drandTicketsAbi, drandAcceptWord: drandTicketsAbi, drandSettle: drandTicketsAbi,
  itemSync: itemAbi, itemResidue: itemAbi, pileLoadSeed: pileAbi, pileReturnSeed: pileAbi,
  holderSettle: holderAbi, holderResidue: holderAbi,
  shopBurn: shopAbi, shopReturn: shopAbi,
  buyBack: receiverV2Abi, burnPending: receiverV2Abi, royaltyFlush: royaltyRouterV2Abi, royaltySweep: royaltyRouterV2Abi,
  royaltyRefresh: royaltyRouterV2Abi, royaltyObserve: royaltyRouterV2Abi, sellFees: hookV2Abi,
  shopFees: receiverModulesV21Abi,
  moveToPile: receiverPileV21Abi,
  executeModule: receiverModulesV21Abi,
  eatPriceCoin: receiverEatV21Abi,
  claimReward: coordinatorV2Abi, routerSweep: launchRouterV2Abi,
  collect: receiverAbi,
  receiverPayFit: receiverAbi,
  receiverPayPlatform: receiverAbi,
  deepen: hookAbi,
  fail: coordinatorAbi,
  failClosed: coordinatorAbi,
  graduate: coordinatorAbi,
  poke: priceSourceAbi,
  executorTopUp: priceSourceAbi,
  executorExecute: executorAbi,
};

/** Dispatch by explicit version, never by matching a function selector alone. */
export function abiFor(c: Candidate): Abi {
  if (c.version === 2) {
    if (c.job === 'itemResidue' && c.fn === 'flushResidueT') return itemLedgerV2Abi;
    if (c.job === 'deepen') return hookV2Abi;
    if (['collect', 'receiverPayFit', 'receiverPayPlatform'].includes(c.job)) return receiverV2Abi;
  }
  return ABI_OF_JOB[c.job];
}

export interface AbiSource {
  readonly name: string;
  readonly abi: Abi;
  /** The artifact under packages/contracts/out, or null for an external contract. */
  readonly artifact: string | null;
  readonly external?: string;
}

export const ABI_SOURCES: readonly AbiSource[] = [
  { name: 'drandSource', abi: drandSourceAbi, artifact: 'DrandSource.sol/DrandSource.json' },
  { name: 'backedSource', abi: backedSourceAbi, artifact: 'BoxBackedSource.sol/BoxBackedSource.json' },
  { name: 'drandTicketsV1', abi: drandTicketsAbi, artifact: 'BoxTickets.sol/BoxTickets.json' },
  { name: 'drandTicketsV2', abi: drandTicketsAbi, artifact: 'BoxTicketsV2.sol/BoxTicketsV2.json' },
  { name: 'drandVault', abi: drandVaultAbi, artifact: 'BoxVaultV2.sol/BoxVaultV2.json' },
  { name: 'item', abi: itemAbi, artifact: 'IItemLedgerV2.sol/IItemLedgerV2.json' },
  { name: 'itemFunding', abi: itemFundingAbi, artifact: 'IBoxReceiverV2.sol/IBoxReceiverItemsV2.json' },
  { name: 'itemLifecycle', abi: itemLifecycleAbi, artifact: 'IBoxVaultV2.sol/IBoxVaultItemsV2.json' },
  { name: 'pile', abi: pileAbi, artifact: 'IPileVaultV2.sol/IPileVaultV2.json' },
  { name: 'pileFactory', abi: pileFactoryAbi, artifact: 'IBoxCoordinatorV2.sol/IBoxFactoryPileV2.json' },
  { name: 'holder', abi: holderAbi, artifact: 'IHolderLedgerV2.sol/IHolderLedgerV2.json' },
  { name: 'holderFunding', abi: holderFundingAbi, artifact: 'IBoxReceiverV2.sol/IBoxReceiverV2.json' },
  { name: 'holderBatch', abi: holderBatchAbi, artifact: 'IBoxHookV2.sol/IBoxHookV2.json' },
  { name: 'shop', abi: shopAbi, artifact: 'IShopVaultV2.sol/IShopVaultV2.json' },
  { name: 'boxRegistry', abi: boxRegistryAbi, artifact: 'IBoxRegistryV2.sol/IBoxRegistryV2.json' },
  { name: 'coordinator', abi: coordinatorAbi, artifact: 'IBoxCoordinatorV2.sol/IBoxCoordinatorV2.json' },
  { name: 'coordinatorV1', abi: coordinatorV1Abi, artifact: 'IBoxCoordinator.sol/IBoxCoordinator.json' },
  { name: 'hookV2', abi: hookV2Abi, artifact: 'IBoxHookV2.sol/IBoxHookV2.json' },
  { name: 'receiverV2', abi: receiverV2Abi, artifact: 'IBoxReceiverV2.sol/IBoxReceiverV2.json' },
  { name: 'receiverCursors', abi: receiverCursorsAbi, artifact: 'IBoxReceiverV2.sol/IBoxReceiverCursorsV21.json' },
  { name: 'receiverPileV21', abi: receiverPileV21Abi, artifact: 'IBoxReceiverPileV21.sol/IBoxReceiverPileV21.json' },
  { name: 'receiverModulesV21', abi: receiverModulesV21Abi, artifact: 'IFeeModulesV21.sol/IFeeModulesV21.json' },
  { name: 'receiverEatV21', abi: receiverEatV21Abi, artifact: 'IBoxReceiverEatV21.sol/IBoxReceiverEatV21.json' },
  { name: 'launchRouterV2', abi: launchRouterV2Abi, artifact: 'IBoxPeripheryV2.sol/IBoxLaunchRouterV2.json' },
  { name: 'hookV1', abi: hookAbi, artifact: 'IBoxHook.sol/IBoxHook.json' },
  { name: 'receiverV1', abi: receiverAbi, artifact: 'IBoxReceiver.sol/IBoxReceiver.json' },
  { name: 'fitExecutor', abi: [...priceSourceAbi, ...executorAbi], artifact: 'FitBuybackExecutor.sol/FitBuybackExecutor.json' },
  { name: 'poolManager', abi: poolManagerAbi, artifact: 'IExtsload.sol/IExtsload.json' },
];

type Param = { type: string; components?: readonly Param[] };
const canonical = (p: Param): string =>
  p.type.startsWith('tuple') ? `(${(p.components ?? []).map(canonical).join(',')})${p.type.slice(5)}` : p.type;

export const canonicalInputs = (item: { inputs?: readonly unknown[] }) => ((item.inputs ?? []) as Param[]).map(canonical).join(',');
export const canonicalOutputs = (item: { outputs?: readonly unknown[] }) => ((item.outputs ?? []) as Param[]).map(canonical).join(',');
