import { ClaimsGatewayV2 } from '../../../packages/indexer/src/core/v2/claims-gateway-v2.ts';

// Invoke the real upstream route handler with in-memory request/response objects, never a listener.
export function gatewayFixture() {
  const chainId = 11155111;
  const wallet = `0x${'1'.repeat(40)}`;
  const token = `0x${'2'.repeat(40)}`;
  const asOf = { block: '100', hash: `0x${'3'.repeat(64)}`, tier: 'head' };
  const feed = { schema: 'sh.core-feed.v2', chainId, asOf, cards: [], hidden: [] };
  const claims = { schema: 'sh.core-claims.v2', chainId, wallet, asOf, recentFromBlock: '0', items: [], next: null };
  const activity = { asOf, items: [], next: null };
  const source = {
    chainId,
    health: () => ({ following: true, reason: null, history: null }),
    feed: () => ({ ...feed, schema: 'sh.core-feed.v1' }),
    v2Feed: () => feed,
    v2Box: (address) => address === token ? { asOf } : null,
    activity: async () => activity,
  };
  const gateway = new ClaimsGatewayV2({ source, port: 0, host: '127.0.0.1' }, { page: async () => claims });
  const request = async (url, method = 'GET') => {
    const response = {
      status: 0, headers: {}, body: Buffer.alloc(0),
      writeHead(status, headers) {
        this.status = status;
        this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
      },
      end(body = '') { this.body = Buffer.from(body); },
    };
    await gateway.route({ url, method }, response);
    return response;
  };
  return { chainId, wallet, token, feed, claims, activity, request };
}
