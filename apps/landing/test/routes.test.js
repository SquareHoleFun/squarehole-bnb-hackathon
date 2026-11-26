import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const routes = JSON.parse(readFileSync(join(PUBLIC, '_routes.json'), 'utf8'));
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? files(join(dir, entry.name)) : [`/${relative(PUBLIC, join(dir, entry.name)).split('\\').join('/')}`]);
const excluded = (path) => routes.exclude.some((rule) => rule.endsWith('/*') ? path.startsWith(rule.slice(0, -1)) : path === rule);

// Every Functions request counts toward the Workers Free plan's 100,000 a day; static files are free and unlimited.
// The Sepolia test NFTs' fixed baseURI points at this project (squarehole-7ua.pages.dev/nft/...), so crawlers must
// never reach the middleware there (2026-10-12: the daily limit was exceeded).
describe('_routes.json keeps the middleware off static files and crawler paths', () => {
  it('is a valid version 1 file within Cloudflare limits', () => {
    expect(routes.version).toBe(1);
    expect(routes.include.length + routes.exclude.length).toBeLessThanOrEqual(100);
    for (const rule of [...routes.include, ...routes.exclude]) {
      expect(rule.startsWith('/')).toBe(true);
      expect(rule.length).toBeLessThanOrEqual(100);
    }
  });

  it('still runs the host redirect for pages', () => {
    expect(routes.include).toContain('/*');
    for (const page of ['/', '/index.html', '/404.html']) expect(excluded(page)).toBe(false);
  });

  it('serves the old NFT metadata paths and every static asset without a Function', () => {
    expect(excluded('/nft/the-misfits/1.json')).toBe(true);
    expect(excluded('/nft/orchard/images/orchard-tree-blossom.webp')).toBe(true);
    const assets = files(PUBLIC).filter((path) => !/\.html$/.test(path) && !['/_headers', '/_routes.json'].includes(path));
    expect(assets.filter((path) => !excluded(path))).toEqual([]);
  });
});
