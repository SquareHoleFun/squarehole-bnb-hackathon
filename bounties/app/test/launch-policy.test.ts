import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * SH-280: the launch page's content policy in the stack (hackathon/stack/Caddyfile) by the alpha's switch: with
 * SH_BNB_ALPHA 0 (or unset) byte for byte the policy of the live release b8fbcef9; with 1 the same plus exactly what the
 * made wallet needs, as the platform's policy adds it.
 */
const caddy = readFileSync(new URL('../../../hackathon/stack/Caddyfile', import.meta.url), 'utf8');
const PICTURES = ['https://upload.ardrive.io', 'https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net'];
// SH-294: the live release's line plus the platform's four picture origins (connect-src) and blob: pictures (img-src).
const TODAY = `	header @launch Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self' https://bsc-testnet-rpc.publicnode.com https://bsc-testnet-dataseed.bnbchain.org ${PICTURES.join(' ')}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"`;
const snippet = (name: string) => new RegExp(`\\(${name}\\) \\{\\n(.*)\\n\\}`).exec(caddy)?.[1];
const directives = (line: string) => Object.fromEntries(/"(.*)"/.exec(line)![1]!.split('; ').map((d) => { const [k, ...v] = d.split(' '); return [k, v]; }));

describe('the launch page’s policy by SH_BNB_ALPHA', () => {
  it('the site imports the snippet by the switch, 0 when unset, and sets the policy nowhere else', () => {
    expect(caddy).toContain('\timport launch_csp_{$SH_BNB_ALPHA:0}\n');
    expect(caddy.split('header @launch Content-Security-Policy').length - 1).toBe(2);
  });
  it('0: today’s line, byte for byte', () => {
    expect(snippet('launch_csp_0')).toBe(TODAY);
  });
  it('1: today’s plus Privy’s origins, its frame, the profile’s second endpoint and inline styles, nothing else', () => {
    const on = directives(snippet('launch_csp_1')!);
    const off = directives(TODAY);
    const offBase = (off['connect-src'] as string[]).filter((o: string) => !PICTURES.includes(o));
    expect(on['connect-src']).toEqual([...offBase, 'https://bsc-prebsc-dataseed.bnbchain.org', 'https://auth.privy.io', 'https://*.rpc.privy.systems', ...PICTURES]);
    expect(on['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(on['frame-src']).toEqual(['https://auth.privy.io']);
    expect(on['child-src']).toEqual(['https://auth.privy.io']);
    for (const key of Object.keys(off)) if (!['connect-src', 'style-src'].includes(key)) expect(on[key]).toEqual(off[key]);
    expect(Object.keys(on).sort()).toEqual([...Object.keys(off), 'frame-src', 'child-src'].sort());
  });
  it('the platform’s policy adds the same Privy origins (platform_csp_1)', () => {
    const platform = snippet('platform_csp_1')!;
    for (const part of ['https://auth.privy.io https://*.rpc.privy.systems', 'frame-src https://auth.privy.io', 'child-src https://auth.privy.io']) expect(platform).toContain(part);
  });
});

describe('SH-294: the launch page reads and publishes pictures the platform\'s way', () => {
  it('both snippets add exactly the platform\'s four picture origins and blob: pictures', async () => {
    const { PICTURE_ORIGINS } = await import('../src/lib/pictures/publish');
    expect([...PICTURE_ORIGINS]).toEqual(PICTURES);
    for (const name of ['launch_csp_0', 'launch_csp_1']) {
      const d = directives(snippet(name)!);
      expect((d['connect-src'] as string[]).filter((o: string) => PICTURES.includes(o))).toEqual(PICTURES);
      expect(d['img-src']).toEqual(["'self'", 'blob:']);
    }
  });
  it('the platform\'s own policy names the same four', () => {
    for (const origin of PICTURES) expect(snippet('platform_csp_0') ?? '').toContain(origin);
  });
});
