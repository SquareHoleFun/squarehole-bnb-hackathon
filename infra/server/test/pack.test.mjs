import { execFileSync, spawnSync } from './local-command.mjs';
import fs, { chmodSync, existsSync, lstatSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { pack } from '../app/pack.mjs';
import { checkPack, tarMembers } from '../app/check-pack.mjs';

function work() {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/app-pack-'));
  mkdirSync(join(dir, 'artifact/public'), { recursive: true });
  writeFileSync(join(dir, 'artifact/public/index.html'), 'offline app');
  writeFileSync(join(dir, 'install.sh'), '#!/usr/bin/env bash\n', { mode: 0o755 });
  return dir;
}

// A minimal ustar writer, so refusals are tested on exact archives whatever tar this machine has.
function headerOf({ name, type = '0', size = 0, checksum = true }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  for (const [at, value] of [[100, '0000644'], [108, '0000000'], [116, '0000000'], [124, size.toString(8).padStart(11, '0')], [136, '00000000000']]) header.write(`${value}\0`, at);
  header.write(type, 156);
  header.write('ustar\0' + '00', 257);
  header.fill(0x20, 148, 156);
  let sum = checksum ? 0 : 1;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function tarOf(entries) {
  const blocks = [];
  for (const { name, type = '0', body = '', checksum = true } of entries) {
    const data = Buffer.from(body);
    blocks.push(headerOf({ name, type, size: data.length, checksum }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const pax = (records) => records.map(([key, value]) => {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  return `${length}${body}`;
}).join('');

const plain = [{ name: 'artifact/', type: '5' }, { name: 'artifact/public/', type: '5' }, { name: 'artifact/public/index.html', body: 'offline app' }, { name: 'install.sh', body: '#!/usr/bin/env bash\n' }];

function check(entries) {
  const dir = work();
  const tarball = join(dir, 'app.tar.gz');
  writeFileSync(tarball, tarOf(entries));
  return () => checkPack(tarball, dir);
}

describe('app tarball packing', () => {
  it('accepts exactly the work directory files and directories', () => {
    expect(check(plain)()).toBe(2);
    expect(check([...plain.slice(0, 2), { name: 'x', type: 'x', body: pax([['path', 'artifact/public/index.html'], ['mtime', '1']]) }, { name: 'placeholder', body: 'offline app' }, plain[3]])()).toBe(2);
  });

  it('refuses macOS metadata: AppleDouble members and extended-attribute records', () => {
    expect(check([...plain, { name: 'artifact/public/._index.html', body: 'mac' }])).toThrow(/AppleDouble/);
    expect(check([{ name: 'artifact/._public', body: 'mac' }, ...plain])).toThrow(/AppleDouble/);
    expect(check([...plain.slice(0, 2), { name: 'x', type: 'x', body: pax([['path', 'artifact/public/._index.html']]) }, { name: 'placeholder', body: 'mac' }, ...plain.slice(2)])).toThrow(/AppleDouble/);
    expect(check([...plain.slice(0, 2), { name: 'x', type: 'x', body: pax([['LIBARCHIVE.xattr.com.apple.provenance', 'AQ']]) }, ...plain.slice(2)])).toThrow(/LIBARCHIVE\.xattr/);
    expect(check([...plain.slice(0, 2), { name: 'x', type: 'x', body: pax([['SCHILY.xattr.user.test', 'x']]) }, ...plain.slice(2)])).toThrow(/extended record/);
  });

  it('refuses missing, extra, linked, unsafe and corrupted members', () => {
    expect(check(plain.slice(0, 3))).toThrow(/differ/);
    expect(check([...plain, { name: 'artifact/public/extra.html', body: 'extra' }])).toThrow(/differ/);
    expect(check([...plain, { name: 'artifact/public/index.html', body: 'twice' }])).toThrow(/differ/);
    expect(check([...plain, { name: 'artifact/public/link', type: '2' }])).toThrow(/only regular files/);
    expect(check([...plain, { name: '../install.sh', body: 'x' }])).toThrow(/unsafe/);
    expect(check([...plain, { name: 'artifact/extra/', type: '5' }])).toThrow(/unexpected directory/);
    expect(check([plain[0], { ...plain[1], checksum: false }, ...plain.slice(2)])).toThrow(/checksum/);
    expect(() => tarMembers(gzipSync(Buffer.alloc(512, 0x41)))).toThrow();
  });

  // XR-SH-APP-PACK F1-F4: shapes where a lenient reader and an extractor would see different files.
  it('refuses archives an extractor could read differently', () => {
    const [artifactDir, publicDir, index, install] = plain;
    const paxOf = (records) => ({ name: 'x', type: 'x', body: pax(records) });
    const longOf = (name) => ({ name: '././@LongLink', type: 'L', body: `${name}\0` });
    const placeholder = { name: 'placeholder', body: 'offline app' };
    // F1: a pax size the reader would not apply.
    expect(check([artifactDir, publicDir, paxOf([['size', '1024']]), { name: index.name, body: '' }, install])).toThrow(/extended record size/);
    // F2: a directory whose payload hides another header.
    expect(check([{ ...artifactDir, body: headerOf({ name: 'artifact/public/extra' }) }, publicDir, index, install])).toThrow(/directory with a payload/);
    // F3: a regular member named as a directory, by header, pax path or GNU long name.
    for (const named of [[{ name: 'artifact/public/index.html/', body: 'offline app' }], [paxOf([['path', 'artifact/public/index.html/']]), placeholder], [longOf('artifact/public/index.html/'), placeholder]]) {
      expect(check([artifactDir, publicDir, ...named, install])).toThrow(/named as a directory/);
    }
    // F4: two pending name extensions, in either order, or two pax paths.
    expect(check([artifactDir, publicDir, paxOf([['path', 'artifact/public/unexpected.html']]), longOf(index.name), placeholder, install])).toThrow(/mixed tar name extensions/);
    expect(check([artifactDir, publicDir, longOf('artifact/public/unexpected.html'), paxOf([['path', index.name]]), placeholder, install])).toThrow(/mixed tar name extensions/);
    expect(check([artifactDir, publicDir, paxOf([['path', 'artifact/public/unexpected.html'], ['path', index.name]]), placeholder, install])).toThrow(/repeated tar path/);
    expect(check([artifactDir, publicDir, paxOf([['mtime', '1']]), paxOf([['path', index.name]]), placeholder, install])).toThrow(/mixed tar name extensions/);
    expect(check([artifactDir, publicDir, longOf(index.name), { name: 'placeholder', body: 'offline app' }, install])()).toBe(2);
  });

  it('pack.sh does not invoke the host tar, including its version probe (SH-204 supersedes F5)', () => {
    const dir = work();
    mkdirSync('.cache/tmp', { recursive: true });
    const bin = mkdtempSync(resolve('.cache/tmp/app-pack-bin-'));
    writeFileSync(join(bin, 'tar'), '#!/usr/bin/env bash\necho unexpected-tar >&2\nexit 23\n', { mode: 0o755 });
    const result = spawnSync('bash', ['infra/server/app/pack.sh', dir, join(dir, 'app.tar.gz')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('pack.sh writes a plain archive even when the files carry extended attributes', () => {
    const dir = work();
    if (process.platform === 'darwin') execFileSync('xattr', ['-w', 'com.example.sh-pack-test', 'yes', join(dir, 'artifact/public/index.html')]);
    if (process.platform === 'linux') execFileSync('python3', ['-c', 'import os, sys; os.setxattr(sys.argv[1], "user.sh-pack-test", b"yes")', join(dir, 'artifact/public/index.html')]);
    const tarball = join(dir, 'app.tar.gz');
    const result = spawnSync('bash', ['infra/server/app/pack.sh', dir, tarball], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('app-pack: 2 files, no metadata members');
    expect(checkPack(tarball, dir)).toBe(2);
    expect(spawnSync('bash', ['infra/server/app/pack.sh', dir], { encoding: 'utf8' }).status).not.toBe(0);
  });

  it.runIf(process.platform === 'darwin')('macOS native tar metadata control (skipped elsewhere: requires macOS xattr and bsdtar)', () => {
    const dir = work();
    execFileSync('xattr', ['-w', 'com.example.sh-pack-test', 'yes', join(dir, 'artifact/public/index.html')]);
    const tarball = join(dir, 'app.tar.gz');
    execFileSync('tar', ['-czf', tarball, '-C', dir, 'artifact', 'install.sh']);
    expect(() => checkPack(tarball, dir)).toThrow(/extended record|AppleDouble/);
    execFileSync('tar', ['-czf', tarball, '-C', dir, 'artifact', 'install.sh'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    expect(() => checkPack(tarball, dir)).toThrow(/extended record/);
  });

  it('ship.sh packs through pack.sh and validate.sh shellchecks it', () => {
    const ship = execFileSync('cat', ['infra/server/ship.sh'], { encoding: 'utf8' });
    expect(ship).toContain('bash infra/server/app/pack.sh "$work" "$tarball"');
    expect(ship).not.toMatch(/tar -czf "\$tarball"/);
    expect(execFileSync('cat', ['infra/server/app/validate.sh'], { encoding: 'utf8' })).toContain('infra/server/app/pack.sh)');
  });

  it('packs identical fixture bytes twice across umask, mode, timestamp and creation-order changes', () => {
    const hashes = [];
    const archives = [];
    for (const [mask, time, reverse] of [['077', 1000000000, false], ['002', 1700000000, true]]) {
      mkdirSync('.cache/tmp', { recursive: true });
      const dir = mkdtempSync(resolve('.cache/tmp/reproducible-pack-'));
      // A child sets umask so Vitest's own process and other fixtures are unaffected.
      const create = `const fs = require('node:fs'), p = require('node:path'), root = process.argv[1];
        const names = ['z.txt', 'a.txt', 'nested/deep.txt'];
        if (process.argv[2] === 'true') names.reverse();
        for (const name of names) { const file = p.join(root, 'artifact/public', name); fs.mkdirSync(p.dirname(file), { recursive: true }); fs.writeFileSync(file, name); }
        fs.writeFileSync(p.join(root, 'install.sh'), '#!/usr/bin/env bash\\n');`;
      execFileSync('bash', ['-c', 'umask "$1"; shift; exec "$@"', 'fixture', mask, process.execPath, '-e', create, dir, String(reverse)]);
      for (const name of ['artifact', 'artifact/public', 'artifact/public/nested', 'artifact/public/z.txt', 'artifact/public/a.txt', 'artifact/public/nested/deep.txt', 'install.sh']) {
        utimesSync(join(dir, name), time, time);
        chmodSync(join(dir, name), name.includes('.') ? (reverse ? 0o755 : 0o600) : (reverse ? 0o700 : 0o755));
      }
      const output = join(dir, 'app.tar.gz');
      const result = spawnSync('bash', ['infra/server/app/pack.sh', dir, output], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const bytes = readFileSync(output);
      archives.push(bytes);
      hashes.push(createHash('sha256').update(bytes).digest('hex'));
      expect(result.stdout).toContain(`sha256: ${hashes.at(-1)}`);
    }
    expect(hashes[0]).toBe(hashes[1]);
    // Node 24.22.1 golden bytes: the macOS run must produce this same archive, not merely agree with itself.
    expect(hashes[0]).toBe('5b7755283b78d683d3ae85101d80fc1304ce51d8508827a988ca44ae2d0e4a22');
    expect(archives[0].equals(archives[1])).toBe(true);
    // Metadata inspection is independent of the writer. Every header is plain ustar in this fixture.
    const bytes = gunzipSync(archives[0]);
    const names = [];
    for (let offset = 0; bytes[offset];) {
      const block = bytes.subarray(offset, offset + 512);
      const field = (at, width) => block.subarray(at, at + width).toString('utf8').replace(/\0.*$/s, '');
      const name = field(0, 100);
      names.push(name);
      expect(field(108, 8)).toBe('0000000');
      expect(field(116, 8)).toBe('0000000');
      expect(field(136, 12)).toBe('00000000000');
      expect(field(265, 32)).toBe('');
      expect(field(297, 32)).toBe('');
      expect(field(100, 8)).toBe(name.endsWith('/') || name === 'install.sh' ? '0000755' : '0000644');
      const size = parseInt(field(124, 12), 8);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual([...names].sort());
    expect(archives[0].subarray(4, 8)).toEqual(Buffer.alloc(4)); // gzip time
    expect(archives[0][9]).toBe(255); // no host OS
  });

  it('round trips long PAX paths through the native extractor and rejects links before writing', () => {
    const dir = work();
    const path = `artifact/public/${'a'.repeat(90)}/${'b'.repeat(90)}.txt`;
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), 'long-path-bytes');
    const tarball = join(dir, 'long.tar.gz');
    execFileSync('bash', ['infra/server/app/pack.sh', dir, tarball]);
    const extracted = join(dir, 'extracted');
    mkdirSync(extracted);
    execFileSync('tar', ['-xzf', tarball, '-C', extracted]);
    expect(readFileSync(join(extracted, path), 'utf8')).toBe('long-path-bytes');
    symlinkSync('index.html', join(dir, 'artifact/public/link'));
    const bad = spawnSync('bash', ['infra/server/app/pack.sh', dir, join(dir, 'bad.tar.gz')], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('non-regular files and symlinks refused');
  });

  it('Git archive compression ignores tar.umask configuration and shell umask for committed files', () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const dir = mkdtempSync(resolve('.cache/tmp/git-pack-repro-'));
    const packer = resolve('infra/server/app/archive.mjs');
    const outputs = [];
    for (const mask of ['077', '002']) {
      const out = join(dir, `${mask}.tar.gz`);
      // Read only these committed, non-secret files. No fixture commits or index changes are needed.
      const script = 'umask "$1"; git -c tar.umask=0077 -c tar.umask=0022 archive --format=tar HEAD infra/server/ship.sh infra/server/app/pack.sh | node "$2" "$3"';
      execFileSync('bash', ['-o', 'pipefail', '-c', script, 'fixture', mask, packer, out]);
      outputs.push(readFileSync(out));
    }
    expect(createHash('sha256').update(outputs[0]).digest('hex')).toBe(createHash('sha256').update(outputs[1]).digest('hex'));
    expect(outputs[0].equals(outputs[1])).toBe(true);
  });
});


// Independent native extraction checks the full tree, including empty directories and canonical permissions.
async function roundTrip(dir) {
  const tarball = join(dir, 'round-trip.tar.gz');
  await pack(dir, tarball);
  const names = [];
  const walk = name => {
    names.push(name);
    if (lstatSync(join(dir, name)).isDirectory()) for (const child of readdirSync(join(dir, name))) walk(`${name}/${child}`);
  };
  walk('artifact');
  walk('install.sh');
  expect(checkPack(tarball, dir)).toBe(names.filter(name => lstatSync(join(dir, name)).isFile()).length);
  const extracted = join(dir, 'extracted');
  mkdirSync(extracted);
  execFileSync('tar', ['-xzpf', tarball, '-C', extracted]);
  expect(tarMembers(readFileSync(tarball)).map(entry => entry.name).sort()).toEqual(names.sort());
  const extractedNames = [];
  const compare = name => {
    extractedNames.push(name);
    const source = join(dir, name);
    const target = join(extracted, name);
    const stat = lstatSync(target);
    expect(stat.isDirectory(), name).toBe(lstatSync(source).isDirectory());
    expect(stat.mode & 0o7777, name).toBe(stat.isDirectory() || name === 'install.sh' ? 0o755 : 0o644);
    if (stat.isDirectory()) for (const child of readdirSync(target)) compare(`${name}/${child}`);
    else expect(readFileSync(target).equals(readFileSync(source)), name).toBe(true);
  };
  for (const name of readdirSync(extracted)) compare(name);
  expect(extractedNames.sort()).toEqual(names);
}

describe('SH-204 af1 tar writer coverage', () => {
  it.each([0, 1, 511, 512, 513, 1048577])('round trips %i byte files with check-pack, native tar, bytes and modes', async size => {
    const dir = work();
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 256;
    writeFileSync(join(dir, 'artifact/public/boundary.bin'), bytes, { mode: 0o600 });
    await roundTrip(dir);
  });

  it.each([99, 100, 101, 255])('round trips %i byte names and tar paths with check-pack, native tar, bytes and modes', async length => {
    const dir = work();
    // Cover both a basename this long and the full archive name at the ustar/PAX boundary.
    for (const name of ['a'.repeat(length), 'b'.repeat(length - 'artifact/public/'.length)]) {
      writeFileSync(join(dir, 'artifact/public', name), Buffer.from([0, 255, 10, 128]));
    }
    await roundTrip(dir);
  });

  it('round trips empty folders, ten nesting levels and paths over 255 bytes', async () => {
    const dir = work();
    mkdirSync(join(dir, 'artifact/public/empty'), { mode: 0o700 });
    const deep = join(dir, 'artifact/public', ...Array.from({ length: 10 }, (_, i) => `level-${i}-${'x'.repeat(23)}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'leaf.bin'), Buffer.from([0, 1, 255]));
    await roundTrip(dir);
  });

  it.each(['has space', "has'quote", 'has\nnewline', '._metadata'])('refuses unsupported name %j with a repair message before writing an archive', async name => {
    const dir = work();
    writeFileSync(join(dir, 'artifact/public', name), 'refused');
    const output = join(dir, 'refused.tar.gz');
    const result = spawnSync('bash', ['infra/server/app/pack.sh', dir, output], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('app-pack: unsupported or AppleDouble archive path');
    expect(result.stderr).toContain('use only letters, digits, _, ., / and -; remove AppleDouble ._ entries');
    expect(existsSync(output)).toBe(false);
  });

  it('round trips 200 seeded random trees with check-pack, native tar, bytes and modes', async () => {
    let seed = 0x204af1;
    const random = max => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return (seed >>> 0) % max;
    };
    for (let tree = 0; tree < 200; tree++) {
      const dir = work();
      const folders = ['artifact/public'];
      const count = 5 + random(25);
      for (let entry = 0; entry < count; entry++) {
        const parent = folders[random(folders.length)];
        const name = `${parent}/${entry}-${'abcdefghijklmnopqrstuvwxyz0123456789_.-'[random(39)]}${'x'.repeat(random(130))}`;
        if (random(4) === 0) {
          mkdirSync(join(dir, name), { mode: 0o700 });
          folders.push(name);
        } else {
          const bytes = Buffer.alloc(random(4097));
          for (let i = 0; i < bytes.length; i++) bytes[i] = random(256);
          writeFileSync(join(dir, name), bytes, { mode: random(2) ? 0o600 : 0o755 });
        }
      }
      await roundTrip(dir);
    }
  }, shLimit(120000));

  it.each(['grow', 'shrink', 'rewrite', 'replace', 'symlink'])('refuses a file that changes during read (%s)', async change => {
    const dir = work();
    const path = join(dir, 'artifact/public/changing.bin');
    writeFileSync(path, Buffer.alloc(1025, 0x61));
    fs.utimesSync(path, 1000000000, 1000000000);
    const originalOpen = fs.openSync;
    const originalRead = fs.readSync;
    let target;
    let changed = false;
    const open = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (file === path) target = fd;
      return fd;
    });
    // Node's readFileSync uses fs.readSync for binary reads. Split the first real read, then change its source.
    const read = vi.spyOn(fs, 'readSync').mockImplementation((fd, buffer, offset, length, position) => {
      if (fd === target && !changed) {
        const count = originalRead(fd, buffer, offset, Math.min(length, 128), position);
        if (change === 'grow') fs.appendFileSync(path, Buffer.alloc(512, 0x62));
        else if (change === 'shrink') fs.truncateSync(path, 513);
        else if (change === 'rewrite') {
          writeFileSync(path, Buffer.alloc(1025, 0x62));
          // Restoring mtime must still fail on ctime.
          fs.utimesSync(path, 1000000000, 1000000000);
        } else {
          const replacement = `${path}.replacement`;
          if (change === 'symlink') symlinkSync('index.html', replacement);
          else writeFileSync(replacement, Buffer.alloc(1025, 0x62));
          fs.renameSync(replacement, path);
        }
        changed = true;
        return count;
      }
      return originalRead(fd, buffer, offset, length, position);
    });
    syncBuiltinESMExports();
    const output = join(dir, 'changing.tar.gz');
    try {
      const result = await pack(dir, output).catch(error => error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toMatch(/file changed.*while packing/);
      expect(result.message).toContain(path);
      expect(changed).toBe(true);
      const opens = open.mock.calls.filter(([file]) => file === path && typeof file === 'string');
      const readOpens = opens.filter(([, flags]) => typeof flags === 'number');
      expect(readOpens).toHaveLength(1);
      expect(readOpens[0][1] & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    } finally {
      open.mockRestore();
      read.mockRestore();
      syncBuiltinESMExports();
    }
    // A failed pack cannot be accepted for upload as a complete archive.
    if (existsSync(output)) expect(() => checkPack(output, dir)).toThrow();
  });

  it('M2 refuses a file changed to a link just before open without following it', async () => {
    const dir = work(), path = join(dir, 'artifact/public/index.html');
    const original = fs.openSync;
    let openError, followed = false;
    const open = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (file === path) {
        symlinkSync('../../install.sh', `${path}.link`);
        fs.renameSync(`${path}.link`, path);
      }
      try {
        const fd = original(file, ...args);
        if (file === path) followed = true;
        return fd;
      } catch (error) {
        if (file === path) openError = error;
        throw error;
      }
    });
    syncBuiltinESMExports();
    try {
      const result = await pack(dir, join(dir, 'link.tar.gz')).catch(error => error);
      expect(result.message).toContain(path);
      expect(followed).toBe(false);
      expect(openError?.code).toBe('ELOOP');
      expect(result.cause).toBe(openError);
    } finally {
      open.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each(['artifact', 'artifact/public'])('af3 refuses %s replaced by a link after listing', async name => {
    const dir = work(), path = join(dir, name), original = fs.openSync;
    let replaced = false;
    const open = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (!replaced && file === join(dir, 'artifact/public/index.html')) {
        fs.renameSync(path, `${dir}/saved-directory`);
        symlinkSync(`${dir}/saved-directory`, path);
        replaced = true;
      }
      return original(file, ...args);
    });
    syncBuiltinESMExports();
    try {
      await expect(pack(dir, join(dir, 'directory-link.tar.gz'))).rejects.toThrow(/symlinks refused/);
      expect(replaced).toBe(true);
    } finally {
      open.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each(['artifact/public/index.html', 'install.sh'])('af3 refuses %s replaced between listing and read', async name => {
    const dir = work(), path = join(dir, name), original = fs.lstatSync;
    let replaced = false, seen = 0;
    const stat = vi.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
      const result = original(file, ...args);
      // install.sh also has a required-input check before the listing.
      if (file === path && ++seen === (name === 'install.sh' ? 2 : 1)) {
        writeFileSync(`${path}.next`, 'replacement');
        fs.renameSync(`${path}.next`, path);
        replaced = true;
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      await expect(pack(dir, join(dir, 'replaced.tar.gz'))).rejects.toThrow(/file changed.*while packing/);
      expect(replaced).toBe(true);
    } finally {
      stat.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
