import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { rawCidV1 } from '../../../scripts/ipfs/pin-raw-lib.mjs';
import { configOf, policyOf, renderSites } from '../app/config.mjs';
import { serviceConfig } from '../../../packages/cards/src/service/config.ts';

const read = (path) => readFileSync(path, 'utf8');
const base = '0a9d0e89f6592678a91f734423b4c0faeb9886f3';
const compose = () => JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))', 'infra/server/compose.yaml'], { encoding: 'utf8' }));
const digest = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const cidOf = (bytes) => rawCidV1(digest(bytes));
// Byte signatures only: this route identifies MIME; image decoding remains the consumer's job.
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const webp = Buffer.from('524946461000000057454250565038200400000000000000', 'hex');
const cid = cidOf(png);
const path = `/ipfs/${cid}`;
const immutable = 'public, max-age=31536000, immutable';

async function harness(fetch = vi.fn(async () => new Response(png))) {
  const { createArtHandler } = await import('../ipfs/gateway.mjs');
  const handler = createArtHandler({ fetch });
  const request = async (url = path, method = 'GET', headers = {}) => {
    const response = { status: 0, headers: {}, body: null,
      writeHead(status, values) { this.status = status; this.headers = values; },
      end(bytes = '') { this.body = Buffer.from(bytes); },
    };
    await handler({ url, method, headers }, response);
    return response;
  };
  return { request, fetch };
}

describe('SH-TA-25 isolated raw image gateway', () => {
  it('keeps Kubo and its guard on a Caddy-only internal network, with no published API or swarm', () => {
    const c = compose();
    expect(c.services.kubo, 'Kubo service is required').toBeDefined();
    expect(c.services.kubo.networks).toEqual(['art']);
    expect(c.networks.art).toEqual({ internal: true });
    expect(Object.entries(c.services).filter(([, s]) => s.networks?.includes('art')).map(([name]) => name).sort()).toEqual(['caddy', 'kubo']);
    expect(c.services['ipfs-art'].network_mode).toBe('service:kubo');
    expect(c.services.kubo.volumes).toContain('ipfs_data:/data/ipfs');
    for (const name of ['kubo', 'ipfs-art']) {
      expect(c.services[name].ports).toBeUndefined();
      expect(c.services[name].privileged).toBeUndefined();
      expect(c.services[name].cap_drop).toEqual(['ALL']);
      expect(c.services[name].security_opt).toContain('no-new-privileges:true');
      expect(c.services[name].read_only).toBe(true);
    }
    expect(c.services.kubo.entrypoint).toEqual(['/bin/sh', '/opt/ipfs/start.sh']);
    const start = read('infra/server/ipfs/start.sh');
    for (const setting of ['Addresses.API /ip4/127.0.0.1/tcp/5001', 'Addresses.Gateway /ip4/127.0.0.1/tcp/8080', 'Gateway.NoFetch true', 'Gateway.NoDNSLink true', "Addresses.Swarm '[]'", "Bootstrap '[]'"]) expect(start).toContain(setting);
    expect(start).toContain('daemon --offline --enable-gc=false --migrate=false');
    expect(c.services.kubo.image).toBe('ipfs/kubo:v0.43.1@sha256:b293923d66e490e70ced64df42ea7a6cf7eac2740e3fb29101df18070fa7be48');
    if (!c.services.kubo.image.includes('@sha256:')) expect(read('infra/server/compose.yaml')).toMatch(/TODO.*integrator.*digest/);
    expect(c.services['ipfs-art'].image).toMatch(/^node:24\.22\.1-trixie-slim@sha256:[a-f0-9]{64}$/);
  });

  it('admits canonical raw/sha2-256 CIDs at the API site only and explicitly refuses the rest of /ipfs', () => {
    const caddy = read('infra/server/Caddyfile');
    const gateway = caddy.split('(gateway) {')[1].split('\n}')[0];
    const match = gateway.match(/@ipfs_art \{([\s\S]*?)\n\t\}/)?.[1];
    expect(match, 'raw image route is required').toBeDefined();
    expect(match).toContain('method GET HEAD');
    expect(match).toContain('{http.request.orig_uri}');
    const regex = new RegExp(match.match(/path_regexp ipfs_raw (.+)/)[1].trim());
    expect(regex.test(path)).toBe(true);
    for (const invalid of ['/ipfs', '/ipfs/', `${path}/`, `${path}/x`, path.replace('bafkrei', 'bafybei'), `${path.slice(0, -1)}b`, path.toUpperCase()]) expect(regex.test(invalid), invalid).toBe(false);
    expect(gateway).toMatch(/handle @ipfs_art \{\s*reverse_proxy kubo:8081/);
    // Retain the original namespace even if Caddy cleans a path such as /ipfs/../v2/feed.
    expect(gateway).toContain("@ipfs_other expression `path('/ipfs', '/ipfs/*') || {http.request.orig_uri}.startsWith('/ipfs/')`");
    expect(gateway).toMatch(/handle @ipfs_other \{\s*header Cache-Control no-store\s*respond "not found" 404/);
    expect(gateway.indexOf('handle @ipfs_art')).toBeLessThan(gateway.indexOf('handle @ipfs_other'));
    expect(gateway).toContain('header_up -Authorization');
    expect(gateway).toContain('header_up -Cookie');
  });

  it('uses the existing origin-only consumer contracts to produce the requested public /ipfs URLs', () => {
    const indexer = read('infra/server/indexer.env').match(/^SH_CORE_ART_GATEWAYS=(.+)$/m)?.[1];
    const cards = read('infra/server/cards.env').match(/^SH_CARDS_ART_GATEWAYS=(.+)$/m)?.[1];
    expect(indexer).toBe('https://api.squarehole.fun');
    expect(cards).toBe(indexer);
    expect(serviceConfig({ SH_CARDS_ART_GATEWAYS: cards }).artGateways).toEqual([cards]);
    expect(`${indexer}/ipfs/${cid}`).toBe(`https://api.squarehole.fun${path}`);
  });

  it('preserves all non-API Caddy blocks and compares the rendered app site/CORS to the given base', async () => {
    const before = execFileSync('git', ['show', `${base}:infra/server/Caddyfile`], { encoding: 'utf8' });
    const after = read('infra/server/Caddyfile');
    const marker = '# Static landing (SH-LANDING-SERVER).';
    expect(after.slice(after.indexOf(marker))).toBe(before.slice(before.indexOf(marker)));
    // Everything before the gateway block except the file's leading comment, which later API work (SH-LINKS-SRV) updates.
    const head = (file) => file.slice(0, file.indexOf('(gateway) {')).replace(/^(#[^\n]*\n)+/, '');
    expect(head(after)).toBe(head(before));
    const oldModule = execFileSync('git', ['show', `${base}:infra/server/app/config.mjs`], { encoding: 'utf8' });
    const old = await import(`data:text/javascript;base64,${Buffer.from(oldModule).toString('base64')}`);
    const release = { ...configOf('', 'sepolia'), id: 'b'.repeat(64), headers: await policyOf(process.cwd()) };
    const oldHeaders = await old.policyOf(process.cwd());
    // SH-ARWEAVE-PICTURES-WEB: the one intended change since the base: Turbo's upload origin and the three Arweave
    // gateways appended to connect-src (box pictures; img-src unchanged).
    const expected = { ...oldHeaders, 'Content-Security-Policy': oldHeaders['Content-Security-Policy'].replace(/(connect-src [^;]*)/, '$1 https://upload.ardrive.io https://turbo-gateway.com https://arweave.net https://goldsky.arweave.net') };
    // SH-252: the second intended change: the examples' pictures kept a day (config.mjs EXAMPLES_ART_CACHE), one block
    // before the no-store rule for other files.
    const oldSites = old.renderSites({ ...release, ...old.configOf('', 'sepolia'), headers: expected });
    const examplesArt = "\t# SH-252: the examples' pictures never change within a release: kept a day in the browser, not fetched on every visit.\n"
      + '\t@examples_art {\n\t\tpath_regexp examples_art ^/examples/art/[A-Za-z0-9_.-]+$\n\t\tfile\n\t}\n'
      + '\thandle @examples_art {\n\t\theader Cache-Control "public, max-age=86400"\n\t\tfile_server\n\t}\n';
    const missing = '\t# Missing scripts/images';
    expect(oldSites.site.split(missing).length).toBe(2);
    expect(renderSites(release)).toEqual({ ...oldSites, site: oldSites.site.replace(missing, `${examplesArt}${missing}`) });
    expect(release.headers['Content-Security-Policy']).toContain('img-src \'self\' data: blob: https://api.squarehole.fun');
  });

  it.each([[png, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp']])('serves magic-byte MIME and exact committed bytes (%s)', async (bytes, type) => {
    const f = await harness(vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'bad=1' } })));
    const response = await f.request(`/ipfs/${cidOf(bytes)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
    expect(response.headers).toEqual({ 'Content-Type': type, 'Content-Length': String(bytes.length), 'Cache-Control': immutable, 'X-Content-Type-Options': 'nosniff' });
    const [url, options] = f.fetch.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:8080/ipfs/${cidOf(bytes)}?format=raw`);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/vnd.ipld.raw', 'Cache-Control': 'only-if-cached' } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('HEAD still checks full block, hash and MIME, sends the same headers and no body', async () => {
    const f = await harness();
    const get = await f.request();
    const head = await f.request(path, 'HEAD', { range: 'bytes=0-3', authorization: 'secret', cookie: 'secret', accept: 'text/html' });
    expect(head.status).toBe(200);
    expect(head.headers).toEqual(get.headers);
    expect(head.body.length).toBe(0);
    expect(f.fetch.mock.calls[1][1].headers).toEqual({ Accept: 'application/vnd.ipld.raw', 'Cache-Control': 'only-if-cached' });
  });

  it.each([300_000, 1_048_576])('serves a single %i-byte raw block across the UnixFS chunk boundary', async (length) => {
    const bytes = Buffer.alloc(length);
    png.copy(bytes);
    const f = await harness(vi.fn(async () => new Response(bytes)));
    const response = await f.request(`/ipfs/${cidOf(bytes)}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE'])('refuses %s without contacting Kubo', async (method) => {
    const f = await harness();
    expect((await f.request(path, method)).status).toBe(405);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(['/ipfs', '/ipfs/', '/ipns/example', '/api/v0/id', `${path}/`, `${path}/file.png`, `${path}?format=car`, `${path}?download=true`, `${path}?`, `${path}#x`, `${path}%00`, path.replace('bafkrei', 'bafybei'), path.toUpperCase(), path.replace('/ipfs/', '/ipfs/%62'), `/ipfs/../${cid}`, `https://host${path}`, `${path.slice(0, -1)}b`])('refuses malformed/alternate path %s without fetching', async (url) => {
    const f = await harness();
    const response = await f.request(url);
    expect(response.status).toBe(404);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('<?xml version="1.0"?><svg/>'), Buffer.from('<html>bad</html>'), Buffer.from('GIF89a'), Buffer.alloc(0), Buffer.from('RIFFxxxxWEBP'), png.subarray(0, 7)])('refuses unsupported content even when its hash matches', async (bytes) => {
    const f = await harness(vi.fn(async () => new Response(bytes)));
    const response = await f.request(`/ipfs/${cidOf(bytes)}`);
    expect(response.status).toBe(415);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.body.length).toBe(0);
  });

  it('rejects hash mismatches, including HEAD, and never exposes upstream errors or redirects', async () => {
    for (const method of ['GET', 'HEAD']) {
      const f = await harness(vi.fn(async () => new Response(jpeg)));
      expect((await f.request(path, method)).status).toBe(502);
    }
    for (const status of [301, 404, 500, 504, 206]) {
      const f = await harness(vi.fn(async () => new Response('private upstream details', { status, headers: { Location: 'https://public.invalid', 'Cache-Control': immutable } })));
      const response = await f.request();
      expect(response.status).toBe([404, 504].includes(status) ? 404 : 502);
      expect(response.body.length).toBe(0);
      expect(response.headers['Cache-Control']).toBe('no-store');
      expect(response.headers.Location).toBeUndefined();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds streamed bodies to 1 MiB, cancels oversize reads and handles transport failure', async () => {
    const cancel = vi.fn();
    const f = await harness(vi.fn(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(600_000)); }, cancel }))));
    expect((await f.request()).status).toBe(502);
    expect(cancel).toHaveBeenCalled();
    const broken = await harness(vi.fn(async () => { throw new Error('private failure'); }));
    expect((await broken.request()).status).toBe(502);
  });

  it('cancels a stalled body on the 2.5-second deadline', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const cancel = vi.fn();
    try {
      const f = await harness(vi.fn(async () => new Response(new ReadableStream({ cancel }))));
      const pending = f.request();
      await new Promise((resolve) => setImmediate(resolve));
      expect(timeout).toHaveBeenCalledWith(2500);
      controller.abort();
      expect((await pending).status).toBe(502);
      expect(cancel).toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });

  it('limits concurrent block reads and frees capacity after completion', async () => {
    const releases = [];
    const f = await harness(vi.fn(() => new Promise((resolve) => releases.push(resolve))));
    const pending = Array.from({ length: 16 }, () => f.request());
    expect((await f.request()).status).toBe(503);
    expect(f.fetch).toHaveBeenCalledTimes(16);
    for (const release of releases) release(new Response(png));
    expect((await Promise.all(pending)).every((response) => response.status === 200)).toBe(true);
    const retry = f.request();
    releases[16](new Response(png));
    expect((await retry).status).toBe(200);
  });
});
