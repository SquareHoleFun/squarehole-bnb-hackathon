import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderPngs } from '../kits/png-workers.mjs';
import { loadResvg, toPng } from '../../examples/boxes/paper-certificates/src/render.mjs';
import { VARIANTS, itemSvg } from '../../examples/boxes/paper-certificates/src/items.mjs';

test('paper certificates: every variant and boundary number renders exactly the same bytes, in order', async () => {
  const Resvg = await loadResvg();
  const svgs = VARIANTS.flatMap(variant => ['1', '1929'].map(id => itemSvg(variant, id)));
  const before = performance.now();
  const expected = svgs.map(svg => Buffer.from(toPng(Resvg, svg)));
  const serialMs = performance.now() - before;
  const after = performance.now();
  let i = 0;
  for await (const bytes of renderPngs(svgs)) assert.deepEqual(bytes, expected[i++]);
  assert.equal(i, svgs.length);
  console.warn(JSON.stringify({ pictures: i, serialMs, workersMs: performance.now() - after }));
});
test('workers return render errors, validate limits, accept empty input and close on early exit', async () => {
  const collect = async (svgs, options) => { for await (const bytes of renderPngs(svgs, options)) assert.ok(bytes.length); };
  await assert.rejects(collect(['not an SVG']), /SVG|svg|parse|document/i);
  await assert.rejects(collect([], { workers: 0 }), /workers/);
  await collect([]);
  for await (const bytes of renderPngs(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'])) {
    assert.ok(bytes.length); break;
  }
});
