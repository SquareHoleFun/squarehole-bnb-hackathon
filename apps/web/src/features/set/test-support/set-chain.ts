/**
 * TEST ONLY (SH-EXISTING-NFTS-E08C): an in-memory chain for the existing-NFTs add-on, with an outside ERC-721, a price
 * coin, the add-on's factory, registry and listing registry, and every box it creates (coordinator, token, SetVault,
 * loader, hook). It answers `SetReads` (view calls, code, estimates and receipts) and plays E-08B's executor
 * (`submit`): E-08B's real guard first (`assertSendableSetCallV2` / `assertSendableSetCreate`, exactly as `submitWrite`
 * and `submitSetCreateWrite` run it), then each call is decoded by its target's ABI and applied as the contracts would,
 * or refused (reverted). `walletFor` is a browser wallet over the same chain, for tests that drive the real executor.
 * Amounts and ids are bigint; nothing here reaches a network.
 */
import {
  BaseError, ContractFunctionRevertedError, decodeFunctionData, encodeFunctionResult, encodePacked, erc20Abi, getAddress, keccak256, parseAbi, stringToHex,
  toFunctionSelector, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hex,
} from 'viem';
import { SET_TEMPLATE, decodeSetSpecV2, encodeSetSpecV2, quoteSetPick, quoteSetReturn, setLinkHash, type SetSpecV2 } from '@squarehole/box-spec';
import {
  parseSetManifest, setCoordinatorV2Abi, setFactoryV2Abi, setListingRegistryV2Abi, setRegistryV2Abi, setStarterSetLoaderV2Abi, setTokenV2Abi, setVaultV2Abi,
} from '@squarehole/chain/core/set-v2';
import { setManifestInput } from '../../../../../../packages/chain/src/core/set-v2/test-support';
import { synthManifestV2, synthManifestV2Json } from '../../../../../../packages/chain/src/core/v2/test-support/synth-v2';
import { standardRuntime } from '../../../../../../packages/chain/src/core/v2';
import type { SetSource } from '../set-build';
import { EIP7825_TX_GAS_CAP, RpcRequestError, assertSendableSetCallV2, assertSendableSetCreate, type ChainReader } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { ERC721_ABI, setCreatePlanOf, setTargetV2Of, type SetSendRequest } from '../set-calls';
import { loaderArgsOf } from '../set-identity';
import type { SetGasRequest, SetReads } from '../set-reads';

export const label = (text: string): Address => getAddress(`0x${keccak256(stringToHex(text)).slice(-40)}`);
export const CREATOR = label('set test creator');
export const HOLDER = label('set test holder');
export const OTHER = label('set test other');
export const COLLECTION = label('set test outside collection');
export const P_COIN = getAddress('0x0000000000000000000000000000000000001234');
export const VAULT_CODE: Hex = '0x60016001016000526020600060003960206000f3';
export const LOADER_CODE: Hex = '0x60026002016000526020600060003960206000f3';
export const BOOTSTRAP = 4_206_980_085_000_000n;
export const RAISE_ETH = 4_206_980_085_000_000_000n;
export const RAISE_P = 15_000_000_000n;
const E18 = 10n ** 18n;
const MAX = (1n << 256n) - 1n;

/** The add-on's local manifest with implementation pins whose code this chain serves (raw JSON). */
export function setManifestJson(): ReturnType<typeof setManifestInput> {
  const input = setManifestInput();
  return { ...input, implementations: { ...input.implementations, vault: { ...input.implementations.vault, codeHash: keccak256(VAULT_CODE) }, starterSetLoader: { ...input.implementations.starterSetLoader, codeHash: keccak256(LOADER_CODE) } } };
}

/** The add-on on a local source, parsed as set-build.ts parses it. */
export function testSetSource(patch: Partial<SetSource> = {}): SetSource {
  const core = synthManifestV2();
  const release = parseSetManifest(setManifestJson(), synthManifestV2Json());
  return { network: 'local', chainId: release.chainId, core, release, rpc: 'http://127.0.0.1:8599', origin: 'http://127.0.0.1:8597', art: ['http://127.0.0.1:8596'], ...patch };
}

/** A contract's refusal, as viem reports one (a ContractFunctionRevertedError inside) with its revert data. */
export class Reverted extends BaseError {
  readonly data: Hex;
  constructor(reason: string, data: Hex = toFunctionSelector('InvalidRequest()')) {
    super(`execution reverted: ${reason}`, { cause: new ContractFunctionRevertedError({ abi: [], functionName: 'call', message: reason }) });
    this.data = data;
  }
}

type Member = 'Inside' | 'Outside' | 'Released';

export interface FakeBox {
  readonly boxId: bigint;
  readonly coordinator: Address;
  readonly token: Address;
  readonly vault: Address;
  readonly loader: Address;
  readonly hook: Address;
  readonly spec: SetSpecV2;
  readonly encoded: Hex;
  readonly roles: readonly Address[];
  readonly ids: readonly bigint[];
  loaded: number;
  remaining: Hex;
  notified: boolean;
  tradingOpen: boolean;
  /** When the coordinator's trading gate opened (its effectiveOpenAt); 0 while it holds. */
  effectiveOpenAt: bigint;
  /** The vault's conversion gate (graduation). */
  gateOpen: boolean;
  failed: boolean;
  supply: bigint;
  escrow: bigint;
  inside: bigint;
  members: Map<string, Member>;
  tBalance: Map<string, bigint>;
  tAllowance: Map<string, bigint>;
  pot: bigint;
  tLeft: bigint;
  openAt: bigint;
  deadline: bigint;
  hookClosed: boolean;
  closedAt: bigint;
}

export interface SentCall {
  readonly kind: string;
  readonly to: Address;
  readonly from: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly gasLimit: bigint;
  readonly fn: string;
  readonly args: readonly unknown[];
}

const key = (a: string) => a.toLowerCase();
const pair = (a: string, b: string) => `${key(a)}:${key(b)}`;
const HOOK_ABI = parseAbi(['function closed() view returns (bool)', 'function closedAt() view returns (uint256)']);
/** A block's hash on this chain: a function of its number (the same block reads the same hash). */
export const blockHash = (block: bigint): Hex => keccak256(toHex(block));

export interface FakeChainOptions {
  readonly ids?: readonly bigint[];
  readonly native?: boolean;
  /** Load pages above this many items revert TransferGas() in the estimate (null: never). */
  readonly transferGasAbove?: number | null;
  /** Each loaded item's estimated gas (a page of 16 at 1.1M is over the cap once the fifth is added). */
  readonly loadGasPerItem?: bigint;
}

export class FakeSetChain implements SetReads {
  readonly source: SetSource;
  readonly chainIdValue: number;
  block = 100n;
  time = 1_800_000_000n;
  readonly owners = new Map<string, Address>();
  readonly itemApprovals = new Map<string, Address>();
  readonly operators = new Set<string>();
  readonly tokenUris = new Map<string, unknown>();
  readonly pBalance = new Map<string, bigint>();
  readonly pAllowance = new Map<string, bigint>();
  readonly boxes: FakeBox[] = [];
  readonly sent: SentCall[] = [];
  readonly statuses = new Map<string, 'success' | 'reverted'>();
  /** Hashes the node has seen but not mined (a pending transaction). */
  readonly pending = new Set<string>();
  /** Who sent each graduate() this chain mined. */
  readonly graduations: Address[] = [];
  /** Every view call made, as `fn` names (to show when reads happen). */
  readonly calls: string[] = [];
  native: boolean;
  transferGasAbove: number | null;
  loadGasPerItem: bigint;
  /** Owner reads that fail without an answer (an RPC that times out), by id. */
  readonly downIds = new Set<string>();
  /** While true, a sent call stays pending until it is waited for (a block not mined yet). */
  hold = false;
  /** The next wait gives up without an answer (the page closed, the RPC dropped); the call stays pending. */
  failNextWait = false;
  /** Serve another runtime at every box's vault (a clone of something else). */
  badVault = false;
  private readonly held = new Map<string, () => void>();

  constructor(options: FakeChainOptions = {}) {
    this.source = testSetSource();
    this.chainIdValue = this.source.chainId;
    this.native = options.native ?? true;
    this.transferGasAbove = options.transferGasAbove ?? null;
    this.loadGasPerItem = options.loadGasPerItem ?? 200_000n;
    for (const id of options.ids ?? []) this.owners.set(id.toString(), CREATOR);
    this.pBalance.set(key(CREATOR), 10n ** 30n);
  }

  get release() { return this.source.release; }
  get box(): FakeBox {
    const box = this.boxes.at(-1);
    if (!box) throw new Error('no box yet');
    return box;
  }

  /** The listing book: 0 is ETH, 1 a six-decimal coin. */
  /** Added to every listing's bootstrap (a factory whose terms moved after a plan was prepared). */
  bootstrapExtra = 0n;

  listing(id: number) {
    const q = { bootstrapQ: (id === 0 ? BOOTSTRAP : 15_000_000n) + this.bootstrapExtra, batchMinQ: 1n, tipMaxQ: 1n, swapStepMinQ: 1n };
    return id === 0
      ? { id: 0, token: zeroAddress, decimals: 18, class: 1, kind: 1, listedAt: 1n, raise: RAISE_ETH, q }
      : { id: 1, token: P_COIN, decimals: 6, class: 3, kind: 1, listedAt: 2n, raise: RAISE_P, q };
  }

  // ---- SetReads ------------------------------------------------------------------------------------------------
  chainId = async () => this.chainIdValue;
  blockNumber = async () => this.block;
  timestamp = async () => this.time;

  /**
   * E-08B's ChainReader over this chain (for `prepareSetConversion` and `readSetLoadPlan`): eth_call decoded with its
   * target's ABI and answered as `read` would, a revert as an RPC error with its data; blocks by number.
   */
  readonly chain: ChainReader = {
    chainId: async () => this.chainIdValue,
    blockNumber: async () => this.block,
    getBlock: async (block) => {
      const number = typeof block === 'bigint' ? block : this.block;
      return { number, hash: blockHash(number), timestamp: this.time, baseFeePerGas: 1n, transactions: [] };
    },
    call: async (request) => {
      const abi = this.abiAt(request.to);
      const decoded = decodeFunctionData({ abi, data: request.data });
      let result: unknown;
      try {
        result = await this.read(request.to, abi, decoded.functionName, decoded.args ?? []);
      } catch (error) {
        if (error instanceof Reverted) throw new RpcRequestError('execution reverted', 3, error.data);
        throw error;
      }
      return encodeFunctionResult({ abi, functionName: decoded.functionName, result } as never);
    },
    estimateGas: async (request) => this.estimateGas({ account: request.from ?? zeroAddress, to: request.to, data: request.data, value: request.value ?? 0n }),
    maxPriorityFeePerGas: async () => 1n,
    getTransaction: async () => null,
    getReceipt: async () => null,
    getTransactionCount: async () => 0n,
    // SH-SEND-FEES: every account can pay a send's most fee here (1,000 ETH).
    getBalance: async () => 10n ** 21n,
  };

  /** The ABI this chain answers calls to `to` with. */
  private abiAt(to: Address): Abi {
    const t = key(to);
    const r = this.release;
    if (t === key(r.factory.address)) return setFactoryV2Abi;
    if (t === key(r.registry.address)) return setRegistryV2Abi;
    if (t === key(r.listingRegistry.address)) return setListingRegistryV2Abi;
    if (t === key(COLLECTION)) return ERC721_ABI;
    if (t === key(P_COIN)) return erc20Abi;
    for (const box of this.boxes) {
      if (t === key(box.loader)) return setStarterSetLoaderV2Abi;
      if (t === key(box.vault)) return setVaultV2Abi;
      if (t === key(box.token)) return setTokenV2Abi;
      if (t === key(box.coordinator)) return setCoordinatorV2Abi;
      if (t === key(box.hook)) return HOOK_ABI;
    }
    return this.fail(`no contract at ${to}`);
  }
  blockGasLimit = async () => 36_000_000n;
  code = async (address: Address): Promise<Hex> => {
    if (key(address) === key(this.release.implementations.vault.address)) return VAULT_CODE;
    if (key(address) === key(this.release.implementations.starterSetLoader.address)) return LOADER_CODE;
    for (const box of this.boxes) {
      if (key(address) === key(box.vault)) return standardRuntime(this.badVault ? label('another vault') : this.release.implementations.vault.address, this.vaultArgs(box));
      if (key(address) === key(box.loader)) return standardRuntime(this.release.implementations.starterSetLoader.address, loaderArgsOf(box.coordinator, box.vault, box.spec));
      if (key(address) === key(box.coordinator)) return '0x6080604052';
    }
    return '0x';
  };

  vaultArgs(box: Pick<FakeBox, 'coordinator' | 'token' | 'loader' | 'spec'>, creator: Address = CREATOR): Hex {
    return encodePacked(['address', 'address', 'address', 'address', 'address', 'uint32', 'bytes32', 'uint16'],
      [box.coordinator, box.token, box.loader, creator, box.spec.collection, box.spec.count, box.spec.setHash, box.spec.pickFeeBps]);
  }

  read = async (address: Address, _abi: Abi, fn: string, args: readonly unknown[] = []): Promise<unknown> => {
    this.calls.push(fn);
    const to = key(address);
    const r = this.release;
    if (to === key(r.factory.address)) return this.factoryRead(fn, args);
    if (to === key(r.listingRegistry.address)) {
      if (fn === 'listingCount') return 2;
      if (fn === 'listing') return this.listing(args[0] as number);
    }
    if (to === key(r.registry.address)) {
      if (fn === 'boxIdOf') {
        const box = this.boxes.find((b) => key(b.coordinator) === key(args[0] as string));
        return box ? [true, box.boxId] as const : [false, 0n] as const;
      }
      if (fn === 'recordOf') return this.record(this.boxes.find((b) => b.boxId === args[0]) ?? this.fail('no record'));
    }
    if (to === key(COLLECTION)) return this.collectionRead(fn, args);
    if (to === key(P_COIN)) {
      if (fn === 'allowance') return this.pAllowance.get(pair(args[0] as string, args[1] as string)) ?? 0n;
      if (fn === 'balanceOf') return this.pBalance.get(key(args[0] as string)) ?? 0n;
      if (fn === 'symbol') return 'USDC';
      if (fn === 'decimals') return 6;
    }
    for (const box of this.boxes) {
      if (to === key(box.loader) && fn === 'progress') return [box.loaded, box.remaining, box.notified] as const;
      if (to === key(box.vault)) return this.vaultRead(box, fn, args);
      if (to === key(box.token)) {
        if (fn === 'totalSupply') return box.supply;
        if (fn === 'balanceOf') return box.tBalance.get(key(args[0] as string)) ?? 0n;
        if (fn === 'allowance') return box.tAllowance.get(pair(args[0] as string, args[1] as string)) ?? 0n;
        if (fn === 'decimals') return 18;
        if (fn === 'symbol') return box.spec.tokenSymbol;
      }
      if (to === key(box.coordinator)) return this.coordinatorRead(box, fn, args);
      if (to === key(box.hook)) return fn === 'closed' ? box.hookClosed : box.closedAt;
    }
    return this.fail(`no ${fn} at ${address}`);
  };

  private fail(reason: string): never {
    throw new Reverted(reason);
  }

  private factoryRead(fn: string, args: readonly unknown[]): unknown {
    const r = this.release;
    switch (fn) {
      case 'registry': return r.registry.address;
      case 'listingRegistry': return r.listingRegistry.address;
      case 'refusal': return '0x';
      case 'boxQParameters': return this.listing(args[0] as number).q;
      case 'tokenAddressLimit': { const p = BigInt(args[0] as string); return getAddress(toHex(p + ((1n << 160n) - p) / 2n, { size: 20 })); }
      case 'predictBox': return this.predict(args[0] as Address, args[1] as SetSpecV2, args[2] as Hex);
      case 'versionCodeHash': return r.versionCodeHash;
      case 'RELEASE': return r.release;
      case 'TEMPLATE': return r.templateId;
      default: return this.fail(`factory ${fn}`);
    }
  }

  predict(creator: Address, spec: SetSpecV2, cs: Hex): readonly [Address, Address, Hex] {
    const seed = keccak256(encodePacked(['address', 'bytes32', 'bytes32'], [creator, keccak256(encodeSetSpecV2(spec)), cs]));
    const coordinator = getAddress(`0x${keccak256(`${seed}01`).slice(-40)}`);
    // The token sits above the price coin and below its limit: a small address above P_COIN.
    const token = getAddress(`0x00${keccak256(`${seed}02`).slice(-38)}`);
    return [coordinator, token, keccak256(`${seed}03`)];
  }

  private record(box: FakeBox) {
    return { boxId: box.boxId, templateId: SET_TEMPLATE, specHash: keccak256(box.encoded), creator: CREATOR, pricingListingId: box.spec.pricing.listingId,
      q: box.spec.pricing.token, raise: box.spec.raise, poolManager: this.release.poolManager.address, poolId: zeroHash, creationBlock: 100n, openAt: box.openAt,
      randomness: zeroAddress, contracts: box.roles, codeHashes: box.roles.map(() => zeroHash) };
  }

  private collectionRead(fn: string, args: readonly unknown[]): unknown {
    const id = (args[0] as bigint)?.toString();
    if (fn === 'ownerOf') {
      if (this.downIds.has(id)) throw new Error('The request took too long to respond.');
      return this.owners.get(id) ?? this.fail('ERC721NonexistentToken');
    }
    if (fn === 'getApproved') return this.itemApprovals.get(id) ?? zeroAddress;
    if (fn === 'isApprovedForAll') return this.operators.has(pair(args[0] as string, args[1] as string));
    if (fn === 'tokenURI') {
      const uri = this.tokenUris.get(id);
      if (uri === undefined) return this.fail('no uri');
      return typeof uri === 'function' ? (uri as () => unknown)() : uri;
    }
    return this.fail(`collection ${fn}`);
  }

  private snapshot(box: FakeBox) {
    return { supply: box.supply, escrow: box.escrow, inside: box.inside, count: BigInt(box.spec.count) };
  }

  private vaultRead(box: FakeBox, fn: string, args: readonly unknown[]): unknown {
    switch (fn) {
      case 'failed': return box.failed;
      case 'gateOpen': return box.gateOpen;
      case 'inside': return box.inside;
      case 'loaded': return BigInt(box.loaded);
      case 'collectionSize': return BigInt(box.spec.count);
      case 'escrowPrincipal': return box.escrow;
      case 'pickFeeBps': return BigInt(box.spec.pickFeeBps);
      case 'seedReady': return box.loaded === box.spec.count && !box.failed;
      case 'eligible': return box.members.has((args[0] as bigint).toString());
      case 'isOutside': return box.members.get((args[0] as bigint).toString()) === 'Outside';
      case 'quoteWithdraw': if (!box.gateOpen) this.fail('GateClosed'); return quoteSetPick(this.snapshot(box), args[0] as bigint, BigInt(box.spec.pickFeeBps)).principal;
      case 'quoteReturn': if (!box.gateOpen) this.fail('GateClosed'); return quoteSetReturn(this.snapshot(box), args[0] as bigint).principal;
      default: return this.fail(`vault ${fn}`);
    }
  }

  private coordinatorRead(box: FakeBox, fn: string, args: readonly unknown[]): unknown {
    switch (fn) {
      case 'failed': return box.failed;
      case 'graduated': return box.gateOpen;
      case 'gateOpen': return box.tradingOpen;
      case 'effectiveOpenAt': return box.tradingOpen ? box.effectiveOpenAt : 0n;
      case 'openAt': return box.openAt;
      case 'deadline': return box.deadline;
      case 'hook': return box.hook;
      case 'registry': return this.release.registry.address;
      case 'roleAddress': return box.roles[Number(args[0] as bigint)] ?? zeroAddress;
      case 'claimState': return [box.pot, box.tLeft] as const;
      case 'quoteClaim': if (args[0] !== 0n || box.tLeft !== 0n) this.fail('InvalidClaim'); return 7n;
      default: return this.fail(`coordinator ${fn}`);
    }
  }

  estimateGas = async (request: SetGasRequest): Promise<bigint> => {
    for (const box of this.boxes) {
      if (key(request.to) === key(box.loader)) {
        const call = decodeFunctionData({ abi: setStarterSetLoaderV2Abi, data: request.data });
        if (call.functionName === 'load') {
          const n = (call.args[1] as readonly bigint[]).length;
          if (this.transferGasAbove !== null && n > this.transferGasAbove) throw new Reverted('TransferGas', toFunctionSelector('TransferGas()'));
          return 100_000n + this.loadGasPerItem * BigInt(n);
        }
      }
    }
    if (key(request.to) === key(this.release.factory.address)) return 3_000_000n;
    return 120_000n;
  };

  receipt = async (hash: Hex) => (this.pending.has(hash) ? null : this.statuses.get(hash) ?? null);
  known = async (hash: Hex) => this.pending.has(hash) || this.statuses.has(hash);
  wait = async (hash: Hex): Promise<'success' | 'reverted'> => {
    if (this.failNextWait) {
      this.failNextWait = false;
      throw new Error('The request took too long to respond.');
    }
    const apply = this.held.get(hash);
    if (apply) {
      this.held.delete(hash);
      this.pending.delete(hash);
      apply();
    }
    const status = this.statuses.get(hash);
    if (!status) throw new Error('unknown transaction');
    return status;
  };

  // ---- E-08B's executor, played -------------------------------------------------------------------------------
  /** Sends a checked call: E-08B's guard (a refusal throws, nothing is sent), then decoded by its target and applied
   *  at once (mined), or marked reverted. */
  submit = async (request: SetSendRequest): Promise<Hex> => {
    const { call, from, gasLimit, target } = request;
    const raw = { to: call.to, data: call.data, value: call.value };
    if (target.kind === 'create') assertSendableSetCreate(raw, setCreatePlanOf(target), from);
    else assertSendableSetCallV2(raw, setTargetV2Of(target), from);
    if (gasLimit <= 0n || gasLimit > EIP7825_TX_GAS_CAP) throw new Error('set gas limit out of range');
    return this.mine(call.kind, from, raw, gasLimit);
  };

  /**
   * A browser wallet on this chain with one account: what E-08B's executor asks before it sends (eth_chainId,
   * eth_accounts), then eth_sendTransaction, mined here. Every request is recorded in `requests`.
   */
  walletFor(account: Address, requests: { method: string; params?: unknown }[] = []): Eip1193Request {
    return async ({ method, params }) => {
      requests.push({ method, params });
      if (method === 'eth_chainId') return toHex(this.chainIdValue);
      if (method === 'eth_accounts') return [account];
      if (method !== 'eth_sendTransaction') throw new Error(`The test wallet does not answer ${method}.`);
      const [tx] = params as readonly [{ readonly from: Address; readonly to: Address; readonly data: Hex; readonly value: Hex; readonly gas: Hex; readonly chainId: Hex }];
      if (key(tx.from) !== key(account) || BigInt(tx.chainId) !== BigInt(this.chainIdValue)) throw new Error('The test wallet signs only for its account on its chain.');
      return this.mine('wallet', tx.from, { to: tx.to, data: tx.data, value: BigInt(tx.value) }, BigInt(tx.gas));
    };
  }

  private mine(kind: string, from: Address, call: { readonly to: Address; readonly data: Hex; readonly value: bigint }, gasLimit: bigint): Hex {
    const hash = keccak256(toHex(`tx ${this.sent.length} ${call.to} ${call.data}`));
    const entry = { kind, to: call.to, from, data: call.data, value: call.value, gasLimit, fn: 'unknown', args: [] as readonly unknown[] };
    const mine = () => {
      try {
        const done = this.apply(from, call.to, call.data, call.value);
        entry.fn = done.fn;
        entry.args = done.args;
        this.statuses.set(hash, 'success');
        this.block += 1n;
      } catch {
        this.statuses.set(hash, 'reverted');
      }
    };
    this.sent.push(entry);
    if (this.hold) {
      this.pending.add(hash);
      this.held.set(hash, mine);
    } else mine();
    return hash;
  }

  private apply(from: Address, to: Address, data: Hex, value: bigint): { fn: string; args: readonly unknown[] } {
    const target = key(to);
    if (target === key(P_COIN)) {
      const call = decodeFunctionData({ abi: erc20Abi, data });
      if (call.functionName !== 'approve') this.fail('coin');
      this.pAllowance.set(pair(from, call.args[0] as string), call.args[1] as bigint);
      return { fn: call.functionName, args: call.args };
    }
    if (target === key(this.release.factory.address)) {
      const call = decodeFunctionData({ abi: setFactoryV2Abi, data });
      if (call.functionName !== 'createBox') this.fail('factory');
      this.create(from, call.args[0] as SetSpecV2, call.args[1] as Hex, value);
      return { fn: call.functionName, args: call.args };
    }
    if (target === key(COLLECTION)) {
      const call = decodeFunctionData({ abi: ERC721_ABI, data });
      if (call.functionName === 'setApprovalForAll') {
        const [operator, approved] = call.args as readonly [Address, boolean];
        if (approved) this.operators.add(pair(from, operator)); else this.operators.delete(pair(from, operator));
      } else if (call.functionName === 'approve') {
        const [spender, id] = call.args as readonly [Address, bigint];
        if (key(this.owners.get(id.toString()) ?? '') !== key(from)) this.fail('not owner');
        this.itemApprovals.set(id.toString(), spender);
      } else this.fail('collection');
      return { fn: call.functionName, args: call.args };
    }
    for (const box of this.boxes) {
      if (target === key(box.loader)) return this.loaderCall(box, from, data);
      if (target === key(box.vault)) return this.vaultCall(box, from, data);
      if (target === key(box.token)) {
        const call = decodeFunctionData({ abi: setTokenV2Abi, data });
        if (call.functionName !== 'approve') this.fail('token');
        box.tAllowance.set(pair(from, call.args[0] as string), call.args[1] as bigint);
        return { fn: call.functionName, args: call.args };
      }
      if (target === key(box.coordinator)) return this.coordinatorCall(box, from, data);
    }
    return this.fail('unknown target');
  }

  create(from: Address, spec: SetSpecV2, cs: Hex, value: bigint): void {
    const payment = this.listing(spec.pricing.listingId).q.bootstrapQ + spec.creatorBuy;
    if (/^0x0{40}$/i.test(spec.pricing.token)) {
      if (value !== payment) this.fail('value');
    } else {
      const allowance = this.pAllowance.get(pair(from, this.release.factory.address)) ?? 0n;
      if (value !== 0n || allowance < payment) this.fail('payment');
      this.pAllowance.set(pair(from, this.release.factory.address), allowance - payment);
    }
    const [coordinator, token] = this.predict(from, spec, cs);
    if (this.boxes.some((b) => key(b.coordinator) === key(coordinator))) this.fail('exists');
    const encoded = encodeSetSpecV2(spec);
    const n = this.boxes.length;
    const roles: Address[] = Array<Address>(24).fill(zeroAddress);
    const names: Record<number, string> = { 0: 'coordinator', 1: 'token', 2: 'hook', 3: 'vault', 5: 'receiver', 6: 'router', 19: 'loader' };
    for (const [role, name] of Object.entries(names)) roles[Number(role)] = label(`box ${n} ${name}`);
    roles[0] = coordinator;
    roles[1] = token;
    const box: FakeBox = {
      boxId: BigInt(n), coordinator, token, vault: roles[3] as Address, loader: roles[19] as Address, hook: roles[2] as Address, spec, encoded, roles,
      ids: [], loaded: 0, remaining: spec.setHash, notified: false, tradingOpen: false, effectiveOpenAt: 0n, gateOpen: false, failed: false,
      supply: 1_000_000_000n * E18, escrow: 0n, inside: 0n, members: new Map(), tBalance: new Map(), tAllowance: new Map(),
      pot: 0n, tLeft: 0n, openAt: this.time, deadline: 0n, hookClosed: false, closedAt: 0n,
    };
    this.boxes.push(box);
  }

  private loaderCall(box: FakeBox, from: Address, data: Hex) {
    const call = decodeFunctionData({ abi: setStarterSetLoaderV2Abi, data });
    if (box.failed || box.notified) this.fail('loader closed');
    if (call.functionName === 'complete') {
      if (box.loaded !== box.spec.count || box.remaining !== zeroHash) this.fail('incomplete');
      box.notified = true;
      box.tradingOpen = true;
      box.effectiveOpenAt = this.time + 1n; // as BoxCoordinatorV2._openGate: one second after the completing block
      box.deadline = this.time + BigInt(box.spec.deadlineDays) * 86_400n;
      return { fn: call.functionName, args: [] as readonly unknown[] };
    }
    if (call.functionName !== 'load') this.fail('loader');
    if (key(from) !== key(CREATOR)) this.fail('Unauthorized');
    const [collections, ids, tiers, nextHash] = call.args as readonly [readonly Address[], readonly bigint[], readonly number[], Hex];
    const end = box.loaded + ids.length;
    if (ids.length === 0 || ids.length > 32 || end > box.spec.count || (end === box.spec.count) !== (nextHash === zeroHash)) this.fail('page');
    let hash = nextHash;
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      if (key(collections[i] as string) !== key(box.spec.collection) || tiers[i] !== 0) this.fail('page item');
      hash = setLinkHash(box.spec.collection, ids[i] as bigint, hash);
    }
    if (hash !== box.remaining) this.fail('hash');
    for (const id of ids) {
      const owner = this.owners.get(id.toString());
      if (key(owner ?? '') !== key(CREATOR) || !this.operators.has(pair(CREATOR, box.vault))) this.fail('pull');
    }
    for (const id of ids) {
      this.owners.set(id.toString(), box.vault);
      box.members.set(id.toString(), 'Inside');
    }
    box.loaded = end;
    box.inside += BigInt(ids.length);
    box.remaining = nextHash;
    return { fn: call.functionName, args: call.args };
  }

  private vaultCall(box: FakeBox, from: Address, data: Hex) {
    const call = decodeFunctionData({ abi: setVaultV2Abi, data });
    const ids = (call.args?.[0] ?? []) as readonly bigint[];
    if (call.functionName === 'withdrawBatch') {
      const [, maxIn, deadline] = call.args as readonly [readonly bigint[], bigint, bigint];
      if (!box.gateOpen || box.failed || this.time > deadline) this.fail('closed');
      if (ids.some((id) => box.members.get(id.toString()) !== 'Inside')) this.fail('IneligibleId');
      const q = quoteSetPick(this.snapshot(box), BigInt(ids.length), BigInt(box.spec.pickFeeBps));
      if (q.tokenIn > maxIn) this.fail('MaxTokenExceeded');
      const allowance = box.tAllowance.get(pair(from, box.vault)) ?? 0n;
      const balance = box.tBalance.get(key(from)) ?? 0n;
      if (allowance < q.tokenIn || balance < q.tokenIn) this.fail('pull');
      box.tAllowance.set(pair(from, box.vault), allowance - q.tokenIn);
      box.tBalance.set(key(from), balance - q.tokenIn);
      box.escrow += q.principal;
      box.supply -= q.fee;
      box.inside -= BigInt(ids.length);
      for (const id of ids) { box.members.set(id.toString(), 'Outside'); this.owners.set(id.toString(), from); }
      return { fn: call.functionName, args: call.args };
    }
    if (call.functionName === 'returnItems') {
      const [, minOut, deadline] = call.args as readonly [readonly bigint[], bigint, bigint];
      if (!box.gateOpen || box.failed || this.time > deadline) this.fail('closed');
      for (const id of ids) {
        if (box.members.get(id.toString()) !== 'Outside' || key(this.owners.get(id.toString()) ?? '') !== key(from)) this.fail('NotOwner');
        const ok = key(this.itemApprovals.get(id.toString()) ?? '') === key(box.vault) || this.operators.has(pair(from, box.vault));
        if (!ok) this.fail('not approved');
      }
      const q = quoteSetReturn(this.snapshot(box), BigInt(ids.length));
      if (q.tokenOut < minOut) this.fail('MinTokenNotMet');
      box.escrow -= q.principal;
      box.supply -= q.fee;
      box.inside += BigInt(ids.length);
      box.tBalance.set(key(from), (box.tBalance.get(key(from)) ?? 0n) + q.tokenOut);
      for (const id of ids) { box.members.set(id.toString(), 'Inside'); this.owners.set(id.toString(), box.vault); this.itemApprovals.delete(id.toString()); }
      return { fn: call.functionName, args: call.args };
    }
    if (call.functionName === 'releaseToCreator') {
      if (!box.failed) this.fail('not failed');
      for (const id of ids) {
        if (box.members.get(id.toString()) !== 'Inside') continue;
        box.members.set(id.toString(), 'Released');
        this.owners.set(id.toString(), CREATOR);
        box.inside -= 1n;
      }
      return { fn: call.functionName, args: call.args };
    }
    return this.fail('vault');
  }

  private coordinatorCall(box: FakeBox, from: Address, data: Hex) {
    const call = decodeFunctionData({ abi: setCoordinatorV2Abi, data });
    if (call.functionName === 'graduate') {
      // Anyone, once, after the curve filled (the hook closed); never after failure.
      if (!box.hookClosed || box.gateOpen || box.failed) this.fail('cannot graduate');
      box.gateOpen = true;
      this.graduations.push(from);
      return { fn: call.functionName, args: [] as readonly unknown[] };
    }
    if (call.functionName === 'fail' || call.functionName === 'failClosed') {
      if (box.failed || box.gateOpen) this.fail('cannot fail');
      this.failBox(box);
      return { fn: call.functionName, args: [] as readonly unknown[] };
    }
    if (call.functionName === 'claim') {
      const [t, to] = call.args as readonly [bigint, Address];
      if (!box.failed || key(to) !== key(from)) this.fail('InvalidClaim');
      const allowance = box.tAllowance.get(pair(from, box.coordinator)) ?? 0n;
      const balance = box.tBalance.get(key(from)) ?? 0n;
      if (t === 0n) { if (box.tLeft !== 0n || key(from) !== key(CREATOR)) this.fail('InvalidClaim'); return { fn: 'claim', args: call.args }; }
      if (allowance < t || balance < t || t > box.tLeft) this.fail('InvalidClaim');
      const p = (box.pot * t) / box.tLeft;
      box.tAllowance.set(pair(from, box.coordinator), allowance - t);
      box.tBalance.set(key(from), balance - t);
      box.pot -= p;
      box.tLeft -= t;
      return { fn: 'claim', args: call.args };
    }
    return this.fail('coordinator');
  }

  failBox(box: FakeBox = this.box): void {
    box.failed = true;
    box.tradingOpen = false;
    box.pot = 3n * E18;
    box.tLeft = 500n * E18;
  }

  // ---- test moves --------------------------------------------------------------------------------------------
  /**
   * A box in a given state without sending its creation: created from `spec` (the creator's `ids`), `loaded` items
   * loaded in order (all, by default), completed when every item is in, graduated, failed with `released` items back
   * with the creator, or graduated with `picked` items out with the holder.
   */
  seed(spec: SetSpecV2, ids: readonly bigint[], state: { readonly loaded?: number; readonly complete?: boolean; readonly filled?: boolean; readonly graduated?: boolean; readonly failed?: boolean; readonly released?: number; readonly picked?: number } = {}): FakeBox {
    const salt = toHex(this.boxes.length, { size: 32 });
    this.create(CREATOR, spec, salt, /^0x0{40}$/i.test(spec.pricing.token) ? this.listing(0).q.bootstrapQ + spec.creatorBuy : 0n);
    const box = this.box;
    const loaded = state.loaded ?? ids.length;
    let next: Hex = zeroHash;
    const hashes: Hex[] = new Array<Hex>(ids.length + 1).fill(zeroHash);
    for (let i = ids.length - 1; i >= 0; i -= 1) { next = setLinkHash(spec.collection, ids[i] as bigint, next); hashes[i] = next; }
    for (const id of ids.slice(0, loaded)) {
      this.owners.set(id.toString(), box.vault);
      box.members.set(id.toString(), 'Inside');
    }
    box.loaded = loaded;
    box.inside = BigInt(loaded);
    box.remaining = hashes[loaded] ?? zeroHash;
    this.operators.add(pair(CREATOR, box.vault));
    if ((state.complete ?? loaded === ids.length) && loaded === ids.length) {
      box.notified = true;
      box.tradingOpen = true;
      box.effectiveOpenAt = this.time + 1n; // as BoxCoordinatorV2._openGate: one second after the completing block
      box.deadline = this.time + BigInt(spec.deadlineDays) * 86_400n;
    }
    // A full curve: the hook closed (trading on the curve over); graduate() may follow.
    if (state.filled || state.graduated) {
      box.hookClosed = true;
      box.closedAt = this.time;
    }
    if (state.graduated) {
      this.graduate(box);
      // Each pick as the vault prices it: principal into escrow, the fee burned, one item fewer inside.
      for (const id of ids.slice(0, state.picked ?? 0)) {
        const q = quoteSetPick(this.snapshot(box), 1n, BigInt(spec.pickFeeBps));
        box.escrow += q.principal;
        box.supply -= q.fee;
        box.inside -= 1n;
        box.members.set(id.toString(), 'Outside');
        this.owners.set(id.toString(), HOLDER);
      }
    }
    if (state.failed) {
      this.failBox(box);
      for (const id of ids.slice(0, state.released ?? 0)) {
        box.members.set(id.toString(), 'Released');
        this.owners.set(id.toString(), CREATOR);
        box.inside -= 1n;
      }
    }
    return box;
  }

  /** Graduation: conversion opens and the holder gets coins to pick with. */
  graduate(box: FakeBox = this.box, coins = 500_000_000n * E18): void {
    box.gateOpen = true;
    box.tBalance.set(key(HOLDER), coins);
  }

  /** The id now belongs to `to` (a transfer outside the page: a sale, a gift, a seizure). */
  move(id: bigint, to: Address): void {
    this.owners.set(id.toString(), to);
  }
}

/** The ids 0..n-1 sparsely spread across the full width (0, max uint256 and large ids included). */
export function sparseIds(n: number): bigint[] {
  const ids: bigint[] = [0n, MAX];
  for (let i = 1; ids.length < n; i += 1) ids.push(BigInt(i) * 1_000_003n + (BigInt(i) << 200n));
  return ids.slice(0, n);
}

/** The wire row (`SetBoxData`) of a fake box, as the indexer would publish it. */
export function wireOf(chain: FakeSetChain, box: FakeBox = chain.box) {
  const wire = decodeSetSpecV2(box.encoded);
  return {
    registry: chain.release.registry.address, boxId: box.boxId.toString(), coordinator: box.coordinator, token: box.token, vault: box.vault, loader: box.loader,
    creator: CREATOR, collection: box.spec.collection, templateId: SET_TEMPLATE, specHash: keccak256(box.encoded), encodedSpec: box.encoded,
    spec: { ...wire, raise: wire.raise.toString(), creatorBuy: wire.creatorBuy.toString() },
    state: {
      loaded: box.loaded.toString(), inside: box.inside.toString(), totalSupply: box.supply.toString(), escrowPrincipal: box.escrow.toString(),
      // As SetVaultV2.seedReady(): every committed item loaded (custody), whether or not complete() opened trading.
      gateOpen: box.gateOpen, failed: box.failed, seedReady: box.loaded === box.spec.count && !box.failed, remainingHash: box.remaining,
    },
  };
}

/** The members wire page of a fake box (accepted order). */
export function membersOf(chain: FakeSetChain, box: FakeBox = chain.box) {
  const ids = [...box.members.keys()];
  return {
    schema: 'sh.core-set-members.v1' as const, chainId: chain.chainIdValue, asOf: { block: chain.block.toString(), hash: keccak256(toHex(chain.block)), tier: 'latest' as const },
    registry: chain.release.registry.address, boxId: box.boxId.toString(), collection: box.spec.collection, setHash: box.spec.setHash, offset: '0', nextOffset: null,
    members: ids.map((id, index) => ({ index: index.toString(), id, state: box.members.get(id) as Member })),
  };
}

export const asOfOf = (chain: FakeSetChain) => ({ block: chain.block.toString(), hash: keccak256(toHex(chain.block)), tier: 'latest' as const });

/** A complete, valid spec for this chain's collection and ids (the factory's own shape). */
export function specFor(chain: FakeSetChain, ids: readonly bigint[], patch: Partial<SetSpecV2> = {}): SetSpecV2 {
  const listing = chain.listing(chain.native ? 0 : 1);
  let next: Hex = zeroHash;
  for (let i = ids.length - 1; i >= 0; i -= 1) next = setLinkHash(COLLECTION, ids[i] as bigint, next);
  return {
    format: 2, schema: keccak256(stringToHex('SquareHole.SetSpecV2.v1')), release: keccak256(stringToHex('SquareHole.ExistingNFTs.v1')),
    tokenName: 'Outside Set', tokenSymbol: 'OUT', pricing: { listingId: listing.id, token: listing.token }, raise: listing.raise, openAt: 0, deadlineDays: 30,
    creatorBuy: 0n, collection: COLLECTION, count: ids.length, setHash: next, pickFeeBps: 500, description: '', logoSha256: keccak256(stringToHex('logo')), ...patch,
  };
}

