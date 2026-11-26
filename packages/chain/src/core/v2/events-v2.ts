import { alchemistV21Abi } from './alchemist-v21';
import { cowSettlementV21Abi } from './inbox-v21';
import { toEventSelector, type Abi, type AbiEvent, type Hex } from 'viem';
import { boxCollectionAbi } from '../../abi/boxCollection';
import { boxCoordinatorAbi } from '../../abi/boxCoordinator';
import { boxLaunchRouterAbi } from '../../abi/boxLaunchRouter';
import { boxRoyaltyRouterAbi } from '../../abi/boxRoyaltyRouter';
import { boxTicketsAbi } from '../../abi/boxTickets';
import { boxTokenAbi } from '../../abi/boxToken';
import { drandSourceAbi } from '../../abi/drandSource';
import { poolManagerAbi } from '../../abi/poolManager';
import type { RoleNameV2 } from '../roles';
import { royaltyRouterV2Abi, receiverShopV21Abi, receiverModulesV21Abi, receiverPileV21Abi, receiverPayInTV21Abi, receiverEatV21Abi, listingBurnV21Abi, itemLedgerV2Abi, pileVaultV2Abi, receiverItemsV2Abi, vaultItemsV2Abi, vaultV2ExtraEventsAbi, coordinatorV2Abi, coordinatorV2ExtraEventsAbi, holderLedgerV2Abi, hookV2Abi, listingRegistryV2Abi, receiverV2Abi, registryV2Abi, shopVaultV2Abi, starterSetLoaderV2Abi, vaultV2Abi } from './abi-v2';

/**
 * Where a v2 event comes from: a release singleton (the ETH-in helper is its periphery), a converter, the chain's
 * PoolManager or drand source, a box role.
 */
export type EventSourceV2 = 'cowSettlement' | 'feeModule' | 'registry' | 'listingRegistry' | 'converter' | 'platformCap' | 'ethInHelper' | 'poolManager' | 'randomness' | RoleNameV2;

export interface EventEntryV2 {
  readonly source: EventSourceV2;
  /** The interface that declares the event (Solidity), for the pin tests. */
  readonly container: string;
  readonly name: string;
}

const entries = (source: EventSourceV2, container: string, names: readonly string[]): EventEntryV2[] => names.map((name) => ({ source, container, name }));

/** The v2 events the indexer reads, each with its frozen interface. */
export const FROZEN_EVENTS_V2: readonly EventEntryV2[] = Object.freeze([
  ...entries('royaltyRouter', 'IBoxRoyaltyRouterV2', ['InKindClaimed', 'OrderRefreshed']),
  ...entries('registry', 'IBoxRegistryV2', ['BoxCreated', 'BoxSpec']),
  ...entries('listingRegistry', 'IListingRegistry', listingRegistryV2Abi.filter((e) => e.type === 'event').map((e) => e.name)),
  ...entries('coordinator', 'IBoxCoordinatorV2', ['ChunkLoaded', 'BoxOpenSet', 'BoxFailed', 'PotFixed', 'Claimed', 'EscrowSurplusClipped', 'StarterSetLoaded']),
  ...entries('hook', 'IBoxHookV2', hookV2Abi.filter((e) => e.type === 'event' && e.name !== 'OpenSet').map((e) => e.name)),
  ...entries('hook', 'IBoxOpenGateV2', ['OpenSet']),
  ...entries('launchRouter', 'IBoxOpenGateV2', ['OpenSet']),
  ...entries('tickets', 'IBoxOpenGateV2', ['OpenSet']),
  ...entries('receiver', 'IBoxReceiverV2', receiverV2Abi.filter((e) => e.type === 'event').map((e) => e.name)),
  ...entries('receiver', 'IBoxReceiverPayInTV21', ['RewardsBought', 'RewardTBurned', 'ItemsDepthFunded']),
  ...entries('receiver', 'IBoxReceiverShopV21', receiverShopV21Abi.filter(e => e.type === 'event').map(e => e.name)),
  ...entries('receiver', 'IFeeModulesV21', ['ModuleExecuted']),
  ...entries('receiver', 'IBoxReceiverPileV21', ['PileFeesMoved']),
  ...entries('receiver', 'IBoxReceiverEatV21', ['PriceCoinEaten']),
  ...entries('listingRegistry', 'IListingBurnV21', ['CheckedBurnRecorded']),
  ...entries('receiver', 'IBoxReceiverItemsV2', ['ItemFunded']),
  ...entries('vault', 'IBoxVaultItemsV2', ['ItemLifecycleRecorded']),
  ...entries('holderLedger', 'IHolderLedgerV2', ['BatchSettled', 'HolderPaid', 'ResidueFlushed']),
  ...entries('vault', 'IShopVaultV2', ['SeedFunded', 'FeesFunded', 'CollectionAdded', 'Given', 'Picked']),
  ...entries('vault', 'IBoxVaultV2', ['Withdrawn', 'Returned', 'TicketsOpened', 'TicketsReleased', 'TicketDelivered', 'VaultInitialized', 'GateOpened', 'HandBackFeeWaived', 'FailureEntered', 'ReleasedToCreator', 'ItemLedgerCallFailed', 'ItemPayoutForwarded']),
]);

export interface NotReadEntryV2 {
  readonly container: string;
  readonly name: string;
  readonly reason: string;
}

/** Every surviving declared M3 event is read; F127 adds no pushed-claim event. */
export const NOT_READ_V2: readonly NotReadEntryV2[] = Object.freeze([

]);

/** Events a v2 part inherits from v1's interface, read with the generated v1 ABI. */
export const INHERITED_EVENTS_V2: readonly EventEntryV2[] = Object.freeze([
  ...entries('coordinator', 'IBoxCoordinator', ['BoxLaunched', 'Graduated', 'RewardClaimed', 'PokeFailed']),
  ...entries('launchRouter', 'IBoxLaunchRouter', ['TaxedBuy', 'Bootstrapped', 'CreatorBought', 'Swept']),
  ...entries('tickets', 'IBoxTickets', ['Transfer', 'PlaceholdersTaken', 'PlaceholdersHandedBack', 'GraduationWordRequested', 'GraduationWordStored', 'DrawRequested', 'DrawSettled', 'Opened', 'TicketCancelled', 'TerminalModeEntered', 'TakenByNumber']),
  ...entries('royaltyRouter', 'IBoxRoyaltyRouter', ['Flushed']),
  ...entries('token', 'IBoxToken', ['Transfer']),
]);

/**
 * Events of v2 parts that M1-00 froze no v2 interface for, read with the generated v1 ABI of the part they copy: the
 * collection (M1-30-b's copy of v1's, its table and texts from the chunks) [I: the copy keeps v1's events].
 */
export const V1_COPY_EVENTS_V2: readonly EventEntryV2[] = Object.freeze([
  ...entries('collection', 'IBoxCollection', ['ConsecutiveTransfer', 'Transfer', 'Revealed', 'RevealUnlocked', 'TransferObserverFailed']),
]);

/** The chain's own contracts, read as v1 reads them (the PoolManager by the box's pool id). */
const CHAIN_EVENTS: readonly [EventSourceV2, Abi, readonly string[]][] = [
  ['cowSettlement', cowSettlementV21Abi, ['Trade']],
  ['poolManager', poolManagerAbi as Abi, ['Swap', 'ModifyLiquidity', 'Initialize', 'Donate']],
  ['randomness', drandSourceAbi as Abi, ['Requested', 'RoundPosted', 'BountyAdded']],
];

const V2_ABI: Readonly<Record<string, Abi>> = {
  IBoxRoyaltyRouterV2: royaltyRouterV2Abi,
  IBoxReceiverShopV21: receiverShopV21Abi,
  IFeeModulesV21: receiverModulesV21Abi,
  IBoxReceiverPayInTV21: receiverPayInTV21Abi,
  IBoxReceiverPileV21: receiverPileV21Abi,
  IBoxReceiverEatV21: receiverEatV21Abi,
  IListingBurnV21: listingBurnV21Abi,
  IBoxReceiverItemsV2: receiverItemsV2Abi,
  IBoxVaultItemsV2: vaultItemsV2Abi,
  IBoxRegistryV2: registryV2Abi as Abi,
  IListingRegistry: listingRegistryV2Abi as Abi,
  IBoxCoordinatorV2: coordinatorV2Abi as Abi,
  IBoxHookV2: hookV2Abi as Abi,
  IBoxOpenGateV2: hookV2Abi as Abi,
  IBoxReceiverV2: receiverV2Abi as Abi,
  IBoxVaultV2: vaultV2Abi as Abi,
  IHolderLedgerV2: holderLedgerV2Abi,
  IShopVaultV2: shopVaultV2Abi,
};

const V1_ABI: Readonly<Record<string, Abi>> = {
  IBoxCoordinator: boxCoordinatorAbi as Abi,
  IBoxLaunchRouter: boxLaunchRouterAbi as Abi,
  IBoxTickets: boxTicketsAbi as Abi,
  IBoxRoyaltyRouter: boxRoyaltyRouterAbi as Abi,
  IBoxToken: boxTokenAbi as Abi,
  IBoxCollection: boxCollectionAbi as Abi,
};

function eventOf(abi: Abi | undefined, name: string, where: string): AbiEvent {
  const found = (abi ?? []).filter((item): item is AbiEvent => item.type === 'event' && item.name === name);
  if (found.length !== 1) throw new Error(`events-v2: ${where} has ${found.length} events named ${name}`);
  return found[0] as AbiEvent;
}

function build(): { readonly abi: Partial<Record<EventSourceV2, Abi>>; readonly names: Partial<Record<EventSourceV2, readonly string[]>> } {
  const abi: Partial<Record<EventSourceV2, AbiEvent[]>> = {};
  const add = (source: EventSourceV2, event: AbiEvent): void => {
    abi[source] = [...(abi[source] ?? []), event];
  };
  for (const e of FROZEN_EVENTS_V2) add(e.source, eventOf(V2_ABI[e.container], e.name, e.container));
  // Include implementation supplements; role 3 may be a share vault, shop or pile.
  for (const [source, from] of [['feeModule', alchemistV21Abi], ['coordinator', coordinatorV2ExtraEventsAbi], ['itemLedger', itemLedgerV2Abi], ['vault', pileVaultV2Abi], ['vault', vaultItemsV2Abi], ['vault', vaultV2ExtraEventsAbi], ['receiver', receiverItemsV2Abi], ['vault', shopVaultV2Abi], ['starterSetLoader', starterSetLoaderV2Abi]] as const) {
    for (const event of from) if (event.type === 'event' && !(abi[source] ?? []).some(e => toEventSelector(e) === toEventSelector(event))) add(source, event);
  }
  for (const e of [...INHERITED_EVENTS_V2, ...V1_COPY_EVENTS_V2]) add(e.source, eventOf(V1_ABI[e.container], e.name, e.container));
  for (const [source, from, names] of CHAIN_EVENTS) for (const name of names) add(source, eventOf(from, name, source));
  const names = Object.fromEntries(Object.entries(abi).map(([source, events]) => [source, Object.freeze(events.map((e) => e.name))]));
  return { abi: abi as Partial<Record<EventSourceV2, Abi>>, names };
}

const BUILT = build();

/** Each source's ABI, narrowed to the events the indexer reads from it. */
export const EVENT_ABI_V2: Readonly<Partial<Record<EventSourceV2, Abi>>> = Object.freeze(BUILT.abi);

/** The events read from each source, by name. */
export const CORE_EVENTS_V2: Readonly<Partial<Record<EventSourceV2, readonly string[]>>> = Object.freeze(BUILT.names);

/** topic0 of every event read from each source (the getLogs topic filter is their union). */
export const CORE_TOPIC0_V2: Readonly<Partial<Record<EventSourceV2, readonly Hex[]>>> = Object.freeze(
  Object.fromEntries(Object.entries(BUILT.abi).map(([source, abi]) => [source, (abi as AbiEvent[]).map((e) => toEventSelector(e))])),
);
