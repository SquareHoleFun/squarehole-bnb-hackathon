export const NOW = 1791892800n;
export const IDENTITY = '11155111:0x0000000000000000000000000000000000000001::';
export function healthy(headers) {
  return {
    drand: { consumers: [], timestamp: String(NOW - 900n), canary: { status: 'ok', reason: 'no-posted-word' } },
    heartbeat: { configured: true, valid: true }, keeperLock: { absent: true },
    landing: { status: 200, headers: { ...headers, 'cf-ray': 'fake-ray', server: 'cloudflare', 'content-type': 'text/html', 'cache-control': 'no-cache' }, body: '<title>Square Hole</title>' },
    api: { status: 200, headers: { 'cf-ray': 'fake-ray', server: 'cloudflare', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'access-control-allow-origin': 'https://squarehole.fun', vary: 'Origin' }, body: { ok: true, following: true, asOf: { block: '2000', timestamp: String(NOW) }, history: { ok: true } } },
    feed: { status: 200, body: { chainId: 11155111 } },
    rpc: { chainId: '11155111', block: '1950', timestamp: String(NOW - 900n), balanceWei: '1000000000000000000' },
    keeper: { version: 1, identity: IDENTITY, state: { budget: { day: String(NOW / 86400n), oursWei: '0', pokesWei: '0', totalWei: '0' } }, modifiedAt: String(NOW) },
    view: { schema: 'squarehole.monitor-keeper.v1', chainId: '11155111', identity: IDENTITY, observedAt: String(NOW), block: '2000', complete: true,
      maxFeePerGasWei: '2000000000', queue: { count: '0', oldestBlock: null },
      income: { platformWei: '400', unattributedWei: '0', boxes: [{ box: '0x0000000000000000000000000000000000000002', shareWei: '10', tipsWei: '0', spentWei: '0' }] },
      drand: { complete: true, requests: [] } },
    journal: { modifiedAt: String(NOW), record: { recordedUtc: new Date(Number(NOW) * 1000).toISOString(), chainId: '11155111' } },
    disk: { total: '1000', available: '200' }, memory: { total: '1000', available: '200' }, backup: { modifiedAt: String(NOW - 3600n) },
  };
}
export const options = { keeperIdentity: IDENTITY, keeperAddress: '0x0000000000000000000000000000000000000001' };
