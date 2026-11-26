import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector, toHex, type Abi, type AbiFunction, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { rawCidV1 } from '../../../packages/artwork/src/misfits-commitment';
import { rolesOfV2, vaultV2Abi } from '../../../packages/chain/src/core/v2';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';
import { mixedDeployment } from '../src/features/core/v2/test-support/mixed-deployment';
import { ETH, publishedItems } from '../src/features/core/v2/test-support/m3-published';
import { m3RpcFixture } from '../src/features/core/v2/test-support/m3-rpc';
import { bagHoldersItem, rentFreeItem, type ItemArtFixture } from '../src/features/core/v2/test-support/item-models';
import type { RpcCall } from '../src/features/core/v2/test-support/m2-rpc';

// SH-WITHHELD-SITE (founder decision F157 (3)): our withheld-picture list on the site. A v2 box's page on synthetic
// reads (the M3-52 publication, a JSON-RPC double for the vault and the collection, and the local art gateway and
// indexer the browser suite's build names, 127.0.0.1:8595 and :8596, answered here; nothing reaches a network). The
// indexer's /v2/withheld first lists the box's cover and item 1's picture: both are the neutral "Picture withheld" tile
// and neither is ever asked of the gateway, while item 2's picture shows. The list then also names item 2's picture: a
// minute later (the page's clock moved on) the page reads the list again and item 2's shown picture turns into the tile,
// with no reload. Desktop at 1440×900 and a phone at 375 px. SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to
// docs/evidence/SH-WITHHELD-SITE/<name>-<project>.png.
const CORE = 'http://127.0.0.1:8596';
const RPC = 'http://127.0.0.1:8599';
const GATEWAY = 'http://127.0.0.1:8595';
const ZERO = `0x${'0'.repeat(64)}` as Hex;
const WITHHELD = 'Picture withheld';

async function shot(target: Page | Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/SH-WITHHELD-SITE/${name}-${info.project.name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  if ('goto' in target) await target.screenshot({ path, fullPage: false, scale: 'css' });
  else await target.screenshot({ path, scale: 'css' });
}

/** The list's hash of a picture id (packages/indexer/API.md): SHA-256 hex of "sh-withheld-v1:" + the full id. */
const hashOf = (id: string) => createHash('sha256').update(`sh-withheld-v1:${id}`).digest('hex');
const idOf = (sha256: Hex) => `ipfs:${rawCidV1(sha256)}`;

interface Shelf { readonly revealed: boolean; readonly art: ItemArtFixture | null }
const rent = rentFreeItem();
const bags = bagHoldersItem();
const SHELF: Readonly<Record<string, Shelf>> = {
  '1': { revealed: true, art: rent },
  '2': { revealed: true, art: bags },
  '3': { revealed: false, art: null },
};
const ABI = [...vaultV2Abi, ...boxCollectionAbi] as Abi;
const OWN = ABI.filter((item): item is AbiFunction => item.type === 'function');

async function fixture(page: Page) {
  const data = await mixedDeployment();
  const known = Object.fromEntries(Object.keys(SHELF).map((id, i) => [id, { inside: true, sequence: BigInt(i + 1) }]));
  const published = await publishedItems({ n: Object.keys(SHELF).length, known });
  const body = { ...published.body, chainId: data.manifest.chainId, gate: { ...(published.body.gate as Record<string, unknown>), open: true },
    row: { ...published.body.row, chainId: data.manifest.chainId, record: { ...published.body.row.record, poolManager: data.manifest.chain.poolManager.address } } };
  const vault = rolesOfV2(body.row.record as never).contracts.vault as Address;
  const m3 = m3RpcFixture({ vault });
  const own: Record<string, (args: readonly unknown[]) => unknown> = {
    inside: () => 3n, pickFeeBps: () => 100n, returnFeeBps: () => 100n, quoteWithdraw: () => 300n * ETH, quoteReturn: () => 290n * ETH,
    isOnShelf: () => true, isOutside: () => false, ownerOf: () => vault,
    traitsOf: ([id]) => {
      const item = SHELF[String(id)];
      return item?.revealed && item.art ? [true, 1n, item.art.pictureSha256, ZERO] : [false, 0n, ZERO, ZERO];
    },
  };
  // The box's own pictures: BoxCover shows the collection cover (else the logo). Our node has neither file.
  const spec = published.row.spec as { coverSha256: Hex; collectionCoverSha256: Hex };
  const cover = spec.collectionCoverSha256 !== ZERO ? spec.collectionCoverSha256 : spec.coverSha256;
  const files = new Map<string, Uint8Array>();
  for (const item of Object.values(SHELF)) if (item.art) files.set(rawCidV1(item.art.pictureSha256), item.art.picture);
  /** Every CID asked of our node, in order. */
  const asked: string[] = [];
  /** The list the indexer answers now (ids; the route answers their hashes), and how many times it was read. */
  const list = { ids: [idOf(cover), idOf(rent.pictureSha256)], reads: 0 };
  await installUntouchableWallet(page);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  await page.route(`${CORE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v2/withheld') {
      list.reads += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'cache-control': 'max-age=60' }, body: JSON.stringify({ version: 1, hashes: list.ids.map(hashOf).sort() }) });
    }
    const answer = path === '/v1/feed' ? data.v1.feed : path === '/v2/feed' ? { ...data.feed, cards: [body] } : path.endsWith('/activity') ? { asOf: body.asOf, items: [], next: null } : null;
    await route.fulfill({ status: answer ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(answer) });
  });
  await page.route(`${RPC}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const call = route.request().postDataJSON() as RpcCall & { id: number };
    let answer;
    try {
      if (call.method === 'eth_chainId') answer = { result: toHex(data.manifest.chainId) };
      // SH-235: the Items card names its item reads by the chain's head; the head is the published card's block.
      else if (call.method === 'eth_blockNumber') answer = { result: toHex(BigInt(body.asOf.block)) };
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
  await page.route(`${GATEWAY}/**`, async (route) => {
    const cid = new URL(route.request().url()).pathname.replace(/^\/ipfs\//, '');
    asked.push(cid);
    const file = files.get(cid);
    if (!file) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*', 'content-length': String(file.length) }, body: Buffer.from(file) });
  });
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Local chain/ }).check();
  await page.goto(`/box/${data.manifest.chainId}/${body.token.toLowerCase()}`);
  const panel = page.getByRole('region', { name: 'Items in the vault' });
  await expect(panel).toBeVisible();
  const shelf = panel.getByRole('list', { name: 'In the vault' });
  return { panel, shelf, asked, list, cover };
}

test.describe('SH-WITHHELD-SITE: withheld pictures on the site', () => {
  test.beforeEach(async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 375, height: 812 });
  });

  test('a listed picture is the neutral tile and never asked; an unlisted one shows; a list refresh hides a shown one without a reload', async ({ page }, info) => {
    test.setTimeout(120_000);
    // The page's own clock, so that "a minute later" does not take a minute (it runs as usual until moved on).
    await page.clock.install();
    const { panel, shelf, asked, list, cover } = await fixture(page);
    const head = page.locator('header.sh-bpic-head');

    // The cover and item 1's picture are listed: the tile, with its two words; item 2's picture shows.
    const coverTile = head.getByRole('img', { name: WITHHELD });
    await expect(coverTile).toBeVisible();
    await expect(coverTile).toHaveText(WITHHELD);
    await expect(head.locator('.sh-box-cover[data-art="withheld"]')).toHaveCount(1);
    const first = shelf.getByRole('img', { name: 'Item #1, picture withheld' });
    await expect(first).toBeVisible();
    await expect(first).toHaveText(WITHHELD);
    const second = shelf.getByRole('img', { name: 'Item #2', exact: true });
    await expect(second).toBeVisible();
    await expect.poll(() => second.evaluate((img) => img.tagName === 'IMG' && (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await expect(shelf.getByRole('img', { name: 'Item #3, not revealed' })).toBeVisible();
    // A listed picture is never asked of our node; the unlisted one was, once.
    await expect.poll(() => asked.includes(rawCidV1(bags.pictureSha256))).toBe(true);
    expect(asked).not.toContain(rawCidV1(cover));
    expect(asked).not.toContain(rawCidV1(rent.pictureSha256));
    expect(asked.filter((cid) => cid === rawCidV1(bags.pictureSha256))).toHaveLength(1);
    expect(list.reads).toBe(1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shot(head, info, 'cover-tile');
    await shot(panel, info, 'items-tile');

    // The list now names item 2's picture too. A minute later the page reads it again: the shown picture turns into
    // the tile, in the same page (no reload: a value kept on the window survives), and it is not asked again.
    await page.evaluate(() => { (window as unknown as { shKept?: string }).shKept = 'same page'; });
    list.ids = [...list.ids, idOf(bags.pictureSha256)];
    await page.clock.fastForward('01:05');
    await expect(shelf.getByRole('img', { name: 'Item #2, picture withheld' })).toBeVisible();
    await expect(shelf.getByRole('img', { name: 'Item #2', exact: true })).toHaveCount(0);
    expect(list.reads).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => (window as unknown as { shKept?: string }).shKept)).toBe('same page');
    expect(asked.filter((cid) => cid === rawCidV1(bags.pictureSha256))).toHaveLength(1);
    await expect(shelf.locator('[data-withheld]')).toHaveCount(2);
    // Pictures only: the items, their numbers and the actions stay; no wallet was touched.
    await expect(panel.getByRole('button', { name: /Take out item 2/ })).toBeVisible();
    expect(await walletTouches(page)).toEqual([]);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shot(panel, info, 'items-tile-after-refresh');
  });
});
