/** Creator-signed off-chain links, pinned by docs/design/box-links-v2.md §1–4 (F148–F149). */
import { hashTypedData, type Address } from 'viem';

export const BOX_LINKS_LIMITS = Object.freeze({
  bodyBytes: 4096, bodyTimeoutMs: 5000, websiteChars: 200, signatureBytes: 1024,
  issuedAtMax: (1n << 64n) - 1n, aheadSeconds: 300n, rpcConcurrent: 4, rpcPerMinute: 20,
  rpcTimeoutMs: 3000, rpcGas: 1_000_000n, postPerMinute: 10, reloadMs: 60_000, retryAfterSeconds: 10,
});
export const ERC1271_MAGIC_WORD = '0x1626ba7e00000000000000000000000000000000000000000000000000000000';

export interface BoxLinks {
  readonly website: string;
  readonly x: string;
  readonly telegram: string;
}

// The same HOST and PATH alphabet as the v1 site-links.ts; v2 adds the canonical URL and host restrictions.
const HOST = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+';
const PATH = "(?:[/?#][A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]*)?";
const WEBSITE = new RegExp(`^https://${HOST}${PATH}$`);
const LOCAL_SUFFIX = /\.(?:localhost|local|internal|test|invalid|example|onion|arpa)$/;

export function canonicalWebsite(input: string): string | null {
  const value = input.trim();
  if (value === '') return '';
  if (value.length > BOX_LINKS_LIMITS.websiteChars || !WEBSITE.test(value)) return null;
  try {
    const u = new URL(value);
    const labels = u.hostname.split('.');
    if (!/[a-z]/i.test(labels.at(-1) ?? '') || labels.some(label => label.startsWith('xn--'))
      || u.hostname === 'localhost' || LOCAL_SUFFIX.test(u.hostname)) return null;
    const out = u.href === `${u.origin}/` ? u.origin : u.href;
    return out.length <= BOX_LINKS_LIMITS.websiteChars && WEBSITE.test(out) ? out : null;
  } catch { return null; }
}

export function canonicalX(input: string): string | null {
  const value = input.trim();
  if (value === '') return '';
  const match = /^(?:@|https:\/\/(?:(?:www\.)?x\.com|(?:(?:www|mobile)\.)?twitter\.com)\/)?([A-Za-z0-9_]{1,15})\/?$/.exec(value);
  return match?.[1] ?? null;
}

export function canonicalTelegram(input: string): string | null {
  const value = input.trim();
  if (value === '') return '';
  const match = /^(?:@|(?:https:\/\/)?t\.me\/)?([A-Za-z][A-Za-z0-9_]{3,31})\/?$/.exec(value);
  return match?.[1] ?? null;
}

/** Full host, never abbreviated. Empty/invalid input has no display host. */
export function displayHost(website: string): string {
  const canonical = canonicalWebsite(website);
  return canonical ? new URL(canonical).hostname : '';
}

const TYPES = {
  EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
  BoxLinks: [{ name: 'token', type: 'address' }, { name: 'website', type: 'string' }, { name: 'x', type: 'string' },
    { name: 'telegram', type: 'string' }, { name: 'issuedAt', type: 'uint64' }],
} as const;

/** JSON-safe eth_signTypedData_v4 object. Callers canonicalize before signing; the server requires exact equality. */
export function boxLinksTypedData(chainId: number, token: Address, links: BoxLinks, issuedAt: bigint | string) {
  return { domain: { name: 'Square Hole', version: '1', chainId }, types: TYPES, primaryType: 'BoxLinks' as const,
    message: { token, website: links.website, x: links.x, telegram: links.telegram, issuedAt: issuedAt.toString() } };
}

export function boxLinksDigest(chainId: number, token: Address, links: BoxLinks, issuedAt: bigint | string) {
  const data = boxLinksTypedData(chainId, token, links, issuedAt);
  // Explicit EIP712Domain types make viem require bigint for uint256; keep the wallet JSON object above JSON-safe.
  return hashTypedData({ ...data, domain: { ...data.domain, chainId: BigInt(chainId) }, message: { ...data.message, issuedAt: BigInt(issuedAt) } });
}
