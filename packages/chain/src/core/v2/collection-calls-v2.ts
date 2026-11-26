/** Unsigned collection actions (SH-TA-32). All roles come from one box, all amounts are raw bigint. */
import { concatHex, encodeAbiParameters, keccak256, encodeFunctionData, erc20Abi, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '../../abi/boxCollection';
import { boxTicketsAbi } from '../../abi/boxTickets';
import { NotSendableError } from '../../write/calls';
import { vaultV2Abi } from './abi-v2';
import { rolesOfV2, type BoxRecordV2 } from './record-v2';
import { assertSendableCallV2, type WriteCallV2, type WriteTargetV2 } from './write-calls-v2';

/** IBoxTickets.ItemReveal; also the six trailing arguments of IBoxCollection.reveal. */
export interface ItemRevealV2 {
  readonly traitsPacked: bigint;
  readonly imageHash: Hex;
  readonly avatarHash: Hex;
  readonly modelHash: Hex;
  readonly salt: Hex;
  readonly proof: readonly Hex[];
}

export interface CollectionTargetV2 extends WriteTargetV2 {
  readonly vault: Address;
  readonly collection: Address;
  readonly collectionCaller: Address;
}

/**
 * Use the verified indexer box view's record (or the coordinator's equivalent wiring), never the release's
 * implementation addresses. The caller must verify chain, record provenance and current state before sending.
 * Add collectionApproval for each reviewed approval and drawValue for a draw, independently of submitted calldata.
 */
export function collectionTargetV2(chainId: number, record: BoxRecordV2, from: Address): CollectionTargetV2 {
  const { token, coordinator, receiver, vault, collection, tickets } = rolesOfV2(record).contracts;
  if (!token || !coordinator || !receiver || !vault || !collection) throw new NotSendableError('box has no collection wiring');
  const addresses = [token, coordinator, receiver, vault, collection, ...(tickets ? [tickets] : [])];
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAddress(record.q)
    || !isAddress(from) || from === zeroAddress
    || addresses.some(address => !isAddress(address) || address === zeroAddress)
    || new Set(addresses.map(address => address.toLowerCase())).size !== addresses.length) {
    throw new NotSendableError('invalid collection wiring or caller');
  }
  return { chainId, token, coordinator, receiver, p: record.q, vault, collection, collectionCaller: from, ...(tickets ? { tickets } : {}) };
}

function checked(target: WriteTargetV2, from: Address, role: 'token' | 'vault' | 'collection' | 'tickets', data: Hex, value = 0n): WriteCallV2 {
  const to = target[role];
  if (!to) throw new NotSendableError(`collection action needs ${role}`);
  const call = { to, data, value };
  assertSendableCallV2(call, target, from);
  return call;
}

/** Exact finite allowance for this operation's T limit (principal plus fee), to the vault or tickets. */
export function collectionTokenApprovalCallV2(target: WriteTargetV2, from: Address): WriteCallV2 {
  const approval = target.collectionApproval;
  if (approval?.kind !== 'token' || (approval.spender !== 'vault' && approval.spender !== 'tickets')) throw new NotSendableError('prepare the exact T approval first');
  const spender = target[approval.spender];
  if (!spender) throw new NotSendableError('missing collection approval spender');
  return checked(target, from, 'token', encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, approval.amount] }));
}

/** One approval per returned item, even for returnItems; the vault needs no setApprovalForAll. */
export function collectionItemApprovalCallV2(target: WriteTargetV2, from: Address): WriteCallV2 {
  const approval = target.collectionApproval;
  if (approval?.kind !== 'item' || !target.vault) throw new NotSendableError('prepare the item approval first');
  return checked(target, from, 'collection', encodeFunctionData({ abi: boxCollectionAbi, functionName: 'approve', args: [target.vault, approval.id] }));
}

/** The vault pulls T and delivers the named item to msg.sender. */
export function withdrawCallV2(target: WriteTargetV2, id: bigint, maxTokenIn: bigint, deadline: bigint, from: Address): WriteCallV2 {
  return checked(target, from, 'vault', encodeFunctionData({ abi: vaultV2Abi, functionName: 'withdraw', args: [id, maxTokenIn, deadline] }));
}

export function withdrawBatchCallV2(target: WriteTargetV2, ids: readonly bigint[], maxTokenIn: bigint, deadline: bigint, from: Address): WriteCallV2 {
  return checked(target, from, 'vault', encodeFunctionData({ abi: vaultV2Abi, functionName: 'withdrawBatch', args: [ids, maxTokenIn, deadline] }));
}

/** The vault pulls the caller's item, deducts the fee from principal and pays the caller; no T approval. */
export function returnItemCallV2(target: WriteTargetV2, id: bigint, minTokenOut: bigint, deadline: bigint, from: Address): WriteCallV2 {
  return checked(target, from, 'vault', encodeFunctionData({ abi: vaultV2Abi, functionName: 'returnItem', args: [id, minTokenOut, deadline] }));
}

export function returnItemsCallV2(target: WriteTargetV2, ids: readonly bigint[], minTokenOut: bigint, deadline: bigint, from: Address): WriteCallV2 {
  return checked(target, from, 'vault', encodeFunctionData({ abi: vaultV2Abi, functionName: 'returnItems', args: [ids, minTokenOut, deadline] }));
}

/** Tickets pulls T from the caller; the placeholders are minted to the caller. */
export function takeCallV2(target: WriteTargetV2, count: bigint, maxTokenIn: bigint, deadline: bigint, from: Address): WriteCallV2 {
  return checked(target, from, 'tickets', encodeFunctionData({ abi: boxTicketsAbi, functionName: 'take', args: [count, maxTokenIn, deadline] }));
}

/** Burns the caller's placeholders and pays the caller; no item or T approval. */
export function handBackCallV2(target: WriteTargetV2, ids: readonly bigint[], minTokenOut: bigint, deadline: bigint, from: Address): WriteCallV2 {
  return checked(target, from, 'tickets', encodeFunctionData({ abi: boxTicketsAbi, functionName: 'handBack', args: [ids, minTokenOut, deadline] }));
}

/** Only this requested action takes ETH: the exact prepared drand bounty, separate from its T approval. */
export function drawCallV2(target: WriteTargetV2, maxTokenIn: bigint, deadline: bigint, from: Address): WriteCallV2 {
  if (target.drawValue === undefined) throw new NotSendableError('prepare the draw ETH bounty first');
  return checked(target, from, 'tickets', encodeFunctionData({ abi: boxTicketsAbi, functionName: 'draw', args: [maxTokenIn, deadline] }), target.drawValue);
}

/** The contract delivers to the placeholder's current owner; no approval needed for an owner's own open. */
export function openCallV2(target: WriteTargetV2, id: bigint, reveal: ItemRevealV2, from: Address): WriteCallV2 {
  return checked(target, from, 'tickets', encodeFunctionData({ abi: boxTicketsAbi, functionName: 'open', args: [id, reveal] }));
}

/** Explicit recipient is always the prepared caller; the contract enforces drawer/grace rules. */
export function openDrawCallV2(target: WriteTargetV2, id: bigint, reveal: ItemRevealV2, from: Address): WriteCallV2 {
  return checked(target, from, 'tickets', encodeFunctionData({ abi: boxTicketsAbi, functionName: 'openDraw', args: [id, from, reveal] }));
}

/** Permissionless proof submission to this box's collection; the contract checks reveal eligibility and proof. */
export function revealCallV2(target: WriteTargetV2, id: bigint, reveal: ItemRevealV2, from: Address): WriteCallV2 {
  return checked(target, from, 'collection', encodeFunctionData({ abi: boxCollectionAbi, functionName: 'reveal',
    args: [id, reveal.traitsPacked, reveal.imageHash, reveal.avatarHash, reveal.modelHash, reveal.salt, reveal.proof] }));
}

/** Authenticate an index-directed collection proof against a previously read on-chain commitment. */
export function checkedRevealCallV2(
  target: WriteTargetV2, id: bigint, reveal: ItemRevealV2,
  commitment: { readonly root: Hex; readonly firstId: bigint; readonly size: bigint }, from: Address,
): WriteCallV2 {
  const { root, firstId, size } = commitment;
  if (size <= 0n || size > 1n << 20n || firstId < 0n || id < firstId || id - firstId >= size) {
    throw new NotSendableError('reveal id outside collection');
  }
  let depth = 0;
  for (let width = 1n; width < size; width <<= 1n) depth++;
  if (reveal.proof.length !== depth || !/^0x[0-9a-fA-F]{64}$/.test(root)) throw new NotSendableError('invalid reveal proof');
  // The existing builder validates ABI ranges, every bytes32, the target and caller as well.
  const call = revealCallV2(target, id, reveal, from);
  let node = keccak256(encodeAbiParameters([
    { type: 'uint256' }, { type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
  ], [id, reveal.traitsPacked, reveal.imageHash, reveal.avatarHash, reveal.modelHash, reveal.salt]));
  let position = id - firstId;
  for (const sibling of reveal.proof) {
    node = keccak256(position & 1n ? concatHex([sibling, node]) : concatHex([node, sibling]));
    position >>= 1n;
  }
  if (node.toLowerCase() !== root.toLowerCase()) throw new NotSendableError('invalid reveal proof for root');
  return call;
}
