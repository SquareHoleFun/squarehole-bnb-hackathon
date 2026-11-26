import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';
import type { BoxSpecV2 } from './spec-v2';

/** IShopVaultV2.ShopConfigV2; prices and seed are raw T, never P. */
export const shopConfigV2Parameters = parseAbiParameters('(uint256 seedT,uint256[4] givePricesT,uint16 pickBps,uint16 weeklyBps,uint16 collectionBps,uint32 listDelay,address curator,address[] collections,uint8[] tiers)');
export function shopConfigV2(contents: Hex) {
  const values = decodeAbiParameters(shopConfigV2Parameters, contents);
  if (encodeAbiParameters(shopConfigV2Parameters, values).toLowerCase() !== contents.toLowerCase()) throw new Error('noncanonical shop config');
  return values[0];
}
export function starterCommitmentV2(spec: BoxSpecV2) {
  const addon = spec.addOns.find(a => a.id === 8);
  if (!addon) return null;
  const params = parseAbiParameters('bytes32,uint32');
  const [setHash, count] = decodeAbiParameters(params, addon.params);
  if (encodeAbiParameters(params, [setHash, count]).toLowerCase() !== addon.params.toLowerCase()
    || (count === 0) !== /^0x0{64}$/i.test(setHash) || (count !== 0 && (count < 10 || count > 10000))) throw new Error('invalid starter commitment');
  return { setHash, count };
}
