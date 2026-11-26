import { describe, expect, it } from 'vitest';
import { loadServiceConfig, SEPOLIA_REHEARSAL } from '../src/config';
import { decodeFrame, encodeFrame, eventId, seqOf } from '../src/frame';
import { scoreOf, stateFromJson, toJson, tradeFromJson } from '../src/model';
import { tierOf, windowView } from '../src/views';

const T = SEPOLIA_REHEARSAL;
const head = (number: bigint) => ({ number, hash: '0x01' as const, parentHash: '0x00' as const, timestamp: 1_790_740_000n });

describe('launch window view (relative to the next block)', () => {
  it('counts down to the open, then walks the tax table, then opens every route', () => {
    expect(windowView(head(T.openBlock - 11n), T)).toMatchObject({ status: 'before_open', blocksToOpen: '10', etaOpenUnix: (1_790_740_000n + 11n * 12n).toString(), nextBlockTaxPips: 0 });
    expect(windowView(head(T.openBlock - 1n), T)).toMatchObject({ status: 'router_window', blocksToOpen: '0', nextBlockTaxPips: 931_974, nextBlockTaxPercent: '93.1974', blocksToClose: '32' }); // window blocks left, the next one included
    expect(windowView(head(T.closeBlock - 2n), T)).toMatchObject({ status: 'router_window', nextBlockTaxPips: 80_565, nextBlockTaxPercent: '8.0565', blocksToClose: '1' });
    expect(windowView(head(T.closeBlock - 1n), T)).toMatchObject({ status: 'open', nextBlockTaxPips: 0, etaOpenUnix: null, etaCloseUnix: null });
  });
});

describe('finality tiers', () => {
  it('head → confirmed → safe → finalized', () => {
    expect(tierOf(100n, 100n, 2, null, null)).toBe('head');
    expect(tierOf(99n, 100n, 2, null, null)).toBe('confirmed');
    expect(tierOf(99n, 100n, 2, 99n, null)).toBe('safe');
    expect(tierOf(50n, 100n, 2, 99n, 60n)).toBe('finalized');
  });
});

describe('frames and JSON', () => {
  it('round-trips a frame and refuses multi-line parts', () => {
    const frame = { type: 'block' as const, id: eventId(7, 12n, '0xABCDEF0123456789'), etag: '0xabc', event: '{"a":1}', snapshot: '{"b":2}' };
    expect(frame.id).toBe('7-12:abcdef01');
    expect(decodeFrame(encodeFrame(frame))).toEqual({ ...frame, seq: 7 });
    expect(decodeFrame(encodeFrame({ ...frame, type: 'finality', id: eventId(8), snapshot: null }))).toMatchObject({ seq: 8, id: '8', snapshot: null });
    expect(() => encodeFrame({ ...frame, event: '{\n}' })).toThrow();
    expect(() => encodeFrame({ ...frame, id: '1|2' })).toThrow();
    expect(() => decodeFrame('nope')).toThrow();
    expect(() => decodeFrame('evil|1|x\n{}\n')).toThrow(/unknown frame type/);
    expect(() => decodeFrame('block|12:abcdef01|x\n{}\n')).toThrow(/sequence/); // the old id format has no sequence
  });

  it('parses the sequence of an SSE id and refuses anything else', () => {
    expect(seqOf('1790745524219-11812131:0000abcd')).toBe(1_790_745_524_219);
    expect(seqOf('42')).toBe(42);
    for (const bad of ['', '11812131:0000abcd', '-1', '1e3', '12-x', '9999999999999999999']) expect(seqOf(bad)).toBeNull();
  });

  it('writes amounts as decimal strings and reads them back as bigint', () => {
    const json = toJson({ block: 5n, timestamp: 6n, sqrtPriceX96: 7n, liquidity: 8n, volumeWei: 9n, feesWei: 1n, feesTokenRaw: 2n, taxWei: 3n, burnedRaw: 4n, lastTradeBlock: null, tick: -5 });
    expect(json).toContain('"volumeWei":"9"');
    expect(stateFromJson(json)).toMatchObject({ volumeWei: 9n, lastTradeBlock: null, tick: -5 });
    const trade = tradeFromJson(toJson({ block: 1n, timestamp: 2n, ethRaw: 3n, tokenRaw: 4n, feeEthRaw: 5n, feeTokenRaw: 6n, taxRaw: 7n, sqrtPriceX96After: 8n, retainedAfterWei: 9n }));
    expect(trade.retainedAfterWei).toBe(9n);
    expect(scoreOf(11_812_130n, 167)).toBe(1_181_213_000_167);
    expect(() => scoreOf(1n, 100_000)).toThrow(RangeError);
  });
});

describe('service config', () => {
  it('defaults to port 5393 and the local Redis on 5395, and refuses reserved ports', () => {
    const config = loadServiceConfig({});
    expect(config).toMatchObject({ port: 5393, store: 'redis', redisUrl: 'redis://127.0.0.1:5395/0', confirmations: 2, role: 'all' });
    expect(config.wsUrls[0]).toBe('wss://ethereum-sepolia-rpc.publicnode.com');
    expect(config.httpUrls).toHaveLength(2);
    for (const port of ['4173', '5173', '8547', '8548', '8549']) expect(() => loadServiceConfig({ SH_INDEXER_PORT: port })).toThrow();
    expect(loadServiceConfig({ SH_DISABLE_WS: '1' }).wsUrls).toEqual([]);
    expect(loadServiceConfig({ SH_HTTP_URLS: 'http://a, http://b' }).httpUrls).toEqual(['http://a', 'http://b']);
  });
});
