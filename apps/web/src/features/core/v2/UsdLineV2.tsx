import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { usdNote, usdText, type UsdPriceV2 } from './usd-v2';

/** SH-266: one dollar line under a coin amount, with its (i) closed by default. Nothing without a fresh price. */
export function UsdLine({ raw, decimals, price, nowSec }: { raw: bigint | null; decimals: number; price: UsdPriceV2 | null; nowSec: bigint }) {
  const tip = useInfoTip();
  if (raw === null || !price) return null;
  return <div className="sh-v2-usd">{usdText(raw, decimals, price)}<InfoButton tip={tip} label="About the dollar value" />
    <InfoPanel tip={tip}><p>{usdNote(price, nowSec)}</p></InfoPanel></div>;
}
