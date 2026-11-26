// Host-independent compression for both Git tar streams and the app packer. Pin Node via mise.
import { createHash } from 'node:crypto';
import { createWriteStream, realpathSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';

export async function gzipArchive(input, output) {
  const hash = createHash('sha256');
  let header = Buffer.alloc(0);
  let started = false;
  const canonical = new Transform({
    transform(chunk, encoding, done) {
      if (!started) {
        header = Buffer.concat([header, chunk]);
        if (header.length < 10) return done();
        // Node writes no filename or time. Make the gzip OS field platform-independent too.
        header[9] = 255;
        chunk = header;
        started = true;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(input, createGzip({ level: 9 }), canonical, createWriteStream(output, { flags: 'wx', mode: 0o600 }));
  return hash.digest('hex');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: archive.mjs <new tar.gz>; input: tar on stdin');
    const hash = await gzipArchive(process.stdin, process.argv[2]);
    process.stdout.write(`app-archive: archive: ${process.argv[2]}; sha256: ${hash}\n`);
  } catch (error) {
    process.stderr.write(`${error.message.startsWith('usage:') ? error.message : `app-archive: ${error.message}`}\n`);
    process.exitCode = 1;
  }
}
