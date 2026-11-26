/**
 * SH-261: a JSON-RPC proxy on 127.0.0.1 in front of a LOCAL chain that answers the way a busy public endpoint did on
 * 25 November, for the proof of the real-run mode (proof.mjs --faults). Loopback only, both ways: it refuses a target
 * that is not http://127.0.0.1:<port> (lane b's pace-rig is the model).
 *
 * Faults, counted:
 *   - the `nonceTooLowAt`th eth_sendRawTransaction is answered "nonce too low: next nonce N, tx nonce M" and not
 *     forwarded (a node behind the endpoint that still holds an old count);
 *   - the `send429At`th eth_sendRawTransaction is answered HTTP 429 and not forwarded;
 *   - the 3rd to 5th eth_gasPrice are answered HTTP 429 "Rate limit exceeded";
 *   - every `limitEvery`th request (up to `limitCount` times) is answered with a JSON-RPC error "Rate limit exceeded";
 *   - every other eth_getTransactionCount answers one less than the node (a lagging node).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export function startFaultProxy({ target, port, nonceTooLowAt = 5, send429At = 8, limitEvery = 25, limitCount = 6 }) {
  assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/, 'the fault proxy fronts a local chain only');
  const counts = { requests: 0, sends: 0, nonceTooLow: 0, send429: 0, gasPrice429: 0, jsonLimit: 0, lagged: 0, gasPrices: 0, counts: 0 };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    counts.requests += 1;
    const body = JSON.parse(raw);
    const single = Array.isArray(body) ? null : body;
    const reply = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
    if (single?.method === 'eth_sendRawTransaction') {
      counts.sends += 1;
      if (counts.sends === nonceTooLowAt) {
        counts.nonceTooLow += 1;
        return reply(200, { jsonrpc: '2.0', id: single.id, error: { code: -32000, message: 'nonce too low: next nonce 1, tx nonce 0' } });
      }
      if (counts.sends === send429At) { counts.send429 += 1; return reply(429, 'Rate limit exceeded'); }
    }
    if (single?.method === 'eth_gasPrice') {
      counts.gasPrices += 1;
      if (counts.gasPrices >= 3 && counts.gasPrices <= 5) { counts.gasPrice429 += 1; return reply(429, 'Rate limit exceeded'); }
    }
    if (single && single.method !== 'eth_sendRawTransaction' && counts.requests % limitEvery === 0 && counts.jsonLimit < limitCount) {
      counts.jsonLimit += 1;
      return reply(200, { jsonrpc: '2.0', id: single.id, error: { code: -32005, message: 'Rate limit exceeded' } });
    }
    const forwarded = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    const text = await forwarded.text();
    if (single?.method === 'eth_getTransactionCount') {
      counts.counts += 1;
      const parsed = JSON.parse(text);
      if (counts.counts % 2 === 0 && parsed.result && BigInt(parsed.result) > 0n) {
        counts.lagged += 1;
        return reply(200, { ...parsed, result: `0x${(BigInt(parsed.result) - 1n).toString(16)}` });
      }
    }
    res.writeHead(forwarded.status, { 'content-type': 'application/json' });
    res.end(text);
  });
  return new Promise(done => server.listen(port, '127.0.0.1', () => done({ url: `http://127.0.0.1:${port}`, counts, stop: () => server.close() })));
}
