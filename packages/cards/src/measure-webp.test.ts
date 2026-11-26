import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { base64 } from './share-render';
import { testCardEngine } from './webp-test-support';

it('timing tool holds stdin open until the real child returns a decoded PNG', async () => {
  const tool = fileURLToPath(new URL('../scripts/measure-webp.py', import.meta.url));
  const fixture = fileURLToPath(new URL('../../artwork/src/picture-fixtures/lossless.webp', import.meta.url));
  const result = spawnSync('python3', ['-c', `
import runpy, sys
from pathlib import Path
decode = runpy.run_path(sys.argv[1])['decode']
png, result = decode(Path(sys.argv[2]).read_bytes())
sys.stderr.write(result['error'])
if result['exit']:
    raise SystemExit(result['exit'])
sys.stdout.buffer.write(png)
`, tool, fixture], { stdio: ['ignore', 'pipe', 'pipe'], timeout: shLimit(10000) });
  expect(result.error, result.stderr.toString()).toBeUndefined();
  expect(result.status, result.stderr.toString()).toBe(0);
  expect(result.stdout.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const engine = await testCardEngine('native');
  expect(engine.pictureDecodes?.({ bytes: result.stdout, type: 'image/png' })).toBe(true);
  const pixels = (png: Uint8Array) => engine.rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><image width="3" height="2" href="data:image/png;base64,${base64(png)}"/></svg>`).pixels;
  const reference = readFileSync(new URL('./webp-fixtures/lossless.png', import.meta.url));
  expect(Buffer.from(pixels(result.stdout))).toEqual(Buffer.from(pixels(reference)));
});
