import { arId, decimal, fail, httpsUrl, jsonRequest } from './common.mjs';

/** Provider interface: identity, quote(serializedBytes): decimal winc,
 * upload({id, bytes}): {id}. No SDK, wallet funding, auto retry or EVM writes.
 * Turbo bills in winc; these units must never be interpreted as winston or USD.
 */
export function turboProvider({ uploadOrigin, paymentOrigin, fetch = globalThis.fetch }) {
  const upload = httpsUrl(uploadOrigin);
  const payment = httpsUrl(paymentOrigin);
  return {
    identity: `turbo-https/1:${upload}:${payment}`,
    quote: async (serializedBytes) => {
      const result = await jsonRequest(fetch, `${payment}/v1/price/bytes/${serializedBytes}`, { limit: 16_384 });
      if (!decimal(result?.winc)) fail('invalid price: expected decimal winc');
      return result.winc;
    },
    upload: async ({ id, bytes }) => {
      let result;
      try {
        result = await jsonRequest(fetch, `${upload}/v1/tx/arweave`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, limit: 65_536 });
      } catch { fail('upload outcome uncertain; preserve intent and reconcile by id'); }
      if (!arId(result?.id) || result.id !== id) fail('upload id mismatch; preserve intent and reconcile by id');
      return { id: result.id };
    },
  };
}
