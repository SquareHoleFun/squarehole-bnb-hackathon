/**
 * SH-EXISTING-NFTS-E08C: every transaction the add-on's pages can prepare, built from validated inputs only, and the
 * one way they reach a wallet.
 *
 * The calls are exactly the ones E-08B's guard admits (`assertSendableSetCallV2`, docs/design/existing-nfts-v2.md § 4.10
 * and § 4.11). Built here: the price coin's exact approval and SetFactoryV2.createBox (`assertSendableSetCreate`);
 * setApprovalForAll(vault, true|false) from the creator to the box's own vault; an exact T approval to the box's own
 * coordinator and claim(t, to = the caller); releaseToCreator with 1-32 distinct ids; fail and failClosed. Prepared by
 * E-08B and only named here (`sdkCall`): a pick's or return's approvals and withdrawBatch / returnItems
 * (`prepareSetConversion`, set-conversion.ts), the loader's pages and complete (`readSetLoadPlan`, create/set/
 * set-send.ts), and a filled box's graduate() (E-09C `setGraduateCalls`). Nothing else is sent. Amounts and ids are
 * bigint; nothing passes through Number.
 *
 * `setSubmit()` is the one sender: E-08B's executor, its 'set-v2' branch for a box's calls (`submitWrite`, which re-runs
 * the routing rule on the identity's same-block observations and the guard on the call) and `submitSetCreateWrite` for
 * a creation's two steps. Each checks the wallet's chain and account, then asks the wallet to send that one call.
 */
import { encodeFunctionData, erc20Abi, parseAbi, toFunctionSelector, type Address, type Hex } from 'viem';
import { SET_MAX_PAGE, SET_RELEASE_BATCH, decodeSetSpecV2, encodeSetSpecV2, type SetSpecV2 } from '@squarehole/box-spec';
import { setCoordinatorV2Abi, setFactoryV2Abi, setVaultV2Abi } from '@squarehole/chain/core/set-v2';
import type { Eip1193Request } from '@squarehole/chain/write/wallet';
import { EIP7825_TX_GAS_CAP, revertDataOf, submitSetCreateWrite, submitWrite, type SendFeeReader, type SetCreatePlanV2, type SetTargetV2 } from '@squarehole/chain/write';
import type { SetBoxIdentity } from './set-identity';

/** The outside collection's ERC-721 functions the pages read or call (never tokenURI in a financial path). */
export const ERC721_ABI = /* @__PURE__ */ parseAbi([
  'function ownerOf(uint256 id) view returns (address)',
  'function getApproved(uint256 id) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function approve(address to, uint256 id)',
  'function tokenURI(uint256 id) view returns (string)',
]);

export type SetCallKind =
  | 'approve' | 'createBox' | 'approveAll' | 'revokeAll' | 'load' | 'complete'
  | 'approveToken' | 'approveItem' | 'pick' | 'return' | 'release' | 'claim' | 'fail' | 'failClosed' | 'graduate';

export interface SetCall {
  readonly kind: SetCallKind;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

/**
 * What the executor checks a call against: a creation's factory, spec bytes, salts and bootstrap; any later call the
 * box's identity as set-identity.ts verified it (its vault, loader, token, coordinator, collection and creator, and the
 * same-block observations the routing rule ran on). A T approval is admitted only at the amount the action prepared:
 * `tokenApproval`, a pick's quoted most (to the vault); `claimApproval`, a holder's claim (to the coordinator).
 */
export type SetTarget =
  | { readonly kind: 'create'; readonly chainId: number; readonly factory: Address; readonly creator: Address; readonly encodedSpec: Hex; readonly cs: Hex; readonly hs: Hex; readonly bootstrapQ: bigint }
  | {
      readonly kind: 'box'; readonly identity: SetBoxIdentity; readonly tokenApproval?: bigint; readonly claimApproval?: { readonly from: Address; readonly amount: bigint };
      /** A graduation's pinned observation (E-09C `setGraduateCalls`): the guard admits graduate() only with it. */
      readonly graduation?: NonNullable<SetTargetV2['graduation']>;
    };

export interface SetSendRequest {
  readonly wallet: Eip1193Request;
  readonly target: SetTarget;
  readonly call: SetCall;
  readonly from: Address;
  readonly gasLimit: bigint;
  /** SH-SEND-FEES: the source RPC's fee and balance reads the send carries (`SetReads.chain`). */
  readonly feeReader: SendFeeReader;
}
/** Sends one checked call through the wallet; resolves with its hash (not a confirmation). */
export type SetSubmit = (request: SetSendRequest) => Promise<Hex>;

/** A box target as E-08B's executor takes it: the chain, both manifests, the observations, and any approval scope. */
export function setTargetV2Of(target: Extract<SetTarget, { kind: 'box' }>): SetTargetV2 {
  const { identity } = target;
  return {
    chainId: identity.chainId, core: identity.core, release: identity.release, identity: identity.observed,
    ...(target.tokenApproval === undefined ? {} : { tokenApproval: target.tokenApproval }),
    ...(target.claimApproval === undefined ? {} : { claimApproval: target.claimApproval }),
    ...(target.graduation === undefined ? {} : { graduation: target.graduation }),
  };
}

/** A creation target as E-08B's creation guard takes it (the spec decoded from the very bytes the run committed). */
export const setCreatePlanOf = (target: Extract<SetTarget, { kind: 'create' }>): SetCreatePlanV2 => ({
  chainId: target.chainId, factory: target.factory, creator: target.creator, spec: decodeSetSpecV2(target.encodedSpec), cs: target.cs, hs: target.hs, bootstrapQ: target.bootstrapQ,
});

const sendThroughExecutor: SetSubmit = (request) => {
  const call = { to: request.call.to, data: request.call.data, value: request.call.value };
  const { wallet, from, gasLimit, target, feeReader } = request;
  return target.kind === 'create'
    ? submitSetCreateWrite({ wallet, plan: setCreatePlanOf(target), call, from, gasLimit, feeReader })
    : submitWrite({ protocol: 'set-v2', wallet, target: setTargetV2Of(target), call, from, gasLimit, feeReader });
};

/** E-08B's executor: the only way a set call reaches a wallet (no other file sends one). */
export function setSubmit(): SetSubmit | null {
  return sendThroughExecutor;
}

export class SetCallError extends Error {
  override readonly name = 'SetCallError';
}
function refuse(message: string): never {
  throw new SetCallError(message);
}
const MAX_UINT256 = (1n << 256n) - 1n;
const uint = (value: bigint): bigint => (value >= 0n && value <= MAX_UINT256 ? value : refuse('Amount out of range.'));

/** 1..max distinct full-width ids, as the vault checks them (no sentinel, no Number). */
export function checkIds(ids: readonly bigint[], max: number): readonly bigint[] {
  if (ids.length === 0 || ids.length > max || ids.length > SET_MAX_PAGE) refuse(`Pick 1 to ${max} items.`);
  if (new Set(ids).size !== ids.length) refuse('An item is listed twice.');
  for (const id of ids) uint(id);
  return ids;
}

const call = (kind: SetCallKind, to: Address, data: Hex, value = 0n): SetCall => Object.freeze({ kind, to, data, value });

/** A call E-08B's builders prepared (`prepareSetConversion`, `setLoadPlan`), named for the page; its bytes untouched. */
export const sdkCall = (kind: SetCallKind, prepared: { readonly to: Address; readonly data: Hex; readonly value: bigint }): SetCall =>
  call(kind, prepared.to, prepared.data, prepared.value);

/** The price coin's exact approval to the factory: the bootstrap plus the creator's first buy (an ERC-20 price coin only). */
export const approveCall = (spec: SetSpecV2, factory: Address, bootstrapQ: bigint): SetCall =>
  call('approve', spec.pricing.token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [factory, uint(bootstrapQ + spec.creatorBuy)] }));

/** createBox(spec, coordinatorSalt, hookSalt): a native price coin pays the bootstrap plus the first buy as value. */
export function createBoxCall(spec: SetSpecV2, factory: Address, cs: Hex, hs: Hex, bootstrapQ: bigint): SetCall {
  encodeSetSpecV2(spec);
  const native = /^0x0{40}$/i.test(spec.pricing.token);
  return call('createBox', factory, encodeFunctionData({ abi: setFactoryV2Abi, functionName: 'createBox', args: [spec, cs, hs] }), native ? uint(bootstrapQ + spec.creatorBuy) : 0n);
}

/** The creator's one approval of the box's own vault for loading (true), or its revoke (false). */
export const approveAllCall = (box: SetBoxIdentity, approved: boolean): SetCall =>
  call(approved ? 'approveAll' : 'revokeAll', box.collection, encodeFunctionData({ abi: ERC721_ABI, functionName: 'setApprovalForAll', args: [box.vault, approved] }));

/** An exact approval of the box's T to its coordinator (a failed raise's claim; a pick's is E-08B's, to its vault). */
export const approveTokenCall = (box: SetBoxIdentity, spender: 'vault' | 'coordinator', amount: bigint): SetCall =>
  call('approveToken', box.token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender === 'vault' ? box.vault : box.coordinator, uint(amount)] }));

export const releaseCall = (box: SetBoxIdentity, ids: readonly bigint[]): SetCall =>
  call('release', box.vault, encodeFunctionData({ abi: setVaultV2Abi, functionName: 'releaseToCreator', args: [checkIds(ids, SET_RELEASE_BATCH)] }));

/** claim(t, to): always to the caller itself (t = 0 is the creator's remainder of a raise nobody bought into). */
export const claimCall = (box: SetBoxIdentity, t: bigint, caller: Address): SetCall =>
  call('claim', box.coordinator, encodeFunctionData({ abi: setCoordinatorV2Abi, functionName: 'claim', args: [uint(t), caller] }));

export const closeCall = (box: SetBoxIdentity, kind: 'fail' | 'failClosed'): SetCall =>
  call(kind, box.coordinator, encodeFunctionData({ abi: setCoordinatorV2Abi, functionName: kind }));

/** EIP-7825's per-transaction cap (the write package's own constant): no limit the site sets is ever above it. */
export const SET_TX_GAS_CAP = EIP7825_TX_GAS_CAP;

/** The estimate plus a fifth, at most the cap; null when that does not fit (the caller halves a page, or refuses). */
export function gasWithMargin(estimate: bigint): bigint | null {
  if (estimate <= 0n) return null;
  const limit = estimate + (estimate + 4n) / 5n;
  return limit > SET_TX_GAS_CAP ? null : limit;
}

const TRANSFER_GAS = /* @__PURE__ */ toFunctionSelector('TransferGas()');
/** Whether an estimate failed on the vault's TransferGas(): a transfer that needs more gas than the page leaves it. */
export function transferGasRevert(error: unknown): boolean {
  const data = revertDataOf(error);
  return data !== null && data.slice(0, 10).toLowerCase() === TRANSFER_GAS;
}
