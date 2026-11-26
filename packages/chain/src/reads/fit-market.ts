/**
 * Direct chain reads for the v2 FIT pair page (T19): the fallback when the live indexer is not reachable (C19, UI-12,
 * docs/design/realtime-chain-data.md § 7 step 3), and the vault counters the indexer does not carry. Read-only
 * `eth_call`s, every one pinned to ONE block number taken from the `latest` header, so the numbers of a read never
 * mix blocks (BOX-SYSTEM :27). No wallet, no transaction, no swap.
 *
 * - Pool: `PoolManager.extsload(poolStateSlot(poolId))` gives √price and tick (Uniswap v4 StateLibrary layout).
 * - Launch phase: `FitPoolHook.phase()`, `completedAtBlock()`, `migratedAtBlock()`, `liquidityOpensAt()`,
 *   `openBlock()` (FitPoolHook.sol:187-215, 641-662).
 * - Burned: FIT `totalSupply()` against the one-time issuance.
 * - Vault counters: `MisfitsVault.inside()`, `collectionSize()`, `gateOpen()`; placeholders taken =
 *   `MisfitsPlaceholders.status().slots` (q, placeholders held and not handed back; fixed from graduation on).
 * - The vault's price inputs (box page, F49 M1): `escrowPrincipal()` (E), FIT `totalSupply()` (S) at the SAME block,
 *   `quoteWithdraw(1)` (the chain's own ⌈(S − E)/n⌉, to cross-check the app's vault math), and the stage-1 counts
 *   `hiddenCount()`, `pendingTickets()`, `shelfCount()` (MisfitsVault.sol:218, 481-495, 522).
 * - A wallet box (`readWalletBox`): FIT, Misfits and placeholders held by one address, at one block, over the market's
 *   own RPC (never the wallet's provider).
 *
 * A failed read throws `ChainUnavailableError` (never a zero); an answer that contradicts itself throws
 * `ChainDataError`.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { ChainDataError, ChainUnavailableError } from '../errors';
import { decodeSlot0, poolStateSlot } from './reader';

export const FIT_POOL_MANAGER_READ_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);
export const FIT_HOOK_READ_ABI = parseAbi([
  'function phase() view returns (uint8)',
  'function completedAtBlock() view returns (uint256)',
  'function migratedAtBlock() view returns (uint64)',
  'function liquidityOpensAt() view returns (uint256)',
  'function openBlock() view returns (uint256)',
]);
export const FIT_TOKEN_READ_ABI = parseAbi(['function totalSupply() view returns (uint256)', 'function balanceOf(address owner) view returns (uint256)']);
export const FIT_VAULT_READ_ABI = parseAbi([
  'function inside() view returns (uint256)',
  'function collectionSize() view returns (uint256)',
  'function gateOpen() view returns (bool)',
  'function escrowPrincipal() view returns (uint256)',
  'function quoteWithdraw(uint256 count) view returns (uint256)',
  'function hiddenCount() view returns (uint256)',
  'function pendingTickets() view returns (uint256)',
  'function shelfCount() view returns (uint256)',
]);
/** ERC-721 `balanceOf` (MisfitsCollection, MisfitsPlaceholders); the same selector as FIT's ERC-20 `balanceOf`. */
export const ERC721_BALANCE_READ_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
export const FIT_PLACEHOLDERS_READ_ABI = parseAbi([
  'struct State { uint40 minted; uint32 slots; uint40 wordRequestedAt; uint40 wordAcceptedAt; uint40 terminalAt; uint32 drawsRequested; uint32 drawsSettled; }',
  'function status() view returns (State)',
]);

/** FitPoolHook.Phase in declaration order. */
export const FIT_LAUNCH_PHASES = Object.freeze(['curve', 'completed', 'migrated'] as const);
export type FitLaunchPhase = (typeof FIT_LAUNCH_PHASES)[number];

export interface FitMarketContracts {
  readonly poolManager: Address;
  readonly poolId: Hex;
  readonly hook: Address;
  readonly token: Address;
  readonly vault: Address | null;
  readonly placeholders: Address | null;
  /** The Misfits collection (ERC-721); only the wallet read needs it. */
  readonly collection?: Address | null;
}

export interface FitBlockHeader {
  readonly number: bigint;
  readonly hash: Hex;
  readonly timestamp: bigint;
}

/** What the reads need from an RPC: the `latest` / `safe` / `finalized` headers and `eth_call` at a block number. */
export interface FitMarketRpc {
  header(tag: 'latest' | 'safe' | 'finalized'): Promise<FitBlockHeader | null>;
  call(to: Address, data: Hex, blockNumber: bigint): Promise<Hex>;
}

export interface FitCurveRead {
  readonly block: FitBlockHeader;
  readonly safeBlock: bigint | null;
  readonly finalizedBlock: bigint | null;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly phase: FitLaunchPhase;
  readonly completedBlock: bigint | null;
  readonly migratedBlock: bigint | null;
  readonly liquidityOpensAtBlock: bigint | null;
  readonly openBlock: bigint;
  readonly totalSupplyRaw: bigint;
}

export interface FitVaultRead {
  readonly block: FitBlockHeader;
  /** n: Misfits inside the vault. */
  readonly inside: bigint | null;
  /** N: the edition size. */
  readonly collectionSize: bigint | null;
  /** False until graduation. */
  readonly gateOpen: boolean | null;
  /** q: placeholders held (taken and not handed back). */
  readonly placeholdersTaken: bigint | null;
  /** Placeholder serials ever minted. */
  readonly placeholdersMinted: bigint | null;
  /** E: FIT principal locked by tickets and withdrawals (null without a vault). */
  readonly escrowPrincipal: bigint | null;
  /** S: FIT totalSupply at the same block as E (never from another read). */
  readonly totalSupply: bigint;
  /** The vault's own quote for one Misfit, ⌈(S − E)/n⌉; null when it has no quote (no vault, or n = 1). */
  readonly quoteWithdrawOne: bigint | null;
  /** h: hidden Misfits reserved by no ticket. */
  readonly hidden: bigint | null;
  /** t: tickets pending. */
  readonly pendingTickets: bigint | null;
  /** s = n − h: returned Misfits on the shelf. */
  readonly shelf: bigint | null;
}

/** What one address holds of a market, at one block (a wallet box). Null = the deployment has no such contract. */
export interface WalletBoxRead {
  readonly block: FitBlockHeader;
  readonly account: Address;
  /** FIT (or a rehearsal's token), raw 18-decimal units. */
  readonly tokenBalance: bigint;
  /** Misfits held (revealed NFTs). */
  readonly collectionBalance: bigint | null;
  /** Placeholders held (sealed until graduation). */
  readonly placeholderBalance: bigint | null;
}

async function latest(rpc: FitMarketRpc): Promise<FitBlockHeader> {
  let header: FitBlockHeader | null;
  try {
    header = await rpc.header('latest');
  } catch (error) {
    throw new ChainUnavailableError('The latest block could not be read', { cause: error });
  }
  if (header === null) throw new ChainUnavailableError('The RPC returned no latest block');
  return header;
}

async function optionalHeader(rpc: FitMarketRpc, tag: 'safe' | 'finalized'): Promise<bigint | null> {
  try {
    return (await rpc.header(tag))?.number ?? null;
  } catch {
    // Some nodes have no safe or finalized tag (a young local chain): unknown, never a guess.
    return null;
  }
}

async function call(rpc: FitMarketRpc, to: Address, data: Hex, block: bigint, what: string): Promise<Hex> {
  try {
    return await rpc.call(to, data, block);
  } catch (error) {
    throw new ChainUnavailableError(`${what} could not be read at block ${block}`, { cause: error });
  }
}

function decode<T>(fn: () => T, what: string): T {
  try {
    return fn();
  } catch (error) {
    throw new ChainDataError('inconsistent_state', `${what} returned data that does not decode`, { cause: error });
  }
}

/** An unsigned integer answer as bigint (viem decodes uint8…uint48 as number, wider ones as bigint). */
function uint(value: unknown, what: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new ChainDataError('inconsistent_state', `${what} is not an unsigned integer`);
}

/** The pool, the launch phase and the burned supply at the newest block (all calls at that one block). */
export async function readFitCurve(rpc: FitMarketRpc, contracts: FitMarketContracts): Promise<FitCurveRead> {
  const block = await latest(rpc);
  const at = block.number;
  const hookCall = async (functionName: 'phase' | 'completedAtBlock' | 'migratedAtBlock' | 'liquidityOpensAt' | 'openBlock'): Promise<bigint> => {
    const what = `The hook's ${functionName}()`;
    const data = await call(rpc, contracts.hook, encodeFunctionData({ abi: FIT_HOOK_READ_ABI, functionName }), at, what);
    return uint(decode(() => decodeFunctionResult({ abi: FIT_HOOK_READ_ABI, functionName, data }) as unknown, what), what);
  };
  const [slotWord, phaseRaw, completed, migrated, opens, openBlock, supplyData, safeBlock, finalizedBlock] = await Promise.all([
    call(rpc, contracts.poolManager, encodeFunctionData({ abi: FIT_POOL_MANAGER_READ_ABI, functionName: 'extsload', args: [poolStateSlot(contracts.poolId)] }), at, 'The pool state'),
    hookCall('phase'),
    hookCall('completedAtBlock'),
    hookCall('migratedAtBlock'),
    hookCall('liquidityOpensAt'),
    hookCall('openBlock'),
    call(rpc, contracts.token, encodeFunctionData({ abi: FIT_TOKEN_READ_ABI, functionName: 'totalSupply' }), at, 'FIT totalSupply()'),
    optionalHeader(rpc, 'safe'),
    optionalHeader(rpc, 'finalized'),
  ]);
  const word = decode(() => decodeFunctionResult({ abi: FIT_POOL_MANAGER_READ_ABI, functionName: 'extsload', data: slotWord }), 'The pool state');
  const slot0 = decodeSlot0(word);
  if (slot0.sqrtPriceX96 === 0n) throw new ChainDataError('inconsistent_state', 'The pool is not initialised at this block');
  const phase = FIT_LAUNCH_PHASES[Number(phaseRaw)];
  if (phase === undefined) throw new ChainDataError('inconsistent_state', `The hook reported an unknown phase ${String(phaseRaw)}`);
  const totalSupplyRaw = uint(decode(() => decodeFunctionResult({ abi: FIT_TOKEN_READ_ABI, functionName: 'totalSupply', data: supplyData }) as unknown, 'FIT totalSupply()'), 'FIT totalSupply()');
  const migratedBlock = migrated;
  if ((phase === 'migrated') !== (migratedBlock !== 0n)) throw new ChainDataError('inconsistent_state', 'The hook’s phase and migration block disagree');
  return Object.freeze({
    block,
    safeBlock,
    finalizedBlock,
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: slot0.tick,
    phase,
    completedBlock: completed === 0n ? null : completed,
    migratedBlock: migratedBlock === 0n ? null : migratedBlock,
    liquidityOpensAtBlock: opens === 0n ? null : opens,
    openBlock,
    totalSupplyRaw,
  });
}

type VaultCount = 'inside' | 'collectionSize' | 'gateOpen';
/** Views a vault deployed before the box page may lack (the Sepolia record of 2026-09-30 was recorded without them). */
type VaultPriceView = 'escrowPrincipal' | 'hiddenCount' | 'pendingTickets' | 'shelfCount';

/**
 * The vault counters at the newest block: Misfits inside, the edition size, whether the gate is open, the placeholders
 * taken, and the price inputs E and S with the vault's own quote for one Misfit, every call at that one block. A
 * contract the deployment does not name reads as null ("not in this deployment"), never zero. The counters are strict
 * (a failed call throws `ChainUnavailableError`). The price views and `quoteWithdraw(1)` (a cross-check; it reverts at
 * n = 1, where the last Misfit stays) read as null when the call fails, so an older vault, or an RPC that refuses one
 * of them, shows "not available" for the price picture instead of hiding the counters. A malformed answer still throws.
 */
export async function readFitVault(rpc: FitMarketRpc, contracts: FitMarketContracts): Promise<FitVaultRead> {
  const block = await latest(rpc);
  const at = block.number;
  const vault = contracts.vault;
  const placeholders = contracts.placeholders;
  const vaultCall = async (functionName: VaultCount): Promise<unknown> => {
    if (vault === null) return null;
    const data = await call(rpc, vault, encodeFunctionData({ abi: FIT_VAULT_READ_ABI, functionName }), at, `The vault's ${functionName}()`);
    return decode(() => decodeFunctionResult({ abi: FIT_VAULT_READ_ABI, functionName, data }) as unknown, `The vault's ${functionName}()`);
  };
  const softCall = async (data: Hex, decodeAs: (answer: Hex) => unknown, what: string): Promise<bigint | null> => {
    if (vault === null) return null;
    let answer: Hex;
    try {
      answer = await rpc.call(vault, data, at);
    } catch {
      return null;
    }
    return uint(decode(() => decodeAs(answer), what), what);
  };
  const priceView = (functionName: VaultPriceView) =>
    softCall(encodeFunctionData({ abi: FIT_VAULT_READ_ABI, functionName }), (data) => decodeFunctionResult({ abi: FIT_VAULT_READ_ABI, functionName, data }), `The vault’s ${functionName}()`);
  const quoteCall = () =>
    softCall(
      encodeFunctionData({ abi: FIT_VAULT_READ_ABI, functionName: 'quoteWithdraw', args: [1n] }),
      (data) => decodeFunctionResult({ abi: FIT_VAULT_READ_ABI, functionName: 'quoteWithdraw', data }),
      'The vault’s quoteWithdraw(1)',
    );
  const statusCall = async () => {
    if (placeholders === null) return null;
    const data = await call(rpc, placeholders, encodeFunctionData({ abi: FIT_PLACEHOLDERS_READ_ABI, functionName: 'status' }), at, 'The placeholders’ status()');
    return decode(() => decodeFunctionResult({ abi: FIT_PLACEHOLDERS_READ_ABI, functionName: 'status', data }), 'The placeholders’ status()');
  };
  const supplyCall = async (): Promise<bigint> => {
    const data = await call(rpc, contracts.token, encodeFunctionData({ abi: FIT_TOKEN_READ_ABI, functionName: 'totalSupply' }), at, 'FIT totalSupply()');
    return uint(decode(() => decodeFunctionResult({ abi: FIT_TOKEN_READ_ABI, functionName: 'totalSupply', data }) as unknown, 'FIT totalSupply()'), 'FIT totalSupply()');
  };
  const [inside, collectionSize, gateOpen, escrow, hidden, tickets, shelf, status, supply, quoteOne] = await Promise.all([
    vaultCall('inside'),
    vaultCall('collectionSize'),
    vaultCall('gateOpen'),
    priceView('escrowPrincipal'),
    priceView('hiddenCount'),
    priceView('pendingTickets'),
    priceView('shelfCount'),
    statusCall(),
    supplyCall(),
    quoteCall(),
  ]);
  const count = (value: unknown, what: string): bigint | null => (value === null ? null : uint(value, what));
  const insideCount = count(inside, 'The vault’s inside()');
  const size = count(collectionSize, 'The vault’s collectionSize()');
  const escrowPrincipal = escrow;
  if (gateOpen !== null && typeof gateOpen !== 'boolean') throw new ChainDataError('inconsistent_state', 'The vault’s gateOpen() is not a boolean');
  if (insideCount !== null && size !== null && insideCount > size) throw new ChainDataError('inconsistent_state', 'The vault holds more Misfits than the edition has');
  if (escrowPrincipal !== null && escrowPrincipal > supply) throw new ChainDataError('inconsistent_state', 'The vault’s escrow is above the token’s supply');
  return Object.freeze({
    block,
    inside: insideCount,
    collectionSize: size,
    gateOpen,
    placeholdersTaken: status === null ? null : uint(status.slots, 'The placeholders’ slots'),
    placeholdersMinted: status === null ? null : uint(status.minted, 'The placeholders’ minted count'),
    escrowPrincipal,
    totalSupply: supply,
    quoteWithdrawOne: quoteOne,
    hidden,
    pendingTickets: tickets,
    shelf,
  });
}

const ACCOUNT = /^0x[0-9a-fA-F]{40}$/;

/**
 * What `account` holds of this market at the newest block: the token, the Misfits and the placeholders (each call at
 * that one block). A contract the deployment does not name reads as null, never zero; a failed call throws
 * `ChainUnavailableError`. Read over the market's RPC: a wallet's provider is never asked.
 */
export async function readWalletBox(rpc: FitMarketRpc, contracts: FitMarketContracts, account: Address): Promise<WalletBoxRead> {
  if (!ACCOUNT.test(account)) throw new ChainDataError('inconsistent_state', 'The wallet address is not a 20-byte address');
  const block = await latest(rpc);
  const at = block.number;
  const balance = async (to: Address | null | undefined, what: string): Promise<bigint | null> => {
    if (to === null || to === undefined) return null;
    const label = `${what} balanceOf()`;
    const data = await call(rpc, to, encodeFunctionData({ abi: ERC721_BALANCE_READ_ABI, functionName: 'balanceOf', args: [account] }), at, label);
    return uint(decode(() => decodeFunctionResult({ abi: ERC721_BALANCE_READ_ABI, functionName: 'balanceOf', data }) as unknown, label), label);
  };
  const [token, collection, placeholders] = await Promise.all([
    balance(contracts.token, 'The token’s'),
    balance(contracts.collection, 'The collection’s'),
    balance(contracts.placeholders, 'The placeholders’'),
  ]);
  if (token === null) throw new ChainDataError('inconsistent_state', 'The token balance is missing');
  return Object.freeze({ block, account, tokenBalance: token, collectionBalance: collection, placeholderBalance: placeholders });
}
