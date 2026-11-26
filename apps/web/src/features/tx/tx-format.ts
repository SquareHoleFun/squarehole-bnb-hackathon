/**
 * Display helpers for chain transactions. Network fees are shown in the chain's native test currency, never in USD
 * (there is no disclosed USD source for test ETH). Explorer links are built only from an exact transaction hash on the
 * chain's explorer origin and must pass the reviewed-provider allowlist (EXT-02, EXT-07); the local chain has none.
 */
import type { FeeEstimate } from '@squarehole/chain/write';
import { formatTokenAmount } from '@squarehole/domain';
import { vetExternalHref } from '@squarehole/links';

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** "≈ 0.000321 SepoliaETH (at most 0.000642 SepoliaETH)", or an honest "unavailable" (never zero). */
export function networkFeeText(fee: FeeEstimate | null, nativeSymbol: string): string {
  if (fee === null) return 'Unavailable: the fee could not be read from the chain. The wallet shows its own estimate.';
  const expected = formatTokenAmount(fee.expectedFeeWei, 18, { maxFractionDigits: 6 });
  const most = formatTokenAmount(fee.maxFeeWei, 18, { maxFractionDigits: 6 });
  return `≈ ${expected} ${nativeSymbol} (at most ${most} ${nativeSymbol}); an estimate, the wallet sets the final fee`;
}

/** An explorer link for an exact transaction hash, or null (no explorer, malformed hash, or not allowlisted). */
export function txExplorerHref(explorerOrigin: string | null, hash: string): string | null {
  if (explorerOrigin === null || !HASH.test(hash)) return null;
  const vetted = vetExternalHref(`${explorerOrigin}/tx/${hash}`, 'explorer');
  return vetted.ok ? vetted.href : null;
}
