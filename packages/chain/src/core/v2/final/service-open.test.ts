import { afterEach, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startCoreService } from '../../../../../indexer/src/core/core-service';
import { CoreChainIndexer } from '../../../../../indexer/src/core/chain-indexer';
import { CoreGateway } from '../../../../../indexer/src/core/core-gateway';
import { HeadFeed } from '../../../../../indexer/src/heads';
import type { CoreReader } from '../../../../../indexer/src/core/core-reader';
import { A, walletFixture } from './wallet-fixture';

afterEach(() => vi.restoreAllMocks());

it('CLAIMS-INDEX inherited request: the CLI service exposes claims, reporting an unready index as 503', async () => {
  // Exercise the CLI's actual composition, without starting RPC, polling or a listener.
  vi.spyOn(CoreChainIndexer.prototype, 'start').mockResolvedValue(undefined);
  vi.spyOn(CoreChainIndexer.prototype, 'idle').mockResolvedValue(undefined);
  vi.spyOn(CoreGateway.prototype, 'start').mockResolvedValue(undefined);
  vi.spyOn(HeadFeed.prototype, 'start').mockImplementation(() => undefined);
  const f = walletFixture(0, 0);
  const service = await startCoreService({ manifest: f.holder.manifest, reader: {} as CoreReader, host: '127.0.0.1', port: 5391 });
  try {
    const response = { status: 0, body: '', writeHead(status: number) { this.status = status; }, end(body = '') { this.body = body; } };
    await service.gateway.route({ method: 'GET', url: `/v2/wallets/${f.source.chainId}/${A}/claims` } as IncomingMessage, response as unknown as ServerResponse);
    expect(response.status, 'the v2 claims endpoint must exist before the first canonical block').toBe(503);
  } finally { await service.stop(); }
});
