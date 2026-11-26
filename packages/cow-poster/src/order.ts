import { concat, encodeAbiParameters, keccak256, parseAbiParameters, toHex, type Address, type Hex } from 'viem';
import type { Order } from './types';

/** Exact preimage pinned by BoxRoyaltyRouterV2.APP_DATA. CoW accepts full JSON plus its hash. */
export const APP_DATA = '{"version":"1.3.0","appCode":"Square Hole Royalties","metadata":{}}';
const TYPE_HASH = keccak256(toHex('Order(address sellToken,address buyToken,address receiver,uint256 sellAmount,uint256 buyAmount,uint32 validTo,bytes32 appData,uint256 feeAmount,string kind,bool partiallyFillable,string sellTokenBalance,string buyTokenBalance)'));
const encodedFields = parseAbiParameters('bytes32, address, address, address, uint256, uint256, uint32, bytes32, uint256, bytes32, bool, bytes32, bytes32');

/** GPv2 UID = EIP-712 digest || owner (20 bytes) || validTo (4 bytes, big endian). */
export function orderUid(order: Order, owner: Address, domainSeparator: Hex): Hex {
  const hash = keccak256(encodeAbiParameters(encodedFields, [TYPE_HASH, order.sellToken, order.buyToken,
    order.receiver, order.sellAmount, order.buyAmount, order.validTo, order.appData, order.feeAmount,
    order.kind, order.partiallyFillable, order.sellTokenBalance, order.buyTokenBalance]));
  const digest = keccak256(concat(['0x1901', domainSeparator, hash]));
  return concat([digest, owner, toHex(order.validTo, { size: 4 })]).toLowerCase() as Hex;
}

/** Do not reinterpret an unknown signed enum, appData preimage, or a future incompatible inbox order. */
export function orderFields(order: Order) {
  if (order.kind !== keccak256(toHex('sell')) || order.sellTokenBalance !== keccak256(toHex('erc20'))
    || order.buyTokenBalance !== keccak256(toHex('erc20')) || order.appData !== keccak256(toHex(APP_DATA))
    || order.sellAmount <= 0n || order.buyAmount <= 0n || order.feeAmount !== 0n || order.partiallyFillable) {
    throw new Error('unsupported inbox order');
  }
  return { sellToken: order.sellToken, buyToken: order.buyToken, receiver: order.receiver,
    sellAmount: order.sellAmount.toString(), buyAmount: order.buyAmount.toString(), validTo: order.validTo,
    appData: APP_DATA, appDataHash: order.appData, feeAmount: order.feeAmount.toString(),
    kind: 'sell' as const, partiallyFillable: order.partiallyFillable,
    sellTokenBalance: 'erc20' as const, buyTokenBalance: 'erc20' as const };
}
