/**
 * TA-22: Create on a real build. After the Overview the creator connects a browser wallet (on a click, never on
 * navigation) and the page sends the plan one step at a time: the price coin's exact approval (an ERC-20 price coin
 * only), createBox with the salts found here, a loadChunk for each chunk, then a pile's seed (approval + loadSeed) or a
 * shop's (its starter items, then approval + fundSeed + complete). Each step goes through the executor's creation entry
 * point (`submitCreateWriteV2`), which checks it against the steps of the plan prepared here before the wallet sees it.
 *
 * SH-SHOP-CREATE: a shop's starter items (the run keeps them: the spec commits only their hash and count). After
 * createBox each item of a loader page is approved to the created shop (ERC-721 `approve(shop, id)`), then the page is
 * loaded (StarterSetLoaderV2 `load`). SH-STARTER-GUARD: both are steps of the creation plan (`createStepsV2` derives
 * each approval from the committed loader pages, to the verified shop only), so they go through the creation entry
 * point like every other step; the creation guard admits exactly the committed items, in order.
 *
 * Progress is the chain's: before each step the page reads what is already done (the price coin's allowance, the
 * coordinator's code, its chunk state, each starter item's approval and the loader's count, the seed's allowance and
 * pull, the starter loader's gate), so a stopped or failed run resumes where the chain stands and a mined step is never
 * sent again. A sent hash is kept with the run; a resume waits for it while the node still knows it instead of sending
 * the step again. Each press (Create or Continue) first reads who holds every starter item the loader has not pulled
 * yet: all must be the creator's before the wallet is asked for anything (XR-SH-SHOP-CREATE F2).
 *
 * Framework-free: the hook (useCreateSend.ts) supplies the reads (a public client over the source's RPC) and the wallet.
 */
import { BaseError, ContractFunctionRevertedError, decodeAbiParameters, erc20Abi, keccak256, parseAbi, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import {
  CREATE_CHUNK_MAX_V2, CREATE_GAS_CEILING_V2, chunkChainV2, coordinatorV2Abi, createNeedsRolesV2, createStepsV2, estimateCreateGasV2, factoryV2Abi,
  findCreateSaltsV2, listingRegistryV2Abi, pileConfigV2, pileVaultV2Abi, shopConfigV2, shopVaultV2Abi, starterCommitmentV2, starterSetLoaderV2Abi, tokenUriTextsV2,
  type CreateSendPlanV2, type CreateStepV2, type StarterItemV2,
} from '../../../../../../packages/chain/src/core/v2';
import type { CreateSubmitOptionsV2, SendFeeReader } from '@squarehole/chain/write';
import { formatUnits } from '@squarehole/domain';
import { STARTER_PAGE, starterApproveLabel, starterPageLabel, starterPages } from './creation-plan';
import { amountText, type SiteListing } from './listings';
import { startersMissingLine, starterCommitmentOf, type StarterItem } from './shop';
import { BOX_SPEC_V2_ABI_COMPONENTS, BoxTypeV2, ChunkPart, encodeBoxSpecV2, type BoxSpecV2 } from './spec-types';

/** The release this build creates with (the source's manifest) and the chain's per-transaction gas cap. */
export interface CreateChainV2 {
  readonly chainId: number;
  readonly factory: Address;
  readonly listingRegistry: Address;
  readonly coordinatorImplementation: Address;
  readonly maxTxGas: bigint;
}

/** What the run reads, over the source's RPC (never the wallet's). */
export interface CreateReadsV2 {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  blockGasLimit(): Promise<bigint>;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[], blockNumber?: bigint): Promise<unknown>;
  code(address: Address): Promise<Hex>;
  estimateGas(request: { readonly account: Address; readonly to: Address; readonly data: Hex; readonly value: bigint }): Promise<bigint>;
  /** The mined status, or null while there is no receipt. */
  receipt(hash: Hex): Promise<'success' | 'reverted' | null>;
  /** Whether the node still has this transaction (pending or mined). */
  known(hash: Hex): Promise<boolean>;
  wait(hash: Hex): Promise<'success' | 'reverted'>;
  /** SH-SEND-FEES: the same RPC's fee and balance reads every step's send carries. */
  readonly feeReader: SendFeeReader;
}

/**
 * One box's creation as prepared at a pinned block: the exact spec (encoded, so a later clock or edit cannot change it),
 * the salts and the addresses predictBox gave, the bootstrap read with them, and each step's last sent hash.
 */
export interface CreateRunV2 {
  readonly chainId: number;
  readonly creator: Address;
  readonly factory: Address;
  readonly encoded: Hex;
  readonly cs: Hex;
  readonly hs: Hex;
  readonly coordinator: Address;
  readonly token: Address;
  /** Raw price coin, as a decimal string. */
  readonly bootstrapQ: string;
  /** A shop's starter items in add-on 8's order (ids as decimal strings); absent or empty for any other box. */
  readonly starters?: readonly RunStarterV2[];
  readonly sent: Readonly<Record<string, Hex>>;
  /** A wallet request may have sent without returning a hash. Preserve its backup until reconciled. */
  readonly walletPending?: boolean;
  /**
   * SH-256 E1b: the kind of that request (the call's `kind`), the most advanced one while several are uncertain; absent
   * on a run saved before it was recorded (then it counts as possibly createBox, the careful side).
   */
  readonly walletPendingKind?: string;
}

/** A starter item as a run keeps it (JSON for the tab's storage). */
export interface RunStarterV2 {
  readonly collection: Address;
  readonly id: string;
  readonly tier: number;
}

export type CreateRefusalCode = 'wrong-chain' | 'listing-changed' | 'refused' | 'chunk-size' | 'other-box' | 'too-heavy' | 'reverted' | 'not-seen';
/** Why the run stopped before the wallet was asked (or after a step failed on chain). */
export class CreateRefusal extends Error {
  readonly code: CreateRefusalCode;
  constructor(code: CreateRefusalCode, message: string) {
    super(message);
    this.name = 'CreateRefusal';
    this.code = code;
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const SPEC = [{ type: 'tuple', components: BOX_SPEC_V2_ABI_COMPONENTS }] as const;
/** The run's spec, decoded from its own bytes (never rebuilt from the page's choices). */
export const specOfRun = (run: Pick<CreateRunV2, 'encoded'>): BoxSpecV2 => decodeAbiParameters(SPEC, run.encoded)[0] as unknown as BoxSpecV2;

/** The run's starter items as the chain package takes them. */
const startersOfRun = (run: Pick<CreateRunV2, 'starters'>): StarterItemV2[] => (run.starters ?? []).map((item) => ({ collection: item.collection, id: BigInt(item.id), tier: item.tier }));

/** The plan the guard checks each step against; `roles` once the created box named them. */
export function planOfRun(run: CreateRunV2, roles: { readonly vault?: Address; readonly starterLoader?: Address } = {}): CreateSendPlanV2 {
  const spec = specOfRun(run);
  return { chainId: run.chainId, creator: run.creator, factory: run.factory, coordinator: run.coordinator, token: run.token, spec, cs: run.cs, hs: run.hs,
    bootstrapQ: BigInt(run.bootstrapQ), ...roles, ...(spec.boxType === BoxTypeV2.SHOP ? { starterItems: startersOfRun(run) } : {}) };
}

/** The starter count a spec commits (add-on 8); 0 for any other box, or one whose commitment does not read. */
function starterCountOf(spec: BoxSpecV2): number {
  if (spec.boxType !== BoxTypeV2.SHOP) return 0;
  try { return starterCommitmentV2(spec)?.count ?? 0; } catch { return 0; }
}

/**
 * Prepare at one pinned block: the release's chunk size, the listing exactly as the spec prices it, the factory's own
 * refusal (none), the bootstrap and the salts (TA-21 `findCreateSaltsV2` with this creator's predictBox).
 */
export async function prepareCreateV2(reads: CreateReadsV2, chain: CreateChainV2, spec: BoxSpecV2, creator: Address, starters: readonly StarterItem[] = []): Promise<CreateRunV2> {
  if (await reads.chainId() !== chain.chainId) throw new CreateRefusal('wrong-chain', 'The chain this page reads is not the box’s.');
  // A shop's starter items must be exactly those add-on 8 commits (the page builds both from the same rows).
  const committed = ((): { readonly setHash: Hex; readonly count: number } | null => {
    try { return spec.boxType === BoxTypeV2.SHOP ? starterCommitmentV2(spec) : null; } catch { return null; }
  })();
  const given = starterCommitmentOf(starters);
  if (spec.boxType === BoxTypeV2.SHOP ? !committed || committed.count !== given.count || committed.setHash.toLowerCase() !== given.setHash.toLowerCase() : starters.length > 0) {
    throw new CreateRefusal('refused', STARTERS_NOT_THIS_BOX);
  }
  const block = await reads.blockNumber();
  const at = (address: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => reads.read(address, abi, fn, args, block);
  if (BigInt(await at(chain.coordinatorImplementation, coordinatorV2Abi, 'CHUNK_MAX') as bigint) !== BigInt(CREATE_CHUNK_MAX_V2)) {
    throw new CreateRefusal('chunk-size', 'This release loads chunks of another size.');
  }
  if (!same(await at(chain.factory, factoryV2Abi, 'listingRegistry') as string, chain.listingRegistry)) throw new CreateRefusal('wrong-chain', 'The factory is not this release’s.');
  const listing = await at(chain.listingRegistry, listingRegistryV2Abi, 'listing', [spec.pricing.listingId]) as { readonly token: Address; readonly raise: bigint };
  if (!same(listing.token, spec.pricing.token) || listing.raise !== spec.raise) throw new CreateRefusal('listing-changed', 'Price coin changed: refresh this plan');
  const refusal = await at(chain.factory, factoryV2Abi, 'refusal', [spec, creator]) as Hex;
  if (refusal !== '0x') throw new CreateRefusal('refused', 'The factory refuses this box.');
  const q = await at(chain.factory, factoryV2Abi, 'boxQParameters', [spec.pricing.listingId, spec.raise]) as { readonly bootstrapQ: bigint };
  const limit = await at(chain.factory, factoryV2Abi, 'tokenAddressLimit', [spec.pricing.token]) as Address;
  const salts = await findCreateSaltsV2({ priceToken: spec.pricing.token, tokenAddressLimit: limit,
    predictBox: async (cs) => await at(chain.factory, factoryV2Abi, 'predictBox', [creator, spec, cs]) as readonly [Address, Address, Hex] });
  return { chainId: chain.chainId, creator, factory: chain.factory, encoded: encodeBoxSpecV2(spec), cs: salts.cs, hs: salts.hs,
    coordinator: salts.coordinator, token: salts.token, bootstrapQ: q.bootstrapQ.toString(),
    ...(starters.length > 0 ? { starters: starters.map((item) => ({ collection: item.collection, id: item.id.toString(), tier: item.tier })) } : {}), sent: {} };
}

/** The page's starter items are not the spec's (it builds both from the same rows, so this never shows on a sound page). */
export const STARTERS_NOT_THIS_BOX = 'The starter items are not this box’s.';

/**
 * One step as the page shows it: its key (kept with its sent hash), the exact call and a short plain label. Every call
 * is one of the plan's (`createStepsV2`), a starter item's approval included (it carries its index and item).
 */
export interface SendStepV2 {
  readonly key: string;
  readonly call: CreateStepV2;
  readonly label: string;
}
export interface CreateProgressV2 {
  readonly steps: readonly SendStepV2[];
  readonly done: readonly boolean[];
  /** The steps the guard knows; before creation a pile or shop lists only its payment, and these complete it. */
  readonly later: readonly string[];
  readonly plan: CreateSendPlanV2;
  /** How many starter items the loader has pulled (0 before the box exists or for a box without them). */
  readonly startersLoaded?: number;
}

const ERC721 = parseAbi([
  'function ownerOf(uint256 id) view returns (address)',
  'function getApproved(uint256 id) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

/** How the labels name amounts: the price coin's listing, a pile seed's listing, the box's ticker. */
export interface LabelCtxV2 {
  readonly pricing: Pick<SiteListing, 'symbol' | 'decimals' | 'token'>;
  readonly seed: Pick<SiteListing, 'symbol' | 'decimals' | 'token'> | null;
  readonly ticker: string;
}

/**
 * The labels' coins as the run's own spec names them (never the page's current choices, which a reload starts again):
 * its price coin and a pile's seed coin by their listings, and its ticker. A coin the book does not list keeps raw units.
 */
export function labelCtxOf(spec: BoxSpecV2, listings: readonly Pick<SiteListing, 'symbol' | 'decimals' | 'token'>[]): LabelCtxV2 {
  const find = (token: string) => listings.find((listing) => same(listing.token, token)) ?? { symbol: `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: 0, token: token as Address };
  return { pricing: find(spec.pricing.token), seed: spec.boxType === BoxTypeV2.PILE ? find(pileConfigV2(spec.contentsParams).asset) : null, ticker: spec.tokenSymbol };
}

const partName = (part: number) => (part === ChunkPart.Table ? 'items' : 'texts');
/** The seed the spec commits, in its own coin's raw units: a pile's seed, a shop's T; 0 for any other box. */
export function seedAmountOf(spec: BoxSpecV2): bigint {
  if (spec.boxType === BoxTypeV2.PILE) return pileConfigV2(spec.contentsParams).seedAmount;
  if (spec.boxType === BoxTypeV2.SHOP) return shopConfigV2(spec.contentsParams).seedT;
  return 0n;
}
const seedText = (spec: BoxSpecV2, ctx: LabelCtxV2): string => (spec.boxType === BoxTypeV2.PILE
  ? amountText(seedAmountOf(spec), ctx.seed ?? ctx.pricing) : `${formatUnits(seedAmountOf(spec), 18)} ${ctx.ticker || 'T'}`);

/**
 * The steps with their keys and labels: chunks keyed by part and index, a shop's starter items' approvals by their
 * index in the set and its loader pages by page (the plan puts each page's approvals right before it), each other step
 * by its kind.
 */
export function labelledSteps(plan: CreateSendPlanV2, ctx: LabelCtxV2): readonly SendStepV2[] {
  const calls = createStepsV2(plan);
  const counts = new Map<number, number>([[ChunkPart.Table, chunkChainV2(plan.spec.metadataTable).chunks.length], [ChunkPart.Texts, chunkChainV2(tokenUriTextsV2(plan.spec)).chunks.length]]);
  const seen = new Map<number, number>();
  let tablesLeft = counts.get(ChunkPart.Table) ?? 0;
  const starters = plan.starterItems ?? [];
  const pages = starterPages(starters.length);
  let page = 0;
  return calls.map((call): SendStepV2 => {
    if (call.kind === 'loadChunk') {
      const part = tablesLeft > 0 ? ChunkPart.Table : ChunkPart.Texts;
      if (part === ChunkPart.Table) tablesLeft -= 1;
      const index = seen.get(part) ?? 0;
      seen.set(part, index + 1);
      return { key: `chunk-${part}-${index}`, call, label: `Load ${partName(part)} ${index + 1}/${counts.get(part) ?? 0}` };
    }
    if (call.kind === 'approve') return { key: 'approve', call, label: `Approve ${amountText(BigInt(plan.bootstrapQ) + plan.spec.creatorBuy, ctx.pricing)}` };
    if (call.kind === 'createBox') return { key: 'createBox', call, label: 'Create the box' };
    // A starter item's approval to the verified shop (the plan's own, by its index in the committed set).
    if (call.kind === 'approveStarter') return { key: `approve-starter-${call.index}`, call, label: starterApproveLabel(call.index, starters.length) };
    if (call.kind === 'loadStarter') {
      const at = page;
      page += 1;
      return { key: `starter-${at}`, call, label: starterPageLabel(at, pages) };
    }
    if (call.kind === 'approveSeed') return { key: 'approveSeed', call, label: `Approve the seed · ${seedText(plan.spec, ctx)}` };
    if (call.kind === 'loadSeed') return { key: 'loadSeed', call, label: 'Load the pile' };
    if (call.kind === 'fundSeed') return { key: 'fundSeed', call, label: 'Fund the shop' };
    if (call.kind === 'complete') return { key: 'complete', call, label: 'Open the shop' };
    // A kind this page does not know is never sent as another one.
    throw new CreateRefusal('not-seen', `No label for a step of kind ${call.kind}.`);
  });
}

/** What a pile or a shop still adds after createBox, before its roles are known (labels only, never sendable). */
function laterLabels(spec: BoxSpecV2, ctx: LabelCtxV2): readonly string[] {
  if (!createNeedsRolesV2(spec)) return [];
  if (spec.boxType === BoxTypeV2.PILE) {
    const erc20 = !same(pileConfigV2(spec.contentsParams).asset, zeroAddress);
    return [...(erc20 ? [`Approve the seed · ${seedText(spec, ctx)}`] : []), 'Load the pile'];
  }
  const count = starterCountOf(spec);
  const starters: string[] = [];
  for (let page = 0; page < starterPages(count); page += 1) {
    for (let index = page * STARTER_PAGE; index < Math.min(count, (page + 1) * STARTER_PAGE); index += 1) starters.push(starterApproveLabel(index, count));
    starters.push(starterPageLabel(page, starterPages(count)));
  }
  return [...starters, `Approve the seed · ${seedText(spec, ctx)}`, 'Fund the shop', 'Open the shop'];
}

const allowance = async (reads: CreateReadsV2, coin: Address, owner: Address, spender: Address) => reads.read(coin, erc20Abi as Abi, 'allowance', [owner, spender]) as Promise<bigint>;

/**
 * What the chain already holds of this run. Before the coordinator exists: the price coin's approval when its allowance
 * covers the payment. After: the created box must be this run's (its creator, spec hash, factory and token), its roles
 * are read and checked, and each step is done by the chain's own state.
 */
export async function readProgressV2(reads: CreateReadsV2, run: CreateRunV2, ctx: LabelCtxV2): Promise<CreateProgressV2> {
  if (await reads.chainId() !== run.chainId) throw new CreateRefusal('wrong-chain', 'The chain this page reads is not the box’s.');
  const spec = specOfRun(run);
  const payment = BigInt(run.bootstrapQ) + spec.creatorBuy;
  if (await reads.code(run.coordinator) === '0x') {
    const plan = planOfRun(run);
    const steps = labelledSteps(plan, ctx);
    const approved = same(spec.pricing.token, zeroAddress) ? false : await allowance(reads, spec.pricing.token, run.creator, run.factory) >= payment;
    return { plan, steps, done: steps.map((step) => step.call.kind === 'approve' && approved), later: laterLabels(spec, ctx) };
  }
  const read = (fn: string, args: readonly unknown[] = []) => reads.read(run.coordinator, coordinatorV2Abi, fn, args);
  const [creator, specHash, factory, token] = await Promise.all([read('creator'), read('specHash'), read('factory'), read('token')]) as [Address, Hex, Address, Address];
  if (!same(creator, run.creator) || !same(specHash, keccak256(run.encoded)) || !same(factory, run.factory) || !same(token, run.token)) {
    throw new CreateRefusal('other-box', 'Another box is at this address.');
  }
  let roles: { vault?: Address; starterLoader?: Address } = {};
  if (createNeedsRolesV2(spec)) {
    const [vault, loader] = await Promise.all([read('roleAddress', [3n]), read('starterSetLoader')]) as [Address, Address];
    if (spec.boxType === BoxTypeV2.PILE) {
      const pile = (fn: string) => reads.read(vault, pileVaultV2Abi, fn);
      const [asset, amount, seeder] = await Promise.all([pile('asset'), pile('seedAmount'), pile('seeder')]) as [Address, bigint, Address];
      const expected = pileConfigV2(spec.contentsParams);
      if (!same(asset, expected.asset) || amount !== expected.seedAmount || !same(seeder, run.creator) || !same(loader, vault)) throw new CreateRefusal('other-box', 'The pile does not match this box.');
      roles = { vault };
    } else {
      if (same(loader, zeroAddress) || same(vault, zeroAddress)) throw new CreateRefusal('other-box', 'The shop does not match this box.');
      roles = { vault, starterLoader: loader };
    }
  }
  const plan = planOfRun(run, roles);
  const steps = labelledSteps(plan, ctx);
  const chunkState = async (part: number) => {
    const [, loaded, total] = await read('chunkState', [part]) as readonly [Hex, bigint, bigint];
    return { loaded, total };
  };
  const parts = new Map<number, { loaded: bigint; total: bigint }>();
  for (const part of [ChunkPart.Table, ChunkPart.Texts]) parts.set(part, await chunkState(part));
  for (const [part, state] of parts) {
    const count = BigInt(steps.filter((step) => step.key.startsWith(`chunk-${part}-`)).length);
    if (state.total !== count) throw new CreateRefusal('other-box', 'The box expects other chunks.');
  }
  const gateHeld = createNeedsRolesV2(spec) ? await read('starterSetPending') as boolean : false;
  const shopFunded = spec.boxType === BoxTypeV2.SHOP && roles.vault ? await reads.read(roles.vault, shopVaultV2Abi, 'seedReady') as boolean : false;
  const pulled = spec.boxType === BoxTypeV2.SHOP ? shopFunded : !gateHeld;
  const starters = await starterProgress(reads, run, plan);
  const done = await Promise.all(steps.map(async (step) => {
    const kind = step.call.kind;
    if (kind === 'approve' || kind === 'createBox') return true;
    if (step.call.kind === 'approveStarter') return step.call.index < starters.loaded || starters.approved.has(step.call.index);
    if (kind === 'loadStarter') return starters.loaded >= Math.min(starters.count, (Number(step.key.slice('starter-'.length)) + 1) * STARTER_PAGE);
    if (kind === 'loadChunk') {
      const [, part, index] = step.key.split('-').map(Number);
      return (parts.get(part ?? 0)?.loaded ?? 0n) > BigInt(index ?? 0);
    }
    if (kind === 'approveSeed') {
      if (pulled || !roles.vault) return true;
      return await allowance(reads, step.call.to, run.creator, roles.vault) >= seedAmountOf(spec);
    }
    if (kind === 'loadSeed') return !gateHeld;
    if (kind === 'fundSeed') return shopFunded;
    if (kind === 'complete') return !gateHeld;
    return false;
  }));
  return { plan, steps, done, later: [], startersLoaded: starters.loaded };
}

/**
 * The address one starter item is approved to, or null when its `getApproved` reverts (an id the collection does not
 * have: burned or never minted). Then it is simply not approved here; the press's ownership read, next and before any
 * send, counts it as missing (XR-SH-SHOP-CREATE-R2). A read the chain does not answer still throws (fail closed).
 */
async function approvedTo(reads: CreateReadsV2, item: StarterItemV2): Promise<string | null> {
  try {
    return await reads.read(item.collection, ERC721 as Abi, 'getApproved', [item.id]) as string;
  } catch (error) {
    if (revertedRead(error)) return null;
    throw error;
  }
}

/**
 * A created shop's starter items as the chain holds them: how many the loader has pulled, and which items of the page it
 * pulls next are already approved to the shop (`getApproved`, or the shop as the creator's operator of that collection).
 * A run approves only the items of that page before loading it, so the items of later pages are not read. Nothing for a
 * box without starter items or before its roles are known. (The approvals themselves are the creation plan's steps.)
 */
async function starterProgress(reads: CreateReadsV2, run: CreateRunV2, plan: CreateSendPlanV2) {
  const items = plan.starterItems ?? [];
  const { vault, starterLoader } = plan;
  const none = { count: items.length, loaded: 0, approved: new Set<number>() };
  if (plan.spec.boxType !== BoxTypeV2.SHOP || items.length === 0 || !vault || !starterLoader) return none;
  const [loadedRaw] = await reads.read(starterLoader, starterSetLoaderV2Abi, 'progress') as readonly [number | bigint, Hex, boolean];
  const loaded = Number(loadedRaw);
  const approved = new Set<number>();
  const start = Math.floor(loaded / STARTER_PAGE) * STARTER_PAGE;
  const page = items.slice(start, start + STARTER_PAGE);
  const operator = new Map<string, boolean>();
  for (const collection of new Set(page.map((item) => item.collection.toLowerCase()))) {
    operator.set(collection, await reads.read(collection as Address, ERC721 as Abi, 'isApprovedForAll', [run.creator, vault]) as boolean);
  }
  await Promise.all(page.map(async (item, i) => {
    if (start + i < loaded) return;
    if (operator.get(item.collection.toLowerCase()) === true) { approved.add(start + i); return; }
    const to = await approvedTo(reads, item);
    if (to !== null && same(to, vault)) approved.add(start + i);
  }));
  return { count: items.length, loaded, approved };
}

/** The step's gas limit: createBox by TA-21's estimate (its margin, the block and the chain's cap); others +20%. */
export async function gasLimitOfStep(reads: CreateReadsV2, chain: Pick<CreateChainV2, 'maxTxGas'>, step: SendStepV2, account: Address): Promise<bigint> {
  const request = { account, to: step.call.to, data: step.call.data, value: step.call.value };
  if (step.call.kind === 'createBox') {
    const cap = chain.maxTxGas < CREATE_GAS_CEILING_V2 ? chain.maxTxGas : CREATE_GAS_CEILING_V2;
    try {
      return (await estimateCreateGasV2((r) => reads.estimateGas(r), request, await reads.blockGasLimit(), cap)).gasLimit;
    } catch (error) {
      if (error instanceof RangeError) throw new CreateRefusal('too-heavy', 'Too heavy to create');
      throw error;
    }
  }
  const estimate = await reads.estimateGas(request);
  const limit = estimate + estimate / 5n;
  if (limit > chain.maxTxGas) throw new CreateRefusal('too-heavy', 'This step is too heavy to send.');
  return limit;
}

export interface RunHooksV2 {
  readonly reads: CreateReadsV2;
  readonly chain: CreateChainV2;
  readonly ctx: LabelCtxV2;
  /** The executor's creation entry point (submitCreateWriteV2) with the connected wallet: every step, starter approvals included. */
  readonly submit: (options: Omit<CreateSubmitOptionsV2, 'wallet' | 'createOptionsCheck'>, kind: string) => Promise<Hex>;
  /** The run with a newly sent hash (the hook keeps it for a resume). */
  readonly onRun: (run: CreateRunV2) => void;
  readonly onProgress: (progress: CreateProgressV2, sending: number | null) => void;
  /** True once the creator pressed Stop or left Create: no further step is sent (one already in the wallet still finishes). */
  readonly stopped: () => boolean;
  /**
   * SH-ARWEAVE-PICTURES-WEB fix round 1 (integrator decision): asked once per run, right before its first wallet request
   * while the chain does not show the box created (so before createBox, and before the price coin's approval when there
   * is one), after every check that request goes through (the starter items' owners read for this press, the step's own
   * checks, its estimate). Create publishes the box's logo and cover there, so their hashes are on Arweave before
   * createBox makes them public. False stops the run there ('stopped'), nothing sent; the page decides what the next
   * press does.
   */
  readonly beforeWallet?: () => Promise<boolean>;
}

/**
 * Send what is left, one step at a time: read the chain, take the first step not done, wait for its earlier hash if the
 * node still has it, else estimate, send it through the guard and wait for its receipt. Ends 'done' when every step is
 * done, 'stopped' on Stop; a refusal, a revert or a wallet error throws, and the next run starts from the chain again.
 */
export async function runCreateV2(start: CreateRunV2, hooks: RunHooksV2): Promise<'done' | 'stopped'> {
  let run = start;
  // This press (Create or Continue) has read who holds every starter item not pulled yet.
  let startersRead = false;
  // This run has asked `beforeWallet` (once, right before its first wallet request).
  let asked = hooks.beforeWallet === undefined;
  for (;;) {
    const progress = await readProgressV2(hooks.reads, run, hooks.ctx);
    const next = progress.done.findIndex((done) => !done);
    if (next < 0 && progress.later.length === 0) { hooks.onProgress(progress, null); return 'done'; }
    if (next < 0) throw new CreateRefusal('not-seen', 'The chain does not show the box yet. Try again.');
    hooks.onProgress(progress, null);
    if (hooks.stopped()) return 'stopped';
    // XR-SH-SHOP-CREATE F2: before this press's first wallet request, read fresh who holds every committed starter item
    // the loader has not pulled; the page's own check may be old. All must be the creator's (ShopVaultV2 pulls them from
    // the creator), else nothing is sent and the line says how many are missing.
    if (!startersRead) {
      await ownStarters(hooks.reads, run.creator, startersOfRun(run).slice(progress.startersLoaded ?? 0));
      startersRead = true;
    }
    const step = progress.steps[next];
    if (!step) throw new CreateRefusal('not-seen', 'No step to send.');
    const earlier = run.sent[step.key];
    if (earlier) {
      const status = await hooks.reads.receipt(earlier) ?? (await hooks.reads.known(earlier) ? await hooks.reads.wait(earlier) : null);
      if (status === 'success') {
        const again = await readProgressV2(hooks.reads, run, hooks.ctx);
        if (!again.done[next] && again.steps[next]?.key === step.key) throw new CreateRefusal('not-seen', 'The chain does not show this step yet. Try again.');
        continue;
      }
      // Reverted (reported when it happened), or dropped before it was mined: this press sends it again.
      const rest = Object.fromEntries(Object.entries(run.sent).filter(([key]) => key !== step.key));
      run = { ...run, sent: rest };
      hooks.onRun(run);
    }
    hooks.onProgress(progress, next);
    // A starter item is approved and pulled from the creator: each must still be theirs (ShopVaultV2 `_receiveItem`).
    if (step.call.kind === 'approveStarter') await ownStarters(hooks.reads, run.creator, [step.call.item]);
    if (step.call.kind === 'loadStarter') {
      const first = Number(step.key.slice('starter-'.length)) * STARTER_PAGE;
      await ownStarters(hooks.reads, run.creator, (progress.plan.starterItems ?? []).slice(first, first + STARTER_PAGE));
    }
    const gasLimit = await gasLimitOfStep(hooks.reads, hooks.chain, step, run.creator);
    // Stop (or leaving the page) while the receipt checks or the estimate were awaited: the wallet is not asked.
    if (hooks.stopped()) { hooks.onProgress(progress, null); return 'stopped'; }
    // SH-ARWEAVE-PICTURES-WEB: the run's first wallet request. While the box is not created, its pictures go first
    // (`beforeWallet`), after every check above: this press's read of the starter items' owners, the step's own checks
    // and its estimate. The line does not say "confirm in your wallet" while they publish.
    if (!asked) {
      asked = true;
      const box = progress.steps.findIndex((entry) => entry.call.kind === 'createBox');
      if (hooks.beforeWallet && !(box >= 0 && progress.done[box] === true)) {
        hooks.onProgress(progress, null);
        if (!(await hooks.beforeWallet()) || hooks.stopped()) { hooks.onProgress(progress, null); return 'stopped'; }
        hooks.onProgress(progress, next);
      }
    }
    // Every step, a starter item's approval included, through the creation entry point with this run's own plan.
    // SH-256 E1b: with the step's kind, so a request that may have been sent is recorded as what it was.
    const hash = await hooks.submit({ plan: progress.plan, call: step.call, from: run.creator, gasLimit, feeReader: hooks.reads.feeReader }, step.call.kind);
    run = { ...run, sent: { ...run.sent, [step.key]: hash } };
    hooks.onRun(run);
    if (await hooks.reads.wait(hash) !== 'success') throw new CreateRefusal('reverted', 'This step failed on chain.');
  }
}

/** How many starter items' owners are read at once (a set holds up to 10,000). */
export const STARTER_OWNER_READS = 16;

const revertedRead = (error: unknown): boolean => error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;

/**
 * Every item must be the creator's now, else the run stops before the wallet with how many are not (a page with any
 * other's would revert). Read STARTER_OWNER_READS at a time; an id whose `ownerOf` reverts (none minted, burned) is not
 * the creator's; a read the chain does not answer stops the run too (its error), so nothing is sent unread.
 */
async function ownStarters(reads: CreateReadsV2, creator: Address, items: readonly StarterItemV2[]): Promise<void> {
  let missing = 0;
  for (let start = 0; start < items.length; start += STARTER_OWNER_READS) {
    const owners = await Promise.all(items.slice(start, start + STARTER_OWNER_READS).map(async (item) => {
      try {
        return await reads.read(item.collection, ERC721 as Abi, 'ownerOf', [item.id]) as string;
      } catch (error) {
        if (revertedRead(error)) return null;
        throw error;
      }
    }));
    missing += owners.filter((owner) => owner === null || !same(owner, creator)).length;
  }
  if (missing > 0) throw new CreateRefusal('refused', startersMissingLine(missing));
}

/** Equal runs for a draft: the same chain, creator and spec bytes (SH-256: a reload keeps both the run and the draft). */
export const sameRun = (run: CreateRunV2, chainId: number, creator: Address, spec: BoxSpecV2): boolean =>
  run.chainId === chainId && same(run.creator, creator) && same(run.encoded, encodeBoxSpecV2(spec));
