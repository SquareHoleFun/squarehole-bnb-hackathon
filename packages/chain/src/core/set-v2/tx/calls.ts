import { decodeFunctionData, encodeFunctionData, erc20Abi, erc721Abi, isAddress, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { setUint256Schema } from '@squarehole/box-spec';
import { checkSetIdentity, type SetIdentityInput } from '../route-set-v2';
import type { SetCoreManifest, SetReleaseManifest } from '../manifest-set-v2';
import { setVaultV2Abi } from '../abi-set-v2';
import { coordinatorV2Abi, starterSetLoaderV2Abi } from '../../v2/abi-v2';
import { NotSendableError } from '../../../write/calls';

export interface SetCallV2 { readonly to: Address; readonly data: Hex; readonly value: bigint }
/** Identity observations must come from the selected chain at one pinned block. No metadata-supplied vault. */
export interface SetTargetV2 {
  readonly chainId: number;
  readonly core: SetCoreManifest;
  readonly release: SetReleaseManifest;
  readonly identity: SetIdentityInput;
  /** Exact fee-inclusive input of the prepared pick; no standing unlimited T approval. */
  readonly tokenApproval?: bigint;
  /** Exact T input for this holder's self-recipient failure claim, scoped separately from picks. */
  readonly claimApproval?: { readonly from: Address; readonly amount: bigint };
  /** Produced by setGraduateCalls from the verified coordinator/hook at one canonical block. */
  readonly graduation?: {
    readonly blockNumber: bigint; readonly blockHash: Hex;
    readonly coordinator: Address; readonly hook: Address;
    readonly closed: boolean; readonly graduated: boolean; readonly failed: boolean;
  };
}
export function setCall(to: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): SetCallV2 {
  return {to, data: encodeFunctionData({abi, functionName, args}), value: 0n};
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const refuse = (): never => { throw new NotSendableError('not a canonical scoped set action'); };
function distinctIds(value: unknown): value is bigint[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32
    && value.every(id => setUint256Schema.safeParse(id).success) && new Set(value).size === value.length;
}
export function creatorApproval(target: SetTargetV2, from: Address, approved: boolean): SetCallV2 {
  const {collection, vault} = checkSetIdentity(target.core, target.release, target.identity);
  const call = setCall(collection, erc721Abi, 'setApprovalForAll', [vault, approved]);
  assertSendableSetCallV2(call, target, from);
  return call;
}
/** Present/send the approval only immediately before this holder's claim. Never a standing allowance. */
export function setClaimCalls(target: SetTargetV2, from: Address, amount: bigint) {
  const scoped = {...target, claimApproval: {from, amount}};
  const coordinator = target.identity.roles[0], token = target.identity.roles[1];
  if (!coordinator || !token) return refuse();
  const approval = setCall(token, erc20Abi, 'approve', [coordinator, amount]);
  const call = setCall(coordinator, coordinatorV2Abi, 'claim', [amount, from]);
  for (const c of [approval, call]) assertSendableSetCallV2(c, scoped, from);
  return {target: scoped, approval, call};
}
/** Re-encode to reject trailing bytes, dirty padding and aliasing, as well as every unlisted selector/recipient. */
export function assertSendableSetCallV2(call: SetCallV2, target: SetTargetV2, from: Address): void {
  if (!Number.isSafeInteger(target.chainId) || target.chainId !== target.release.chainId || target.chainId !== target.core.chainId
    || !isAddress(from) || same(from,zeroAddress) || !isAddress(call.to) || call.value !== 0n) refuse();
  const {collection, vault} = checkSetIdentity(target.core, target.release, target.identity);
  const [coordinator, token] = target.identity.roles;
  const loader = target.identity.roles[19];
  let abi: Abi;
  if (same(call.to,vault)) abi = setVaultV2Abi;
  else if (coordinator && same(call.to,coordinator)) abi = coordinatorV2Abi;
  else if (token && same(call.to,token)) abi = erc20Abi;
  else if (same(call.to,collection)) abi = erc721Abi;
  else if (loader && same(call.to,loader)) abi = starterSetLoaderV2Abi;
  else return refuse();
  try {
    const decoded = decodeFunctionData({abi, data: call.data});
    const args = (decoded.args ?? []) as readonly unknown[];
    if (!same(encodeFunctionData({abi, functionName: decoded.functionName, args}),call.data)) refuse();
    const fn = decoded.functionName;
    if (same(call.to,vault)) {
      if (!['withdrawBatch','returnItems','releaseToCreator'].includes(fn) || !distinctIds(args[0])) refuse();
    } else if (coordinator && same(call.to,coordinator)) {
      if (fn === 'graduate') {
        const observed = target.graduation, hook = target.identity.roles[2];
        if (!observed || !hook || !same(observed.coordinator,coordinator) || !same(observed.hook,hook)
          || typeof observed.blockNumber !== 'bigint' || observed.blockNumber < 0n || !/^0x[0-9a-fA-F]{64}$/.test(observed.blockHash)
          || observed.closed !== true || observed.graduated !== false || observed.failed !== false) refuse();
      } else if (!(fn === 'fail' || fn === 'failClosed' || (fn === 'claim' && same(String(args[1]),from)))) refuse();
      if (fn === 'claim' && target.claimApproval
        && (!same(target.claimApproval.from,from) || args[0] !== target.claimApproval.amount)) refuse();
    } else if (token && same(call.to,token)) {
      const expected = same(String(args[0]),vault) ? target.tokenApproval
        : coordinator && same(String(args[0]),coordinator) && target.claimApproval && same(target.claimApproval.from,from)
          ? target.claimApproval.amount : undefined;
      if (fn !== 'approve' || expected === undefined || expected <= 0n || expected >= (1n<<256n)-1n || args[1] !== expected) refuse();
    } else if (same(call.to,collection)) {
      if (!same(String(args[0]),vault)) refuse();
      if (fn === 'setApprovalForAll') { if (!same(from,target.identity.creator)) refuse(); }
      else if (fn !== 'approve') refuse();
    } else if (fn === 'load') {
      const [collections, ids, tiers] = args;
      if (!distinctIds(ids) || !Array.isArray(collections) || !Array.isArray(tiers) || collections.length !== ids.length
        || tiers.length !== ids.length || !collections.every(c => same(String(c), collection)) || !tiers.every(t => t === 0)) refuse();
    } else if (fn !== 'complete') refuse();
  } catch (error) { if (error instanceof NotSendableError) throw error; refuse(); }
}
