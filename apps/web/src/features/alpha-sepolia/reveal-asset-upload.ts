/** The Sepolia alpha's picture transport. The shared worker owns checks, retries and response limits. */
import type { RevealAssetUpload } from '../core/v2/reveal-assets';

export function createRevealAssetUpload(fetcher: typeof fetch): RevealAssetUpload {
  return (scope, id, role, bytes, transaction, signal) => fetcher(`/alpha/asset/${scope.chainId}/${scope.collection.toLowerCase()}/${id}/${role}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(transaction ? { 'X-SH-Reveal-Tx': transaction } : {}) },
    credentials: 'same-origin', redirect: 'error', body: bytes, signal,
  });
}
