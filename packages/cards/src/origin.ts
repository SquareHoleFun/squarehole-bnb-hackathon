/** Origins and RPC lists from configuration (the indexer gateway, the card service, IPFS gateways, keyless RPCs). */
import { SEPOLIA_PUBLIC_RPC_URLS } from '@squarehole/chain';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A bare https origin (or http on loopback, for local testing), or null. */
export function originOf(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
  return url.origin;
}

/** https RPC URLs from a comma-separated list (credentials, queries and plain http refused), or the keyless default list. */
export function rpcUrlsOf(raw: string | undefined): readonly string[] {
  const urls = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => {
      try {
        const url = new URL(entry);
        return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
      } catch {
        return false;
      }
    });
  return urls.length > 0 ? urls : SEPOLIA_PUBLIC_RPC_URLS;
}
