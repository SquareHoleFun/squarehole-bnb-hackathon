/** SH-199 process-peak RSS. Run once for fixtures, then each printed --measure command in a fresh process. */
import { createReadStream, mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === '--measure') {
  const { parseOpenRevealFileV2, planOpenRevealBatchesV2 } = await import('../src/core/v2/open-reveal-batches-v2.ts');
  const path = process.argv[3], root = process.argv[4];
  const baselineRss = process.memoryUsage().rss;
  const started = performance.now();
  const file = await parseOpenRevealFileV2(createReadStream(path, { highWaterMark: 65_536 }), { root });
  let batches = 0, items = 0;
  for (const batch of planOpenRevealBatchesV2(file, { collection: '0x0000000000000000000000000000000000000300' })) {
    batches++;
    items += batch.ids.length;
  }
  process.stdout.write(`${JSON.stringify({ items, batches, fileBytes: statSync(path).size, baselineRssBytes: baselineRss,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, elapsedMs: Math.round(performance.now() - started) })}\n`);
} else {
  const { openRevealFixture } = await import('../src/core/v2/test-support/open-reveal-fixture.ts');
  const directory = mkdtempSync(join(tmpdir(), 'sh-199-memory-'));
  for (const n of [500, 10_000]) {
    const file = openRevealFixture(n);
    for (const assetBytes of [0, 64 * 1024 * 1024]) {
      const path = join(directory, `${n}-${assetBytes}.json`);
      writeFileSync(path, JSON.stringify({ ...file, pictures: [{ base64: 'A'.repeat(assetBytes) }] }));
      process.stdout.write(`mise exec -- node --import ./packages/chain/scripts/register-ts.mjs ${script} --measure ${path} ${file.spec.revealRoot}\n`);
    }
  }
}
