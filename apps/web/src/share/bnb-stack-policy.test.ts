// @vitest-environment node
/**
 * SH-285: the BNB Chain testnet stack writes its content policy by hand (hackathon/stack/Caddyfile, the two platform
 * snippets: sign-in off and on). A box's logo and cover go on Arweave there as on the Sepolia test site, so both
 * snippets connect to exactly the origins the app uses for them (pictures/arweave-hosts.ts `PICTURE_ORIGINS`), the
 * same ones the Sepolia test site's server puts in its policy (share-headers.ts `SITE_CSP_ORIGINS.pictures`, read by
 * infra/server/app/config.mjs). This test is the one source: a host changed in either place and it fails.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PICTURE_ORIGINS } from '../features/pictures/arweave-hosts';
import { SITE_CSP_ORIGINS } from './share-headers';

const CADDYFILE = readFileSync(fileURLToPath(new URL('../../../../hackathon/stack/Caddyfile', import.meta.url)), 'utf8');
const PICTURE_HOST = /arweave|ardrive|turbo/;
const PRIVY = ['https://auth.privy.io', 'https://*.rpc.privy.systems'];

/**
 * The policy a snippet sets (`(platform_csp_<n>) { header @platform Content-Security-Policy "…" }`; the launch page's
 * `(launch_csp_<n>)` with `@launch`).
 */
function snippetPolicy(name: string, matcher: 'platform' | 'launch' = 'platform'): string {
  const match = new RegExp(`^\\(${name}\\) \\{\\n\\theader @${matcher} Content-Security-Policy "([^"]+)"\\n\\}$`, 'm').exec(CADDYFILE);
  if (!match?.[1]) throw new Error(`no snippet ${name}`);
  return match[1];
}
function directives(policy: string): Map<string, string[]> {
  return new Map(policy.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name as string, values]));
}

describe('SH-285: the stack’s platform policy and the pictures on Arweave', () => {
  it('the app, the Sepolia test site’s policy and the stack name the same four origins', () => {
    expect([...PICTURE_ORIGINS]).toEqual(['https://upload.ardrive.io', 'https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net']);
    expect(SITE_CSP_ORIGINS.pictures).toEqual([...PICTURE_ORIGINS]);
  });

  for (const [name, signIn] of [['platform_csp_0', 'sign-in off'], ['platform_csp_1', 'sign-in on']] as const) {
    it(`${name} (${signIn}): connect-src holds exactly PICTURE_ORIGINS, in order, and no other picture host; img-src none`, () => {
      const policy = directives(snippetPolicy(name));
      const connect = policy.get('connect-src') ?? [];
      expect(connect.filter((source) => PICTURE_HOST.test(source))).toEqual([...PICTURE_ORIGINS]);
      // The bytes are checked against their hash and drawn from a blob: URL: img-src gains nothing (as the alpha's).
      expect((policy.get('img-src') ?? []).filter((source) => PICTURE_HOST.test(source))).toEqual([]);
      expect(policy.get('img-src')).toContain('blob:');
      for (const [directive, sources] of policy) if (directive !== 'connect-src') expect(sources.filter((source) => PICTURE_HOST.test(source)), directive).toEqual([]);
    });
  }

  it('the two snippets differ only by Privy’s origins and frames (SH-275)', () => {
    const off = directives(snippetPolicy('platform_csp_0'));
    const on = directives(snippetPolicy('platform_csp_1'));
    expect(on.get('connect-src')?.filter((source) => !PRIVY.includes(source))).toEqual(off.get('connect-src'));
    expect([on.get('frame-src'), on.get('child-src')]).toEqual([['https://auth.privy.io'], ['https://auth.privy.io']]);
    for (const [directive, sources] of off) if (directive !== 'connect-src') expect(on.get(directive), directive).toEqual(sources);
  });

  // SH-294: a launch on Flap or Four.meme carries a picture, published to Arweave from the launch page and read back from
  // its gateways there, as the platform's pictures are: the launch page's two snippets (sign-in off and on) name the same
  // four origins, and only where the platform's do.
  for (const [name, signIn] of [['launch_csp_0', 'sign-in off'], ['launch_csp_1', 'sign-in on']] as const) {
    it(`the launch page's ${name} (${signIn}): connect-src holds exactly PICTURE_ORIGINS, in order, and no other picture host; img-src blob: and no picture host`, () => {
      const policy = directives(snippetPolicy(name, 'launch'));
      expect((policy.get('connect-src') ?? []).filter((source) => PICTURE_HOST.test(source))).toEqual([...PICTURE_ORIGINS]);
      // The bytes are fetched, checked against the link's hash and drawn from a blob: URL: img-src names no picture host.
      expect(policy.get('img-src')).toContain('blob:');
      for (const [directive, sources] of policy) if (directive !== 'connect-src') expect(sources.filter((source) => PICTURE_HOST.test(source)), directive).toEqual([]);
    });
  }

  it('the launch page’s two snippets differ only by the sign-in’s origins and frames (its second read endpoint and inline styles with them, SH-280)', () => {
    const off = directives(snippetPolicy('launch_csp_0', 'launch'));
    const on = directives(snippetPolicy('launch_csp_1', 'launch'));
    const signIn = [...PRIVY, 'https://bsc-prebsc-dataseed.bnbchain.org'];
    expect(on.get('connect-src')?.filter((source) => !signIn.includes(source))).toEqual(off.get('connect-src'));
    expect([on.get('frame-src'), on.get('child-src')]).toEqual([['https://auth.privy.io'], ['https://auth.privy.io']]);
    expect(on.get('style-src')?.filter((source) => source !== "'unsafe-inline'")).toEqual(off.get('style-src'));
    for (const [directive, sources] of off) if (!['connect-src', 'style-src'].includes(directive)) expect(on.get(directive), directive).toEqual(sources);
    expect([...on.keys()].filter((directive) => !off.has(directive)).sort()).toEqual(['child-src', 'frame-src']);
  });
});
