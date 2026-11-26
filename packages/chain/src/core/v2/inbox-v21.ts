import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, zeroHash, type Address, type Hex } from 'viem';
import { royaltyRouterV2Abi } from './abi-v2';

/** GPv2Settlement receipts identify both the inbox owner and the sold coin. */
export const cowSettlementV21Abi = parseAbi([
  'event Trade(address indexed owner,address sellToken,address buyToken,uint256 sellAmount,uint256 buyAmount,uint256 feeAmount,bytes orderUid)',
]);
export interface InboxWiringV21 { readonly router: Address; readonly handler: Address; readonly settlement: Address }
export async function readInboxWiringV21(reader: { callAt(to: Address, data: Hex, hash: Hex): Promise<Hex> }, router: Address, hash: Hex): Promise<InboxWiringV21> {
  const [handler, settlement] = await Promise.all((['cowHandler', 'settlement'] as const).map(async functionName =>
    decodeFunctionResult({ abi: royaltyRouterV2Abi, functionName, data: await reader.callAt(router,
      encodeFunctionData({ abi: royaltyRouterV2Abi, functionName }), hash) }) as Address));
  if (!handler || !settlement || BigInt(handler) === 0n || BigInt(settlement) === 0n) throw new Error('missing inbox CoW wiring');
  return { router, handler, settlement };
}
/** keccak256(abi.encode(orderParams(coin))), exactly the inbox's OrderRefreshed ID. */
export function inboxOrderIdV21(handler: Address, coin: Address): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('(address handler,bytes32 salt,bytes staticInput)'), [
    { handler, salt: zeroHash, staticInput: encodeAbiParameters(parseAbiParameters('address'), [coin]) },
  ]));
}
export const INBOX_CLAIM_NOTICE_V21 = "the claim moves the inbox's P into the pot first";
