/** The card service's input checks: its routes (an untrusted URL), its configuration, the manifest file it re-reads. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { itemPngsOf, serviceConfig, serviceOrigin } from './config';
import { manifestFile } from './manifest';
import { CARD_CHAINS, routeOf } from './route';
import { Lru } from './cache';

const TOKEN = '0xbd0a48c997121b66299e558db15b282485495c4a';

describe('routes', () => {
  it('a card: Sepolia only, 0x + 40 hex (any case, lowercased), `.png` optional, `v` a short [0-9a-z-] word or nothing', () => {
    expect([...CARD_CHAINS.keys()]).toEqual(['11155111']);
    expect(routeOf(`/card/box/11155111/${TOKEN}.png?v=1-open`)).toEqual({ kind: 'card', chainId: 11_155_111, token: TOKEN, v: '1-open' });
    expect(routeOf(`/card/box/11155111/${TOKEN.toUpperCase().replace('0X', '0x')}?v=1-upcoming-1791734400&x=1`)).toEqual({ kind: 'card', chainId: 11_155_111, token: TOKEN, v: '1-upcoming-1791734400' });
    for (const v of ['', '1_open', '1-OPEN', '-1', 'a'.repeat(65), '1-open%00', '1-open/x']) {
      expect(routeOf(`/card/box/11155111/${TOKEN}.png?v=${v}`), v).toMatchObject({ kind: 'card', v: null });
    }
  });

  it('under /card/box/ but no box: invalid (the generic card); elsewhere: none (404); health', () => {
    for (const target of [
      `/card/box/1/${TOKEN}.png`,
      `/card/box/31337/${TOKEN}.png`,
      `/card/box/011155111/${TOKEN}.png`,
      `/card/box/11155111/${TOKEN.slice(0, 41)}.png`,
      `/card/box/11155111/${TOKEN}0.png`,
      `/card/box/11155111/${TOKEN}.PNG`,
      `/card/box/11155111/../${TOKEN}.png`,
      '/card/box/__proto__/constructor',
      '/card/box/',
    ]) {
      expect(routeOf(target).kind, target).toBe('invalid');
    }
    for (const target of ['/', '/card', '/card/', '/card/x', '//card/box', 'http://evil.example/card/healthz', `/card/box/${'1'.repeat(600)}`]) {
      expect(routeOf(target).kind, target).toBe('none');
    }
    expect(routeOf('/card/healthz')).toEqual({ kind: 'health' });
  });
});

describe('configuration', () => {
  it('defaults: 127.0.0.1:5395, native resvg, the keyless RPC list, no gateway, no disk, the repository\'s generic card and assets', () => {
    const config = serviceConfig({});
    expect(config).toMatchObject({ host: '127.0.0.1', port: 5395, engine: 'native', indexerOrigin: null, manifestPath: null, artGateways: [], cacheDir: null });
    expect(config.rpcUrls).toEqual(['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co']);
    expect(config.genericPath).toMatch(/apps\/web\/public\/share\/square-hole-1200x630\.jpg$/);
    expect(config.assetsDir).toMatch(/packages\/cards\/assets$/);
  });

  it('the server\'s settings, and refusals that stop the service from starting', () => {
    const config = serviceConfig({ SH_CARDS_HOST: '0.0.0.0', SH_CARDS_PORT: '5395', SH_CARDS_INDEXER_ORIGIN: 'http://indexer:5394', SH_CARDS_MANIFEST: '/manifests/11155111.json', SH_CARDS_CACHE_DIR: '/cache', SH_CARDS_ART_GATEWAYS: 'https://a.example, https://b.example' });
    expect(config).toMatchObject({ host: '0.0.0.0', indexerOrigin: 'http://indexer:5394', manifestPath: '/manifests/11155111.json', cacheDir: '/cache', artGateways: ['https://a.example', 'https://b.example'] });
    expect(serviceOrigin('none')).toBeNull();
    for (const env of [
      { SH_CARDS_PORT: '0' },
      { SH_CARDS_PORT: '70000' },
      { SH_CARDS_PORT: '53a' },
      { SH_CARDS_ENGINE: 'gpu' },
      { SH_CARDS_INDEXER_ORIGIN: 'http://indexer:5394/v1' },
      { SH_CARDS_INDEXER_ORIGIN: 'http://user:pass@indexer:5394' },
      { SH_CARDS_INDEXER_ORIGIN: 'ftp://indexer' },
      { SH_CARDS_ART_GATEWAYS: 'http://plain.example' },
      { SH_CARDS_ART_GATEWAYS: 'https://a.example/ipfs' },
      { SH_CARDS_LOCAL_RPC_URL: 'http://10.0.0.1:8545' },
    ]) {
      expect(() => serviceConfig(env), JSON.stringify(env)).toThrow();
    }
  });
});

describe('the manifest file', () => {
  it('read again once it changes (looked at every few seconds); missing: none; unparsable: invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-cards-manifest-'));
    try {
      const path = join(dir, '11155111.json');
      let now = 0;
      const read = manifestFile(path, 5000, () => now);
      expect(read()).toBeNull();
      writeFileSync(path, '{"status":"awaiting-broadcast"}');
      expect(read()).toBeNull();
      now += 5000;
      expect(read()).toEqual({ status: 'awaiting-broadcast' });
      writeFileSync(path, '{"status":"deployed","more":true}');
      now += 5000;
      expect(read()).toEqual({ status: 'deployed', more: true });
      writeFileSync(path, '{nope');
      now += 5000;
      expect(read()).toEqual({ invalid: true });
      expect(manifestFile(null)()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the memory cache', () => {
  it('bounded by entries and by bytes, least recently used out first, entries expire', () => {
    const lru = new Lru<string>(3, 10, (v) => v.length);
    lru.set('a', 'aaa', Infinity);
    lru.set('b', 'bbb', Infinity);
    lru.set('c', 'ccc', Infinity);
    expect(lru.get('a', 0)).toBe('aaa');
    lru.set('d', 'dd', Infinity);
    expect([lru.get('b', 0), lru.size, lru.totalBytes]).toEqual([undefined, 3, 8]);
    lru.set('e', 'eeeeeeeeeee', Infinity);
    expect(lru.get('e', 0)).toBeUndefined();
    lru.set('f', 'f', 10);
    expect([lru.get('f', 9), lru.get('f', 10)]).toEqual(['f', undefined]);
  });
});


it('MF23-4: the PNG manifest is runtime input; invalid content is refused without echoing it', () => {
  const image = `0x${'12'.repeat(32)}`;
  const png = `0x${'34'.repeat(32)}`;
  expect(itemPngsOf(JSON.stringify({ [image]: png }))).toEqual({ [image]: png });
  expect(() => itemPngsOf('private material')).toThrow('SH_CARDS_ITEM_PNG_MANIFEST must map image sha256 to PNG sha256');
  expect(serviceConfig({ SH_CARDS_ITEM_PNG_MANIFEST: 'item-pngs.json' }).itemPngManifestPath).toMatch(/item-pngs.json$/);
});
