/** Narrow wallet authority for prepared v2 box actions, including collection conversion (SH-TA-32). */
import { decodeFunctionData, encodeFunctionData, erc20Abi, isAddress, maxUint256, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '../../abi/boxCollection';
import { boxTicketsAbi } from '../../abi/boxTickets';
import { NotSendableError } from '../../write/calls';
import { MAX_PER_BATCH, MULTICALL3, multicall3Abi } from './reveal-batch-calls-v2';
import { launchRouterV2Abi, royaltyRouterV2Abi, receiverModulesV21Abi, receiverPileV21Abi, receiverEatV21Abi, coordinatorV2Abi, itemLedgerV2Abi, pileVaultV2Abi, receiverV2Abi, shopVaultV2Abi, vaultV2Abi } from './abi-v2';

/** One reviewed approval, fixed independently of the calldata presented to the sender. */
export type CollectionApprovalV2 =
  | { readonly kind: 'token'; readonly spender: 'vault' | 'tickets'; readonly amount: bigint }
  | { readonly kind: 'item'; readonly id: bigint };

export interface WriteTargetV2 {
  readonly chainId: number;
  readonly token: Address;
  readonly coordinator: Address;
  readonly receiver: Address;
  readonly p: Address;
  readonly royaltyRouter?: Address;
  /** Role 6, the launch router: only for its public sweep (SH-RC7-SITE-INBOX, KF-5). */
  readonly launchRouter?: Address;
  /** Role 17 of a holder-payout box (M2); absent for every other box. */
  readonly holderLedger?: Address;
  /** Role 16 of an every-item box (M3); absent for every other box. */
  readonly itemLedger?: Address;
  /** Role 3 of a coin-pile box (M3); absent for every other box. */
  readonly pile?: Address;
  /** Role 3 of a shop box (M2); absent for every other box. */
  readonly shop?: Address;
  /**
   * Canonical receiver sellers choice read at the prepared block, when the caller knows it: 11 (ShopT) authorizes
   * executeModule(true) only as the core shop step of the prepared shop and holder ledger; 10 is a directory action.
   */
  readonly sellersChoice?: number;
  /**
   * The shop's listed collections (its spec's and those its curator added), only with `shop`: an item approval for the
   * shop, a give and a pick each name one of them, and an addition names none of them.
   */
  readonly shopCollections?: readonly Address[];
  /** Collection box roles 3, 4 and optional 7, from its indexed record or coordinator wiring, never implementations. */
  readonly vault?: Address;
  readonly collection?: Address;
  readonly tickets?: Address;
  /** Wallet for which the collection action was prepared; rechecked against the submitting caller. */
  readonly collectionCaller?: Address;
  /** Exact reviewed approval: T up to the operation's chosen limit, or one item id. No blanket item approval. */
  readonly collectionApproval?: CollectionApprovalV2;
  /** Exact ETH value prepared for draw's drand bounty; required even when zero, never used by another action. */
  readonly drawValue?: bigint;
}

export interface WriteCallV2 {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

const abi: Abi = [
  ...royaltyRouterV2Abi.filter(item => item.type === 'function' && ['claimInKind', 'refreshOrder', 'observe'].includes(item.name)),
  ...receiverModulesV21Abi.filter(item => item.type === 'function' && item.name === 'executeModule'),
  ...receiverPileV21Abi.filter(item => item.type === 'function' && item.name === 'moveToPile'),
  ...receiverEatV21Abi.filter(item => item.type === 'function' && item.name === 'eatPriceCoin'),
  ...coordinatorV2Abi.filter((item) => item.type === 'function' && ['claim', 'fail', 'failClosed'].includes(item.name)),
  ...receiverV2Abi.filter((item) => item.type === 'function' && item.name === 'claimCreator'),
  ...erc20Abi.filter((item) => item.type === 'function' && item.name === 'approve'),
  ...itemLedgerV2Abi.filter((item) => item.type === 'function' && ['claim', 'claimT', 'sync'].includes(item.name)),
  ...pileVaultV2Abi.filter((item) => item.type === 'function' && ['redeem', 'returnSeed'].includes(item.name)),
  ...shopVaultV2Abi.filter((item) => item.type === 'function' && ['give', 'pick', 'addCollection'].includes(item.name)),
  // KF-5: the launch router's sweep() (no argument); the inbox's sweep(address) is not a site action.
  ...launchRouterV2Abi.filter((item) => item.type === 'function' && item.name === 'sweep'),
  ...vaultV2Abi.filter((item) => item.type === 'function' && ['withdraw', 'withdrawBatch', 'returnItem', 'returnItems'].includes(item.name)),
  // V2 implements the same IBoxTickets / IBoxCollection signatures as these generated ABIs.
  ...boxTicketsAbi.filter((item) => item.type === 'function' && ['take', 'handBack', 'draw', 'open', 'openDraw'].includes(item.name)),
  ...boxCollectionAbi.filter((item) => item.type === 'function' && item.name === 'reveal'),
];

// ceil(log2(10_000)) = 14 siblings. Inner reveal = 4 + 8*32 + 14*32 = 708 bytes.
// aggregate3 = 4 + 64 + 40*(32 offset + 128 tuple header + 736 padded bytes) = 35_908.
export const MAX_OPEN_REVEAL_CALLDATA_BYTES = 35_908;
const uint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value <= maxUint256;
const positive = (value: unknown): value is bigint => uint(value) && value > 0n;
const ids = (value: unknown, minimum: bigint): boolean => Array.isArray(value) && value.length > 0
  && value.every(id => uint(id) && id >= minimum) && new Set(value).size === value.length;

/** Recheck the prepared role addresses, selector and caller-bound arguments immediately before submission. */
export function assertSendableCallV2(call: WriteCallV2, target: WriteTargetV2, from: Address): void {
  const same = (a: unknown, b: Address): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (![target.token, target.coordinator, target.receiver, from].every((address) => isAddress(address) && address !== zeroAddress) || !isAddress(target.p)) {
    throw new NotSendableError('invalid box role or caller address');
  }
  const ledger = target.holderLedger;
  const items = target.itemLedger;
  const pile = target.pile;
  const shop = target.shop;
  const optional = [ledger, items, pile, shop, target.royaltyRouter, target.launchRouter, target.vault, target.collection, target.tickets].filter((role): role is Address => role !== undefined);
  const roles = [target.token, target.coordinator, target.receiver, ...optional];
  if (optional.some((role) => !isAddress(role) || role === zeroAddress) || new Set(roles.map((role) => role.toLowerCase())).size !== roles.length
    || (target.collection !== undefined && same(target.collection, target.p))) {
    throw new NotSendableError('invalid optional box role address');
  }
  // A shop's collections: only with the shop, each a nonzero address that is none of the box's roles, none twice.
  const collections = target.shopCollections ?? [];
  if (collections.length > 0 && shop === undefined) throw new NotSendableError('shop collections need the shop');
  if (collections.some((collection) => !isAddress(collection) || collection === zeroAddress)
    || new Set([...roles, ...collections].map((address) => address.toLowerCase())).size !== roles.length + collections.length) {
    throw new NotSendableError('invalid shop collection address');
  }
  const listed = (value: unknown): value is Address => typeof value === 'string' && collections.some((collection) => same(value, collection));
  const collectionRole = (role: 'vault' | 'collection' | 'tickets'): Address => {
    if (!target.vault || !target.collection || !target.collectionCaller || !same(target.collectionCaller, from) || !target[role]) {
      throw new NotSendableError('collection action needs its prepared roles and caller');
    }
    return target[role];
  };
  // SH-202: this is the only Multicall3 exception. Proofs are authenticated by the source
  // reader/planner and again by the collection. This boundary limits wallet authority.
  if (same(call.to, MULTICALL3)) {
    const collection = collectionRole('collection');
    try {
      if (call.value !== 0n || typeof call.data !== 'string' || call.data.length > 2 + 2 * MAX_OPEN_REVEAL_CALLDATA_BYTES) throw new Error();
      const decoded = decodeFunctionData({ abi: multicall3Abi, data: call.data });
      if (encodeFunctionData({ abi: multicall3Abi, ...decoded }).toLowerCase() !== call.data.toLowerCase()) throw new Error();
      const calls = decoded.args[0];
      if (calls.length < 1 || calls.length > MAX_PER_BATCH) throw new Error();
      let previous = -1n;
      for (const inner of calls) {
        if (!same(inner.target, collection) || inner.allowFailure !== true) throw new Error();
        const reveal = decodeFunctionData({ abi: boxCollectionAbi, data: inner.callData });
        if (reveal.functionName !== 'reveal' || reveal.args[0] <= previous || reveal.args[0] < 1n || reveal.args[0] > 10_000n || reveal.args[6].length > 14
          || encodeFunctionData({ abi: boxCollectionAbi, ...reveal }).toLowerCase() !== inner.callData.toLowerCase()) throw new Error();
        previous = reveal.args[0];
      }
      return;
    } catch { throw new NotSendableError('invalid-open-reveal-batch'); }
  }
  let decoded;
  try {
    decoded = decodeFunctionData({ abi, data: call.data });
    if (encodeFunctionData({ abi, functionName: decoded.functionName, args: decoded.args }).toLowerCase() !== call.data.toLowerCase()) throw new Error('noncanonical');
  } catch {
    throw new NotSendableError('calldata is not a canonical v2 box action');
  }
  if (decoded.functionName === 'draw') {
    if (!uint(target.drawValue) || call.value !== target.drawValue) throw new NotSendableError('draw must carry exactly its prepared ETH bounty');
  } else if (call.value !== 0n) throw new NotSendableError('writes never carry value');
  const args = decoded.args ?? [];
  let to: Address;
  switch (decoded.functionName) {
    case 'approve':
      if (target.collectionApproval !== undefined || (target.collection && same(call.to, target.collection))
        || (target.vault && same(args[0], target.vault)) || (target.tickets && same(args[0], target.tickets))) {
        const vault = collectionRole('vault');
        const approval = target.collectionApproval;
        if (!approval) throw new NotSendableError('collection approval needs an exact prepared amount or item');
        if (approval.kind === 'item') {
          to = collectionRole('collection');
          if (!same(args[0], vault) || !uint(approval.id) || args[1] !== approval.id) throw new NotSendableError('item approval must name the vault and the prepared item');
        } else if (approval.kind === 'token' && (approval.spender === 'vault' || approval.spender === 'tickets')) {
          to = target.token;
          if (!same(args[0], collectionRole(approval.spender)) || !positive(approval.amount) || approval.amount === maxUint256 || args[1] !== approval.amount) {
            throw new NotSendableError('T approval must name its prepared spender and exact finite amount');
          }
        } else throw new NotSendableError('unknown collection approval');
        break;
      }
      if (shop !== undefined && !same(call.to, target.token) && listed(call.to)) {
        // An item approval (ERC-721 approve(shop, id), the same selector): the shop may take this one item, which it
        // does only in its owner's own give.
        to = call.to;
        if (!same(args[0], shop) || typeof args[1] !== 'bigint') throw new NotSendableError('item approval must name the shop and one item');
        break;
      }
      to = target.token;
      // The coordinator takes T for the failure claim; a coin pile takes T for a redemption (M3); a shop for a pick (M2).
      if (!(same(args[0], target.coordinator) || (pile !== undefined && same(args[0], pile)) || (shop !== undefined && same(args[0], shop)))
        || typeof args[1] !== 'bigint' || args[1] <= 0n) {
        throw new NotSendableError('approval must name the coordinator or the pile (or the shop) and a positive exact amount');
      }
      break;
    case 'withdraw':
    case 'returnItem':
    case 'withdrawBatch':
    case 'returnItems': {
      to = collectionRole('vault');
      const batch = decoded.functionName === 'withdrawBatch' || decoded.functionName === 'returnItems';
      const taking = decoded.functionName === 'withdraw' || decoded.functionName === 'withdrawBatch';
      if (!(batch ? ids(args[0], 0n) : uint(args[0])) || !(taking ? positive(args[1]) : uint(args[1])) || !positive(args[2])) {
        throw new NotSendableError('vault conversion needs distinct items, a limit and a deadline');
      }
      break;
    }
    case 'take':
    case 'handBack':
      to = collectionRole('tickets');
      if (!(decoded.functionName === 'take' ? positive(args[0]) && positive(args[1]) : ids(args[0], 1n) && uint(args[1])) || !positive(args[2])) {
        throw new NotSendableError('tickets need a count or distinct ids, a limit and a deadline');
      }
      break;
    case 'draw':
      to = collectionRole('tickets');
      if (!positive(args[0]) || !positive(args[1])) throw new NotSendableError('draw needs a positive limit and deadline');
      break;
    case 'open':
    case 'openDraw':
      to = collectionRole('tickets');
      // open has no recipient argument: the contract delivers to the current placeholder owner.
      if (!positive(args[0]) || (decoded.functionName === 'openDraw' && !same(args[1], from))) {
        throw new NotSendableError('opening needs a ticket and may only name the caller as recipient');
      }
      break;
    case 'reveal':
      to = collectionRole('collection');
      // The ABI checks uint128 and every proof word; only the collection can authenticate the Merkle proof.
      break;
    case 'claimT':
      to = items as Address;
      if (!items || !same(call.to, items) || !Array.isArray(args[0]) || args[0].length !== 1
        || typeof args[0][0] !== 'bigint' || args[0][0] <= 0n || !same(args[1], from)) {
        throw new NotSendableError('T item claim must name one item and pay the caller');
      }
      break;
    case 'claim':
      // The holder ledger's claim(batchId, to) shares the failure claim's selector, so only the prepared target
      // tells them apart. Claim-only payouts (F127): the caller claims its own credit, paid to itself.
      if (items !== undefined && same(call.to, items)) {
        // Item claims are claim-only too: one item id per call, paid to the caller (F127, SH-V2-M3-53).
        to = items;
        const ids = args[0];
        if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'bigint' || ids[0] <= 0n || !same(args[1], from)) {
          throw new NotSendableError('item claim must name one item and pay the caller');
        }
        break;
      }
      if (typeof args[0] !== 'bigint') throw new NotSendableError('claim amount or batch must be a number');
      if (ledger !== undefined && same(call.to, ledger)) {
        to = ledger;
        if (typeof args[0] !== 'bigint' || args[0] <= 0n || !same(args[1], from)) throw new NotSendableError('holder claim must name a batch and pay the caller');
        break;
      }
      to = target.coordinator;
      // Zero is the fixed no-buyer claim; the contract checks its creator entitlement.
      if (!same(args[1], from)) throw new NotSendableError('claim must pay the caller');
      break;
    case 'executeModule':
      // One canonical side, to the prepared receiver: the generic entry of a directory action such as The Alchemist
      // (choice 10, AL21), on either side. A declared sellers ShopT (11) is the core shop step and needs the prepared
      // shop and its holder ledger (SF-W); a declared sellers choice that is neither has no step to run.
      if (args.length !== 1 || typeof args[0] !== 'boolean') throw new NotSendableError('module execution needs one side');
      if (args[0] && target.sellersChoice !== undefined && target.sellersChoice !== 10) {
        if (target.sellersChoice !== 11) throw new NotSendableError('the sellers side has no module or shop step');
        if (!shop || !ledger) throw new NotSendableError('only the sellers core shop step is sendable');
      }
      to = target.receiver;
      break;
    case 'moveToPile':
    case 'eatPriceCoin':
      to = target.receiver;
      break;
    case 'refreshOrder':
      if (!target.royaltyRouter || args.length > 1) throw new NotSendableError('royalty refresh needs a router and at most one coin');
      to = target.royaltyRouter;
      break;
    case 'observe':
      if (!target.royaltyRouter || args.length !== 1) throw new NotSendableError('royalty observation needs a router and one coin');
      to = target.royaltyRouter;
      break;
    case 'claimInKind':
      if (!target.royaltyRouter || same(args[0], target.p) || args.length !== 1) throw new NotSendableError('in-kind royalty needs a router and a non-price coin');
      to = target.royaltyRouter;
      break;
    case 'sweep':
      // KF-5: anyone sweeps the launch tax; the contract fixes where it goes (the pool's depth, or the failure pot).
      if (!target.launchRouter || args.length !== 0) throw new NotSendableError('router sweep needs the launch router and no argument');
      to = target.launchRouter;
      break;
    case 'claimCreator':
      to = target.receiver;
      if (!same(args[0], target.p) || !same(args[1], from)) throw new NotSendableError('creator claim must pay the caller in the box price coin');
      break;
    case 'fail':
    case 'failClosed':
      to = target.coordinator;
      break;
    case 'sync':
      if (items === undefined) throw new NotSendableError('sync needs the item ledger');
      to = items;
      if (typeof args[0] !== 'bigint' || args[0] < 1n || args[0] > 32n) throw new NotSendableError('sync must process 1 to 32 records');
      break;
    case 'redeem':
      if (pile === undefined) throw new NotSendableError('redeem needs the coin pile');
      to = pile;
      if (typeof args[0] !== 'bigint' || args[0] <= 0n || typeof args[1] !== 'bigint' || args[1] <= 0n || !same(args[2], from)) {
        throw new NotSendableError('redeem must burn some T for a positive minimum, paid to the caller');
      }
      break;
    case 'returnSeed':
      if (pile === undefined) throw new NotSendableError('seed return needs the coin pile');
      to = pile;
      break;
    case 'give':
      // The giver's own item, from a listed collection, for at least the given T (the shop pays exactly its tier).
      if (shop === undefined) throw new NotSendableError('give needs the shop');
      to = shop;
      if (!listed(args[0]) || typeof args[1] !== 'bigint' || typeof args[2] !== 'bigint' || args[2] <= 0n) {
        throw new NotSendableError('give must name a listed collection, one item and a positive minimum');
      }
      break;
    case 'pick':
      // One item of a listed collection, for at most the given T, to the caller.
      if (shop === undefined) throw new NotSendableError('pick needs the shop');
      to = shop;
      if (!listed(args[0]) || typeof args[1] !== 'bigint' || typeof args[2] !== 'bigint' || args[2] <= 0n || !same(args[3], from)) {
        throw new NotSendableError('pick must name a listed collection, one item, a positive maximum and the caller');
      }
      break;
    case 'addCollection':
      // The curator's addition (the shop checks the curator): a collection not listed yet and none of the box's roles.
      if (shop === undefined) throw new NotSendableError('adding a collection needs the shop');
      to = shop;
      if (typeof args[0] !== 'string' || !isAddress(args[0]) || args[0] === zeroAddress || listed(args[0]) || roles.some((role) => same(args[0], role))
        || typeof args[1] !== 'number' || args[1] > 3) {
        throw new NotSendableError('an addition must name an unlisted collection and a tier from 1 to 4');
      }
      break;
    default:
      throw new NotSendableError('function is not a v2 box action');
  }
  if (!same(call.to, to)) throw new NotSendableError('v2 action must target its prepared box role');
}
