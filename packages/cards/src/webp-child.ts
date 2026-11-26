/** One WebP in, one PNG out. Only this child loads sharp. No path or URL is accepted. */
import sharp from 'sharp';
import { readSync, writeSync } from 'node:fs';
import { inspectBoxPicture, PICTURE_BUDGET } from '@squarehole/artwork/box-picture';
import { MAX_CONVERTED_BYTES } from './converted-picture';

sharp.cache(false);
sharp.concurrency(1);
// The IPC pipe also closes if the parent is killed without running its shutdown handlers.
const stop = () => { process.kill(process.pid, 'SIGKILL'); };
const ipc = typeof process.send === 'function';
process.on('disconnect', stop);
if (ipc && !process.connected) stop(); // Parent may have exited while modules were loading.
// Without IPC, stdin stays open as the parent's lifetime pipe. EOF must stop native work too.
if (!ipc) process.stdin.once('end', stop);

/** These are the inherited pipes, never file paths. Keep only one bounded input and output buffer. */
async function answer(bytes: Uint8Array): Promise<void> {
  for (let at = 0; at < bytes.length;) {
    try { at += writeSync(1, bytes, at, bytes.length - at); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes('--probe')) {
    if (sharp.versions.sharp !== '0.35.5' || !sharp.format.webp.input.buffer || !sharp.format.png.output.buffer) throw new Error('decoder unavailable');
    await answer(Buffer.from('WebP drawing on\n'));
    return;
  }
  const buffer = Buffer.alloc(PICTURE_BUDGET.bytes + 1);
  let length = 0;
  while (length <= PICTURE_BUDGET.bytes) {
    let count: number;
    try { count = readSync(0, buffer, length, buffer.length - length, null); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
      continue;
    }
    if (!count) { if (!ipc) stop(); break; }
    length += count;
    if (length > PICTURE_BUDGET.bytes) throw new Error('picture too large');
    // IPC callers delimit input with EOF. A stdin-only caller sends one complete RIFF and keeps the pipe open.
    if (!ipc && length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && length >= buffer.readUInt32LE(4) + 8) break;
  }
  if (!ipc) process.stdin.on('data', stop).resume(); // No second input or trailing bytes.
  const input = buffer.subarray(0, length);
  const expected = inspectBoxPicture(input);
  if (expected?.type !== 'image/webp') throw new Error('picture refused');
  const image = sharp(input, { limitInputPixels: PICTURE_BUDGET.pixels, page: 0, pages: 1, animated: false });
  const metadata = await image.metadata();
  if (metadata.format !== 'webp' || metadata.width !== expected.width || (metadata.pageHeight ?? metadata.height) !== expected.height) throw new Error('picture dimensions differ');
  const { data, info } = await image.ensureAlpha().png({ compressionLevel: 6, palette: false }).toBuffer({ resolveWithObject: true });
  if (info.width !== expected.width || info.height !== expected.height || data.length > MAX_CONVERTED_BYTES) throw new Error('PNG refused');
  await answer(data);
}

main().catch(() => process.exit(1));
