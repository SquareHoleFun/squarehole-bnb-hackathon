import { parseSetListFile, setLinkHash, SET_LOAD_BATCH, type SetCommitment, type SetPage } from '@squarehole/box-spec';
import { zeroHash, type Address, type Hex } from 'viem';
import { starterSetLoaderV2Abi } from '../../v2/abi-v2';
import { setCall, type SetCallV2 } from './calls';

export interface SetLoadInput {
  readonly loader: Address;
  readonly commitment: SetCommitment;
  readonly list: unknown;
  /** Read StarterSetLoaderV2.progress(), afresh on every resume, never local receipt counts. */
  readonly progress: () => Promise<readonly [number, Hex, boolean]>;
  readonly batchSize?: number;
}
export async function setLoadPlan(input: SetLoadInput) {
  const {ids} = parseSetListFile(input.list, input.commitment);
  const size = input.batchSize ?? SET_LOAD_BATCH;
  if (!Number.isInteger(size) || size < 1 || size > SET_LOAD_BATCH) throw new RangeError('loading batch');
  const suffix: Hex[] = Array<Hex>(ids.length + 1).fill(zeroHash);
  for (let i = ids.length - 1; i >= 0; --i) suffix[i] = setLinkHash(input.commitment.collection, ids[i] as bigint, suffix[i+1] as Hex);
  const [loaded, remainingHash, notified] = await input.progress();
  if (!Number.isInteger(loaded) || loaded < 0 || loaded > ids.length || suffix[loaded]?.toLowerCase() !== remainingHash.toLowerCase()
    || (notified && loaded !== ids.length)) throw new Error('loader committed suffix differs from progress');
  const pages: {page: SetPage; call: SetCallV2}[] = [];
  for (let start = loaded; start < ids.length; start += size) {
    const pageIds = ids.slice(start, start + size);
    const page: SetPage = {ids: pageIds, collections: pageIds.map(() => input.commitment.collection), tiers: pageIds.map(() => 0), nextHash: suffix[start+pageIds.length] as Hex};
    pages.push({page, call: setCall(input.loader, starterSetLoaderV2Abi, 'load', [page.collections,page.ids,page.tiers,page.nextHash])});
  }
  return {loaded, notified, pages, complete: notified ? null : setCall(input.loader,starterSetLoaderV2Abi,'complete')};
}
