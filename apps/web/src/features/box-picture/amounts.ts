/**
 * SH-251: amounts as the picture prints them. Raw amounts stay bigint; only the printed text has decimals. Rounding is
 * half up at the last printed place; whole numbers are grouped by thousands.
 */
const group = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `raw` in a coin of `decimals`, rounded half up to at most `places` places, trailing zeros dropped. */
export function roundedText(raw: bigint, decimals: number, places: number): string {
  if (raw < 0n) return `-${roundedText(-raw, decimals, places)}`;
  const shown = Math.max(0, Math.min(places, decimals));
  const cut = 10n ** BigInt(decimals - shown);
  const scaled = (raw + cut / 2n) / cut;
  const base = 10n ** BigInt(shown);
  const whole = group((scaled / base).toString());
  const fraction = shown === 0 ? '' : (scaled % base).toString().padStart(shown, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A small amount with three significant digits at least (0.00667), a large one with up to two places (50.33). */
export function shortText(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  const most = Math.min(decimals, 12);
  for (let places = 2; places <= most; places += 1) {
    const text = roundedText(raw, decimals, places);
    if (text.replace(/[^0-9]/g, '').replace(/^0+/, '').length >= 3) return text;
  }
  return roundedText(raw, decimals, most);
}

/** A raise on the picture: three places, none from 1,000 whole coins up. */
export function raiseText(raw: bigint, decimals: number): string {
  return roundedText(raw, decimals, raw >= 1000n * 10n ** BigInt(decimals) ? 0 : 3);
}

/** `part` of `whole` as a percent with up to three places ("0.667%"), rounded half up; "0%" for an empty whole. */
export function percentText(part: bigint, whole: bigint): string {
  if (whole <= 0n) return '0%';
  const thousandths = (part * 100_000n + whole / 2n) / whole;
  const text = `${thousandths / 1000n}.${(thousandths % 1000n).toString().padStart(3, '0')}`.replace(/\.?0+$/, '');
  return `${text}%`;
}
