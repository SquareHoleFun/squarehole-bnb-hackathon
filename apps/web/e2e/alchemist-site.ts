/**
 * The Alchemist's browser fixtures (SH-V21-FE14), shared by v21-fe14.spec.ts and alchemist-less-text.spec.ts (moved
 * here unchanged from v21-fe14.spec.ts by SH-ALCHEMIST-LESS-TEXT): synthetic box pages served through the real source,
 * page and wallet boundary; the release's directory row, module and route helper as their view calls answer; and the
 * local chain source's book of 150 listed coins. Every other origin is aborted, so nothing leaves the machine.
 */
import { createOptionsAnswer } from './create-options-list';
import type { Locator, Page } from '@playwright/test';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, erc20Abi, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import manifest from './fixtures/core-local/manifest-11155111.json' with { type: 'json' };
import { makePng } from '../../../packages/artwork/src/test-support/images';
import { alchemistDirectoryV21Abi, alchemistRouteV21Abi, alchemistV21Abi, receiverModulesV21Abi } from '../../../packages/chain/src/core/v2';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import type { RpcCall } from '../src/features/core/v2/test-support/m2-rpc';
import { MODULE } from '../src/features/core/v2/test-support/alchemist-published';

export const CORE = 'http://127.0.0.1:8596';
export const RPC = 'http://127.0.0.1:8599';
export const NATIVE = '0x0000000000000000000000000000000000000000' as Address;

export const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true }).click();
export const heading = (page: Page) => page.getByRole('heading', { level: 1 });
export const logo = { name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) };
export const figure = (scope: Locator, label: string) => scope.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
export const row = (scope: Locator, term: string) => scope.locator('.sh-newbox-row').filter({ has: scope.page().locator('dt', { hasText: new RegExp(`^${term}$`) }) }).locator('dd');

// --- Box pages (synthetic publications) -------------------------------------------------------------------------
export async function serve(page: Page, body: Record<string, unknown> & { token: string; asOf?: unknown }, rpc: (call: RpcCall) => Promise<unknown>, book: unknown = null) {
  const data = await mixedDeployment();
  const row = body.row as { record: Record<string, unknown> };
  const card = { ...body, chainId: data.manifest.chainId, row: { ...row, chainId: data.manifest.chainId, record: { ...row.record, poolManager: data.manifest.chain.poolManager.address } } };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards: [card] } : path.endsWith('/activity') ? { asOf: body.asOf, items: [], next: null }
      : path.startsWith('/v2/listings/') ? book : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    let answer;
    try { answer = { result: call.method === 'eth_chainId' ? toHex(data.manifest.chainId) : await rpc(call) }; }
    catch (error) { answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message } }; }
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }) });
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${data.manifest.chainId}/${body.token.toLowerCase()}`);
  return data;
}

/** PAXG at the pile's address, for the listing book: its symbol and decimals name the pile's amounts. */
export const pileBook = (asset: Address) => ({ schema: 'sh.core-listings.v2', chainId: manifest.chainId, registry: (manifest.releases[0]?.registry.address ?? '').toLowerCase(), listings: [listing(6, asset, 18, 'OTHER', 4_152_900_000_000_000_000n)] });
export function listing(id: number, token: Address, decimals: number, cls: string, raise: bigint, kind = 'LISTED') {
  const detail = { id, token, decimals, class: cls, kind, listedAt: '1', raise: raise.toString(), q: { bootstrapQ: '1', batchMinQ: '1', tipMaxQ: '1', swapStepMinQ: '1' } };
  return { id, token, class: cls, kind, raise: raise.toString(), detail };
}

// The Alchemist on chain, as its directory row, module and route helper answer (AlchemistFeeModuleV21, AlchemistRouteV21).
export const RELEASE = manifest.releases[0] as unknown as { implementations: Record<'receiver' | 'coordinator', { address: Address }>; factory: { address: Address } };
export const PM = manifest.chain.poolManager.address as Address;
export const DIRECTORY = getAddress('0x00000000000000000000000000000000000000d1');
export const EXECUTOR = getAddress('0x0000000000000000000000000000000000000052');
export const WETH = getAddress('0x00000000000000000000000000000000000000e2');
export const MODULE_CODE = '0x01' as Hex; export const EXECUTOR_CODE = '0x02' as Hex;
/**
 * G1: the module's per-step cap and dust size (raw price coin) and its fixed trigger, as `inputCap()`, `dustMax()` and
 * `conversionTrigger()` answer. F153: any address can be the trigger, and the site names it by its short address alone,
 * never a keeper or a private send; this one is Sepolia row 4's, the founder's deployer, not the platform keeper.
 */
export const CAP = 10n ** 15n; export const DUST = 10n ** 9n; export const TRIGGER = getAddress('0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE');
export const KEEPER_WORDS = /keeper|private/i;
export interface AlchemistChain { readonly price: Address; readonly pile: Address; readonly route: readonly { kind: number; tokenIn: Address; tokenOut: Address; pool: Address; fee: number; tickSpacing: number }[]; readonly id: number }
export function alchemistAnswer(chain: AlchemistChain, to: string, data: Hex): Hex | null | undefined {
  const at = to.toLowerCase();
  if (at === RELEASE.implementations.receiver.address.toLowerCase()) {
    let name = '';
    try { name = decodeFunctionData({ abi: receiverModulesV21Abi, data }).functionName; } catch { /* another receiver read */ }
    return name === 'receiverCode'
      ? encodeFunctionResult({ abi: receiverModulesV21Abi, functionName: 'receiverCode', result: [getAddress('0x0000000000000000000000000000000000000073'), getAddress('0x0000000000000000000000000000000000000074'), DIRECTORY] })
      : null;
  }
  if (at === DIRECTORY.toLowerCase()) {
    const { functionName, args } = decodeFunctionData({ abi: alchemistDirectoryV21Abi, data });
    // Rows 0 to 3 are the release's four built-in actions (no Alchemist getters); row 4 is the Alchemist.
    if (functionName === 'count') return encodeFunctionResult({ abi: alchemistDirectoryV21Abi, functionName, result: BigInt(chain.id + 1) });
    const id = Number(args?.[0]);
    const module = id === chain.id ? MODULE : getAddress(toHex(0x40 + id, { size: 20 }));
    const hash = id === chain.id ? keccak256(MODULE_CODE) : keccak256('0x09');
    if (functionName === 'resolve') return encodeFunctionResult({ abi: alchemistDirectoryV21Abi, functionName, result: [module, hash] });
    if (functionName === 'record') return encodeFunctionResult({ abi: alchemistDirectoryV21Abi, functionName, result: [module, hash, 1_800_000_000n, false] });
    return null;
  }
  if (at === MODULE.toLowerCase()) {
    const { functionName } = decodeFunctionData({ abi: alchemistV21Abi, data });
    const answers: Record<string, unknown> = { feeActionVersion: 1n, poolManager: PM, receiverImplementation: RELEASE.implementations.receiver.address, coordinatorImplementation: RELEASE.implementations.coordinator.address,
      priceCoin: chain.price, pileCoin: chain.pile, executor: EXECUTOR, executorCodeHash: keccak256(EXECUTOR_CODE), inputCap: CAP, dustMax: DUST, conversionTrigger: TRIGGER };
    return encodeFunctionResult({ abi: alchemistV21Abi, functionName, result: answers[functionName] } as never);
  }
  if (at === EXECUTOR.toLowerCase()) {
    const { functionName, args } = decodeFunctionData({ abi: alchemistRouteV21Abi, data });
    if (functionName === 'module') return encodeFunctionResult({ abi: alchemistRouteV21Abi, functionName, result: MODULE });
    if (functionName === 'manager') return encodeFunctionResult({ abi: alchemistRouteV21Abi, functionName, result: PM });
    if (functionName === 'length') return encodeFunctionResult({ abi: alchemistRouteV21Abi, functionName, result: BigInt(chain.route.length) });
    const hop = chain.route[Number(args?.[0])];
    return hop ? encodeFunctionResult({ abi: alchemistRouteV21Abi, functionName: 'hop', result: hop }) : null;
  }
  return undefined;
}
export const alchemistCode = (address: string): Hex | undefined => (address.toLowerCase() === MODULE.toLowerCase() ? MODULE_CODE : address.toLowerCase() === EXECUTOR.toLowerCase() ? EXECUTOR_CODE : undefined);

// --- The local chain source: 150 listed coins and The Alchemist in the creation flow --------------------------------
export const coinAt = (n: number): Address => getAddress(toHex(0x6000 + n, { size: 20 }));
export const PEPE = coinAt(1); export const PAXG = coinAt(2);
export const CLASSES = ['STANDARD', 'STABLE', 'STOCK', 'OTHER'] as const;
export const BOOK = [
  ['ETH', NATIVE, 18, 'NATIVE', 4_206_980_085_000_000_000n, 'LISTED'],
  ['PEPE', PEPE, 18, 'OTHER', 420_690_000_000_000_000_000_000_000n, 'LISTED'],
  ['PAXG', PAXG, 18, 'OTHER', 2_103_490_042_500_000_000n, 'LISTED'],
  ['WETH', WETH, 18, 'OTHER', 4_206_980_085_000_000_000n, 'LISTED'],
  ...Array.from({ length: 146 }, (_, i) => [`C${String(i + 1).padStart(3, '0')}`, coinAt(10 + i), 18, CLASSES[i % 4] ?? 'OTHER', 10n ** 21n, (i + 1) % 9 === 0 ? 'BOX_TOKEN' : 'LISTED'] as const),
] as const;
export async function localChain(page: Page) {
  const calls: string[] = [];
  const symbols = new Map(BOOK.map(([symbol, token]) => [token.toLowerCase(), symbol]));
  const chain: AlchemistChain = { price: PEPE, pile: PAXG, id: 4, route: [{ kind: 3, tokenIn: PEPE, tokenOut: WETH, pool: getAddress('0x00000000000000000000000000000000000000a1'), fee: 10_000, tickSpacing: 200 }, { kind: 2, tokenIn: WETH, tokenOut: PAXG, pool: getAddress('0x00000000000000000000000000000000000000a2'), fee: 3000, tickSpacing: 0 }] };
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const registry = (manifest.releases[0]?.registry.address ?? '').toLowerCase();
    const listings = BOOK.map(([, token, decimals, cls, raise, kind], index) => listing(index + 1, token, decimals, cls, raise, kind));
    const answer = path === `/v2/listings/${manifest.chainId}/${registry}` ? { schema: 'sh.core-listings.v2', chainId: manifest.chainId, registry, listings } : createOptionsAnswer(path);
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const body = route.request().postDataJSON() as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
    const answer = (call: { id: number; method: string; params?: unknown[] }) => {
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id: call.id, result });
      const reverted = { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } };
      if (call.method === 'eth_chainId') return ok(toHex(manifest.chainId));
      if (call.method === 'eth_getCode') return ok(alchemistCode(String(call.params?.[0])) ?? '0x6080');
      if (call.method !== 'eth_call') return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `the fixture RPC does not answer ${call.method}` } };
      const { to, data } = call.params?.[0] as { to: string; data: Hex };
      calls.push(`${to.toLowerCase()}.${data.slice(0, 10)}`);
      const alchemist = alchemistAnswer(chain, to, data);
      if (alchemist === null) return reverted;
      if (alchemist !== undefined) return ok(alchemist);
      // Each listed coin answers its symbol; every other getter (issuer powers, the factory's eat check) reverts.
      const symbol = symbols.get(to.toLowerCase());
      try { if (symbol && decodeFunctionData({ abi: erc20Abi, data }).functionName === 'symbol') return ok(encodeAbiParameters([{ type: 'string' }], [symbol])); } catch { /* another getter */ }
      return reverted;
    };
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  return { calls };
}

/** One block of text as a reader sees it: its words and how many rendered lines they take. */
export interface ReadBlock { readonly text: string; readonly lines: number }
/** The reading load of a part of the page (SH-ALCHEMIST-LESS-TEXT): its visible text blocks, lines and words. */
export interface ReadingLoad { readonly blocks: readonly ReadBlock[]; readonly lines: number; readonly rows: number; readonly words: number }

/**
 * What a reader sees in `root`, as rendered: every visible text node (not in a `[hidden]` panel, a visually hidden
 * label, an element the browser does not draw, or a part matching `skip`), grouped by its nearest block-level box
 * (a `<p>`, a `<dt>`, a `<dd>`, a list item, a row of chips) in document order. A block's lines are its distinct rendered
 * line boxes (tops within 8 px are one line); rows are the distinct rows of text on the screen, whatever their blocks
 * (a row of chips or of figure labels is one row); words are runs with a letter or a digit. The same count on the base
 * and on this branch gives the before and after figures in the evidence.
 */
export function readingLoad(root: Locator, skip = ''): Promise<ReadingLoad> {
  return root.evaluate((element, skipSelector) => {
    const blocks = new Map<Element, { parts: string[]; tops: number[] }>();
    const boxes: { top: number; bottom: number }[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.replace(/\s+/g, ' ').trim();
      const parent = node.parentElement;
      if (!text || !parent) continue;
      if (parent.closest('[hidden], .sh-visually-hidden') || (skipSelector && parent.closest(skipSelector))) continue;
      if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      if (rects.length === 0) continue;
      const tops = rects.map((rect) => rect.top);
      boxes.push(...rects.map((rect) => ({ top: rect.top, bottom: rect.bottom })));
      let block: Element = parent;
      while (block !== element && block.parentElement && /^inline|^contents$/.test(getComputedStyle(block).display)) block = block.parentElement;
      const entry = blocks.get(block) ?? { parts: [], tops: [] };
      entry.parts.push(text);
      entry.tops.push(...tops);
      blocks.set(block, entry);
    }
    const out = [...blocks.values()].map(({ parts, tops }) => {
      const sorted = [...tops].sort((a, b) => a - b);
      const lines = sorted.reduce((count, top, i) => (i === 0 || top - (sorted[i - 1] ?? top) > 8 ? count + 1 : count), 0);
      return { text: parts.join(' '), lines };
    });
    const words = out.reduce((sum, block) => sum + block.text.split(' ').filter((word) => /[\p{L}\p{N}]/u.test(word)).length, 0);
    // A text box joins the row it overlaps by more than half its own height; otherwise it starts the next row.
    let rows = 0; let bottom = -Infinity;
    for (const box of [...boxes].sort((a, b) => a.top - b.top)) {
      if (Math.min(bottom, box.bottom) - box.top > (box.bottom - box.top) / 2) bottom = Math.max(bottom, box.bottom);
      else { rows += 1; bottom = box.bottom; }
    }
    return { blocks: out, lines: out.reduce((sum, block) => sum + block.lines, 0), rows, words };
  }, skip);
}
