import { need } from './common.mjs';

const MAX_LOT = ((1n << 256n) - 1n) / 20n;
export function rawAmount(value) {
  need(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'royalty lot price requires decimal strings');
  const n = BigInt(value);
  need(n < 1n << 256n, 'royalty lot integer exceeds uint256');
  return n;
}
export function validatePrice(price) {
  need(price && typeof price.source === 'string' && price.source.trim().length > 0
    && price.source.length <= 4096, 'royalty lot price source required');
  need(typeof price.blockHash === 'string' && /^0x[0-9a-f]{64}$/i.test(price.blockHash)
    && !/^0x0{64}$/i.test(price.blockHash), 'royalty lot price block hash required');
  rawAmount(price.blockNumber);
  need(rawAmount(price.timestamp) > 0n, 'royalty lot price timestamp required');
  const tokenAmount = rawAmount(price.tokenAmount), wethAmount = rawAmount(price.wethAmount);
  need(tokenAmount > 0n && wethAmount > 0n, 'royalty lot price must be positive');
  return { tokenAmount, wethAmount };
}
function targetFor(coinClass) {
  need(['STABLE', 'STOCK', 'OTHER'].includes(coinClass), 'royalty lot class required');
  return coinClass === 'STOCK' ? 250000000000000000n : 50000000000000000n;
}
function wholeCoin(decimals) {
  need(typeof decimals === 'bigint' && decimals >= 6n && decimals <= 18n, 'royalty lot decimals invalid');
  return 10n ** decimals;
}
export function checkRoyaltyLot(lot, decimals, coinClass, price) {
  need(typeof lot === 'bigint' && lot > 0n && lot <= MAX_LOT, 'royalty lot outside contract bounds');
  need(lot !== wholeCoin(decimals), 'default whole-coin lot refused');
  const { tokenAmount, wethAmount } = validatePrice(price);
  const target = targetFor(coinClass) * tokenAmount;
  const value = lot * wethAmount;
  need(2n * value >= target && value <= 2n * target, 'royalty lot outside 0.5x to 2x of CW2 value');
}

/** Round half up to two significant decimal digits, with a one-raw-unit floor. */
export function proposeRoyaltyLot(decimals, coinClass, price) {
  const { tokenAmount, wethAmount } = validatePrice(price);
  const numerator = targetFor(coinClass) * tokenAmount;
  const integer = numerator / wethAmount;
  let increment = 1n;
  while (integer / increment >= 100n) increment *= 10n;
  let lot = (2n * numerator + wethAmount * increment) / (2n * wethAmount * increment) * increment;
  if (lot === 0n) lot = 1n;
  // Even a fairly priced whole coin is indistinguishable from _append's unsafe default.
  if (lot === wholeCoin(decimals)) lot = lot * 11n / 10n;
  checkRoyaltyLot(lot, decimals, coinClass, price);
  return lot;
}
