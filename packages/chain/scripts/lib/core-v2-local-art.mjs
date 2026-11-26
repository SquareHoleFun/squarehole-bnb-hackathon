import '../register-ts.mjs';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ROOT, localOptions } from './core-v2-local-runtime.mjs';
import { ART_FILE, ART_SHA256, checkArtBytes, loadExampleArt } from './core-v2-local-example-art.mjs';

export { resetExampleArt } from './core-v2-local-example-art.mjs';

const { rawCid } = await import('../../../indexer/src/core/core-math.ts');
const ART_DIR = join(ROOT, 'packages/chain/scripts/local-art');

/** Validate once, before opening a socket. Only catalogued PNGs enter the immutable in-memory serving map. */
export function loadLocalArt({ readBytes = readFileSync } = {}) {
  const catalog = JSON.parse(readFileSync(join(ART_DIR, 'catalog.json'), 'utf8'));
  if (catalog.schema !== 'sh.local-art.v1') throw new Error('unknown local art catalog');
  const files = new Map();
  for (const box of Object.values(catalog.boxes)) {
    for (const role of ['logo', 'cover', 'banner']) {
      const entry = box[role];
      if (!entry) continue;
      if (!ART_FILE.test(entry.file) || !ART_SHA256.test(entry.sha256)) {
        throw new Error('invalid local art file or hash');
      }
      const bytes = checkArtBytes(Buffer.from(readBytes(join(ART_DIR, entry.file))), entry.sha256, entry.file);
      files.set(`/ipfs/${rawCid(entry.sha256)}`, bytes);
    }
  }
  return { catalog, files };
}

/** The exact Request/Response boundary is exercised offline by the real indexer and cards hash verifiers. */
export function createLocalArtHandler({ files }) {
  return request => {
    const headers = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' };
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
    const url = new URL(request.url);
    if (url.search || url.hash) return new Response(null, { status: 404, headers });
    if (url.pathname === '/health') return new Response(request.method === 'HEAD' ? null : 'ok', { headers: { ...headers, 'cache-control': 'no-store' } });
    const bytes = files.get(url.pathname);
    if (!bytes) return new Response(null, { status: 404, headers });
    return new Response(request.method === 'HEAD' ? null : bytes, { headers: { ...headers,
      'content-type': 'image/png', 'content-length': String(bytes.length), 'cache-control': 'public, max-age=31536000, immutable' } });
  };
}

/**
 * The example stack's serving map (SH-V21-EXAMPLES-E2E-FIX2): the catalogue, then the pictures the example suite
 * wrote for the boxes it creates (core-v2-local-example-art.mjs). An unknown path re-reads that catalogue only when
 * the file changed; every entry passes the catalogue's checks again, and a refused catalogue adds nothing.
 */
export function exampleArtFiles(files, directory, { load = loadExampleArt, report = console.error } = {}) {
  let served = new Map();
  let version = null;
  const refresh = () => {
    let stat;
    try { stat = statSync(join(directory, 'catalog.json'), { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const next = `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    if (next === version) return;
    version = next;
    try { served = new Map([...load(directory)].map(([sha256, bytes]) => [`/ipfs/${rawCid(sha256)}`, bytes])); }
    catch (error) { report(`[examples-art] catalogue refused, nothing new is served: ${error.message}`); }
  };
  return { get(path) {
    const committed = files.get(path);
    if (committed) return committed;
    if (!served.has(path)) refresh();
    return served.get(path);
  } };
}

/**
 * Loopback only, with the same reserved/collision checks as the chain and site. The supervisor owns shutdown.
 * `exampleArt` (a directory) is given only by the example stack; without it only the catalogue is served.
 */
export async function startLocalArtGateway(ports, { serverFactory = createServer, art = loadLocalArt(), exampleArt = null } = {}) {
  localOptions({ SH_CORE_V2_CHAIN_PORT: String(ports.chainPort), DEV_PORT: String(ports.appPort),
    SH_CORE_V2_GATEWAY_PORT: String(ports.gatewayPort), SH_CORE_V2_ART_PORT: String(ports.artPort) });
  const handle = createLocalArtHandler(exampleArt === null ? art : { files: exampleArtFiles(art.files, exampleArt) });
  const server = serverFactory(async (req, res) => {
    try {
      // Never derive an upstream URL or disk path from Host, Origin or the request path.
      const response = handle(new Request(`http://127.0.0.1:${ports.artPort}${req.url}`, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(400, { 'cache-control': 'no-store' }); res.end();
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(ports.artPort, '127.0.0.1', () => { server.removeListener('error', reject); done(); });
  });
  return server;
}

/** Shared by all local processes; no public gateway fallback. Site consumption is a frontend-owner handoff. */
export function localArtEnvironment(ports) {
  const origin = `http://127.0.0.1:${ports.artPort}`;
  return { SH_CORE_ART_GATEWAYS: origin, SH_CARDS_ART_GATEWAYS: origin, SH_CORE_LOCAL_ART_GATEWAYS: origin };
}
