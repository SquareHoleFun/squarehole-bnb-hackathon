/**
 * SH-EXISTING-NFTS-E08C: Create for a set box on a real build, one checked transaction at a time (the pattern of
 * create/v2/create-send.ts): the price coin's exact approval (an ERC-20 price coin only), createBox with the salts found
 * here, ONE setApprovalForAll to the box's own SetVault (founder default 2026-10-24; its identity checked with the
 * routing rule first), the committed list in loading pages of 16 (halved when a page is too heavy), then the loader's
 * permissionless complete, which opens trading. After complete, or after a failure, the creator is offered a Revoke.
 *
 * Progress is the chain's: before each step the page reads what is done (the price coin's allowance, the coordinator's
 * code, the box's identity, the collection's approval, the loader's progress and the vault's failure), so a stopped or
 * failed run resumes where the chain stands and a mined step is never sent again; a sent hash is kept with the run and
 * a resume waits for it while the node still knows it. The loading itself is E-08B's: `readSetLoadPlan` checks the
 * committed list and the loader's remaining hash at its loaded count (the suffix check) and cuts the pages and the
 * complete call; `estimateWithBackoff` halves a page whose estimate does not fit or reverts TransferGas(). Before each
 * press's first wallet request, and again right before each loading page, the page reads fresh that the creator still
 * owns every item not loaded yet (the shop fix round's lesson: never trust a cached "all yours").
 *
 * Framework-free: the hook (useSetCreate.ts) supplies the reads, the sender and the wallet.
 */
import { erc20Abi, keccak256, type Address, type Hex } from 'viem';
import { SET_LOAD_BATCH, createSetListFile, decodeSetSpecV2, encodeSetSpecV2, parseSetListFile, type SetListFile, type SetSpecV2 } from '@squarehole/box-spec';
import { setFactoryV2Abi, setListingRegistryV2Abi, setVaultV2Abi } from '@squarehole/chain/core/set-v2';
import { estimateWithBackoff, readSetLoadPlan } from '@squarehole/chain/write';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { CREATE_GAS_CEILING_V2, estimateCreateGasV2, findCreateSaltsV2 } from '../../../../../../packages/chain/src/core/v2';
import { formatCount } from '../../fit-pair/fit-format';
import type { SetSource } from '../../set/set-build';
import {
  ERC721_ABI, approveAllCall, approveCall, createBoxCall, gasWithMargin, sdkCall, setTargetV2Of, transferGasRevert,
  type SetCall, type SetSubmit, type SetTarget,
} from '../../set/set-calls';
import { readSetIdentity, type SetBoxIdentity } from '../../set/set-identity';
import { reverted, same, type SetReads } from '../../set/set-reads';
import { amountText, type SiteListing } from '../v2/listings';

/** The release this build creates with and the chain's per-transaction gas cap. */
export interface SetCreateChain {
  readonly chainId: number;
  readonly factory: Address;
  readonly registry: Address;
  readonly listingRegistry: Address;
  readonly maxTxGas: bigint;
}

/**
 * One box's creation as prepared at a pinned block: the exact spec bytes, the salts and addresses predictBox gave, the
 * bootstrap read with them, the committed ids (decimal strings, committed order) and each step's last sent hash.
 */
export interface SetRun {
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
  readonly ids: readonly string[];
  readonly sent: Readonly<Record<string, Hex>>;
}

export type SetCreateRefusalCode = 'wrong-chain' | 'listing-changed' | 'refused' | 'other-box' | 'too-heavy' | 'reverted' | 'not-seen' | 'not-yours' | 'no-sender';

export class SetCreateRefusal extends Error {
  override readonly name = 'SetCreateRefusal';
  constructor(readonly code: SetCreateRefusalCode, message: string) {
    super(message);
  }
}

/** The run's spec, decoded from its own bytes (strict and canonical; never rebuilt from the page's choices). */
export const specOfRun = (run: Pick<SetRun, 'encoded'>): SetSpecV2 => decodeSetSpecV2(run.encoded);
export const idsOfRun = (run: Pick<SetRun, 'ids'>): readonly bigint[] => run.ids.map((id) => BigInt(id));

let lastList: { readonly key: string; readonly list: SetListFile } | null = null;
/**
 * The run's committed list as E-08A's list file, bound to the run's own spec (E-08A's `parseSetListFile`: the ordered
 * ids hashed again, the collection, count and set hash the spec commits); what E-08B's loading plan reads.
 */
export function listOfRun(run: Pick<SetRun, 'encoded' | 'ids'>): SetListFile {
  const key = `${run.encoded}:${run.ids.join(',')}`;
  if (lastList?.key === key) return lastList.list;
  const spec = specOfRun(run);
  let list: SetListFile;
  try {
    list = createSetListFile(spec.collection, idsOfRun(run));
    parseSetListFile(list, { collection: spec.collection, count: spec.count, setHash: spec.setHash });
  } catch {
    throw new SetCreateRefusal('other-box', 'The list is not this box’s.');
  }
  lastList = { key, list };
  return list;
}
const native = (spec: SetSpecV2) => /^0x0{40}$/i.test(spec.pricing.token);

/**
 * The pre-creation observations, at one block: the factory is the selected release's and names its registry and listing
 * registry, the listing prices the spec exactly, the factory's own refusal is empty, and the bootstrap it charges.
 */
async function observe(reads: SetReads, chain: SetCreateChain, spec: SetSpecV2, creator: Address, block: bigint): Promise<{ readonly bootstrapQ: bigint }> {
  const at = (fn: string, args: readonly unknown[] = []) => reads.read(chain.factory, setFactoryV2Abi, fn, args, block);
  const [registry, listingRegistry] = await Promise.all([at('registry'), at('listingRegistry')]) as [Address, Address];
  if (!same(registry, chain.registry) || !same(listingRegistry, chain.listingRegistry)) throw new SetCreateRefusal('wrong-chain', 'The factory is not this release’s.');
  const listing = await reads.read(chain.listingRegistry, setListingRegistryV2Abi, 'listing', [spec.pricing.listingId], block) as { readonly token: Address; readonly raise: bigint };
  if (!same(listing.token, spec.pricing.token) || listing.raise !== spec.raise) throw new SetCreateRefusal('listing-changed', 'Price coin changed: refresh this plan');
  if (await at('refusal', [spec, creator]) !== '0x') throw new SetCreateRefusal('refused', 'The factory refuses this box.');
  const q = await at('boxQParameters', [spec.pricing.listingId, spec.raise]) as { readonly bootstrapQ: bigint };
  return { bootstrapQ: q.bootstrapQ };
}

/**
 * Prepare at one pinned block: the observations above, and the salts (TA-21 `findCreateSaltsV2` with this creator's
 * predictBox).
 */
export async function prepareSetCreate(reads: SetReads, chain: SetCreateChain, spec: SetSpecV2, ids: readonly bigint[], creator: Address): Promise<SetRun> {
  if (await reads.chainId() !== chain.chainId) throw new SetCreateRefusal('wrong-chain', 'The chain this page reads is not the box’s.');
  const block = await reads.blockNumber();
  const at = (fn: string, args: readonly unknown[] = []) => reads.read(chain.factory, setFactoryV2Abi, fn, args, block);
  const q = await observe(reads, chain, spec, creator, block);
  const limit = await at('tokenAddressLimit', [spec.pricing.token]) as Address;
  const salts = await findCreateSaltsV2({ priceToken: spec.pricing.token, tokenAddressLimit: limit,
    predictBox: async (cs) => await at('predictBox', [creator, spec, cs]) as readonly [Address, Address, Hex] });
  return { chainId: chain.chainId, creator, factory: chain.factory, encoded: encodeSetSpecV2(spec), cs: salts.cs, hs: salts.hs,
    coordinator: salts.coordinator, token: salts.token, bootstrapQ: q.bootstrapQ.toString(), ids: ids.map((id) => id.toString()), sent: {} };
}

/** A stored run belongs to the selected checked release: its chain and its factory, nothing else is resumed. */
export function assertRunRelease(run: Pick<SetRun, 'chainId' | 'factory'>, chain: Pick<SetCreateChain, 'chainId' | 'factory'>): void {
  if (run.chainId !== chain.chainId) throw new SetCreateRefusal('wrong-chain', 'The chain this page reads is not the box’s.');
  if (!same(run.factory, chain.factory)) throw new SetCreateRefusal('wrong-chain', 'The factory is not this release’s.');
}

/**
 * Right before a pre-creation step, an approval or a payment: the run is the selected release's, and at one block every
 * observation it was prepared from still holds (the release, the listing, the refusal, the bootstrap, and predictBox
 * naming the run's coordinator and token for its salt), else nothing is asked of the wallet.
 */
async function recheck(reads: SetReads, chain: SetCreateChain, run: SetRun): Promise<void> {
  assertRunRelease(run, chain);
  const spec = specOfRun(run);
  const block = await reads.blockNumber();
  const { bootstrapQ } = await observe(reads, chain, spec, run.creator, block);
  if (bootstrapQ.toString() !== run.bootstrapQ) throw new SetCreateRefusal('listing-changed', 'Price coin changed: refresh this plan');
  const [coordinator, token] = await reads.read(chain.factory, setFactoryV2Abi, 'predictBox', [run.creator, spec, run.cs], block) as readonly [Address, Address, Hex];
  if (!same(coordinator, run.coordinator) || !same(token, run.token)) throw new SetCreateRefusal('other-box', 'Another box is at this address.');
}

export type SetStepKind = 'approve' | 'createBox' | 'approveAll' | 'load' | 'complete';

/** One row of the plan as the page shows it: done by the chain, a count for loading. */
export interface SetPlanRow {
  readonly kind: SetStepKind;
  readonly label: string;
  readonly done: boolean;
}

export interface SetProgress {
  readonly rows: readonly SetPlanRow[];
  /** The next step to send; null when the run is over (done or failed). */
  readonly next: SetStepKind | null;
  readonly created: boolean;
  readonly identity: SetBoxIdentity | null;
  readonly loaded: number;
  readonly count: number;
  readonly complete: boolean;
  /** The raise failed: nothing more loads; the box page sends loaded items back to the creator. */
  readonly failed: boolean;
  /** The creator's loading approval is still on (Revoke is offered once loading is over). */
  readonly approvedAll: boolean;
}

/** How the labels name the price coin (the run's own listing; a coin the book does not list keeps raw units). */
export type SetCoinLabel = Pick<SiteListing, 'symbol' | 'decimals'>;

export function planRows(spec: SetSpecV2, bootstrapQ: bigint, coin: SetCoinLabel, state: { readonly approved: boolean; readonly created: boolean; readonly approvedAll: boolean; readonly loaded: number; readonly complete: boolean }): readonly SetPlanRow[] {
  const loadedAll = state.loaded >= spec.count;
  return [
    ...(native(spec) ? [] : [{ kind: 'approve' as const, label: `Approve ${amountText(bootstrapQ + spec.creatorBuy, coin)}`, done: state.approved || state.created }]),
    { kind: 'createBox', label: 'Create the box', done: state.created },
    { kind: 'approveAll', label: 'Allow loading', done: state.approvedAll || loadedAll },
    { kind: 'load', label: `Load items · ${formatCount(BigInt(state.loaded))}/${formatCount(BigInt(spec.count))}`, done: loadedAll },
    { kind: 'complete', label: 'Open trading', done: state.complete },
  ];
}

/** How many transactions the plan takes from the start: approvals, createBox, the pages of 16 and complete. */
export const planTransactions = (spec: SetSpecV2): number => (native(spec) ? 0 : 1) + 1 + 1 + Math.ceil(spec.count / SET_LOAD_BATCH) + 1;

/**
 * E-08B's loading plan for this box at the latest block (`readSetLoadPlan`): the loader's progress, refused unless its
 * remaining hash is this list's suffix at the loaded count; then the pages of `size` from there and the complete call.
 */
async function loadPlanOf(reads: SetReads, box: SetBoxIdentity, list: SetListFile, size?: number) {
  try {
    return await readSetLoadPlan(reads.chain, setTargetV2Of({ kind: 'box', identity: box }), list, size);
  } catch (error) {
    if (error instanceof Error && error.message === 'loader committed suffix differs from progress') throw new SetCreateRefusal('other-box', 'The list is not this box’s.');
    if (error instanceof Error && error.message === 'set loader chain mismatch') throw new SetCreateRefusal('wrong-chain', 'The chain this page reads is not the box’s.');
    throw error;
  }
}

/**
 * What the chain already holds of this run. Before the coordinator exists: the price coin's approval when its
 * allowance covers the payment. After: the box must be this run's (identity check, its creator and token), the loader's
 * remaining hash must be this list's suffix at its loaded count, and each step is done by the chain's own state.
 */
export async function readSetProgress(reads: SetReads, source: SetSource, run: SetRun, coin: SetCoinLabel): Promise<SetProgress> {
  // A stored run is the selected checked release's or it is not read at all (a manifest changed on the same chain).
  assertRunRelease(run, { chainId: source.chainId, factory: source.release.factory.address });
  if (await reads.chainId() !== run.chainId) throw new SetCreateRefusal('wrong-chain', 'The chain this page reads is not the box’s.');
  const spec = specOfRun(run);
  const list = listOfRun(run);
  const bootstrapQ = BigInt(run.bootstrapQ);
  if (await reads.code(run.coordinator) === '0x') {
    const approved = native(spec) ? true : (await reads.read(spec.pricing.token, erc20Abi, 'allowance', [run.creator, run.factory]) as bigint) >= bootstrapQ + spec.creatorBuy;
    const state = { approved, created: false, approvedAll: false, loaded: 0, complete: false };
    return { rows: planRows(spec, bootstrapQ, coin, state), next: approved ? 'createBox' : 'approve', created: false, identity: null, loaded: 0, count: spec.count, complete: false, failed: false, approvedAll: false };
  }
  let identity: SetBoxIdentity;
  try {
    identity = await readSetIdentity(reads, source, run.coordinator, run.encoded);
  } catch (error) {
    throw new SetCreateRefusal('other-box', error instanceof Error ? error.message : 'Another box is at this address.');
  }
  if (!same(identity.creator, run.creator) || !same(identity.token, run.token)) throw new SetCreateRefusal('other-box', 'Another box is at this address.');
  const [plan, failed, approvedAll] = await Promise.all([
    loadPlanOf(reads, identity, list),
    reads.read(identity.vault, setVaultV2Abi, 'failed'),
    reads.read(identity.collection, ERC721_ABI, 'isApprovedForAll', [run.creator, identity.vault]),
  ]);
  const { loaded } = plan;
  const complete = plan.notified;
  const state = { approved: true, created: true, approvedAll: approvedAll === true, loaded, complete };
  const next: SetStepKind | null = failed === true || complete ? null : loaded < spec.count ? (approvedAll === true ? 'load' : 'approveAll') : 'complete';
  return { rows: planRows(spec, bootstrapQ, coin, state), next, created: true, identity, loaded, count: spec.count, complete, failed: failed === true, approvedAll: approvedAll === true };
}

/** How many owners are read at once (a set holds up to 10,000). */
export const OWNER_READS = 16;
export const missingLine = (count: number): string => `Not in your wallet: ${formatCount(BigInt(count))} ${count === 1 ? 'item' : 'items'}`;

/**
 * Every id must be the creator's now, else nothing is sent and the line says how many are not. An id whose `ownerOf`
 * reverts (never minted, burned) is not the creator's; a read the chain does not answer stops the press too.
 */
export async function ownAll(reads: SetReads, collection: Address, creator: Address, ids: readonly bigint[]): Promise<void> {
  let missing = 0;
  for (let start = 0; start < ids.length; start += OWNER_READS) {
    const owners = await Promise.all(ids.slice(start, start + OWNER_READS).map(async (id) => {
      try {
        return await reads.read(collection, ERC721_ABI, 'ownerOf', [id]) as string;
      } catch (error) {
        if (reverted(error)) return null;
        throw error;
      }
    }));
    missing += owners.filter((owner) => owner === null || !same(owner, creator)).length;
  }
  if (missing > 0) throw new SetCreateRefusal('not-yours', missingLine(missing));
}

interface Step {
  readonly key: string;
  readonly kind: SetStepKind;
  readonly call: SetCall;
  readonly target: SetTarget;
  readonly gasLimit: bigint;
  readonly ids?: readonly bigint[];
}

async function margin(reads: SetReads, call: SetCall, from: Address): Promise<bigint> {
  const limit = gasWithMargin(await reads.estimateGas({ account: from, to: call.to, data: call.data, value: call.value }));
  if (limit === null) throw new SetCreateRefusal('too-heavy', 'This step is too heavy to send.');
  return limit;
}

/**
 * The next loading page as E-08B cuts it: 16 items from the loaded count, halved (16, 8, 4, 2, 1) by
 * `estimateWithBackoff` while its estimate plus a fifth passes the cap or it reverts TransferGas(); each smaller page is
 * a new plan with its own suffix hash.
 */
async function loadStep(reads: SetReads, box: SetBoxIdentity, from: Address, list: SetListFile): Promise<Step> {
  const first = async (size: number) => {
    const plan = await loadPlanOf(reads, box, list, size);
    const [page] = plan.pages;
    if (!page) throw new SetCreateRefusal('not-seen', 'The chain does not show this step yet. Try again.');
    return { loaded: plan.loaded, ...page };
  };
  try {
    const batch = await estimateWithBackoff(SET_LOAD_BATCH, first, (page) => reads.estimateGas({ account: from, to: page.call.to, data: page.call.data, value: 0n }));
    return { key: `load-${batch.call.loaded}`, kind: 'load', call: sdkCall('load', batch.call.call), target: { kind: 'box', identity: box }, gasLimit: batch.gasLimit, ids: batch.call.page.ids };
  } catch (error) {
    if (error instanceof RangeError || transferGasRevert(error)) throw new SetCreateRefusal('too-heavy', 'An item is too heavy to load.');
    throw error;
  }
}

async function stepOf(reads: SetReads, chain: SetCreateChain, run: SetRun, progress: SetProgress): Promise<Step> {
  const spec = specOfRun(run);
  const bootstrapQ = BigInt(run.bootstrapQ);
  const create: SetTarget = { kind: 'create', chainId: run.chainId, factory: run.factory, creator: run.creator, encodedSpec: run.encoded, cs: run.cs, hs: run.hs, bootstrapQ };
  if (progress.next === 'approve' || progress.next === 'createBox') await recheck(reads, chain, run);
  if (progress.next === 'approve') {
    const call = approveCall(spec, run.factory, bootstrapQ);
    return { key: 'approve', kind: 'approve', call, target: create, gasLimit: await margin(reads, call, run.creator) };
  }
  if (progress.next === 'createBox') {
    const call = createBoxCall(spec, run.factory, run.cs, run.hs, bootstrapQ);
    const cap = chain.maxTxGas < CREATE_GAS_CEILING_V2 ? chain.maxTxGas : CREATE_GAS_CEILING_V2;
    try {
      const { gasLimit } = await estimateCreateGasV2((r) => reads.estimateGas({ account: r.account, to: r.to, data: r.data, value: r.value }), { account: run.creator, to: call.to, data: call.data, value: call.value }, await reads.blockGasLimit(), cap);
      return { key: 'createBox', kind: 'createBox', call, target: create, gasLimit };
    } catch (error) {
      if (error instanceof RangeError) throw new SetCreateRefusal('too-heavy', 'Too heavy to create');
      throw error;
    }
  }
  const box = progress.identity;
  if (!box) throw new SetCreateRefusal('not-seen', 'The chain does not show the box yet. Try again.');
  if (progress.next === 'approveAll') {
    const call = approveAllCall(box, true);
    return { key: 'approveAll', kind: 'approveAll', call, target: { kind: 'box', identity: box }, gasLimit: await margin(reads, call, run.creator) };
  }
  const list = listOfRun(run);
  if (progress.next === 'load') return loadStep(reads, box, run.creator, list);
  // The loader's permissionless complete, as E-08B's plan offers it (none once the coordinator was notified).
  const ready = (await loadPlanOf(reads, box, list)).complete;
  if (!ready) throw new SetCreateRefusal('not-seen', 'The chain does not show this step yet. Try again.');
  const call = sdkCall('complete', ready);
  return { key: 'complete', kind: 'complete', call, target: { kind: 'box', identity: box }, gasLimit: await margin(reads, call, run.creator) };
}

export interface SetRunHooks {
  readonly reads: SetReads;
  readonly source: SetSource;
  readonly chain: SetCreateChain;
  readonly coin: SetCoinLabel;
  /** E-08B's executor sender with the connected wallet. */
  readonly submit: SetSubmit;
  readonly wallet: Eip1193Request;
  /** The run with a newly sent hash (the hook keeps it for a resume). */
  readonly onRun: (run: SetRun) => void;
  readonly onProgress: (progress: SetProgress, sending: SetStepKind | null) => void;
  /** True once the creator pressed Stop or left Create: no further step is sent. */
  readonly stopped: () => boolean;
}

/**
 * Send what is left, one step at a time: read the chain, take the next step, wait for its earlier hash while the node
 * still has it, else estimate, read the owners, send it through the executor and wait for its receipt. Ends 'done' once
 * complete, 'failed' when the raise failed, 'stopped' on Stop; a refusal, a revert or a wallet error throws, and the
 * next press starts from the chain again.
 */
export async function runSetCreate(start: SetRun, hooks: SetRunHooks): Promise<'done' | 'stopped' | 'failed'> {
  let run = start;
  const spec = specOfRun(run);
  const ids = idsOfRun(run);
  let ownersRead = false;
  for (;;) {
    const progress = await readSetProgress(hooks.reads, hooks.source, run, hooks.coin);
    hooks.onProgress(progress, null);
    if (progress.failed) return 'failed';
    if (progress.next === null) return 'done';
    if (hooks.stopped()) return 'stopped';
    // Before this press's first wallet request: every item not loaded yet is the creator's, read now.
    if (!ownersRead) {
      await ownAll(hooks.reads, spec.collection, run.creator, ids.slice(progress.loaded));
      ownersRead = true;
    }
    const step = await stepOf(hooks.reads, hooks.chain, run, progress);
    const earlier = run.sent[step.key];
    if (earlier) {
      const status = await hooks.reads.receipt(earlier) ?? (await hooks.reads.known(earlier) ? await hooks.reads.wait(earlier) : null);
      if (status === 'success') {
        const again = await readSetProgress(hooks.reads, hooks.source, run, hooks.coin);
        if (again.next === progress.next && again.loaded === progress.loaded && again.next !== null) throw new SetCreateRefusal('not-seen', 'The chain does not show this step yet. Try again.');
        continue;
      }
      // Reverted (reported when it happened), or dropped before it was mined: this press sends it again.
      run = { ...run, sent: Object.fromEntries(Object.entries(run.sent).filter(([key]) => key !== step.key)) };
      hooks.onRun(run);
    }
    // Right before a page: its own items, read again (the press's read may be minutes old on a long run).
    if (step.ids) await ownAll(hooks.reads, spec.collection, run.creator, step.ids);
    if (hooks.stopped()) {
      hooks.onProgress(progress, null);
      return 'stopped';
    }
    hooks.onProgress(progress, step.kind);
    const hash = await hooks.submit({ wallet: hooks.wallet, target: step.target, call: step.call, from: run.creator, gasLimit: step.gasLimit, feeReader: hooks.reads.chain });
    run = { ...run, sent: { ...run.sent, [step.key]: hash } };
    hooks.onRun(run);
    if (await hooks.reads.wait(hash) !== 'success') throw new SetCreateRefusal('reverted', 'This step failed on chain.');
  }
}

/** The same run for a draft: the same chain, creator, spec bytes and ids. */
export const sameSetRun = (run: SetRun, chain: Pick<SetCreateChain, 'chainId' | 'factory'>, creator: Address, spec: SetSpecV2, ids: readonly bigint[]): boolean =>
  run.chainId === chain.chainId && same(run.factory, chain.factory) && same(run.creator, creator) && run.encoded.toLowerCase() === encodeSetSpecV2(spec).toLowerCase()
  && run.ids.length === ids.length && run.ids.every((id, i) => id === ids[i]?.toString());

/** The box path of a run (`/box/<chain>/<token>`). */
export const boxOfRun = (run: Pick<SetRun, 'chainId' | 'token'>): string => `/box/${run.chainId}/${run.token.toLowerCase()}`;

/** keccak256 of the run's spec: what the registry records as its spec hash. */
export const specHashOfRun = (run: Pick<SetRun, 'encoded'>): Hex => keccak256(run.encoded);
