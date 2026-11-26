import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page, Route } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector, toHex, type Abi, type AbiFunction, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { rawCidV1 } from '../../../packages/artwork/src/misfits-commitment';
import { rolesOfV2, vaultV2Abi } from '../../../packages/chain/src/core/v2';
import { installUntouchableWallet } from './box-helpers';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { ETH, publishedItems } from '../src/features/core/v2/test-support/m3-published';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import type { RpcCall } from '../src/features/core/v2/test-support/m2-rpc';

/**
 * SH-BOX-PICTURE-FIT: v2 boxes on synthetic reads for the picture specs (box-picture-fit.spec.ts, box-picture-edges.spec.ts):
 * the M3-52 publication under each box's own token, a JSON-RPC double, and the browser suite's local art gateway and
 * indexer (127.0.0.1:8595 and :8596), answered in the browser; nothing reaches a network. Fix round af2: any boxes and
 * files, and a gateway whose answers a test can hold back (a stalled gateway) and release.
 */
export const CORE = 'http://127.0.0.1:8596';
export const RPC = 'http://127.0.0.1:8599';
export const GATEWAY = 'http://127.0.0.1:8595';
export const ZERO = `0x${'0'.repeat(64)}` as Hex;

export const sha = (bytes: Uint8Array) => `0x${createHash('sha256').update(bytes).digest('hex')}` as Hex;
export const fixtureFile = (path: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url)));

export interface PictureBox {
  readonly name: string;
  readonly symbol: string;
  /** The logo's commitment (field 23). */
  readonly logo: Hex;
  /** The collection cover's commitment (field 28); ZERO: none, the logo stands in. */
  readonly cover: Hex;
}

/** The art gateway double: the bytes it answers by hash (any bytes: a mismatch is a rejected picture), holds, asks. */
export interface PictureGateway {
  /** Every hash asked, in order (a picture's raw CID path, as its hash). */
  readonly asked: Hex[];
  /** Answers `sha` with `bytes` (404 for a hash it has none for). */
  serve(sha: Hex, bytes: Uint8Array): void;
  /** Holds `sha`'s answer back until the returned release is called (a stalled gateway meanwhile). */
  hold(sha: Hex): () => void;
}

/** The token of the `index`th box: the first keeps the publication's own, the others a token of their own. */
const tokenOf = (base: string, index: number) => (index === 0 ? base : `0x${(0xb0a00 + index).toString(16).padStart(40, '0')}`);

/** A card of another box: the same publication under another token address (the feed keys a box by its token). */
function asOtherToken<T>(body: T, from: string, to: string): T {
  if (from.toLowerCase() === to.toLowerCase()) return body;
  return JSON.parse(JSON.stringify(body).replace(new RegExp(from.slice(2), 'gi'), to.slice(2))) as T;
}

const ABI = [...vaultV2Abi, ...boxCollectionAbi] as Abi;
const OWN = ABI.filter((item): item is AbiFunction => item.type === 'function');

/** The boxes on the local chain source, their pictures on the gateway double. */
export async function pictureFixture(page: Page, boxes: readonly PictureBox[], files: readonly Uint8Array[]) {
  const data = await mixedDeployment();
  const known = { '1': { inside: true, sequence: 1n }, '2': { inside: true, sequence: 2n } };
  const box = async (spec: Record<string, unknown>) => {
    const published = await publishedItems({ n: 2, known, spec });
    return { ...published.body, chainId: data.manifest.chainId, gate: { ...(published.body.gate as Record<string, unknown>), open: true },
      row: { ...published.body.row, chainId: data.manifest.chainId, record: { ...published.body.row.record, poolManager: data.manifest.chain.poolManager.address } } };
  };
  const cards: Awaited<ReturnType<typeof box>>[] = [];
  let base: string | null = null;
  for (const [index, b] of boxes.entries()) {
    const card = await box({ tokenName: b.name, tokenSymbol: b.symbol, collectionName: b.name, coverSha256: b.logo, collectionCoverSha256: b.cover });
    base ??= card.token;
    cards.push(asOtherToken(card, card.token, tokenOf(base, index)));
  }
  const first = cards[0];
  if (!first || base === null) throw new Error('no boxes');
  const vault = rolesOfV2(first.row.record as never).contracts.vault as Address;
  const m3 = m3RpcFixture({ vault });
  const own: Record<string, (args: readonly unknown[]) => unknown> = {
    inside: () => 2n, pickFeeBps: () => 100n, returnFeeBps: () => 100n, quoteWithdraw: () => 300n * ETH, quoteReturn: () => 290n * ETH,
    isOnShelf: () => true, isOutside: () => false, ownerOf: () => vault, traitsOf: () => [false, 0n, ZERO, ZERO],
  };
  const answers = new Map<string, Uint8Array>(files.map((file) => [rawCidV1(sha(file)), file]));
  const hashes = new Map<string, Hex>();
  const holds = new Map<string, Promise<void>>();
  const gateway: PictureGateway = {
    asked: [],
    serve: (hash, bytes) => { answers.set(rawCidV1(hash), bytes); },
    hold: (hash) => {
      let release: () => void = () => undefined;
      holds.set(rawCidV1(hash), new Promise<void>((resolve) => { release = resolve; }));
      return () => release();
    },
  };
  for (const b of boxes) for (const hash of [b.logo, b.cover]) if (hash !== ZERO) hashes.set(rawCidV1(hash), hash);
  await installUntouchableWallet(page);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v2/withheld') return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ version: 1, hashes: [] }) });
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards } : path.endsWith('/activity') ? { asOf: first.asOf, items: [], next: null } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) }).catch(() => undefined);
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    let answer;
    try {
      if (call.method === 'eth_chainId') answer = { result: toHex(data.manifest.chainId) };
      else {
        const tx = call.method === 'eth_call' ? call.params?.[0] as { data: Hex } : null;
        const fn = tx ? OWN.find((f) => toFunctionSelector(f) === tx.data.slice(0, 10) && own[f.name]) : undefined;
        if (tx && fn) {
          const { args = [] } = decodeFunctionData({ abi: [fn], data: tx.data });
          answer = { result: encodeFunctionResult({ abi: [fn], functionName: fn.name, result: (own[fn.name] as (a: readonly unknown[]) => unknown)(args) as never }) };
        } else answer = { result: await m3.request(call) };
      }
    } catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.route(`${GATEWAY}/**`, async (route: Route) => {
    const cid = new URL(route.request().url()).pathname.replace(/^\/ipfs\//, '');
    const hash = hashes.get(cid);
    if (hash) gateway.asked.push(hash);
    const held = holds.get(cid);
    if (held) await held;
    const file = answers.get(cid);
    if (!file) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } }).catch(() => undefined);
    // A held answer can outlive its request (the page gave up, or the test ended): nothing more to answer then.
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'content-length': String(file.length) }, body: Buffer.from(file) }).catch(() => undefined);
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  const chainId = data.manifest.chainId;
  return { chainId, tokens: cards.map((card) => card.token.toLowerCase()), paths: cards.map((card) => `/box/${chainId}/${card.token.toLowerCase()}`), gateway };
}

/** The picture an element draws, measured: its natural size, its box, its fit, and whether it is loaded. */
export async function drawn(img: Locator) {
  return img.evaluate((el: HTMLImageElement) => ({
    natural: [el.naturalWidth, el.naturalHeight], box: [el.clientWidth, el.clientHeight], fit: getComputedStyle(el).objectFit, complete: el.complete && el.naturalWidth > 0,
  }));
}

/**
 * Fix round af2 (review M2): how much of a drawn picture is cut, in CSS px. The picture's own drawn rectangle (its
 * natural ratio placed by object-fit and object-position) is compared with every box that clips it: the <img> itself
 * and each ancestor that does not let overflow show. A round clip (a corner radius of 40% of its side or more: a coin,
 * a circle) is measured exactly at the picture's corners; the small rounding of a rectangular frame's corners is not
 * counted. `cut` 0: the picture is whole. `round`: a round clip draws it.
 */
export async function fitOf(img: Locator) {
  return img.evaluate((el: HTMLImageElement) => {
    const css = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const nw = el.naturalWidth;
    const nh = el.naturalHeight;
    const fit = css.objectFit;
    const scale = fit === 'contain' ? Math.min(box.width / nw, box.height / nh) : Math.max(box.width / nw, box.height / nh);
    const cw = fit === 'fill' ? box.width : nw * scale;
    const ch = fit === 'fill' ? box.height : nh * scale;
    // CSS lengths in a browser, not amounts: a percentage or a px value, as getComputedStyle writes them.
    const length = (v: string) => Number(v.replace(/(?:px|%)$/, '')) || 0;
    const [px = 0.5, py = 0.5] = css.objectPosition.split(' ').map((v) => (v.endsWith('%') ? length(v) / 100 : 0.5));
    const x = box.left + (box.width - cw) * px;
    const y = box.top + (box.height - ch) * py;
    const corners = [[x, y], [x + cw, y], [x, y + ch], [x + cw, y + ch]] as const;
    let cut = 0;
    let round = false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (node !== el && s.overflowX === 'visible' && s.overflowY === 'visible' && s.clipPath === 'none') continue;
      const r = node.getBoundingClientRect();
      cut = Math.max(cut, r.left - x, r.top - y, x + cw - r.right, y + ch - r.bottom);
      const raw = s.borderTopLeftRadius.split(' ')[0] ?? '0';
      const radius = Math.min(raw.endsWith('%') ? (length(raw) / 100) * r.width : length(raw), r.width / 2, r.height / 2);
      if (radius >= 0.4 * Math.min(r.width, r.height)) {
        round ||= r.width === r.height && radius === r.width / 2;
        for (const [cx0, cy0] of corners) {
          const cx = Math.min(Math.max(cx0, r.left + radius), r.right - radius);
          const cy = Math.min(Math.max(cy0, r.top + radius), r.bottom - radius);
          cut = Math.max(cut, Math.hypot(cx0 - cx, cy0 - cy) - radius);
        }
      }
    }
    return { natural: [nw, nh], fit, position: css.objectPosition, cut: Math.max(0, Math.round(cut * 10) / 10), round, complete: el.complete && nw > 0 };
  });
}

/** The SHA-256 of the bytes an <img> draws (its blob or data URL, read inside the page). */
export async function drawnSha(img: Locator): Promise<string> {
  return img.evaluate(async (el: HTMLImageElement) => {
    const bytes = await (await fetch(el.src)).arrayBuffer();
    return `0x${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  });
}

/** Every <img> on the page that the browser tried and could not draw (a broken image). */
export const brokenImages = (page: Page) => page.evaluate(() => Array.from(document.images).filter((img) => img.getAttribute('src') && img.complete && img.naturalWidth === 0).map((img) => img.className || img.src.slice(0, 40)));
