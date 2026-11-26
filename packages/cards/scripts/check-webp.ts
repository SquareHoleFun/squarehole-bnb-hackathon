/** Offline image check. The expected pixels are six opaque red pixels from the shared lossless fixture. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { nodeCardEngine } from '../src/engine';
import { base64 } from '../src/share-render';

const engine = await nodeCardEngine('native');
try {
  if (!engine.webpDrawing) throw new Error('WebP drawing is off');
  const picture = await engine.decodeWebp?.({ type: 'image/webp', bytes: readFileSync(new URL('../../artwork/src/picture-fixtures/lossless.webp', import.meta.url)) });
  if (!picture) throw new Error('WebP conversion failed');
  const png = Buffer.from(picture.bytes);
  if (png.readUInt32BE(16) !== 3 || png.readUInt32BE(20) !== 2) throw new Error('WebP dimensions differ');
  if (!engine.pictureDecodes?.(picture)) throw new Error('PNG cannot be drawn');
  const result = engine.rgba(`<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><image width="3" height="2" href="data:image/png;base64,${base64(png)}"/></svg>`);
  const hash = createHash('sha256').update(result.pixels).digest('hex');
  if (result.width !== 3 || result.height !== 2 || hash !== '1308c8d07d8bd47a24e30b627caaf193042efa719622f09c65d5c97eaa9e4c3a') throw new Error('WebP pixels differ');
  process.stdout.write(`cards: WebP check passed; 3 x 2; RGBA SHA-256 ${hash}\n`);
} finally { await engine.close?.(); }
