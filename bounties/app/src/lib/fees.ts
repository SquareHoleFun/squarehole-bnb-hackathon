import type { PublicClient } from 'viem';
import { PageRefusal } from './errors';

/**
 * SH-280: the fee of every send this page hands a wallet, set by the page and not left to the wallet's own guess (a
 * wallet Privy made signs without a window, so its guess would go unseen). The platform's rule for chain 97, mirrored
 * (packages/chain/src/write/executor.ts `sendFeesOf` with `TIP_CAPS[97]`, `checkedPrice`): the chain's own price is read
 * right before the wallet is asked and is required (no answer or zero: refused); above the ceiling of 5 gwei: refused;
 * the tip is the larger of the endpoint's suggestion and that price, plus a tenth, at most the ceiling; the fee cap is
 * twice the latest base fee (0 on chain 97) plus the tip. Both EIP-1559 fields, never a legacy price.
 * The refusals are the platform's own sentences (executor.ts `NetworkPriceError`).
 */
export const CEILING_WEI = 5_000_000_000n;

export interface SendFees {
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
}

const gweiText = (wei: bigint): string => {
  const whole = wei / 1_000_000_000n;
  const part = (wei % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return part ? `${whole}.${part}` : String(whole);
};

/** The two fee fields from the chain's numbers, or the page's refusal. */
export function sendFees97(baseFeePerGas: bigint, suggestedTip: bigint, gasPrice: bigint | null): SendFees {
  if (gasPrice === null || gasPrice <= 0n) throw new PageRefusal('no-price', 'The network gave no usable gas price; nothing was sent. Try again.');
  if (gasPrice > CEILING_WEI) {
    throw new PageRefusal('price-above-ceiling', `The network asks ${gweiText(gasPrice)} gwei for gas, above the ${gweiText(CEILING_WEI)} gwei this site offers; nothing was sent.`);
  }
  const asked = suggestedTip > gasPrice ? suggestedTip : gasPrice;
  const padded = asked + asked / 10n;
  const tip = padded > CEILING_WEI ? CEILING_WEI : padded;
  return Object.freeze({ maxPriorityFeePerGas: tip, maxFeePerGas: baseFeePerGas * 2n + tip });
}

/** Reads the three numbers through the page's own read endpoints (never the wallet's), now. */
export async function readSendFees(client: Pick<PublicClient, 'getBlock' | 'getGasPrice' | 'estimateMaxPriorityFeePerGas'>): Promise<SendFees> {
  const [block, tip, price] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    client.estimateMaxPriorityFeePerGas().catch(() => 0n),
    client.getGasPrice().catch(() => null),
  ]);
  return sendFees97(block.baseFeePerGas ?? 0n, tip, price);
}

const hex = (value: bigint) => `0x${value.toString(16)}`;

/** A transaction object with the page's two fee fields in place of whatever fee it carried. */
export function withFees(tx: Record<string, unknown>, fees: SendFees): Record<string, unknown> {
  const rest = { ...tx };
  delete rest.gasPrice;
  delete rest.type;
  return { ...rest, maxFeePerGas: hex(fees.maxFeePerGas), maxPriorityFeePerGas: hex(fees.maxPriorityFeePerGas) };
}
