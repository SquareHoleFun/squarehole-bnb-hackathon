/**
 * The core service on a server before core v1 is deployed (infra/server): an `awaiting-broadcast` manifest makes it idle
 * on the gateway's address (200 /healthz, 503 "awaiting deploy" on /v1), a replaced file starts it without a restart, a
 * refused file keeps it idling with a 503 /healthz, and keyed RPC URLs stay out of the logs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CoreNotDeployedError, idleOptionsOf, loadCoreConfig } from '../../src/core/core-config';
import { idleUntilDeployed, startIdleGateway, type IdleGateway } from '../../src/core/idle';
import { redactConsole, redactUrl, urlRedactor } from '../../src/core/redact';

const AWAITING = JSON.stringify({ schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11155111, network: 'sepolia', note: 'placeholder' });
const DEPLOYED = readFileSync(fileURLToPath(new URL('../../../../apps/web/e2e/fixtures/core-local/manifest-11155111.json', import.meta.url)), 'utf8');
const ENV = { SH_CORE_MANIFEST: 'm.json', SH_CORE_HTTP_URLS: 'http://127.0.0.1:8562' };
// Built at run time: a 32-character stand-in for an Infura key, never a literal (gitleaks).
const KEY = 'c0ffee42'.repeat(4);

const get = async (base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null; headers: Headers }> => {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null, headers: res.headers };
};
const waitFor = async (check: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('core config before the broadcast', () => {
  it('refuses an awaiting manifest with CoreNotDeployedError (same words as before), and reads the idle options', () => {
    let thrown: unknown = null;
    try {
      loadCoreConfig(ENV, () => AWAITING);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoreNotDeployedError);
    expect((thrown as CoreNotDeployedError).message).toBe('Core v1 is not on Sepolia yet (the manifest is awaiting the broadcast): nothing to index');
    expect((thrown as CoreNotDeployedError).chainId).toBe(11155111);
    expect(idleOptionsOf(ENV)).toEqual({ port: 5394, host: '127.0.0.1', manifestPollMs: 15_000 });
    expect(idleOptionsOf({ ...ENV, SH_CORE_GATEWAY_HOST: '0.0.0.0', SH_CORE_MANIFEST_POLL_MS: '5000' })).toEqual({ port: 5394, host: '0.0.0.0', manifestPollMs: 5_000 });
    expect(() => idleOptionsOf({ ...ENV, SH_CORE_MANIFEST_POLL_MS: '10' })).toThrow();
    expect(() => idleOptionsOf({ SH_CORE_GATEWAY_PORT: '5394' })).toThrow();
  });
});

describe('core config on chain 1 (SH-188)', () => {
  it("refuses the committed mainnet file, which awaits the broadcast, and names Ethereum mainnet", () => {
    const committed = readFileSync(fileURLToPath(new URL('../../../contracts/deployments/core-v1/1.json', import.meta.url)), 'utf8');
    let thrown: unknown = null;
    try {
      loadCoreConfig(ENV, () => committed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CoreNotDeployedError);
    expect((thrown as CoreNotDeployedError).message).toBe('Core v1 is not on Ethereum mainnet yet (the manifest is awaiting the broadcast): nothing to index');
    expect((thrown as CoreNotDeployedError).chainId).toBe(1);
    expect((thrown as CoreNotDeployedError).network).toBe('mainnet');
  });
});

describe('the idle gateway', () => {
  let gateway: IdleGateway | null = null;
  afterEach(async () => {
    await gateway?.stop();
    gateway = null;
  });

  it('answers /healthz 200 while awaiting, 503 "awaiting deploy" on /v1, and is read-only', async () => {
    gateway = await startIdleGateway({ port: 0, host: '127.0.0.1', state: () => ({ state: 'awaiting-broadcast', chainId: 11155111, network: 'sepolia' }) });
    const base = `http://127.0.0.1:${gateway.address().port}`;
    const health = await get(base, '/healthz');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, state: 'awaiting-broadcast', chainId: 11155111, network: 'sepolia', following: false, asOf: null, history: null });
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
    const feed = await get(base, '/v1/feed?chain=11155111');
    expect(feed.status).toBe(503);
    expect(String(feed.body?.error)).toMatch(/^awaiting deploy: Core v1 is not on Sepolia yet/);
    expect(feed.headers.get('retry-after')).toBe('60');
    expect((await get(base, '/v1/boxes/11155111/0x0000000000000000000000000000000000000001')).status).toBe(503);
    expect((await get(base, '/elsewhere')).status).toBe(404);
    expect((await get(base, '/v1/feed', { method: 'POST' })).status).toBe(405);
    expect((await get(base, '/v1/feed', { method: 'OPTIONS' })).status).toBe(204);
  });

  it('answers /healthz 503 with the reason when the configuration is refused', async () => {
    gateway = await startIdleGateway({ port: 0, host: '127.0.0.1', state: () => ({ state: 'config-invalid', reason: 'Core v1 manifest rejected' }) });
    const health = await get(`http://127.0.0.1:${gateway.address().port}`, '/healthz');
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({ ok: false, state: 'config-invalid', reason: 'Core v1 manifest rejected' });
  });
});

describe('idleUntilDeployed', () => {
  it('returns a deployed configuration at once, without listening', async () => {
    let listened = false;
    const config = await idleUntilDeployed({ env: ENV, read: () => DEPLOYED, port: 0, host: '127.0.0.1', pollMs: 20, onListening: () => (listened = true) });
    expect(config?.manifest).toHaveProperty('releases.0.safes');
    expect(config?.manifest.status).toBe('deployed');
    expect(listened).toBe(false);
  });

  it('throws at the start on anything but awaiting or deployed (a broken file is not idled on)', async () => {
    await expect(idleUntilDeployed({ env: ENV, read: () => '{"schema":"nope"}', port: 0, host: '127.0.0.1', pollMs: 20 })).rejects.toThrow(/manifest rejected/);
  });

  it('idles on an awaiting manifest, keeps idling with 503 on a refused one, and starts once the file is deployed', async () => {
    let file = AWAITING;
    let base = '';
    const events: string[] = [];
    const done = idleUntilDeployed({ env: ENV, read: () => file, port: 0, host: '127.0.0.1', pollMs: 20, log: (event, fields) => events.push(`${event}:${String(fields?.state ?? '')}`), onListening: (a) => (base = `http://127.0.0.1:${a.port}`) });
    await waitFor(() => base !== '');
    expect((await get(base, '/healthz')).status).toBe(200);

    file = '{"schema":"squarehole.core-deployment/v1","status":"deployed"}';
    await waitFor(() => events.includes('core_idle:config-invalid'));
    const refused = await get(base, '/healthz');
    expect(refused.status).toBe(503);
    expect(String(refused.body?.reason)).toMatch(/manifest rejected/);

    file = DEPLOYED;
    const config = await done;
    expect(config?.manifest.status).toBe('deployed');
    expect(events).toEqual(['core_idle:awaiting-broadcast', 'core_idle:config-invalid', 'core_manifest_deployed:']);
    // The idle gateway is closed: the real gateway can take the port.
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });

  it('stops idling when the signal aborts (shutdown) and resolves null', async () => {
    const stop = new AbortController();
    let base = '';
    const done = idleUntilDeployed({ env: ENV, read: () => AWAITING, port: 0, host: '127.0.0.1', pollMs: 20, signal: stop.signal, onListening: (a) => (base = `http://127.0.0.1:${a.port}`) });
    await waitFor(() => base !== '');
    stop.abort();
    expect(await done).toBeNull();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });
});

describe('keyed RPC URLs stay out of the logs', () => {
  it('logs origins only and redacts URLs and key-like path segments in any text', () => {
    expect(redactUrl(`https://sepolia.infura.io/v3/${KEY}`)).toBe('https://sepolia.infura.io/…');
    expect(redactUrl('https://ethereum-sepolia-rpc.publicnode.com')).toBe('https://ethereum-sepolia-rpc.publicnode.com');
    expect(redactUrl('https://rpc.example/sep')).toBe('https://rpc.example/…');
    const redact = urlRedactor([`https://sepolia.infura.io/v3/${KEY}`, `wss://sepolia.infura.io/ws/v3/${KEY}`, 'https://ethereum-sepolia-rpc.publicnode.com']);
    const text = `HTTP request failed. URL: https://sepolia.infura.io/v3/${KEY} | [heads] wss://sepolia.infura.io/ws/v3/${KEY} closed | key ${KEY} | https://ethereum-sepolia-rpc.publicnode.com ok`;
    const out = redact(text);
    expect(out).not.toContain(KEY);
    expect(out).toBe('HTTP request failed. URL: https://sepolia.infura.io/… | [heads] wss://sepolia.infura.io/… closed | key … | https://ethereum-sepolia-rpc.publicnode.com ok');
  });

  it('passes console strings and errors through the redactor and can be undone', () => {
    const lines: unknown[][] = [];
    const sink = { log: (...a: unknown[]) => lines.push(a), info: (...a: unknown[]) => lines.push(a), warn: (...a: unknown[]) => lines.push(a), error: (...a: unknown[]) => lines.push(a), debug: (...a: unknown[]) => lines.push(a) };
    const restore = redactConsole(urlRedactor([`https://sepolia.infura.io/v3/${KEY}`]), sink);
    sink.warn(`[heads] poll failed: URL: https://sepolia.infura.io/v3/${KEY}`, 3);
    sink.error(new Error(`fetch https://sepolia.infura.io/v3/${KEY} failed`));
    restore();
    sink.log('after');
    expect(JSON.stringify(lines)).not.toContain(KEY);
    expect(lines[0]).toEqual(['[heads] poll failed: URL: https://sepolia.infura.io/…', 3]);
    expect(String(lines[1]?.[0])).toMatch(/^Error: fetch https:\/\/sepolia\.infura\.io\/… failed/);
    expect(lines[2]).toEqual(['after']);
  });
});
