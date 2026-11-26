import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, renameSync, statSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { rawCidV1 } from '../../../scripts/ipfs/pin-raw-lib.mjs';
import { createArtHandler } from '../ipfs/gateway.mjs';
import { createWithheldPictures } from '../../../packages/indexer/src/withheld/list.mjs';
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const cid = rawCidV1(`0x${createHash('sha256').update(png).digest('hex')}`);
const id = `ipfs:${cid}`;
const entry = { id, reason: 'illegal', since: '2026-10-28' };
const fixture = () => { mkdirSync('.cache/tmp', { recursive: true }); const dir = mkdtempSync(resolve('.cache/tmp/withheld-infra-')); return { dir, file: join(dir, 'pictures.json') }; };
it('W2: GET/HEAD 451 precedes Kubo, stays no-store, reloads changed/missing/broken files', async () => {
  const f = fixture(); let now = 0; const warn = vi.fn();
  const fetch = vi.fn(async () => new Response(png));
  const handler = createArtHandler({ fetch, withheld: createWithheldPictures({ file: f.file, now: () => now, warn }) });
  const send = async (method = 'GET') => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = Buffer.from(body ?? ''); } };
    await handler({ method, url: `/ipfs/${cid}`, headers: { 'if-none-match': '*', range: 'bytes=0-1' } }, res); return res;
  };
  const ok = await send(); expect(ok.status).toBe(200); expect(ok.body).toEqual(png);
  expect(ok.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  writeFileSync(f.file, JSON.stringify([entry])); now += 10_000;
  for (const method of ['GET', 'HEAD']) {
    const res = await send(method); expect(res.status).toBe(451);
    expect(res.headers).toMatchObject({ 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
    expect(res.body.toString()).toBe(method === 'HEAD' ? '' : 'Picture withheld.\n');
    expect(res.headers.ETag).toBeUndefined();
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  writeFileSync(f.file, '{'); now += 10_000; expect((await send()).status).toBe(451);
  now += 10_000; expect((await send()).status).toBe(451); expect(warn).toHaveBeenCalledTimes(1);
  renameSync(f.file, join(f.dir, 'broken.json')); now += 10_000;
  expect((await send()).status).toBe(200);
});
it('W2: listing during a pending block read prevents its successful response', async () => {
  const f = fixture(); let now = 0; let finish;
  const handler = createArtHandler({ fetch: () => new Promise(resolve => { finish = resolve; }), withheld: createWithheldPictures({ file: f.file, now: () => now }) });
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  const pending = handler({ method: 'GET', url: `/ipfs/${cid}` }, res);
  writeFileSync(f.file, JSON.stringify([entry])); now += 10_000; finish(new Response(png)); await pending;
  expect(res.status).toBe(451); expect(res.headers['Cache-Control']).toBe('no-store');
});
const run = (f, command, ...args) => spawnSync('sh', [`infra/server/withheld/${command}.sh`, ...args], { env: { ...process.env, SH_WITHHELD_FILE: f.file }, encoding: 'utf8' });
it('W5: add/remove validate, dry-run leaves no file, atomic replacements preserve old readers, no list output', () => {
  const f = fixture();
  const dry = run(f, 'add', '--dry-run', id, 'illegal'); expect(dry.status).toBe(0); expect(dry.stdout).toContain('Would add');
  expect(() => statSync(f.file)).toThrow();
  expect(run(f, 'add', id, 'illegal').status).toBe(0);
  const first = readFileSync(f.file, 'utf8'); const before = statSync(f.file); const fd = openSync(f.file, 'r');
  const ar = `ar:${'A'.repeat(43)}`;
  const added = run(f, 'add', ar, 'legal-notice'); expect(added.status).toBe(0); expect(added.stdout).not.toContain(id);
  expect(statSync(f.file).ino).not.toBe(before.ino); expect(readFileSync(fd, 'utf8')).toBe(first); closeSync(fd);
  const both = readFileSync(f.file, 'utf8'); expect(JSON.parse(both)).toHaveLength(2);
  expect(run(f, 'remove', '--dry-run', id).status).toBe(0); expect(readFileSync(f.file, 'utf8')).toBe(both);
  expect(run(f, 'remove', id).status).toBe(0); expect(JSON.parse(readFileSync(f.file, 'utf8')).map(e => e.id)).toEqual([ar]);
  expect(run(f, 'remove', ar).status).toBe(0); expect(JSON.parse(readFileSync(f.file, 'utf8'))).toEqual([]);
});
it('W5: invalid IDs/reasons and corrupt input never overwrite the list or leak its contents', () => {
  const f = fixture(); writeFileSync(f.file, JSON.stringify([entry])); const original = readFileSync(f.file, 'utf8');
  for (const bad of ['ar:short', `ar:${'!'.repeat(43)}`, `${id}/suffix`, `${id}?x`, 'ipfs:QmBad', id.toUpperCase()]) {
    for (const command of ['add', 'remove']) expect(run(f, command, bad, ...(command === 'add' ? ['illegal'] : [])).status).toBe(1);
  }
  expect(run(f, 'add', id, 'taste').status).toBe(1); expect(readFileSync(f.file, 'utf8')).toBe(original);
  writeFileSync(f.file, '{private notice');
  const res = run(f, 'add', id, 'illegal'); expect(res.status).toBe(1); expect(res.stderr).not.toContain('private notice');
  expect(readFileSync(f.file, 'utf8')).toBe('{private notice');
});
it('W1: all consumers mount the stable parent read-only; guard also mounts the shared reader', () => {
  const c = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))', 'infra/server/compose.yaml'], { encoding: 'utf8' }));
  for (const name of ['indexer', 'cards', 'ipfs-art']) {
    expect(c.services[name].volumes).toContainEqual(expect.objectContaining({ type: 'bind', source: '/srv/squarehole/withheld', target: '/srv/squarehole/withheld', read_only: true, bind: { create_host_path: false } }));
  }
  expect(c.services['ipfs-art'].volumes).toContain('../../packages/indexer/src/withheld:/app/packages/indexer/src/withheld:ro');
});
it('W5: restrictive operator umask still leaves the list readable to service UID 1000', () => {
  const f = fixture();
  const res = spawnSync('sh', ['-c', 'umask 077\nexec sh "$1" "$2" "$3"', 'withheld-test', 'infra/server/withheld/add.sh', id, 'illegal'], { env: { ...process.env, SH_WITHHELD_FILE: f.file }, encoding: 'utf8' });
  expect(res.status).toBe(0); expect(statSync(f.file).mode & 0o777).toBe(0o644);
});
it('W5: a held operator lock refuses concurrent updates without changing the list', () => {
  const f = fixture(); writeFileSync(f.file, JSON.stringify([entry])); writeFileSync(`${f.file}.lock`, 'another operator');
  const before = readFileSync(f.file, 'utf8'); expect(run(f, 'remove', id).status).toBe(1);
  expect(readFileSync(f.file, 'utf8')).toBe(before); expect(readFileSync(`${f.file}.lock`, 'utf8')).toBe('another operator');
});
it('W2: Caddy forwards the guard cache/status unchanged and routes the hash API through v2', () => {
  const caddy = readFileSync('infra/server/Caddyfile', 'utf8');
  const art = caddy.split('handle @ipfs_art {')[1].split('@ipfs_other')[0];
  expect(art).toContain('reverse_proxy kubo:8081'); expect(art).not.toMatch(/header.*(?:Cache-Control|Expires|ETag)/i);
  expect(caddy).toContain('@api path /healthz /v1 /v1/* /v2 /v2/*');
});
it('W-install: the installer makes the withheld folder before the stack starts, and never writes its list', () => {
  const install = readFileSync(resolve('infra/server/install.sh'), 'utf8');
  expect(install.match(/^install -d -m 0755 -o root -g root (.+)$/m)[1].split(' ')).toContain('"$base/withheld"');
  expect(install.indexOf('"$base/withheld"')).toBeLessThan(install.indexOf('systemctl start squarehole-stack.service'));
  expect(install).not.toMatch(/pictures\.json/);
});
