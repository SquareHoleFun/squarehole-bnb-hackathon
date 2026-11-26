// Canonical ustar: names sorted by UTF-8 bytes; uid/gid/mtime 0; no ACLs/xattrs/host identity.
// File content and paths are unchanged. The installer runs via bash; it alone gets mode 0755.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { gzipArchive } from './archive.mjs';
import { checkPack } from './check-pack.mjs';

function header(name, type, size, mode) {
  const block = Buffer.alloc(512);
  const put = (at, width, value) => {
    if (Buffer.byteLength(value) > width) throw new Error('tar field overflow; reduce the member size or path length');
    block.write(value, at, width, 'utf8');
  };
  const octal = (at, width, value) => put(at, width, `${value.toString(8).padStart(width - 1, '0')}\0`);
  put(0, 100, name);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  put(156, 1, type);
  put(257, 8, 'ustar\0' + '00');
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function* member(name, type, bytes, mode) {
  // A deterministic PAX path is the only extension; neither timestamps nor metadata are copied.
  if (Buffer.byteLength(name) > 100) {
    const body = ` path=${name}\n`;
    let length = Buffer.byteLength(body) + 1;
    while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
    yield* member('PaxHeader', 'x', Buffer.from(`${length}${body}`), 0o644);
    name = 'PaxPath';
  }
  yield header(name, type, bytes.length, mode);
  yield bytes;
  yield Buffer.alloc((512 - bytes.length % 512) % 512);
}

// One descriptor and nanosecond metadata checks bracket the read. This is detection, not a tree snapshot.
function readStableFile(path, listed) {
  let fd;
  try {
    const same = (a, b) => a.isFile() && b.isFile() &&
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
    const pathBefore = lstatSync(path, { bigint: true });
    if (!pathBefore.isFile() || pathBefore.dev !== listed.dev || pathBefore.ino !== listed.ino) {
      throw new Error('file changed since listing while packing; stop writes and repack');
    }
    // NONBLOCK also prevents a substituted FIFO from hanging before the descriptor's type check.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!same(pathBefore, before)) throw new Error('file changed while packing; stop writes and repack');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (before.size !== BigInt(bytes.length) || !same(before, after) || !same(after, pathAfter)) {
      throw new Error('file changed while packing; stop writes and repack');
    }
    return bytes;
  } catch (error) {
    throw new Error(`${JSON.stringify(path)}: ${error.message}`, { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function pack(work, output) {
  const entries = [];
  const walk = name => {
    if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some(part => part.startsWith('._'))) {
      throw new Error(`unsupported or AppleDouble archive path ${JSON.stringify(name)}; use only letters, digits, _, ., / and -; remove AppleDouble ._ entries`);
    }
    const stat = lstatSync(join(work, name), { bigint: true });
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('non-regular files and symlinks refused');
    entries.push({ name, directory: stat.isDirectory(), dev: stat.dev, ino: stat.ino });
    if (stat.isDirectory()) for (const child of readdirSync(join(work, name))) walk(`${name}/${child}`);
  };
  if (!lstatSync(join(work, 'artifact')).isDirectory() || !lstatSync(join(work, 'install.sh')).isFile()) throw new Error('required: artifact directory and regular install.sh');
  walk('artifact');
  walk('install.sh');
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  function* blocks() {
    for (const entry of entries) {
      const { name, directory } = entry;
      yield* member(directory ? `${name}/` : name, directory ? '5' : '0', directory ? Buffer.alloc(0) : readStableFile(join(work, name), entry), directory || name === 'install.sh' ? 0o755 : 0o644);
    }
    yield Buffer.alloc(1024);
  }
  const hash = await gzipArchive(Readable.from(blocks()), output);
  return { hash, files: checkPack(output, work) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('usage: pack.sh <work directory> <tarball>');
    const result = await pack(...process.argv.slice(2));
    process.stdout.write(`app-pack: ${result.files} files, no metadata members\n`);
    process.stdout.write(`app-pack: archive: ${process.argv[3]}; sha256: ${result.hash}\n`);
  } catch (error) {
    process.stderr.write(`${error.message.startsWith('usage:') ? error.message : `app-pack: ${error.message}`}\n`);
    process.exitCode = 1;
  }
}
