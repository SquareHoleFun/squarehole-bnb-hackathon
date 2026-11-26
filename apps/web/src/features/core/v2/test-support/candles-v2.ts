/**
 * SH-BOX-CANDLES test support: the candle route as the server answers it once every step is served ready-made
 * (`GET /v2/boxes/<chain>/<token>/candles?interval=<12s|1m|10m|1h|10h|1d>&limit=<1-1000>`: the newest `limit` candles,
 * oldest first, the indexer's encoding, `interval` echoed), computed from a fixture's activity items with the indexer's
 * rule (packages/indexer/src/core/candles.ts: trades by block, then log index; √price after each; the hook's, the
 * executor's, the converter's, the swap module's and the buy-backs' swaps move the price but add no volume or trade
 * count; Unix-epoch-aligned buckets). candles-v2.test.ts checks it against the indexer's own function on the steps the
 * live server has.
 */
type Wire = Record<string, unknown>;

export const CANDLE_SECONDS_V2: Readonly<Record<string, bigint>> = Object.freeze({ '12s': 12n, '1m': 60n, '10m': 600n, '1h': 3_600n, '10h': 36_000n, '1d': 86_400n });
const UNCOUNTED = new Set(['hook', 'executor', 'converter', 'swap_module', 'buy_back']);

/** Every candle of `interval` from the trades among `items` (activity route items, any order), oldest first. */
export function candlesOfItemsV2(items: readonly Wire[], interval: string): Wire[] {
  const size = CANDLE_SECONDS_V2[interval];
  if (size === undefined) throw new Error(`no step ${interval}`);
  const trades = items.filter((item) => item.kind === 'trade')
    .map((item) => ({ block: BigInt(item.block as string), logIndex: item.logIndex as number, at: BigInt(item.timestamp as string), sqrt: BigInt(item.sqrtPriceX96After as string), q: BigInt(item.qRaw as string), route: item.route as string }))
    .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const out = new Map<bigint, { open: bigint; high: bigint; low: bigint; close: bigint; volume: bigint; count: number }>();
  for (const t of trades) {
    const start = (t.at / size) * size;
    const counted = !UNCOUNTED.has(t.route);
    const c = out.get(start);
    if (!c) out.set(start, { open: t.sqrt, high: t.sqrt, low: t.sqrt, close: t.sqrt, volume: counted ? t.q : 0n, count: counted ? 1 : 0 });
    else out.set(start, { open: c.open, high: t.sqrt > c.high ? t.sqrt : c.high, low: t.sqrt < c.low ? t.sqrt : c.low, close: t.sqrt, volume: c.volume + (counted ? t.q : 0n), count: c.count + (counted ? 1 : 0) });
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([start, c]) => ({
    start: start.toString(),
    openSqrtPriceX96: c.open.toString(),
    highSqrtPriceX96: c.high.toString(),
    lowSqrtPriceX96: c.low.toString(),
    closeSqrtPriceX96: c.close.toString(),
    volumeQ: c.volume.toString(),
    trades: c.count,
  }));
}

/**
 * The route's answer to `url` over `items`: 400 for a step it does not serve or a limit outside 1-1000, as the server
 * branch does; `steps`: the steps it serves (the live server today: 1m, 1h and 1d, and it pages nothing).
 */
export function candleAnswerV2(items: readonly Wire[], url: URL, asOf: unknown, steps: readonly string[] = Object.keys(CANDLE_SECONDS_V2)): { readonly status: number; readonly body: unknown } {
  const interval = url.searchParams.get('interval') ?? '1h';
  const limit = Number(url.searchParams.get('limit') ?? '1000');
  if (!steps.includes(interval)) return { status: 400, body: { error: `interval is ${steps.join(', ')}` } };
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return { status: 400, body: { error: 'limit is 1-1000' } };
  return { status: 200, body: { asOf, candles: candlesOfItemsV2(items, interval).slice(-limit), interval } };
}
