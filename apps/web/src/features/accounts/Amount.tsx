import type { AssetIdentity, RawAmount } from '@squarehole/domain';
import { displaySymbol } from '../feed/format';
import { AMOUNT_DIGITS, formatNumber } from './amounts';

interface AmountProps {
  readonly raw: RawAmount | bigint;
  readonly asset: Pick<AssetIdentity, 'decimals' | 'symbol'>;
  readonly digits?: number;
}

/** "9.705953 AAPLx-DEMO" (truncated) with tabular figures; the symbol never breaks at its hyphen ("WETH-/DEMO"). */
export function Amount({ raw, asset, digits = AMOUNT_DIGITS }: AmountProps) {
  return (
    <span className="sh-amount">
      <span className="sh-numeric">{formatNumber(raw, asset.decimals, digits)}</span>{' '}
      <span className="sh-nowrap">{displaySymbol(asset.symbol)}</span>
    </span>
  );
}
