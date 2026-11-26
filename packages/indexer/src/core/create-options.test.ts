import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseCreateOptions, CREATE_OPTIONS_MAX_BYTES } from '../../../chain/src/create-options/schema';
import { CreateOptions, CREATE_OPTIONS_DATA, readCreateOptionsFile } from './create-options';
import { CoreGateway, type CoreGatewaySource } from './core-gateway';
import { createCoreService } from './core-service';
import { createOptionsDirectoryOf } from './core-config';
import { writeLocalCreateOptions } from '../../../chain/scripts/lib/local-create-options.mjs';
import { parseCoreManifestV2 } from '../../../chain/src/core/v2/manifest-v2';
import { ClaimsGatewayV2 } from './v2/claims-gateway-v2';
import type { CoreReader } from './core-reader';
import { request, ResponseDouble } from '../../test/links/fixture';

const fixture = (name: string) => new URL(`../../../chain/src/create-options/fixtures/${name}.json`, import.meta.url);
const bytes = await readFile(fixture('empty'));
const parsed = parseCreateOptions(bytes.toString('utf8'));
if (!parsed.ok) throw new Error(parsed.reason);
const release = parsed.document;
const path = `/v2/create-options/${release.chainId}/${release.factory}.json`;
const source = { chainId: release.chainId } as CoreGatewaySource;
const gateway = (options: CreateOptions) => new ClaimsGatewayV2({ source, createOptions: options, host: '127.0.0.1', port: 0 }, {
  page: async () => { throw new Error('Create paths must never reach claims'); },
});
async function send(gw: CoreGateway, url = path, method = 'GET', conditional = false) {
  const res = new ResponseDouble(); const { req } = request(undefined, { url, method });
  if (conditional) Object.assign(req.headers, { 'if-none-match': '*', 'if-modified-since': 'Sun, 15 Nov 2099 00:00:00 GMT' });
  await gw.route(req, res.asResponse()); return res;
}
function uncached(res: ResponseDouble) {
  expect(res.headers['cache-control']).toBe('no-store');
  for (const header of ['etag', 'last-modified', 'expires', 'age']) expect(res.headers).not.toHaveProperty(header);
  expect(res.headers['access-control-allow-origin']).toBe('*');
  expect(res.headers['access-control-allow-headers']).toBe('If-None-Match');
}
async function files() {
  const root = await mkdtemp(join(tmpdir(), 'sh218-options-'));
  const directory = pathToFileURL(`${root}/`);
  await mkdir(join(root, String(release.chainId)));
  const file = new URL(`${release.chainId}/${release.factory}.json`, directory);
  return { directory, file };
}

describe('Local Create lists', () => {
  it.each([['unset', undefined], ['empty', '']] as const)('%s folder uses packaged data', (_name, value) => {
    expect(createOptionsDirectoryOf({ SH_CORE_CREATE_OPTIONS_DIR: value })).toEqual(CREATE_OPTIONS_DATA);
  });
  it('valid absolute folder is used, including spaces and URL punctuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sh218-folder-'));
    const directory = join(root, 'lists #1?'); await mkdir(directory);
    expect(createOptionsDirectoryOf({ SH_CORE_CREATE_OPTIONS_DIR: directory })).toEqual(pathToFileURL(`${directory}/`));
    expect(createOptionsDirectoryOf({ SH_CORE_CREATE_OPTIONS_DIR: `${directory}/` })).toEqual(pathToFileURL(`${directory}/`));
  });
  it('relative folder is refused even when it exists', () => {
    expect(() => createOptionsDirectoryOf({ SH_CORE_CREATE_OPTIONS_DIR: '.' })).toThrow(/SH_CORE_CREATE_OPTIONS_DIR.*absolute.*existing folder/);
  });
  it('missing folder is refused without packaged fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sh218-missing-'));
    expect(() => createOptionsDirectoryOf({ SH_CORE_CREATE_OPTIONS_DIR: join(root, 'missing') })).toThrow(/SH_CORE_CREATE_OPTIONS_DIR.*existing folder/);
  });
  it('a file is refused as a folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sh218-file-')); const file = join(root, 'file'); await writeFile(file, '');
    expect(() => createOptionsDirectoryOf({ SH_CORE_CREATE_OPTIONS_DIR: file })).toThrow(/SH_CORE_CREATE_OPTIONS_DIR.*existing folder/);
  });
  it('startup reads the folder once before listening and passes it to the service', async () => {
    const main = await readFile(new URL('./core-main.ts', import.meta.url), 'utf8');
    expect(main.match(/createOptionsDirectoryOf\(\)/g)).toHaveLength(1);
    expect(main.indexOf('const createOptionsDirectory = createOptionsDirectoryOf();')).toBeLessThan(main.indexOf('const idle = idleOptionsOf();'));
    expect(main).toMatch(/startCoreService\(\{\s*createOptionsDirectory,/);
  });

  async function localManifest(chainId = 11155111) {
    const root = await mkdtemp(join(tmpdir(), 'sh218-local-'));
    const live = parseCoreManifestV2(JSON.parse(await readFile(new URL('../../../contracts/deployments/core-v1/11155111.json', import.meta.url), 'utf8')));
    const original = live.releases[0];
    if (!original) throw new Error('fixture needs a release');
    const releases = ['ab', 'cd'].map(hex => ({ ...original,
      factory: { ...original.factory, address: `0x${hex.repeat(20)}` },
      registry: { ...original.registry, address: `0x${hex.repeat(20)}` }, versionCodeHash: `0x${hex.repeat(32)}`,
    }));
    const manifest = parseCoreManifestV2({ ...live, network: 'local', chainId, releases });
    const file = join(root, 'manifest.json'); await writeFile(file, JSON.stringify(manifest));
    const pins = manifest.releases.map(r => ({ chainId: manifest.chainId, factory: r.factory.address.toLowerCase(),
      registry: r.registry.address.toLowerCase(), versionCodeHash: r.versionCodeHash.toLowerCase() }));
    return { root, file, manifest, pins };
  }
  it.each([11155111, 31337])('helper files accept their own release pins and refuse every other release pin on chain %s', async chainId => {
    const { root, file, pins } = await localManifest(chainId);
    const directory = writeLocalCreateOptions(file);
    expect(directory).toBe(join(root, 'create-options'));
    for (const pin of pins) {
      const text = await readFile(join(directory, `${pin.chainId}`, `${pin.factory}.json`), 'utf8');
      expect(parseCreateOptions(text, pin)).toEqual({ ok: true, document: { schema: 1, ...pin, revision: 1, off: [] } });
      for (const field of ['chainId', 'factory', 'registry', 'versionCodeHash'] as const) {
        expect(parseCreateOptions(text, { ...pin, [field]: field === 'chainId' ? pin.chainId + 1 : release[field] }).ok, field).toBe(false);
      }
    }
  });
  it('helper refuses invalid manifest pins before writing a list', async () => {
    const { file, manifest } = await localManifest();
    await writeFile(file, JSON.stringify({ ...manifest, chainId: -1 }));
    expect(() => writeLocalCreateOptions(file)).toThrow(/local Create list refused: chainId/);
  });
  it.each([11155111, 31337])('local service serves helper bytes as 200, unknown release as 404 and removed file as 503 on chain %s', async chainId => {
    const { file, manifest, pins } = await localManifest(chainId);
    const directory = writeLocalCreateOptions(file);
    const env = { SH_CORE_CREATE_OPTIONS_DIR: directory };
    const service = createCoreService({ manifest, createOptionsDirectory: createOptionsDirectoryOf(env), reader: {} as CoreReader, host: '127.0.0.1', port: 0 });
    // Environment is consulted only at construction; requests use the chosen folder and re-read its files.
    env.SH_CORE_CREATE_OPTIONS_DIR = '/missing-after-startup';
    for (const pin of pins) {
      const path = `/v2/create-options/${pin.chainId}/${pin.factory}.json`;
      const file = join(directory, String(pin.chainId), `${pin.factory}.json`);
      const res = await send(service.gateway, path);
      expect(res.status).toBe(200); expect(Buffer.from(res.body)).toEqual(await readFile(file)); uncached(res);
      await unlink(file);
      const missing = await send(service.gateway, path); expect(missing.status).toBe(503); uncached(missing);
    }
    const unknown = await send(service.gateway, path); expect(unknown.status).toBe(404); uncached(unknown);
  });
});

describe('Create options gateway', () => {
  it('GET sends the exact validated file bytes and JSON/no-store/CORS headers', async () => {
    const res = await send(gateway(new CreateOptions([release])));
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body)).toEqual(await readFile(new URL(`${release.chainId}/${release.factory}.json`, CREATE_OPTIONS_DATA)));
    expect(res.headers['content-type']).toBe('application/json'); uncached(res);
  });
  it('HEAD validates and reads the same document, with the same headers and no body', async () => {
    const read = vi.fn(async () => bytes); const gw = gateway(new CreateOptions([release], CREATE_OPTIONS_DATA, read));
    const get = await send(gw); const head = await send(gw, path, 'HEAD');
    expect(head.status).toBe(get.status); expect(head.headers).toEqual(get.headers); expect(head.body).toBe('');
    expect(read).toHaveBeenCalledTimes(2); uncached(head);
  });
  it('ignores conditional caching headers and never sends 304', async () => {
    const res = await send(gateway(new CreateOptions([release])), path, 'GET', true);
    expect(res.status).toBe(200);
    expect(res.body).toBe(await readFile(new URL(`${release.chainId}/${release.factory}.json`, CREATE_OPTIONS_DATA), 'utf8'));
    uncached(res);
  });
  it('reads every request, including a changed revision and a failure after success', async () => {
    const { directory, file } = await files(); await writeFile(file, bytes);
    const gw = gateway(new CreateOptions([release], directory));
    expect((await send(gw)).status).toBe(200);
    const changed = await readFile(fixture('two-off')); await writeFile(file, changed);
    expect((await send(gw)).body).toBe(changed.toString('utf8'));
    await writeFile(file, '{'); expect((await send(gw)).status).toBe(503);
    await writeFile(file, bytes); expect((await send(gw)).status).toBe(200);
  });
  it('uses only installed manifest releases, normalized by the production source', async () => {
    const manifest = parseCoreManifestV2(JSON.parse(await readFile(new URL('../../../contracts/deployments/core-v1/11155111.json', import.meta.url), 'utf8')));
    // Construct production wiring without starting the service, listening, or making any chain/network call.
    const service = createCoreService({ manifest, reader: {} as CoreReader, host: '127.0.0.1', port: 0 });
    expect((await send(service.gateway)).status).toBe(200);
    const oldOnly = createCoreService({ manifest: { ...manifest, releases: [] }, reader: {} as CoreReader, host: '127.0.0.1', port: 0 });
    expect((await send(oldOnly.gateway)).status).toBe(404);
    expect((await send(new CoreGateway({ source, host: '127.0.0.1', port: 0 }))).status).toBe(404);
  });
  it.each([
    ['unknown chain', '1', release.factory], ['unknown factory', String(release.chainId), `0x${'11'.repeat(20)}`],
    ...['0', '011155111', '-1', '+11155111', '1.0', '1e7', 'abc', '11155111%2f..', '%31' + '1155111', '9007199254740992', '', '１１１５５１１１'].map(chain => ['chain', chain, release.factory]),
    ...[release.factory.toUpperCase(), release.factory.replace('fae', 'FAe'), release.factory.slice(0, -1), `${release.factory}0`, '0x' + 'g'.repeat(40),
      '%30x' + release.factory.slice(2), '..', '', `${release.factory}/other`, `${release.factory}%00`].map(factory => ['factory', String(release.chainId), factory]),
  ])('404 before any file read: %s %s %s', async (_label, chain, factory) => {
    const read = vi.fn(async () => bytes); const gw = gateway(new CreateOptions([release], CREATE_OPTIONS_DATA, read));
    const res = await send(gw, `/v2/create-options/${chain}/${factory}.json`);
    expect(res.status).toBe(404); expect(read).not.toHaveBeenCalled(); uncached(res);
  });
  it.each([`${path}?x=1`, `${path}#x`, `${path}/`, `${path}\n`, `${path}/../../healthz`, `${path}/../../../wallets/11155111/${release.factory}/claims`, path.replace('.json', '.JSON'), '/v2/create-options'])('404 for noncanonical path %s', async raw => {
    const read = vi.fn(async () => bytes); const res = await send(gateway(new CreateOptions([release], CREATE_OPTIONS_DATA, read)), raw);
    expect(res.status).toBe(404); expect(read).not.toHaveBeenCalled(); uncached(res);
  });
  it.each(['missing', 'unreadable', 'directory', 'oversized', 'malformed', 'invalid JSON', 'wrong release', 'bad UTF-8', 'BOM', 'repeated off', 'wrong registry', 'wrong hash', 'wrong chain'])('503 for %s; unrelated route unchanged', async problem => {
    const { directory, file } = await files();
    if (problem === 'directory') await mkdir(file);
    else if (problem !== 'missing') {
      const body = problem === 'oversized' ? await readFile(fixture('oversized')) : problem === 'malformed' ? await readFile(fixture('malformed'))
        : problem === 'wrong release' ? await readFile(fixture('other-release')) : problem === 'invalid JSON' ? Buffer.from('{')
          : problem === 'bad UTF-8' ? Buffer.from([0xff, 0xfe]) : problem === 'BOM' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
            : problem === 'repeated off' ? JSON.stringify({ ...release, off: [{ key: 'kind.token' }] }).replace(/}$/, ',"off":[]}')
              : problem === 'wrong registry' ? JSON.stringify({ ...release, registry: `0x${'11'.repeat(20)}` })
                : problem === 'wrong hash' ? JSON.stringify({ ...release, versionCodeHash: `0x${'11'.repeat(32)}` })
                  : problem === 'wrong chain' ? JSON.stringify({ ...release, chainId: 1 }) : bytes;
      await writeFile(file, body);
    }
    const read = problem === 'unreadable' ? async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } : readCreateOptionsFile;
    const gw = gateway(new CreateOptions([release], directory, read));
    const before = await send(gw, '/v2/withheld');
    const res = await send(gw);
    expect(res.status).toBe(503); expect(res.json()).toEqual({ error: 'create options unavailable' }); expect(res.body.length).toBeLessThan(100); uncached(res);
    const head = await send(gw, path, 'HEAD'); expect(head.status).toBe(503); expect(head.body).toBe(''); uncached(head);
    const after = await send(gw, '/v2/withheld');
    expect(after.status).toBe(before.status); expect(after.body).toBe(before.body); expect(after.headers).toEqual(before.headers);
  });
  it('bounds an injected reader too', async () => {
    const gw = gateway(new CreateOptions([release], CREATE_OPTIONS_DATA, async () => Buffer.alloc(CREATE_OPTIONS_MAX_BYTES + 1, ' ')));
    expect((await send(gw)).status).toBe(503);
  });
  it('HEAD of an unknown release is 404 with no body', async () => {
    const res = await send(gateway(new CreateOptions([])), path, 'HEAD');
    expect(res.status).toBe(404); expect(res.body).toBe(''); uncached(res);
  });
  it('keeps ordinary CORS OPTIONS and refuses writes', async () => {
    const read = vi.fn(async () => bytes); const gw = gateway(new CreateOptions([release], CREATE_OPTIONS_DATA, read));
    expect((await send(gw, path, 'OPTIONS')).headers).toEqual((await send(gw, '/v2/withheld', 'OPTIONS')).headers);
    expect((await send(gw, path, 'OPTIONS')).status).toBe(204);
    const res = await send(gw, path, 'POST'); expect(res.status).toBe(405); uncached(res);
    expect(read).not.toHaveBeenCalled();
  });
});
