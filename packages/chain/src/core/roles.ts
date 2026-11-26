/**
 * Core v1's box roles and the events the indexer and the site read from each (S10a, docs/design/s10a-core-v1-site.md
 * § 2.2 and § 3.3). Plain data: no ABI here (the ABIs are generated, `@squarehole/chain/abi`).
 *
 * Roles index `BoxRecord.contracts` and `codeHashes` exactly as `BoxRegistry.ROLE_*` does
 * (packages/contracts/src/box/BoxRegistry.sol:20-39); an absent role is the zero address and a zero code hash.
 */

export const ROLE = Object.freeze({
  coordinator: 0,
  token: 1,
  hook: 2,
  vault: 3,
  collection: 4,
  receiver: 5,
  launchRouter: 6,
  tickets: 7,
  royaltyRouter: 8,
  executor: 9,
  itemStream: 10,
  swapModule: 11,
  metadataTable: 12,
} as const);

export type RoleName = keyof typeof ROLE;
export const ROLE_COUNT = 13;
export const ROLE_NAMES: readonly RoleName[] = Object.freeze(
  (Object.entries(ROLE) as [RoleName, number][]).sort((a, b) => a[1] - b[1]).map(([name]) => name),
);

/**
 * Core v2's roles (ADR-0017 § 12; ticket M1-00): registry v2's `BoxRecordV2.contracts` and `codeHashes` indexes, as
 * `BoxRolesV2` in packages/contracts/src/box-v2/interfaces/IBoxRegistryV2.sol. v1's 0-12 keep their numbers; for a v2
 * box `itemStream` (box 0's add-on 2) and `metadataTable` (the table loads in chunks after creation) are always absent.
 * A role a box does not use is the zero address and a zero code hash.
 */
export const ROLE_V2 = Object.freeze({
  ...ROLE,
  sampler: 13,
  /** LEG clones (M2). */
  leg0: 14,
  leg1: 15,
  /** M3's item ledger. */
  itemLedger: 16,
  /** M2's holder ledger. */
  holderLedger: 17,
  /** An add-on 9 (`held-item-earnings`) part, if M2-00 gives it a contract. */
  heldItemEarnings: 18,
  /** M2's starter-set loader. */
  starterSetLoader: 19,
  reserved20: 20,
  reserved21: 21,
  reserved22: 22,
  reserved23: 23,
} as const);

export type RoleNameV2 = keyof typeof ROLE_V2;
export const ROLE_V2_COUNT = 24;
export const ROLE_V2_NAMES: readonly RoleNameV2[] = Object.freeze(
  (Object.entries(ROLE_V2) as [RoleNameV2, number][]).sort((a, b) => a[1] - b[1]).map(([name]) => name),
);

/** Where an event comes from: a box role, the box's pool on the PoolManager, the registry, or one of the randomness sources. */
export type EventSource = RoleName | 'poolManager' | 'registry' | 'randomness' | 'backedSource';

/**
 * Every event S10a decodes, by the contract that emits it (plan § 3.3). The hook's and the receiver's events come from
 * their own addresses even when their extension runs (DELEGATECALL keeps the emitter). The PoolManager's are read only
 * for the box's pool id (topic 1).
 */
export const CORE_EVENTS: Readonly<Record<EventSource, readonly string[]>> = Object.freeze({
  registry: ['BoxCreated', 'BoxSpec'],
  poolManager: ['Swap', 'ModifyLiquidity', 'Initialize', 'Donate'],
  hook: ['PoolLaunched', 'CurveClosed', 'Migrated', 'Harvested', 'Deepened', 'DeepenSkipped', 'DepthConverted'],
  launchRouter: ['TaxedBuy', 'Bootstrapped', 'CreatorBought', 'Swept'],
  coordinator: ['BoxLaunched', 'Graduated', 'RewardClaimed', 'PokeFailed'],
  receiver: [
    'Collected',
    'BatchSplit',
    'PlatformCredited',
    'PlatformPaid',
    'FitPaid',
    'DepthFunded',
    'DepthHeld',
    'FeesFunded',
    'DepthGifted',
    'GraduationSettled',
    'StreamFunded',
    'StreamNotifyFailed',
    'ModuleFeesNoted',
    'ModuleFeesReturned',
    'ModuleFeesClipped',
  ],
  vault: ['Withdrawn', 'Returned', 'TicketsOpened', 'TicketsReleased', 'TicketDelivered', 'GateOpened', 'HandBackFeeWaived', 'VaultObserverFailed'],
  collection: ['ConsecutiveTransfer', 'Transfer', 'Revealed', 'RevealUnlocked', 'TransferObserverFailed'],
  tickets: [
    // Placeholder and draw tickets are ERC-721s: their owners are the wallets' placeholders (plan § 6).
    'Transfer',
    'PlaceholdersTaken',
    'PlaceholdersHandedBack',
    'GraduationWordRequested',
    'GraduationWordStored',
    'DrawRequested',
    'DrawSettled',
    'Opened',
    'TicketCancelled',
    'TerminalModeEntered',
    'TakenByNumber',
  ],
  itemStream: ['Started', 'Credited', 'TicketsCredited', 'Claimed', 'Burned', 'BurnRefused', 'Funded', 'CheckpointRepaired'],
  executor: ['ChunkBought', 'TokensBurned', 'Executed', 'ModuleFeesReported'],
  randomness: ['Requested', 'RoundPosted', 'BountyAdded'],
  backedSource: ['Requested', 'BackupStarted', 'BackupFixed'],
  royaltyRouter: ['Flushed'],
  token: ['Transfer'],
  swapModule: [],
  metadataTable: [],
});
