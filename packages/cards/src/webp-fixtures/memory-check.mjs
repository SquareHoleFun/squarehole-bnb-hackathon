/** Offline full card request regression, run only by images-start-check.sh in a limited container. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { crc32 } from 'node:zlib';
import { once } from 'node:events';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { inspectBoxPicture } from '@squarehole/artwork/box-picture';
import { WebpDecoder, WEBP_LIMITS } from '../webp-decoder.ts';
import { nodeCardEngine, nodeCardAssets } from '../engine.ts';
import { renderCardPng } from '../share-render.ts';
import { CardService, cardName } from '../service/card-service.ts';
import { memoryWebp } from './memory-input.ts';

const memory = name => readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
assert.equal(memory('memory.max'), '1073741824', 'run with the Compose 1024 MiB limit');
const events = () => Object.fromEntries(memory('memory.events').split('\n').map(line => {
  const [name, count] = line.split(' '); return [name, Number(count)];
}));
const before = events();
const decoder = await WebpDecoder.start({ deadlineMs: shLimit(WEBP_LIMITS.deadlineMs) });
assert.equal(decoder.available, true);
const native = await nodeCardEngine('native', decoder);
const assets = nodeCardAssets();
let conversions = 0;
let completed = 0;
const engine = { ...native, async decodeWebp(picture) {
  const png = await native.decodeWebp(picture);
  assert.equal(png?.bytes.length, 14370469, 'must exercise the large PNG path');
  conversions++;
  return png;
} };
const box = { chainId: 11155111, token: `0x${'19'.repeat(20)}`, chainLabel: 'Sepolia',
  name: 'Memory check', ticker: 'CHECK', demo: false, state: { kind: 'open' }, logoSha256: null };
let bytes;
const policy = { version: 1, hashes: [] };
const service = new CardService({ engine, assets, engineKind: 'native', generic: readFileSync(new URL('../../../../apps/web/public/share/square-hole-1200x630.jpg', import.meta.url)), disk: null,
  config: () => ({ sepoliaManifest: null, localManifest: null, sepoliaRpcUrls: [], localRpcUrl: null, indexerOrigin: null }),
  readers: { fetch: () => { throw new Error('network forbidden'); }, direct: null, indexerTimeoutMs: shLimit(1000) },
  gateways: ['https://fixture.invalid'], fetchArt: async () => new Response(bytes),
  withheld: { has: () => false, snapshot: () => policy },
});
// Warm the service's actual 48 MiB LRU with distinct valid card PNG buffers.
// tEXt padding gives each card exactly 1 MiB without a second large image decoder.
const card = Buffer.from(await renderCardPng(box, null, assets, engine));
const padding = Buffer.alloc(1024 * 1024 - card.length, 65);
padding.writeUInt32BE(padding.length - 12, 0); padding.write('tEXt', 4); padding.write('warm\0', 8);
padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
const warm = Buffer.concat([card.subarray(0, -12), padding, card.subarray(-12)]);
assert.equal(warm.length, 1024 * 1024);
const warmCache = () => {
  for (let i = 0; i < 48; i++) {
    if (!service.cards.get(`warm-${i}`, Date.now())) service.cards.set(`warm-${i}`, Buffer.from(warm), Infinity);
  }
  assert.equal(service.cards.totalBytes, 48 * 1024 * 1024);
};
const server = createServer((request, response) => {
  service.handle(request.method, request.url).then(answer => {
    response.writeHead(answer.status, answer.headers); response.end(answer.body);
  }, error => { response.destroy(error); });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  for (let i = 0; i < 4; i++) {
    bytes = memoryWebp(72 + i);
    assert.equal(bytes.length, 790040);
    assert.deepEqual(inspectBoxPicture(bytes), { type: 'image/webp', width: 2048, height: 2048, frames: 1 });
    const token = `0x${String(i + 1).padStart(40, '0')}`;
    const logoSha256 = `0x${createHash('sha256').update(bytes).digest('hex')}`;
    service.facts.set(`11155111/${token}`, { status: 'box', box: { ...box, token, logoSha256 }, via: 'indexer' }, Infinity);
    warmCache();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/card/box/11155111/${token}.png?v=2-open`, {
      signal: AbortSignal.timeout(shLimit(30000)),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('x-sh-card') ?? '', /logo=yes; card=drawn/);
    assert.equal(conversions, i + 1, 'each request must run its own decoder child');
    const result = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([result.readUInt32BE(16), result.readUInt32BE(20)], [1200, 630]);
    completed++;
    // Retain the warm cards, then refill only the entry evicted by this result before the next draw.
    service.cards.delete(cardName({ ...box, token }, logoSha256));
    process.stdout.write(`cards memory: draw=${completed}/4 input=790040 canvas=2048x2048 png=14370469 warm_cache=50331648 card=${result.length} memory_current=${memory('memory.current')} memory_peak=${memory('memory.peak')}\n`);
  }
  assert.equal(conversions, 4, 'four conversions must complete');
  assert.equal(completed, 4, 'four card responses must complete');
  const after = events();
  assert.equal(after.oom, before.oom, 'cgroup OOM occurred');
  assert.equal(after.oom_kill, before.oom_kill, 'cgroup OOM kill occurred');
  process.stdout.write(`cards memory: conversions=${conversions} completed=${completed} memory_max=${memory('memory.max')} memory_peak=${memory('memory.peak')} oom_delta=0 oom_kill_delta=0\n`);
} finally {
  server.closeAllConnections(); server.close();
  await service.close();
}
