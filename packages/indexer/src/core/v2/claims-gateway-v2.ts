import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WalletClaimsPageV2 } from '../../../../chain/src/core/v2/claims-types';
import { CoreGateway, type CoreGatewayOptions } from '../core-gateway';
import { ClaimsIndexErrorV2, WalletClaimsIndexV2 } from './claims-index-v2';

export interface ClaimsGatewaySourceV2 { page(wallet: string, options: { after: string | null; limit: number }): Promise<WalletClaimsPageV2> }

/** A CoreGateway with the wallet claims route; inherited start/stop, feed, SSE and health remain usable. */
export class ClaimsGatewayV2 extends CoreGateway {
  constructor(private readonly claimsOptions: CoreGatewayOptions, private readonly claims: ClaimsGatewaySourceV2 | WalletClaimsIndexV2) { super(claimsOptions); }

  override async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The Create document route must reject its raw path before any URL normalization here.
    if (req.url === '/v2/create-options' || req.url?.startsWith('/v2/create-options/')) return super.route(req, res);
    const url = new URL(req.url ?? '/', 'http://gateway');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'v2' || parts[1] !== 'wallets' || parts[4] !== 'claims' || parts.length !== 5) return super.route(req, res);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'If-None-Match',
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(status === 204 ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') return send(204, null);
    if (req.method !== 'GET') return send(405, { error: 'read-only' });
    if (parts[2] !== String(this.claimsOptions.source.chainId)) return send(404, { error: 'no chain here' });
    const wallet = (parts[3] ?? '').toLowerCase();
    const limitText = url.searchParams.get('limit') ?? '50'; const limit = Number(limitText);
    if (!/^0x[0-9a-f]{40}$/.test(wallet) || /^0x0{40}$/.test(wallet) || !/^[1-9][0-9]{0,2}$/.test(limitText) || limit > 100) return send(400, { error: 'invalid wallet or limit (1-100)' });
    if (!this.claimsOptions.source.health().following) return send(503, { error: 'claims index is not following the chain' });
    try { return send(200, await this.claims.page(wallet, { after: url.searchParams.get('after'), limit })); }
    catch (error) {
      if (error instanceof ClaimsIndexErrorV2) return send(error.status, { error: error.message });
      return send(503, { error: 'canonical claims reads unavailable; retry' });
    }
  }
}
