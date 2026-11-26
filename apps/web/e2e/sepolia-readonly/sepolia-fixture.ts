import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import { rawCidV1 } from '@squarehole/artwork';
import { toHex } from 'viem';

/**
 * SH-TA-12: the Sepolia test site as it ships (`SH_BUILD=production SH_TARGET=sepolia`, the committed manifest, the
 * indexer at https://api.squarehole.fun), answered inside the browser. The indexer's paths come from its own recorded
 * answers for this manifest (e2e/fixtures/sepolia-readonly/indexer-answers.json, written by
 * packages/indexer/test/core/sepolia-readonly), the pictures from our node's `/ipfs/<cid>` route (SH-TA-26) as the
 * test says, and the keyless Sepolia RPCs with the head block and a revert for any view (box 0's own panel reads the
 * chain; an unanswered read shows as unavailable). Every other request leaving the machine is aborted and recorded,
 * so a test can say none was made: no live API, no live RPC.
 */
export const API = 'https://api.squarehole.fun';
const RPC_ORIGINS = new Set(['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co']);

interface Fixture {
  readonly headTimestamp: string;
  readonly answers: Readonly<Record<string, unknown>>;
}
export const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/sepolia-readonly/indexer-answers.json', import.meta.url)), 'utf8')) as Fixture;
/** Box 0's token, as the indexer's feed names it. */
export const BOX0_TOKEN = ((FIXTURE.answers['/v1/feed'] as { cards: { token: string }[] }).cards[0]?.token ?? '').toLowerCase();
export const BOX0_PATH = `/box/11155111/${BOX0_TOKEN}`;
/** The browser clock: 20 s after the recorded head, so the answers are current (a Sepolia answer over a minute old is Stale). */
export const NOW_MS = (Number(FIXTURE.headTimestamp) + 20) * 1000;
const head = (FIXTURE.answers['/v1/feed'] as { asOf: { block: string; hash: string; timestamp: string } }).asOf;

/**
 * Box 0's collection cover (BoxSpec field 28) and logo (field 23, the FIT icon, an SVG our node never serves), both
 * in the repository. Since SH-BOX0-ART-TEST-SITE the app draws both from its own bundle, so neither is asked of the node.
 */
export const BOX0_COVER_SHA256 = '0x41cf86fd8bf4bf185534477e35ca01b8183316adc947a92f9c3d8933a90f11fb';
export const BOX0_LOGO_SHA256 = '0x2aa8e531b2837be0a979b85b772ae4a5f286bbbd19b3d1be36804c146da69c93';
export const BOX0_COVER = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../../packages/chain/scripts/local-art/misfits-cover.png', import.meta.url))));
export const BOX0_COVER_CID = rawCidV1(BOX0_COVER_SHA256);
export const BOX0_LOGO_CID = rawCidV1(BOX0_LOGO_SHA256);

export interface SepoliaSite {
  /** Indexer paths asked (with their query), in order. */
  readonly asked: string[];
  /** `/ipfs/<cid>` paths asked of our node. */
  readonly pictures: string[];
  /** RPC methods called. */
  readonly rpc: string[];
  /** Requests to any other host (aborted). */
  readonly escaped: string[];
}

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

/**
 * Answers the site's requests. `pictures` maps a raw CID to the bytes our node serves for it (default: box 0's cover
 * under its own CID); any other CID is the node's 404. `answers` replaces recorded answers by path (a variant).
 */
export async function sepoliaSite(page: Page, options: { pictures?: ReadonlyMap<string, Uint8Array>; answers?: Readonly<Record<string, unknown>> } = {}): Promise<SepoliaSite> {
  const answers = { ...FIXTURE.answers, ...options.answers };
  const pictures = options.pictures ?? new Map([[BOX0_COVER_CID, BOX0_COVER]]);
  const site: SepoliaSite = { asked: [], pictures: [], rpc: [], escaped: [] };
  const block = { number: toHex(BigInt(head.block)), hash: head.hash, parentHash: toHex(0n, { size: 32 }), timestamp: toHex(BigInt(head.timestamp)), transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', miner: '0x0000000000000000000000000000000000000000', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', logsBloom: `0x${'00'.repeat(256)}`, nonce: '0x0000000000000000', receiptsRoot: toHex(0n, { size: 32 }), stateRoot: toHex(0n, { size: 32 }), transactionsRoot: toHex(0n, { size: 32 }), sha3Uncles: toHex(0n, { size: 32 }), uncles: [] };
  await page.clock.setFixedTime(NOW_MS);
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.origin === API) {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      if (url.pathname.startsWith('/ipfs/')) {
        site.pictures.push(url.pathname);
        const bytes = pictures.get(url.pathname.slice('/ipfs/'.length));
        return bytes ? route.fulfill({ status: 200, headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000, immutable' }, body: Buffer.from(bytes) }) : route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'not found' });
      }
      site.asked.push(`${url.pathname}${url.search}`);
      const answer = answers[`${url.pathname}${url.search}`] ?? answers[url.pathname];
      return route.fulfill(answer === undefined ? json({ error: 'not found' }, 404) : json(answer));
    }
    if (RPC_ORIGINS.has(url.origin) && request.method() === 'POST') {
      const body = request.postDataJSON() as unknown;
      const calls = (Array.isArray(body) ? body : [body]) as { id: number; method: string; params?: unknown[] }[];
      const answers = calls.map((call) => {
        site.rpc.push(call.method);
        const reply = (result: unknown) => ({ jsonrpc: '2.0', id: call.id, result });
        if (call.method === 'eth_chainId') return reply(toHex(11_155_111));
        if (call.method === 'eth_blockNumber') return reply(block.number);
        if (call.method === 'eth_getBlockByNumber' || call.method === 'eth_getBlockByHash') return reply(block);
        if (call.method === 'eth_call') return { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } };
        return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `the fixture RPC does not answer ${call.method}` } };
      });
      return route.fulfill(json(Array.isArray(body) ? answers : answers[0]));
    }
    if (RPC_ORIGINS.has(url.origin) && request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    site.escaped.push(`${request.method()} ${request.url()}`);
    return route.abort();
  });
  return site;
}

export type ShotTicket = 'SH-TA-12' | 'SH-TA-26' | 'SH-BOX0-ART-TEST-SITE';
const SHOT_ENV: Record<ShotTicket, string> = { 'SH-TA-12': 'SH_TA12_SCREENSHOTS', 'SH-TA-26': 'SH_TA26_SCREENSHOTS', 'SH-BOX0-ART-TEST-SITE': 'SH_BOX0_ART_SCREENSHOTS' };

/** SH_TA12_SCREENSHOTS=1 (and so on) writes docs/evidence/<ticket>/<name>-<project>.png; otherwise the test output folder. */
export function shotPath(testInfo: TestInfo, ticket: ShotTicket, name: string): string {
  const wanted = process.env[SHOT_ENV[ticket]] === '1';
  return wanted ? fileURLToPath(new URL(`../../../../docs/evidence/${ticket}/${name}-${testInfo.project.name}.png`, import.meta.url)) : testInfo.outputPath(`${name}.png`);
}

