// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { getAddress, type Hex } from 'viem';
import { createRevealAssetUpload } from './reveal-asset-upload';

it.each(['image', 'avatar', 'model'] as const)('SH-203 af3: %s transport preserves the request with and without a receipt hint', async role => {
  const scope = { chainId: 11155111, collection: getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'), ids: [123n] };
  const bytes = new Uint8Array([0, 1, 128, 255]), signal = new AbortController().signal;
  for (const transaction of [undefined, `0x${'ab'.repeat(32)}` as Hex]) {
    const response = Response.json({ stored: true }), fetcher = vi.fn<typeof fetch>(async () => response);
    expect(await createRevealAssetUpload(fetcher)(scope, 123n, role, bytes, transaction, signal)).toBe(response);
    expect(fetcher.mock.calls).toEqual([[`/alpha/asset/11155111/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd/123/${role}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(transaction ? { 'X-SH-Reveal-Tx': transaction } : {}) },
      credentials: 'same-origin', redirect: 'error', body: bytes, signal,
    }]]);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(bytes);
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(signal);
  }
});
