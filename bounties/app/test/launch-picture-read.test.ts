/**
 * SH-294: a launch's picture read back from its link the platform's way: the withheld list first, the two raw gateways
 * in turn, a cap, raster only, the link's hash; anything else is no picture.
 */
import { describe, expect, it } from 'vitest';
import { hexOf, sha256Of } from '../src/lib/pictures/ans104-eth';
import { MAX_PICTURE_BYTES, pictureLink } from '../src/lib/pictures/publish';
import { rawCidOf, readLaunchPicture, rememberLaunchPicture } from '../src/lib/pictures/read';

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const ID = 'C'.repeat(43);
const sha = async (b: Uint8Array) => hexOf(await sha256Of(b));
const key = async (id: string) => hexOf(await sha256Of(new TextEncoder().encode(`sh-withheld-v1:${id}`)));

/** The site and the gateways: the withheld list (or a refusal), then each gateway's answer for the item. */
function net(list: unknown, gateways: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === '/v2/withheld') return list === 'down' ? new Response('no', { status: 500 }) : new Response(JSON.stringify(list));
    const answer = Object.entries(gateways).find(([g]) => url.startsWith(g))?.[1];
    return answer ? answer() : new Response('', { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}
const EMPTY = { version: 1, hashes: [] };
const G1 = 'https://turbo-gateway.com'; const G2 = 'https://arweave.net';

describe('a launch picture read back', () => {
  it('the raw CID of a hash is the platform\'s (the empty file\'s well-known CIDv1)', async () => {
    expect(rawCidOf(await sha(new Uint8Array(0)))).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  });
  it('the first gateway that serves the exact bytes; a 404 first goes on to the second', async () => {
    const link = pictureLink(ID, await sha(PNG));
    const n = net(EMPTY, { [G1]: () => new Response('', { status: 404 }), [G2]: () => new Response(PNG) });
    expect((await readLaunchPicture(link, { fetcher: n.fetcher }))?.type).toBe('image/png');
    expect(n.asked).toEqual(['/v2/withheld', `${G1}/raw/${ID}`, `${G2}/raw/${ID}`]);
  });
  it('no picture: other bytes, an SVG, more than the cap, a withheld item or hash, an unreadable list, another link form', async () => {
    const link = pictureLink(ID, await sha(PNG));
    const other = await readLaunchPicture(link, { fetcher: net(EMPTY, { [G1]: () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9])) }).fetcher });
    const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const svg = await readLaunchPicture(pictureLink(ID, await sha(svgBytes)), { fetcher: net(EMPTY, { [G1]: () => new Response(svgBytes) }).fetcher });
    const big = new Uint8Array(MAX_PICTURE_BYTES + 1); big.set(PNG);
    const tooBig = await readLaunchPicture(pictureLink(ID, await sha(big)), { fetcher: net(EMPTY, { [G1]: () => new Response(big) }).fetcher });
    const byItem = await readLaunchPicture(link, { fetcher: net({ version: 1, hashes: [await key(`ar:${ID}`)] }, { [G1]: () => new Response(PNG) }).fetcher });
    const byHash = await readLaunchPicture(link, { fetcher: net({ version: 1, hashes: [await key(`ipfs:${rawCidOf(await sha(PNG))}`)] }, { [G1]: () => new Response(PNG) }).fetcher });
    const noList = await readLaunchPicture(link, { fetcher: net('down', { [G1]: () => new Response(PNG) }).fetcher });
    const form = await readLaunchPicture(`https://example.org/${ID}#sha256=${await sha(PNG)}`, { fetcher: net(EMPTY, {}).fetcher });
    expect([other, svg, tooBig, byItem, byHash, noList, form]).toEqual([null, null, null, null, null, null, null]);
  });
  it('a picture this page just published shows without a read, still under the withheld list', async () => {
    const bytes = Uint8Array.from([255, 216, 255, 1, 2, 3]);
    const link = pictureLink('D'.repeat(43), await sha(bytes));
    await rememberLaunchPicture(link, bytes);
    const n = net(EMPTY, {});
    expect((await readLaunchPicture(link, { fetcher: n.fetcher }))?.type).toBe('image/jpeg');
    expect(n.asked).toEqual(['/v2/withheld']);
    expect(await readLaunchPicture(link, { fetcher: net({ version: 1, hashes: [await key(`ar:${'D'.repeat(43)}`)] }, {}).fetcher })).toBeNull();
  });
});
