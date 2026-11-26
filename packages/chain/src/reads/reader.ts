/**
 * Typed contract reads at an explicit block (one consistent block per snapshot or account read). Every call uses the
 * generated ABIs; nothing here signs, sends or encodes a transaction for a wallet. A failed read throws
 * `ChainUnavailableError` (never a zero); contradictory data throws `ChainDataError`.
 */
import {
  BlockNotFoundError,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBigInt,
  keccak256,
  type Address,
  type BlockTag,
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
import type { ChainPublicClient } from '../client';
import type { ChainConfig } from '../config/config';
import { deployedManifest } from '../config/config';
import { ChainDataError, ChainUnavailableError, isAbortError } from '../errors';
import { toRegistryPair, type RawPairRecord, type RegistryPair } from './registry-pair';

export interface BlockRef {
  readonly number: bigint;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly timestamp: bigint;
}

export interface Slot0 {
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly protocolFee: number;
  readonly lpFee: number;
}

export interface PairChainState {
  readonly block: BlockRef;
  readonly name: string;
  readonly symbol: string;
  readonly totalSupply: bigint;
  /** Ledger eligible supply: totalSupply − balances of the ledger's excluded roles (ADR-0010). */
  readonly eligibleSupply: bigint;
  /** NFTs that exist on the mirror (collections only). */
  readonly activeNftCount: bigint | null;
  readonly slot0: Slot0;
  readonly poolLiquidity: bigint;
  readonly poolStateSource: 'state_view' | 'pool_manager_extsload';
  readonly ledger: {
    readonly totalHolderQReceived: bigint;
    readonly totalHolderQIndexed: bigint;
    readonly totalClaimed: bigint;
    readonly bootstrapQ: bigint;
    readonly excludedAccounts: readonly Address[];
  };
  readonly collector: {
    readonly totalTReceived: bigint;
    readonly totalTBurned: bigint;
    readonly pendingBurnT: bigint;
    readonly totalQReceived: bigint;
    readonly totalQProtocol: bigint;
    readonly totalQHolders: bigint;
  };
  /** R = T only: the converter's sold-out trigger (the direct-Q fallback may apply). Null for R = Q. */
  readonly soldOut: boolean | null;
  readonly lpFeePips: number;
}

export interface AssetMeta {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface AccountPairState {
  readonly balance: bigint;
  readonly claimable: bigint;
  /** Collections: NFT ids held (bounded), and the mirror's NFT balance. */
  readonly nftCount: bigint | null;
  readonly nftIds: readonly bigint[];
}

export type ConversionQuote =
  | { readonly ok: true; readonly tOut: bigint; readonly source: 'v4_quoter_eth_call' | 'converter_eth_call' }
  | { readonly ok: false; readonly reason: 'no_quote_source' | 'quote_reverted' | 'zero_output' | 'empty_entitlement' };

export interface TemplateState {
  readonly version: number;
  readonly quote: Address;
  readonly active: boolean;
  readonly isLatestForQuote: boolean;
  readonly startFdvQ: bigint;
  readonly minStartUnitValueQ: bigint;
  readonly maxCollectionUnits: bigint;
  readonly tickSpacing: number;
  readonly rangeTicks: number;
  readonly addedAtBlock: bigint;
}

/** Uniswap v4 StateLibrary layout: `pools` mapping at slot 6; liquidity 3 slots after slot0. */
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;
export const MAX_NFT_IDS_PER_POSITION = 10_000n;
const REGISTRY_PAGE = 100n;

export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, POOLS_SLOT]));
}

/** Decodes a packed slot0 word (StateLibrary.getSlot0). */
export function decodeSlot0(word: Hex): Slot0 {
  const value = hexToBigInt(word);
  const sqrtPriceX96 = value & ((1n << 160n) - 1n);
  let tick = Number((value >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return {
    sqrtPriceX96,
    tick,
    protocolFee: Number((value >> 184n) & 0xffffffn),
    lpFee: Number((value >> 208n) & 0xffffffn),
  };
}

/** viem's `getBlock` answer "the node has no such block" (a null block), as opposed to a transport failure. */
function isBlockNotFound(error: unknown): boolean {
  return error instanceof BlockNotFoundError || (error instanceof Error && error.name === 'BlockNotFoundError');
}

function unavailable(what: string, error: unknown): never {
  if (isAbortError(error)) throw error;
  if (error instanceof ChainDataError) throw error;
  throw new ChainUnavailableError(`Chain read failed: ${what}`, { cause: error });
}

export class ChainReader {
  private readonly assetCache = new Map<string, Promise<AssetMeta>>();
  private readonly nameCache = new Map<string, Promise<{ name: string; symbol: string }>>();

  constructor(
    readonly config: ChainConfig,
    readonly client: ChainPublicClient,
  ) {}

  private get manifest() {
    return deployedManifest(this.config);
  }

  private get registry(): Address {
    return this.manifest.contracts.registry.address;
  }

  async block(tag: BlockTag | bigint): Promise<BlockRef> {
    try {
      const block = typeof tag === 'bigint' ? await this.client.getBlock({ blockNumber: tag }) : await this.client.getBlock({ blockTag: tag });
      if (block.number === null || block.hash === null) throw new ChainDataError('inconsistent_state', 'The RPC returned a pending block');
      return { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp };
    } catch (error) {
      return unavailable(`block ${String(tag)}`, error);
    }
  }

  /**
   * The block at `number`, or null when the node answers that no such block exists (the chain is shorter: an anvil
   * `evm_revert` / reset / restart, or a reorg onto a shorter fork). Transport failures still throw
   * `ChainUnavailableError`: "not found" is an answer, an outage is not.
   */
  async blockOrNull(number: bigint): Promise<BlockRef | null> {
    try {
      return await this.block(number);
    } catch (error) {
      if (error instanceof ChainUnavailableError && isBlockNotFound(error.cause)) return null;
      throw error;
    }
  }

  /** The block for a tag, or null when the node does not know the tag (e.g. `finalized` on an old client). */
  async optionalBlock(tag: BlockTag): Promise<BlockRef | null> {
    try {
      return await this.block(tag);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  /** Direct registry enumeration (bounded pages of 100): the degraded-mode source when the log index is unavailable. */
  async registryPairs(blockNumber: bigint): Promise<RegistryPair[]> {
    try {
      const count = await this.client.readContract({ address: this.registry, abi: squareHoleRegistryAbi, functionName: 'pairCount', blockNumber });
      const ids: Hex[] = [];
      for (let begin = 0n; begin < count; begin += REGISTRY_PAGE) {
        const page = await this.client.readContract({
          address: this.registry,
          abi: squareHoleRegistryAbi,
          functionName: 'pairIds',
          args: [begin, begin + REGISTRY_PAGE],
          blockNumber,
        });
        ids.push(...page);
      }
      const records = await Promise.all(
        ids.map((id) => this.client.readContract({ address: this.registry, abi: squareHoleRegistryAbi, functionName: 'pair', args: [id], blockNumber })),
      );
      return records.map((record) => toRegistryPair(record as RawPairRecord, this.config.chainId));
    } catch (error) {
      return unavailable('registry pairs', error);
    }
  }

  /** Direct lookup of one pair by its token (null when the registry has no such pair at that block). */
  async registryPairOfToken(token: Address, blockNumber: bigint): Promise<RegistryPair | null> {
    try {
      const record = (await this.client.readContract({
        address: this.registry,
        abi: squareHoleRegistryAbi,
        functionName: 'pairOfToken',
        args: [token],
        blockNumber,
      })) as RawPairRecord;
      if (/^0x0{40}$/i.test(record.token)) return null;
      return toRegistryPair(record, this.config.chainId);
    } catch (error) {
      return unavailable('registry pairOfToken', error);
    }
  }

  async templates(blockNumber: bigint): Promise<TemplateState[]> {
    try {
      const count = await this.client.readContract({ address: this.registry, abi: squareHoleRegistryAbi, functionName: 'templateCount', blockNumber });
      const versions = Array.from({ length: count }, (_, index) => index + 1);
      const rows = await Promise.all(
        versions.map(async (version) => {
          const [template, maxUnits] = await Promise.all([
            this.client.readContract({ address: this.registry, abi: squareHoleRegistryAbi, functionName: 'template', args: [version], blockNumber }),
            this.client.readContract({ address: this.registry, abi: squareHoleRegistryAbi, functionName: 'maxCollectionUnits', args: [version], blockNumber }),
          ]);
          const latest = await this.client.readContract({
            address: this.registry,
            abi: squareHoleRegistryAbi,
            functionName: 'latestTemplateFor',
            args: [template.quote],
            blockNumber,
          });
          return {
            version,
            quote: getAddress(template.quote),
            active: template.active,
            isLatestForQuote: latest === version,
            startFdvQ: template.startFdvQ,
            minStartUnitValueQ: template.minStartUnitValueQ,
            maxCollectionUnits: maxUnits,
            tickSpacing: template.tickSpacing,
            rangeTicks: template.rangeTicks,
            addedAtBlock: template.addedAtBlock,
          } satisfies TemplateState;
        }),
      );
      return rows;
    } catch (error) {
      return unavailable('registry templates', error);
    }
  }

  /** ERC-20 metadata of a quote asset (symbol is display only; identity is the address). Cached per address. */
  assetMeta(address: Address, blockNumber: bigint): Promise<AssetMeta> {
    const key = address.toLowerCase();
    let cached = this.assetCache.get(key);
    if (!cached) {
      cached = (async () => {
        try {
          const [symbol, decimals] = await Promise.all([
            this.client.readContract({ address, abi: erc20Abi, functionName: 'symbol', blockNumber }),
            this.client.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber }),
          ]);
          if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
            throw new ChainDataError('inconsistent_state', `Quote ${address} reports unsupported decimals`);
          }
          return { address: getAddress(address), symbol, decimals };
        } catch (error) {
          this.assetCache.delete(key);
          return unavailable(`asset metadata ${address}`, error);
        }
      })();
      this.assetCache.set(key, cached);
    }
    return cached;
  }

  /** name()/symbol() of T; immutable for both Square Hole templates, so cached. */
  tokenNames(token: Address, blockNumber: bigint): Promise<{ name: string; symbol: string }> {
    const key = token.toLowerCase();
    let cached = this.nameCache.get(key);
    if (!cached) {
      cached = (async () => {
        try {
          const [name, symbol] = await Promise.all([
            this.client.readContract({ address: token, abi: squareHoleTokenAbi, functionName: 'name', blockNumber }),
            this.client.readContract({ address: token, abi: squareHoleTokenAbi, functionName: 'symbol', blockNumber }),
          ]);
          return { name, symbol };
        } catch (error) {
          this.nameCache.delete(key);
          return unavailable(`token names ${token}`, error);
        }
      })();
      this.nameCache.set(key, cached);
    }
    return cached;
  }

  async slot0(poolId: Hex, blockNumber: bigint): Promise<{ slot0: Slot0; liquidity: bigint; source: PairChainState['poolStateSource'] }> {
    const uniswap = this.config.uniswap;
    if (!uniswap) throw new ChainDataError('inconsistent_state', 'No Uniswap v4 addresses for an undeployed chain');
    try {
      if (uniswap.stateView) {
        const [slot0, liquidity] = await Promise.all([
          this.client.readContract({ address: uniswap.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId], blockNumber }),
          this.client.readContract({ address: uniswap.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId], blockNumber }),
        ]);
        const [sqrtPriceX96, tick, protocolFee, lpFee] = slot0;
        return { slot0: { sqrtPriceX96, tick, protocolFee, lpFee }, liquidity, source: 'state_view' };
      }
      const slot = poolStateSlot(poolId);
      const liquiditySlot = `0x${(hexToBigInt(slot) + LIQUIDITY_OFFSET).toString(16).padStart(64, '0')}` as Hex;
      const [word, liquidityWord] = await Promise.all([
        this.client.readContract({ address: uniswap.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [slot], blockNumber }),
        this.client.readContract({ address: uniswap.poolManager, abi: poolManagerAbi, functionName: 'extsload', args: [liquiditySlot], blockNumber }),
      ]);
      return { slot0: decodeSlot0(word), liquidity: hexToBigInt(liquidityWord) & ((1n << 128n) - 1n), source: 'pool_manager_extsload' };
    } catch (error) {
      return unavailable(`pool state ${poolId}`, error);
    }
  }

  async pairState(pair: RegistryPair, block: BlockRef): Promise<PairChainState> {
    const blockNumber = block.number;
    const read = <T>(promise: Promise<T>): Promise<T> => promise;
    try {
      const names = this.tokenNames(pair.token, blockNumber);
      const [
        totalSupply,
        eligibleSupply,
        totalHolderQReceived,
        totalHolderQIndexed,
        totalClaimed,
        bootstrapQ,
        excludedAccounts,
        totalTReceived,
        totalTBurned,
        pendingBurnT,
        totalQReceived,
        totalQProtocol,
        totalQHolders,
        pool,
        lpFee,
      ] = await Promise.all([
        read(this.client.readContract({ address: pair.token, abi: squareHoleTokenAbi, functionName: 'totalSupply', blockNumber })),
        read(this.client.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'eligibleSupply', blockNumber })),
        read(this.client.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'totalHolderQReceived', blockNumber })),
        read(this.client.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'totalHolderQIndexed', blockNumber })),
        read(this.client.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'totalClaimed', blockNumber })),
        read(this.client.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'bootstrapQ', blockNumber })),
        read(this.client.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'excludedAccounts', blockNumber })),
        read(this.client.readContract({ address: pair.collector, abi: feeCollectorAbi, functionName: 'totalTReceived', blockNumber })),
        read(this.client.readContract({ address: pair.collector, abi: feeCollectorAbi, functionName: 'totalTBurned', blockNumber })),
        read(this.client.readContract({ address: pair.collector, abi: feeCollectorAbi, functionName: 'pendingBurnT', blockNumber })),
        read(this.client.readContract({ address: pair.collector, abi: feeCollectorAbi, functionName: 'totalQReceived', blockNumber })),
        read(this.client.readContract({ address: pair.collector, abi: feeCollectorAbi, functionName: 'totalQProtocol', blockNumber })),
        read(this.client.readContract({ address: pair.collector, abi: feeCollectorAbi, functionName: 'totalQHolders', blockNumber })),
        this.slot0(pair.poolId, blockNumber),
        read(this.client.readContract({ address: pair.hook, abi: squareHoleHookAbi, functionName: 'LP_FEE', blockNumber })),
      ]);
      const activeNftCount = pair.mirror
        ? await this.client.readContract({ address: pair.mirror, abi: dn404MirrorAbi, functionName: 'totalSupply', blockNumber })
        : null;
      const soldOut =
        pair.converter && pair.rewardSide === 'T'
          ? await this.client.readContract({
              address: pair.converter,
              abi: squareHoleClaimConverterAbi,
              functionName: 'isSoldOut',
              args: [pair.token],
              blockNumber,
            })
          : null;
      const { name, symbol } = await names;
      if (eligibleSupply > totalSupply) throw new ChainDataError('inconsistent_state', `eligible supply exceeds total supply for ${pair.pairId}`);
      if (totalSupply > pair.initialSupply) throw new ChainDataError('inconsistent_state', `supply above the initial supply for ${pair.pairId}`);
      return {
        block,
        name,
        symbol,
        totalSupply,
        eligibleSupply,
        activeNftCount,
        slot0: pool.slot0,
        poolLiquidity: pool.liquidity,
        poolStateSource: pool.source,
        ledger: {
          totalHolderQReceived,
          totalHolderQIndexed,
          totalClaimed,
          bootstrapQ,
          excludedAccounts: excludedAccounts.filter((account) => !/^0x0{40}$/i.test(account)).map((account) => getAddress(account)),
        },
        collector: { totalTReceived, totalTBurned, pendingBurnT, totalQReceived, totalQProtocol, totalQHolders },
        soldOut,
        lpFeePips: lpFee,
      };
    } catch (error) {
      return unavailable(`pair state ${pair.pairId}`, error);
    }
  }

  async totalSupply(token: Address, blockNumber: bigint): Promise<bigint> {
    try {
      return await this.client.readContract({ address: token, abi: squareHoleTokenAbi, functionName: 'totalSupply', blockNumber });
    } catch (error) {
      return unavailable(`totalSupply ${token}`, error);
    }
  }

  /** R = T only: the converter's sold-out trigger; null for R = Q pairs. */
  async isSoldOut(pair: RegistryPair, blockNumber: bigint): Promise<boolean | null> {
    if (pair.rewardSide !== 'T' || !pair.converter) return null;
    try {
      return await this.client.readContract({ address: pair.converter, abi: squareHoleClaimConverterAbi, functionName: 'isSoldOut', args: [pair.token], blockNumber });
    } catch (error) {
      return unavailable(`isSoldOut ${pair.pairId}`, error);
    }
  }

  /** Collections: the immutable baseURI (empty = no metadata published). Tokens: ''. */
  async baseURI(pair: RegistryPair, blockNumber: bigint): Promise<string> {
    if (!pair.mirror) return '';
    try {
      return await this.client.readContract({ address: pair.token, abi: squareHoleTokenAbi, functionName: 'baseURI', blockNumber });
    } catch (error) {
      return unavailable(`baseURI ${pair.pairId}`, error);
    }
  }

  async accountPairState(pair: RegistryPair, account: Address, blockNumber: bigint): Promise<AccountPairState> {
    try {
      const [balance, claimable] = await Promise.all([
        this.client.readContract({ address: pair.token, abi: squareHoleTokenAbi, functionName: 'balanceOf', args: [account], blockNumber }),
        this.client.readContract({ address: pair.ledger, abi: rewardLedgerAbi, functionName: 'claimable', args: [account], blockNumber }),
      ]);
      if (!pair.mirror) return { balance, claimable, nftCount: null, nftIds: [] };
      const nftCount = await this.client.readContract({ address: pair.mirror, abi: dn404MirrorAbi, functionName: 'balanceOf', args: [account], blockNumber });
      const wanted = nftCount < MAX_NFT_IDS_PER_POSITION ? nftCount : MAX_NFT_IDS_PER_POSITION;
      const nftIds =
        wanted === 0n
          ? []
          : await this.client.readContract({ address: pair.token, abi: squareHoleTokenAbi, functionName: 'ownedIds', args: [account, 0n, wanted], blockNumber });
      return { balance, claimable, nftCount, nftIds: [...nftIds] };
    } catch (error) {
      return unavailable(`account state ${pair.pairId}`, error);
    }
  }

  /**
   * eth_call quote of converting exactly `qIn` raw Q into T on the pair's canonical pool (the conversion's own swap,
   * fee included). Primary: the canonical V4Quoter (`quoteExactInputSingle`, same PoolKey and direction as the
   * converter). Fallback where no V4Quoter exists (local anvil): an eth_call of the holder's own whole-entitlement
   * `claimAsT(pairId, 0, deadline)` on the converter. Both are reads; nothing is signed or sent.
   */
  async quoteConversion(pair: RegistryPair, holder: Address, qIn: bigint, blockNumber: bigint, deadline: bigint): Promise<ConversionQuote> {
    if (qIn <= 0n) return { ok: false, reason: 'empty_entitlement' };
    if (pair.rewardSide !== 'T' || !pair.converter) return { ok: false, reason: 'no_quote_source' };
    const quoter = this.config.uniswap?.v4Quoter ?? null;
    try {
      if (quoter) {
        const lpFee = await this.client.readContract({ address: pair.hook, abi: squareHoleHookAbi, functionName: 'LP_FEE', blockNumber });
        const qIsCurrency0 = !pair.tIsCurrency0;
        const data = encodeFunctionData({
          abi: v4QuoterAbi,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              poolKey: {
                currency0: qIsCurrency0 ? pair.quote : pair.token,
                currency1: qIsCurrency0 ? pair.token : pair.quote,
                fee: lpFee,
                tickSpacing: pair.tickSpacing,
                hooks: pair.hook,
              },
              zeroForOne: qIsCurrency0,
              exactAmount: qIn,
              hookData: '0x',
            },
          ],
        });
        const result = await this.client.call({ to: quoter, data, blockNumber });
        if (!result.data) return { ok: false, reason: 'quote_reverted' };
        const [amountOut] = decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', data: result.data });
        return amountOut > 0n ? { ok: true, tOut: amountOut, source: 'v4_quoter_eth_call' } : { ok: false, reason: 'zero_output' };
      }
      const data = encodeFunctionData({
        abi: squareHoleClaimConverterAbi,
        functionName: 'claimAsT',
        args: [pair.registryPairId, 0n, deadline],
      });
      const result = await this.client.call({ account: holder, to: pair.converter, data, blockNumber });
      if (!result.data) return { ok: false, reason: 'quote_reverted' };
      const [qUsed, tOut] = decodeFunctionResult({
        abi: squareHoleClaimConverterAbi,
        functionName: 'claimAsT',
        args: [pair.registryPairId, 0n, deadline],
        data: result.data,
      });
      if (qUsed !== qIn) throw new ChainDataError('inconsistent_state', `the conversion would consume ${qUsed}, not the claimable ${qIn}`);
      return tOut > 0n ? { ok: true, tOut, source: 'converter_eth_call' } : { ok: false, reason: 'zero_output' };
    } catch (error) {
      if (isAbortError(error) || error instanceof ChainDataError) throw error;
      if (isExecutionRevert(error)) return { ok: false, reason: 'quote_reverted' };
      return unavailable(`conversion quote ${pair.pairId}`, error);
    }
  }
}

/** viem's transport-level failures: the request never got an EVM answer. */
const TRANSPORT_ERRORS = new Set(['HttpRequestError', 'TimeoutError', 'WebSocketRequestError', 'SocketClosedError']);
/** viem's names for "the EVM ran the call and it reverted". */
const REVERT_ERRORS = new Set(['ContractFunctionRevertedError', 'ExecutionRevertedError', 'RawContractError']);

/**
 * An eth_call that reached the EVM and reverted, as opposed to a transport failure. viem wraps EVERY `call` failure in
 * a `CallExecutionError` (utils/errors/getCallError.ts), outages and timeouts included, so the wrapper proves nothing:
 * the cause chain must name a revert, and any transport error in it makes the answer "unavailable" instead.
 */
function isExecutionRevert(error: unknown): boolean {
  let current: unknown = error;
  let reverted = false;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const name = current.name;
    if (TRANSPORT_ERRORS.has(name)) return false;
    if (REVERT_ERRORS.has(name)) reverted = true;
    current = (current as { cause?: unknown }).cause;
  }
  return reverted;
}
