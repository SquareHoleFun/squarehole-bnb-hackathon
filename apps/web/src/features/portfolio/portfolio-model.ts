/**
 * Portfolio presentation model (SH-014; 01-PRODUCT "Portfolio and collectible UX"; C06, ECO-06, FEED-07). The economic
 * balance is shown ONCE; for an NFT collection its whole-collectible representation (whole NFTs + remaining fraction)
 * is shown beneath it as the same units, never added again. Pure and exact: bigint and decimal strings only.
 */
import { computeMarketCapUsd, formatUsdCompact, type PairRecord, type Position } from '@squarehole/domain';
import { formatInteger, formatNumber } from '../accounts/amounts';
import { displaySymbol } from '../feed/format';

export interface NftRepresentation {
  /** "3 whole NFTs" */
  readonly wholeText: string;
  /** "0.25 ORCH" (the fraction that is not an NFT) */
  readonly fractionText: string | null;
  /** "1 NFT = 1 ORCH" */
  readonly unitText: string;
  /** "#7", "#12", ... (ids actually held; can be fewer than whole units, e.g. skip-NFT accounts) */
  readonly ids: readonly string[];
  /** Whole units without a listed id. */
  readonly unlistedWhole: bigint;
}

export interface PositionView {
  readonly nft: NftRepresentation | null;
  /** Demo value at the snapshot price, or null without a price. Never summed across pairs. */
  readonly demoValue: { readonly value: string; readonly price: string } | null;
}

const plural = (count: bigint, one: string, many: string): string => `${formatInteger(count.toString())} ${count === 1n ? one : many}`;

export function toPositionView(position: Position, pair: PairRecord): PositionView {
  const symbol = displaySymbol(pair.token.symbol);
  let nft: NftRepresentation | null = null;
  if (pair.type === 'nft_collection' && position.wholeNftCount !== null && pair.nftUnitRaw !== undefined) {
    const whole = BigInt(position.wholeNftCount);
    const fraction = position.fractionalRaw === null ? 0n : BigInt(position.fractionalRaw);
    nft = {
      wholeText: plural(whole, 'whole NFT', 'whole NFTs'),
      fractionText: fraction === 0n ? null : `${formatNumber(fraction, pair.token.decimals)} ${symbol}`,
      unitText: `1 NFT = ${formatNumber(pair.nftUnitRaw, pair.token.decimals)} ${symbol}`,
      ids: position.nftTokenIds.map((id) => `#${id}`),
      unlistedWhole: whole > BigInt(position.nftTokenIds.length) ? whole - BigInt(position.nftTokenIds.length) : 0n,
    };
  }
  const demoValue =
    pair.priceUsd === null
      ? null
      : {
          value: formatUsdCompact(computeMarketCapUsd(pair.priceUsd, position.balanceRaw, pair.token.decimals)),
          price: formatUsdCompact(pair.priceUsd),
        };
  return { nft, demoValue };
}
