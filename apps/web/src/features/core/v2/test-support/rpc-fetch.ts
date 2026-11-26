/** A `fetch` that answers JSON-RPC posts from an RPC double, so the real viem clients run in unit tests. */
import type { RpcCall } from './m2-rpc';

export function rpcFetch(request: (call: RpcCall) => Promise<unknown>): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as RpcCall & { id: number; jsonrpc: string };
    let answer: object;
    try { answer = { result: await request({ method: body.method, params: body.params }) }; }
    catch (error) {
      // A revert's ABI-encoded data travels with it, as a node answers (SH-RC7-SITE-INBOX decodes the inbox's errors).
      const data = (error as { data?: unknown }).data;
      answer = { error: { code: (error as { code?: number }).code ?? -32601, message: (error as Error).message, ...(typeof data === 'string' ? { data } : {}) } };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...answer }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
