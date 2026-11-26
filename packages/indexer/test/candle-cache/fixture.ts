import { CoreChainIndexer, type CoreBlockResult } from '../../src/core/chain-indexer';
import { coreGatewaySource } from '../../src/core/core-service';
import { CoreGateway } from '../../src/core/core-gateway';
import type { HistoryStore } from '../../src/history/types';
import { loadCoreLife } from '../core/scripted-core-chain';
import { request, ResponseDouble } from '../links/fixture';

export const steps = ['12s', '1m', '10m', '1h', '10h', '1d'] as const;
export const seconds = [12n, 60n, 600n, 3600n, 36000n, 86400n];

export async function recorded() {
  const life = loadCoreLife();
  const blocks: CoreBlockResult[] = [];
  const indexer = new CoreChainIndexer({ reader: life.chain, manifest: life.manifest, onHistory: message => {
    if (message.type === 'block') blocks.push(message.result);
  } });
  await indexer.start(); await indexer.idle(); indexer.stop();
  const token = required([...indexer.boxes.keys()][0]);
  const trades = blocks.flatMap(b => b.boxes.filter(b => b.token === token).flatMap(b => b.trades));
  return { indexer, life, blocks, token, trades };
}
export type Recorded = Awaited<ReturnType<typeof recorded>>;

/** Extend the recorded trade's exact amounts with sparse, epoch-crossing timestamps and all protocol routes. */
export function expanded(f: Recorded, count = 1005): CoreBlockResult {
  const base = required(f.blocks.find(b => b.boxes.some(b => b.trades.length > 0)));
  const box = required(base.boxes.find(b => b.token === f.token));
  const routes = ['other', 'hook', 'executor', 'converter', 'swap_module', 'buy_back'] as const;
  const trades = Array.from({ length: count }, (_, i) => ({ ...required(f.trades[0]), id: `${i + 10000}-0`,
    block: BigInt(i + 10000), logIndex: 0, timestamp: 86388n + BigInt(i) * 61n,
    sqrtPriceX96After: 2n ** 100n + BigInt(i % 7), qRaw: 10n ** 30n + BigInt(i), route: required(routes[i % routes.length]) }));
  return { ...base, block: { ...base.block, number: required(trades.at(-1)).block, timestamp: required(trades.at(-1)).timestamp }, rows: [],
    boxes: [{ ...box, trades, activity: [], transfers: [] }] };
}

export function gateway(f: Recorded, store: HistoryStore | null) {
  const { source } = coreGatewaySource(f.indexer, f.life.chain, store, 60_000);
  // Routing aliases exercise the same source without needing another recorded contract deployment.
  source.v2Box = token => source.box(token) as never;
  source.setBox = token => source.box(token) as never;
  source.health = () => ({ following: true, reason: null, history: null });
  const gw = new CoreGateway({ source, port: 0, host: '127.0.0.1' });
  const send = async (suffix = 'candles', query = '', tag?: string, route = 'v1/boxes') => {
    const { req } = request(undefined, { method: 'GET', url: `/${route}/${f.indexer.chainId}/${f.token}/${suffix}${query}` });
    if (tag) req.headers['if-none-match'] = tag;
    const res = new ResponseDouble(); await gw.route(req, res.asResponse()); return res;
  };
  return { source, send };
}

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing candle fixture value");
  return value;
}
