// @vitest-environment node
// @vitest-environment node
/** The box page the edge answers keeps the app's security headers (public/_headers does not apply to Functions). */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SITE_CSP_ORIGINS, securityHeadersFor, SPA_SECURITY_HEADERS } from './share-headers';
import { DEFAULT_CARD_ORIGIN, DEFAULT_INDEXER_ORIGIN } from './share-edge';
import { PICTURE_ORIGINS } from '../features/pictures/arweave-hosts';

const HEADERS_FILE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', '_headers'), 'utf8');

/** The `/*` block of a Cloudflare `_headers` file as name → value. */
function rootBlock(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inRoot = false;
  for (const line of file.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inRoot = line.trim() === '/*';
      continue;
    }
    if (!inRoot) continue;
    const at = line.indexOf(':');
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

describe('security headers on the box page', () => {
  it('equal public/_headers for every path', () => {
    expect(SPA_SECURITY_HEADERS).toEqual(rootBlock(HEADERS_FILE));
  });
  it('MF23-7: permits the configured API and art origins without network wildcards', () => {
    const policy = SPA_SECURITY_HEADERS['Content-Security-Policy'] ?? '';
    expect(SITE_CSP_ORIGINS.api).toContain(DEFAULT_INDEXER_ORIGIN);
    expect(SITE_CSP_ORIGINS.api).toContain(DEFAULT_CARD_ORIGIN);
    for (const origin of [...SITE_CSP_ORIGINS.api, ...SITE_CSP_ORIGINS.art]) expect(policy.split(/[; ]+/)).toContain(origin);
    expect(policy).not.toMatch(/\*|(?:^|[ ;])https?:[ ;]/);
    const configured = securityHeadersFor({ api: ['https://api.example'], art: ['https://node.example', 'https://picnic.example'], rpc: ['http://127.0.0.1:8562'] })['Content-Security-Policy'] ?? '';
    const directives = Object.fromEntries(configured.split('; ').map((part) => { const [name, ...sources] = part.split(' '); return [name, sources]; }));
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https://api.example', 'https://node.example', 'https://picnic.example']);
    expect(directives['connect-src']).toEqual(["'self'", 'https://api.example', 'https://node.example', 'https://picnic.example', 'http://127.0.0.1:8562']);
    expect(configured).not.toMatch(/\*|(?:^|[ ;])https?:[ ;]/);
  });
  it('SH-ARWEAVE-PICTURES-WEB: connect-src gets exactly Turbo\'s upload origin and the three Arweave gateways; img-src is unchanged', () => {
    expect(SITE_CSP_ORIGINS.pictures).toEqual(['https://upload.ardrive.io', 'https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net']);
    // The same four the pages use, and nothing else (pictures/arweave-hosts.ts).
    expect(SITE_CSP_ORIGINS.pictures).toEqual(PICTURE_ORIGINS);
    const policy = SPA_SECURITY_HEADERS['Content-Security-Policy'] ?? '';
    const directives = Object.fromEntries(policy.split('; ').map((part) => { const [name, ...sources] = part.split(' '); return [name, sources]; }));
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https://api.squarehole.fun']);
    expect(directives['connect-src']).toEqual(["'self'", 'https://api.squarehole.fun', 'https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co',
      'https://upload.ardrive.io', 'https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net']);
    // The reader asks `/raw/<id>` (no sandbox subdomain), so no wildcard host is ever needed.
    expect(policy).not.toMatch(/\*\.(?:arweave\.net|turbo-gateway\.com)/);
    // The Cloudflare Pages file carries the same policy.
    expect(HEADERS_FILE).toContain(`connect-src 'self' https://api.squarehole.fun https://ethereum-sepolia-rpc.publicnode.com https://sepolia.gateway.tenderly.co ${PICTURE_ORIGINS.join(' ')};`);
    const without = securityHeadersFor({ api: [], art: [], rpc: [] })['Content-Security-Policy'] ?? '';
    expect(without).toContain("connect-src 'self';");
    expect(() => securityHeadersFor({ api: [], art: [], rpc: [], pictures: ['https://*.arweave.net'] })).toThrow('CSP sources must be explicit origins');
  });
  it.each(['https:', 'https://*.example', 'http://localhost:*', 'https://user:secret@example', 'https://example/path', 'https://example?secret=value', "https://example; script-src *"])(
    'MF23-7: refuses a non-origin CSP source without echoing its value', (source) => {
      expect(() => securityHeadersFor({ api: [], art: [source], rpc: [] })).toThrow('CSP sources must be explicit origins');
    },
  );
});
