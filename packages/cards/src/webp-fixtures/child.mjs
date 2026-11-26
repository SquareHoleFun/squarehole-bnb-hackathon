// A real child for failure tests. No file output and no sharp load.
import { readFileSync, writeSync } from 'node:fs';
if (process.argv.includes('--probe')) {
  if (process.argv.includes('load-failure')) process.exit(1);
  writeSync(1, 'WebP drawing on\n');
  process.exit(0);
}
const mode = process.argv[2];
if (mode === 'hang') process.on('message', () => {});
else if (mode === 'crash') process.exit(7);
else if (mode === 'oversized') {
  const block = Buffer.alloc(1024 * 1024);
  for (let remaining = 18 * 1024 * 1024; remaining > 0;) {
    try { remaining -= writeSync(1, block, 0, Math.min(block.length, remaining)); }
    catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  process.exit(0);
}
else {
  const png = readFileSync(new URL('./lossless.png', import.meta.url));
  if (mode === 'crc') png[png.length - 1] ^= 1;
  if (mode === 'double') writeSync(1, Buffer.concat([png, png]));
  else if (mode === 'truncated') writeSync(1, png.subarray(0, 40));
  else if (mode === 'text') writeSync(1, 'not a PNG');
  else writeSync(1, png);
  process.exit(0);
}
