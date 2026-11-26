#!/usr/bin/env node
// Checks the app tarball before upload with its own ustar reader: macOS tar hides AppleDouble ._ members when it
// lists an archive, and GNU tar on the droplet extracts them as files the installer's inventory refuses. The archive
// must hold exactly the work directory's regular files: no ._ members, no extended-attribute records, no links.
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

// The pax keys a plain file archive may carry; xattr, ACL and flag records (LIBARCHIVE.*, SCHILY.*) are refused, and so
// is size: an artifact never needs it, and an override the reader did not apply would shift every later header.
const PAX_KEYS = new Set(['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname']);

const text = (block, start, length) => {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? length : end).toString('utf8');
};

const octal = (block, start, length) => {
  if (block[start] & 0x80) throw new Error('base-256 tar numbers refused');
  const value = text(block, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('invalid tar number');
  return Number.parseInt(value, 8);
};

function paxRecords(data) {
  const records = [];
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    const length = Number.parseInt(data.subarray(at, space).toString('ascii'), 10);
    if (space < 0 || !Number.isSafeInteger(length) || length <= space - at || at + length > data.length) throw new Error('invalid pax record');
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals < 1 || data[at + length - 1] !== 0x0a) throw new Error('invalid pax record');
    records.push([record.slice(0, equals), record.slice(equals + 1)]);
    at += length;
  }
  return records;
}

/** Lists a gzipped tar's members as { name, type: 'file' | 'dir' }, refusing anything a plain file archive lacks. */
export function tarMembers(gzip) {
  const tar = gunzipSync(gzip);
  const members = [];
  // One pending name extension at most (a pax path or a GNU long name): extractors differ on which of two wins.
  let path;
  for (let offset = 0; ;) {
    if (offset + 512 > tar.length) throw new Error('tar archive has no end marker');
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i];
    if (octal(block, 148, 8) !== sum) throw new Error('tar header checksum mismatch');
    const size = octal(block, 124, 12);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    if (data.length !== size) throw new Error('truncated tar member');
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(block[156]);
    if (type === 'x' || type === 'L') {
      if (path !== undefined) throw new Error('repeated or mixed tar name extensions refused');
      if (type === 'L') path = text(data, 0, data.length);
      for (const [key, value] of type === 'x' ? paxRecords(data) : []) {
        if (!PAX_KEYS.has(key)) throw new Error(`tar extended record ${key.slice(0, 40)} refused`);
        if (key === 'path') {
          if (path !== undefined) throw new Error('repeated tar path records refused');
          path = value;
        }
      }
      // A pax header without a path still precedes its member; mark it so a second extension is refused.
      path ??= null;
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '5') throw new Error('only regular files and directories are allowed in the app tarball');
    if (type === '5' && size !== 0) throw new Error('tar directory with a payload refused');
    const prefix = text(block, 257, 6) === 'ustar' ? text(block, 345, 155) : '';
    const name = (path ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100))).replace(/^\.\//, '');
    path = undefined;
    // Extractors treat any name ending in / as a directory, so only directory members may carry the slash.
    if (type !== '5' && name.endsWith('/')) throw new Error('tar file member named as a directory refused');
    members.push({ name: type === '5' ? name.replace(/\/$/, '') : name, type: type === '5' ? 'dir' : 'file' });
  }
  if (path !== undefined) throw new Error('tar header without a member');
  return members;
}

function workFiles(work) {
  const files = ['install.sh'];
  const dirs = new Set(['artifact']);
  const walk = (relative) => {
    if (!lstatSync(join(work, relative)).isDirectory()) throw new Error(`${relative}: expected directory; symlinks refused`);
    for (const entry of readdirSync(join(work, relative))) {
      const child = `${relative}/${entry}`;
      const stat = lstatSync(join(work, child));
      if (stat.isDirectory()) {
        dirs.add(child);
        walk(child);
      } else if (stat.isFile()) files.push(child);
      else throw new Error('non-regular files and symlinks refused');
    }
  };
  walk('artifact');
  if (!lstatSync(join(work, 'install.sh')).isFile()) throw new Error('install.sh must be a regular file');
  return { files: files.sort(), dirs };
}

/** Requires the tarball's file members to equal the work directory's artifact files plus install.sh. */
export function checkPack(tarball, work) {
  const members = tarMembers(readFileSync(tarball));
  const expected = workFiles(work);
  for (const { name } of members) {
    const parts = name.split('/');
    if (!name || name.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) throw new Error('unsafe tar member name');
    if (parts.at(-1).startsWith('._')) throw new Error('AppleDouble ._ member in the app tarball; remove AppleDouble ._ files from the source and repack with infra/server/app/pack.sh');
  }
  for (const { name, type } of members) if (type === 'dir' && !expected.dirs.has(name)) throw new Error('unexpected directory in the app tarball');
  const files = members.filter((member) => member.type === 'file').map((member) => member.name).sort();
  if (files.length !== expected.files.length || files.some((name, i) => name !== expected.files[i])) throw new Error('app tarball files differ from the checked artifact');
  return files.length;
}

const isEntry = () => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
};

if (isEntry()) {
  const [tarball, work] = process.argv.slice(2);
  try {
    if (!tarball || !work || process.argv.length !== 4) throw new Error('usage: check-pack.mjs <tarball> <work directory>');
    process.stdout.write(`app-pack: ${checkPack(tarball, work)} files, no metadata members\n`);
  } catch (error) {
    process.stderr.write(`app-pack: ${error.message}\n`);
    process.exit(1);
  }
}
