/**
 * The core gateway's stream limits (server review, 2026-10-04): a global cap (503) and a cap per client (429), so one
 * address cannot hold every stream slot. The client is the peer, or the last X-Forwarded-For entry when the peer is a
 * trusted proxy (Caddy on the server); an IPv6 client counts by its /64.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { clientKey, clientOf, trustedProxyList } from '../../src/core/client-key';
import { loadCoreConfig } from '../../src/core/core-config';
import { CoreGateway, type CoreGatewayOptions, type CoreGatewaySource } from '../../src/core/core-gateway';
import type { CoreBoxView } from '../../src/core/core-views';

const TOKEN = `0x${'ab'.repeat(20)}`;
const VIEW = { schema: 'sh.core-box.v1', asOf: { block: '7', hash: `0x${'0'.repeat(64)}`, tier: 'latest' } } as unknown as CoreBoxView;
const SOURCE: CoreGatewaySource = {
  chainId: 11155111,
  feed: () => ({ asOf: null }) as never,
  box: (token) => (token === TOKEN ? VIEW : null),
  activity: () => Promise.resolve(null),
  candles: () => Promise.resolve(null),
  wallet: () => Promise.reject(new Error('unused')),
  health: () => ({ following: true, reason: null, history: null }),
  subscribe: () => () => undefined,
};

const DEPLOYED = readFileSync(fileURLToPath(new URL('../../../../apps/web/e2e/fixtures/core-local/manifest-11155111.json', import.meta.url)), 'utf8');
const ENV = { SH_CORE_MANIFEST: 'm.json', SH_CORE_HTTP_URLS: 'http://127.0.0.1:8562' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('who a request counts against', () => {
  it('an IPv4 address as is (also IPv4-mapped), an IPv6 address by its /64', () => {
    expect(clientKey('198.51.100.7')).toBe('198.51.100.7');
    expect(clientKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(clientKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:DB8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:3::9')).toBe('2001:db8:1:3::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('64:ff9b::198.51.100.7')).toBe('64:ff9b:0:0::/64');
    expect(clientKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('trusted proxies are addresses or CIDRs; anything else is refused', () => {
    expect(trustedProxyList([])).toBeNull();
    const list = trustedProxyList(['127.0.0.1', '172.16.0.0/12', 'fd00::/8']);
    expect(list?.check('172.18.0.3', 'ipv4')).toBe(true);
    expect(list?.check('192.168.1.1', 'ipv4')).toBe(false);
    expect(list?.check('fd12::1', 'ipv6')).toBe(true);
    for (const bad of ['caddy', '172.16.0.0/33', '172.16.0.0/12/1', '10.0.0.0/x', '::/129', '']) expect(() => trustedProxyList([bad])).toThrow();
  });

  it('the peer, unless it is a trusted proxy: then the last X-Forwarded-For entry (the one the proxy set)', () => {
    const proxies = trustedProxyList(['172.16.0.0/12']);
    expect(clientOf('203.0.113.9', '198.51.100.1', proxies)).toBe('203.0.113.9');
    expect(clientOf('203.0.113.9', '198.51.100.1', null)).toBe('203.0.113.9');
    expect(clientOf('172.18.0.3', '198.51.100.1', proxies)).toBe('198.51.100.1');
    expect(clientOf('::ffff:172.18.0.3', '1.2.3.4, 198.51.100.1', proxies)).toBe('198.51.100.1');
    expect(clientOf('172.18.0.3', ['1.2.3.4', '2001:db8:5:6::1'], proxies)).toBe('2001:db8:5:6::/64');
    expect(clientOf('172.18.0.3', 'not-an-ip', proxies)).toBe('172.18.0.3');
    expect(clientOf('172.18.0.3', undefined, proxies)).toBe('172.18.0.3');
  });

  it('SH_CORE_MAX_STREAMS_PER_CLIENT (default 8) and SH_CORE_TRUSTED_PROXIES (default none) are read and checked', () => {
    const plain = loadCoreConfig(ENV, () => DEPLOYED);
    expect(plain.manifest).toHaveProperty('releases.0.safes');
    expect(plain.maxStreamsPerClient).toBe(8);
    expect(plain.trustedProxies).toEqual([]);
    const set = loadCoreConfig({ ...ENV, SH_CORE_MAX_STREAMS_PER_CLIENT: '4', SH_CORE_TRUSTED_PROXIES: '172.16.0.0/12, 192.168.0.0/16' }, () => DEPLOYED);
    expect(set.maxStreamsPerClient).toBe(4);
    expect(set.trustedProxies).toEqual(['172.16.0.0/12', '192.168.0.0/16']);
    expect(() => loadCoreConfig({ ...ENV, SH_CORE_TRUSTED_PROXIES: 'caddy' }, () => DEPLOYED)).toThrow(/not an address or CIDR/);
    expect(() => loadCoreConfig({ ...ENV, SH_CORE_MAX_STREAMS_PER_CLIENT: '0' }, () => DEPLOYED)).toThrow();
  });
});

describe('the gateway caps streams', () => {
  const gateways: CoreGateway[] = [];
  const controllers: AbortController[] = [];
  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    for (const gateway of gateways.splice(0)) await gateway.stop();
  });

  const start = async (options: Partial<CoreGatewayOptions>): Promise<{ open: (headers?: Record<string, string>) => Promise<{ status: number; retryAfter: string | null; close: () => void }> }> => {
    const gateway = new CoreGateway({ source: SOURCE, port: 0, host: '127.0.0.1', ...options });
    await gateway.start();
    gateways.push(gateway);
    const url = `http://127.0.0.1:${gateway.address().port}/v1/boxes/11155111/${TOKEN}/stream`;
    return {
      open: async (headers = {}) => {
        const controller = new AbortController();
        controllers.push(controller);
        const res = await fetch(url, { headers, signal: controller.signal });
        if (res.status !== 200) await res.text();
        return { status: res.status, retryAfter: res.headers.get('retry-after'), close: () => controller.abort() };
      },
    };
  };

  it('per client: the next stream from the same address is 429 with Retry-After while the others stay open; a closed one frees its slot', async () => {
    const { open } = await start({ maxStreamsPerClient: 2 });
    const a = await open();
    const b = await open();
    expect([a.status, b.status]).toEqual([200, 200]);
    await sleep(150); // the two stay counted while open
    const c = await open();
    expect(c.status).toBe(429);
    expect(c.retryAfter).toBe('30');
    a.close();
    let d = await open();
    for (let i = 0; d.status !== 200 && i < 50; i += 1) {
      await sleep(20);
      d = await open();
    }
    expect(d.status).toBe(200);
    expect((await open()).status).toBe(429);
  });

  it('X-Forwarded-For is believed only from a trusted proxy, and only its last entry counts', async () => {
    const direct = await start({ maxStreamsPerClient: 2 });
    const spoofed = [];
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) spoofed.push((await direct.open({ 'X-Forwarded-For': ip })).status);
    expect(spoofed).toEqual([200, 200, 429]); // all three are 127.0.0.1

    const proxied = await start({ maxStreamsPerClient: 2, trustedProxies: ['127.0.0.1'] });
    const statuses = [];
    for (const xff of ['198.51.100.1', '203.0.113.1, 198.51.100.1', '198.51.100.2', '203.0.113.2, 198.51.100.1']) statuses.push((await proxied.open({ 'X-Forwarded-For': xff })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    // One IPv6 /64 is one client.
    const v6 = [];
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:ffff::3', '2001:db8:1:3::1']) v6.push((await proxied.open({ 'X-Forwarded-For': ip })).status);
    expect(v6).toEqual([200, 200, 429, 200]);
  });

  it('the global cap still holds (503) across many clients', async () => {
    const { open } = await start({ maxStreams: 3, maxStreamsPerClient: 100, trustedProxies: ['127.0.0.1'] });
    const statuses = [];
    for (let i = 1; i <= 4; i += 1) statuses.push((await open({ 'X-Forwarded-For': `198.51.100.${i}` })).status);
    expect(statuses).toEqual([200, 200, 200, 503]);
  });
});
