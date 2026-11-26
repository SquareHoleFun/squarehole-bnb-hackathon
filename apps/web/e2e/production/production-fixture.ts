import { fileURLToPath } from 'node:url';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, multicall3Abi, toHex, type Hex } from 'viem';
import { boxSpecV2Parameter, encodeBoxSpecV2, type BoxSpecV2 } from '../../../../packages/chain/src/core/v2';
import { SEPOLIA_MULTICALL3 } from '../../../../packages/chain/src/config/networks';
import { mixedDeployment } from '../../src/features/core/v2/test-support/mixed-deployment';
import { publishedV2 } from '../../src/features/core/v2/test-support/published-v2';
import { PRODUCTION_INDEXER } from './production-origin';

/** Our node's picture route on the Sepolia test site (apps/web/deployments-plugin.ts SEPOLIA_ART_GATEWAY). */
const SEPOLIA_ART_GATEWAY = 'https://api.squarehole.fun';
/** SH-ARWEAVE-PICTURES-WEB: the Arweave gateways the Sepolia test site searches and reads for a v2 box's logo and cover. */
const ARWEAVE_GATEWAYS = ['https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net'];

/**
 * The production smoke test's chain (SH-V2-FE6): the indexer and the keyless Sepolia RPC the production build reads,
 * answered inside the browser from the main suite's recorded fixtures (the core v1 life on a twin with Sepolia's
 * chain id, and the indexer's own answers for a v2 box and its listing book). Every other request that would leave
 * the machine is aborted and recorded, so a test can say none was made.
 */
const SEPOLIA = 11_155_111;
const NATIVE = '0x0000000000000000000000000000000000000000';
/** The listed test coin's symbol, as the stubbed RPC answers `symbol()` for it. */
export const LIVE_COIN = 'USDC';

export interface ProductionChain {
  /** Indexer paths asked, in order. */
  readonly asked: string[];
  /** RPC methods called (eth_call by function name). */
  readonly rpc: string[];
  /** Requests to any other host (aborted). */
  readonly escaped: string[];
  /** `/ipfs/<cid>` paths asked of our node (the Sepolia test site only, SH-TA-26), each answered 404. */
  readonly pictures: string[];
  /**
   * SH-ARWEAVE-PICTURES-WEB: requests to the three Arweave gateways (searches by tag, answered with no candidate; raw
   * bytes, answered 404). Turbo's upload origin is never answered: a page that asked it would show in `escaped`.
   */
  readonly arweave: string[];
  /** The tokens of the boxes the indexer answers (v1's box 0 and the v2 box). */
  readonly tokens: { readonly v1: string; readonly v2: string };
  /** The v2 box's snapshot time (its `asOf.timestamp`, Unix seconds). */
  readonly v2Timestamp: string;
}

/**
 * The listing book, in the indexer's own answer shape: native ETH (listing 0, as on Sepolia by construction) and the
 * indexer's test coin as a stable coin with a raise (the recorded one has none, so no page would offer it).
 */
async function listingBook(): Promise<unknown> {
  const { listings: book } = await publishedV2();
  const recorded = book.listings[0];
  if (!recorded?.detail) throw new Error('The recorded listing book is empty');
  const ethRaise = '4206980085000000000';
  const coinRaise = '15986524323';
  const eth = { ...recorded, id: 0, token: NATIVE, class: 'NATIVE', kind: 'LISTED', raise: ethRaise, detail: { ...recorded.detail, id: 0, token: NATIVE, decimals: 18, class: 'NATIVE', kind: 'LISTED', raise: ethRaise } };
  const coin = { ...recorded, class: 'STABLE', raise: coinRaise, detail: { ...recorded.detail, class: 'STABLE', raise: coinRaise } };
  return { ...book, chainId: SEPOLIA, listings: [eth, coin] };
}

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

const Q192_X36 = (1n << 192n) * 10n ** 36n;
/** ⌊√n⌋. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) [x, y] = [y, (y + n / y) / 2n];
  return x;
}
const STEP_SECONDS: Readonly<Record<string, bigint>> = { '12s': 12n, '1m': 60n, '10m': 600n, '1h': 3_600n, '10h': 36_000n, '1d': 86_400n };

/**
 * SH-BOX-CANDLES: the v2 box's candle route (`?interval=<step>&limit=<n>`, the server's ready-made answer) made from the
 * hours its `statistics` publish: each hour a candle, its prices back in √price (P is currency0: √price = √(2^192 ·
 * 10^36 / price)); the 10 h and daily steps join the hours; the finer steps show each hour at its own start. Enough for
 * the production build to draw what its feed figures say.
 */
function candlesFromHours(statistics: unknown, url: URL, asOf: unknown): unknown {
  const interval = url.searchParams.get('interval') ?? '1h';
  const size = STEP_SECONDS[interval] ?? 3_600n;
  const limit = Number(url.searchParams.get('limit') ?? '1000');
  const hours = ((statistics as { hourlyCandles?: Record<string, string>[] } | null)?.hourlyCandles ?? []);
  const sqrt = (price: string) => isqrt(Q192_X36 / BigInt(price)).toString();
  const buckets = new Map<bigint, Record<string, string>[]>();
  for (const hour of hours) {
    const start = size > 3_600n ? (BigInt(hour.start as string) / size) * size : BigInt(hour.start as string);
    buckets.set(start, [...(buckets.get(start) ?? []), hour]);
  }
  const candles = [...buckets].map(([start, group]) => {
    const first = group[0] as Record<string, string>;
    const last = group.at(-1) as Record<string, string>;
    const highest = group.reduce((a, b) => (BigInt(b.high as string) > BigInt(a.high as string) ? b : a));
    const lowest = group.reduce((a, b) => (BigInt(b.low as string) < BigInt(a.low as string) ? b : a));
    return {
      start: start.toString(),
      openSqrtPriceX96: sqrt(first.open as string),
      // The highest price is the lowest √price.
      highSqrtPriceX96: sqrt(lowest.low as string),
      lowSqrtPriceX96: sqrt(highest.high as string),
      closeSqrtPriceX96: sqrt(last.close as string),
      volumeQ: group.reduce((sum, hour) => sum + BigInt(hour.volumeP as string), 0n).toString(),
      trades: group.reduce((sum, hour) => sum + Number(hour.tradeCount), 0),
    };
  });
  return { asOf, candles: candles.slice(-limit), interval };
}

/**
 * SH-224: a v2 box's page shows its creator's description under its name. The synthetic box's spec
 * (packages/chain/src/core/v2/test-support/synth-v2.ts) says "Demo box", which this production page would then show as
 * its creator's words and `noDemoTrace` would rightly find. The fixture's creator writes a neutral line instead: the
 * spec re-encoded with it and the record's spec hash with it, as the chain would hold them for such a box.
 */
export const FIXTURE_DESCRIPTION = 'A recorded box for the production smoke test';
function withDescription<T extends { readonly row: { readonly encodedSpec: string; readonly record: { readonly specHash: string } } }>(body: T, description: string): T {
  const spec = decodeAbiParameters([boxSpecV2Parameter], body.row.encodedSpec as Hex)[0] as unknown as BoxSpecV2;
  const encodedSpec = encodeBoxSpecV2({ ...spec, description });
  return { ...body, row: { ...body.row, encodedSpec, record: { ...body.row.record, specHash: keccak256(encodedSpec) } } };
}

/**
 * `v2`: fields laid over the v2 box's wire answer (its feed card and its snapshot alike), as the indexer would publish
 * them for another state of the same box (SH-TA-29: a box on its curve or graduated, with its `statistics`).
 */
export async function productionChain(page: Page, options: { readonly v2?: Readonly<Record<string, unknown>> } = {}): Promise<ProductionChain> {
  const mixed = await mixedDeployment();
  const data = { ...mixed, body: withDescription(mixed.body, FIXTURE_DESCRIPTION) };
  const book = await listingBook();
  const asked: string[] = [];
  const rpc: string[] = [];
  const escaped: string[] = [];
  const pictures: string[] = [];
  const arweave: string[] = [];
  const v2 = { ...data.body, stale: false, verified: true, ...options.v2 };
  const block = { number: toHex(BigInt(v2.asOf.block)), hash: v2.asOf.hash, parentHash: toHex(0n, { size: 32 }), timestamp: toHex(BigInt(v2.asOf.timestamp)), transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', miner: NATIVE, difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', logsBloom: `0x${'00'.repeat(256)}`, nonce: '0x0000000000000000', receiptsRoot: toHex(0n, { size: 32 }), stateRoot: toHex(0n, { size: 32 }), transactionsRoot: toHex(0n, { size: 32 }), sha3Uncles: toHex(0n, { size: 32 }), uncles: [] };

  /** One view call's answer (the listed coin's symbol and decimals), recorded by function name; null reverts. */
  const view = (input: Hex): Hex | null => {
    try {
      const { functionName } = decodeFunctionData({ abi: erc20Abi, data: input });
      rpc.push(`eth_call ${functionName}`);
      if (functionName === 'symbol') return encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', result: LIVE_COIN });
      if (functionName === 'decimals') return encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: 6 });
    } catch {
      rpc.push('eth_call');
    }
    return null;
  };

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    // SH-TA-26: the Sepolia test site asks our own node for box pictures (https://api.squarehole.fun/ipfs/<cid>); it
    // holds none of this recorded deployment's, so it answers 404 and the placeholder shows.
    if (url.origin === SEPOLIA_ART_GATEWAY && url.pathname.startsWith('/ipfs/')) {
      pictures.push(url.pathname);
      return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'not found' });
    }
    if (ARWEAVE_GATEWAYS.includes(url.origin)) {
      arweave.push(`${request.method()} ${url.origin}${url.pathname}`);
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === '/graphql') return route.fulfill({ ...json({ data: { transactions: { edges: [] } } }), headers: cors });
      return route.fulfill({ status: 404, headers: cors, body: 'not found' });
    }
    if (url.origin === PRODUCTION_INDEXER) {
      const path = url.pathname;
      asked.push(path);
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      const answer =
        path === '/v1/feed' ? data.v1.feed
        : path === '/v2/feed' ? { ...data.feed, cards: [v2] }
        : path.startsWith('/v2/listings/') ? book
        : path.startsWith('/v1/boxes/') ? (path.endsWith('/activity') ? data.v1.activity : path.endsWith('/candles') ? data.v1.candles : data.v1.box)
        : path.startsWith('/v2/boxes/') ? (path.endsWith('/activity') ? { items: [], next: null, asOf: v2.asOf } : path.endsWith('/candles') ? candlesFromHours(v2.statistics, url, v2.asOf) : v2)
        : null;
      return route.fulfill(answer === null ? { status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' } : json(answer));
    }
    const body = request.method() === 'POST' ? request.postDataJSON() as unknown : null;
    const calls = Array.isArray(body) ? body : body && typeof body === 'object' && 'jsonrpc' in body ? [body] : null;
    if (calls === null) {
      escaped.push(request.url());
      return route.abort();
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const answers = (calls as Array<{ id: number; method: string; params?: unknown[] }>).map((call) => {
      const reply = (result: unknown) => ({ jsonrpc: '2.0', id: call.id, result });
      if (call.method === 'eth_chainId') return reply(toHex(SEPOLIA));
      if (call.method === 'eth_blockNumber') return reply(block.number);
      if (call.method === 'eth_getBlockByNumber' || call.method === 'eth_getBlockByHash') return reply(block);
      // The listed coin is a contract (its issuer powers are read only from code; SH-V2-FE8).
      if (call.method === 'eth_getCode') {
        rpc.push('eth_getCode');
        return reply('0x6080');
      }
      if (call.method === 'eth_call') {
        const { to, data: input } = call.params?.[0] as { to?: string; data: Hex };
        // SH-CREATE-RPC-BATCHING: on the public Sepolia RPC the site folds its view calls into Multicall3's aggregate3
        // (view-client.ts), as Sepolia's canonical Multicall3 answers it: each member answered as a call of its own.
        if (to?.toLowerCase() === SEPOLIA_MULTICALL3.toLowerCase()) {
          rpc.push('eth_call aggregate3');
          const { args } = decodeFunctionData({ abi: multicall3Abi, data: input });
          const result = (args[0] as readonly { readonly callData: Hex }[]).map(({ callData }) => {
            const answer = view(callData);
            return answer === null ? { success: false, returnData: '0x' as Hex } : { success: true, returnData: answer };
          });
          return reply(encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result }));
        }
        const answer = view(input);
        return answer === null ? { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } } : reply(answer);
      }
      rpc.push(call.method);
      return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `the fixture RPC does not answer ${call.method}` } };
    });
    return route.fulfill(json(Array.isArray(body) ? answers : answers[0]));
  });
  return { asked, rpc, escaped, pictures, arweave, tokens: { v1: data.v1Token.toLowerCase(), v2: v2.token.toLowerCase() }, v2Timestamp: String(v2.asOf.timestamp) };
}

/**
 * No Demo trace a visitor can meet: the words in the page and in its accessible names, titles and alt texts, and no
 * element marked as Demo data.
 */
export async function noDemoTrace(page: Page, where: string): Promise<void> {
  const traces = await page.evaluate(() => {
    const word = /(?<![A-Za-z])(?:demo|mock)s?(?![a-z])/i;
    const found: string[] = [];
    if (word.test(document.title)) found.push(`title: ${document.title}`);
    if (word.test(document.body.innerText)) found.push(`text: ${(document.body.innerText.match(new RegExp(`.{0,40}${word.source}.{0,40}`, 'i')) ?? [''])[0]}`);
    for (const element of document.querySelectorAll('*')) {
      for (const name of ['aria-label', 'title', 'alt', 'placeholder', 'data-source']) {
        const value = element.getAttribute(name);
        if (value && word.test(value)) found.push(`${element.tagName.toLowerCase()}[${name}="${value}"]`);
      }
      if (element.hasAttribute('data-demo')) found.push(`${element.tagName.toLowerCase()}[data-demo]`);
    }
    return found;
  });
  expect(traces, where).toEqual([]);
}

/**
 * SH_EVIDENCE_SCREENSHOTS=1 writes docs/evidence/SH-V2-FE6/<name>-<project>.png; SH_FE7_SCREENSHOTS=1 writes the pages
 * SH-V2-FE7 changed to docs/evidence/SH-V2-FE7/; otherwise the test output folder.
 */
const FE7_SHOTS: ReadonlySet<string> = new Set(['terms', 'privacy', 'risks', 'risks-open', 'gate']);
export function evidencePath(testInfo: TestInfo, name: string): string {
  // SH-TA-29: SH_TA29_SCREENSHOTS=1 writes the v2 numbers (`ta29-…`) to docs/evidence/SH-TA-29/.
  if (name.startsWith('ta29-')) {
    return process.env.SH_TA29_SCREENSHOTS === '1' ? fileURLToPath(new URL(`../../../../docs/evidence/SH-TA-29/${name.slice(5)}-${testInfo.project.name}.png`, import.meta.url)) : testInfo.outputPath(`${name}.png`);
  }
  // SH-TA-02: SH_TA02_SCREENSHOTS=1 writes the Sepolia test site's notice pages (`test-network-…`) to docs/evidence/SH-TA-02/.
  if (name.startsWith('test-network-')) {
    return process.env.SH_TA02_SCREENSHOTS === '1' ? fileURLToPath(new URL(`../../../../docs/evidence/SH-TA-02/${name}-${testInfo.project.name}.png`, import.meta.url)) : testInfo.outputPath(`${name}.png`);
  }
  // SH-ALPHA-NOTICE: SH_ALPHA_NOTICE_SCREENSHOTS=1 writes notice v3 and both trading cards (`alpha-notice-…`) to
  // docs/evidence/SH-ALPHA-NOTICE/.
  if (name.startsWith('alpha-notice-')) {
    return process.env.SH_ALPHA_NOTICE_SCREENSHOTS === '1' ? fileURLToPath(new URL(`../../../../docs/evidence/SH-ALPHA-NOTICE/${name.slice(13)}-${testInfo.project.name}.png`, import.meta.url)) : testInfo.outputPath(`${name}.png`);
  }
  const fe7 = FE7_SHOTS.has(name);
  const folder = fe7 ? 'SH-V2-FE7' : 'SH-V2-FE6';
  const wanted = fe7 ? process.env.SH_FE7_SCREENSHOTS === '1' : process.env.SH_EVIDENCE_SCREENSHOTS === '1';
  return wanted ? fileURLToPath(new URL(`../../../../docs/evidence/${folder}/${name}-${testInfo.project.name}.png`, import.meta.url)) : testInfo.outputPath(`${name}.png`);
}
