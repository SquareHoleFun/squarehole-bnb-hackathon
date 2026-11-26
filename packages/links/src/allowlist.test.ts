import { describe, expect, it } from 'vitest';
import { REVIEWED_PROVIDERS, vetExternalHref, type HrefRejection } from './allowlist';

const T = '0x00000000000000000000000000000000000003ea';
const Q = '0x0000000000000000000000000000000000002329';

describe('vetExternalHref (EXT-02 provider origin allowlist, EXT-07 no creator redirects)', () => {
  it('accepts an allowlisted https origin for the matching kind and returns the normalised href', () => {
    const vetted = vetExternalHref(`https://app.uniswap.org/swap?chain=mainnet&inputCurrency=${Q}&outputCurrency=${T}`, 'execution');
    expect(vetted).toMatchObject({ ok: true, host: 'app.uniswap.org', provider: { id: 'uniswap-web' } });
    expect(vetExternalHref('https://APP.Uniswap.org/explore', 'execution')).toMatchObject({ ok: true, href: 'https://app.uniswap.org/explore' });
    expect(vetExternalHref(`https://sepolia.etherscan.io/token/${T}`, 'explorer')).toMatchObject({ ok: true, host: 'sepolia.etherscan.io' });
  });

  it('every reviewed provider origin is https with a bare lowercase host', () => {
    for (const provider of REVIEWED_PROVIDERS) {
      const url = new URL(provider.origin);
      expect(url.origin, provider.id).toBe(provider.origin);
      expect(url.protocol).toBe('https:');
      expect(vetExternalHref(`${provider.origin}/`, provider.kind).ok, provider.id).toBe(true);
    }
  });

  it('keeps kinds apart: an explorer origin is not an execution venue', () => {
    expect(vetExternalHref(`https://etherscan.io/token/${T}`, 'execution')).toEqual({ ok: false, reason: 'origin_not_allowed' });
    expect(vetExternalHref('https://app.uniswap.org/swap', 'explorer')).toEqual({ ok: false, reason: 'origin_not_allowed' });
  });

  it.each<[string, unknown, HrefRejection]>([
    ['javascript scheme', 'javascript:alert(1)', 'not_https'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>', 'not_https'],
    ['plain http', 'http://app.uniswap.org/swap', 'not_https'],
    ['relative path', '/swap', 'not_absolute'],
    ['protocol-relative', '//app.uniswap.org/swap', 'not_absolute'],
    ['credentials before the host', 'https://app.uniswap.org@evil.example/swap', 'credentials'],
    ['user and password', 'https://user:pass@app.uniswap.org/swap', 'credentials'],
    ['explicit port', 'https://app.uniswap.org:8443/swap', 'port'],
    ['lookalike suffix', 'https://app.uniswap.org.evil.example/swap', 'origin_not_allowed'],
    ['lookalike hyphen', 'https://app-uniswap.org/swap', 'origin_not_allowed'],
    ['homoglyph host (Cyrillic a)', 'https://\u0430pp.uniswap.org/swap', 'origin_not_allowed'],
    ['bare parent domain', 'https://uniswap.org/swap', 'origin_not_allowed'],
    ['trailing-dot host', 'https://app.uniswap.org./swap', 'origin_not_allowed'],
    ['connect parameter', 'https://app.uniswap.org/swap?connect=metamask', 'forbidden_parameter'],
    ['prefilled amount', 'https://app.uniswap.org/swap?value=100&field=input', 'forbidden_parameter'],
    ['slippage (any case)', 'https://app.uniswap.org/swap?SlippageTolerance=50', 'forbidden_parameter'],
    ['cross-chain output', 'https://app.uniswap.org/swap?outputChain=base', 'forbidden_parameter'],
    ['redirect parameter', 'https://app.uniswap.org/swap?next=https://evil.example', 'embedded_url'],
    ['protocol-relative redirect', 'https://app.uniswap.org/explore?returnTo=//evil.example', 'embedded_url'],
    ['legacy hash route', 'https://app.uniswap.org/#/swap', 'legacy_hash_route'],
    ['embedded whitespace', 'https://app.uniswap.org/sw ap', 'unsafe_characters'],
    ['leading space', ' https://app.uniswap.org/swap', 'unsafe_characters'],
    ['newline', 'https://app.uniswap.org/\nswap', 'unsafe_characters'],
    ['bidi override', 'https://app.uniswap.org/\u202eswap', 'unsafe_characters'],
    ['zero-width space', 'https://app.uniswap.org/\u200bswap', 'unsafe_characters'],
    ['non-breaking space', 'https://app.uniswap.org/\u00a0swap', 'unsafe_characters'],
    ['backslash', 'https://app.uniswap.org\\@evil.example', 'unsafe_characters'],
    ['not a string', 42, 'not_a_string'],
    ['null', null, 'not_a_string'],
    ['very long', `https://app.uniswap.org/${'a'.repeat(3000)}`, 'too_long'],
  ])('rejects %s', (_label, href, reason) => {
    expect(vetExternalHref(href, 'execution')).toEqual({ ok: false, reason });
  });
});
