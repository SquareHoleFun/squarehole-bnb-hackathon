import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, RpcRequestError, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SEPOLIA_PUBLIC_RPC_URLS } from '@squarehole/chain';
import { boxLinksDigest, ERC1271_MAGIC_WORD } from '../../../chain/src/core/v2/box-links-v2';
import { CoreGateway, type CoreGatewaySource } from '../../src/core/core-gateway';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { coreGatewaySource } from '../../src/core/core-service';
import { LinksService } from '../../src/links/links-service';
import { MemoryLinks } from '../../src/links/memory-links';
import { PgLinks } from '../../src/links/pg-links';
import { Erc1271Verifier, erc1271Rpc, ERC1271_ABI, LinksV2 } from '../../src/core/v2/links-v2';
import { ACCOUNT, BODY, CHAIN, HEAD, LINKS, PATH, SIGNATURE, TOKEN, fixture, request, ResponseDouble, signed } from '../links/fixture';
import { row } from '../links/links.contract';
import { World } from './core-synth';
import { boxLogsV2, serviceBoxV2, serviceChainV2, synthManifestV2, listingAddedLog, serviceListingV2, requiredV2 } from './scripted-core-chain';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(store?: Parameters<typeof fixture>[0]) {
  const f = await fixture(store); disposals.push(() => f.service.stop());
  const source = { chainId: CHAIN, health: () => ({ following: f.following(), reason: null, history: null }),
    feed: () => { throw new Error('reader https://rpc.invalid/secret-key'); } } as unknown as CoreGatewaySource;
  const gateway = new CoreGateway({ source, links: f.links, port: 0, host: '127.0.0.1' });
  const send = async (body: unknown = BODY, options: Parameters<typeof request>[1] = {}) => {
    const r = request(body, options); const res = new ResponseDouble();
    await gateway.route(r.req, res.asResponse()); return { ...r, res };
  };
  return { ...f, gateway, send };
}

describe('LINKS-SRV §4 HTTP check order and public shape', () => {
  it.each(['text/plain', 'application/json', 'text/plain; charset=utf-8', 'application/json; charset=utf-8'])('EOA vector with %s: saves and GET exposes its public signature', async type => {
    const f = await setup(); const { res } = await f.send(BODY, { type });
    expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ schema: 'sh.box-links.v1', chainId: CHAIN, token: TOKEN, creator: ACCOUNT.address.toLowerCase(),
      record: { ...BODY, signerKind: 'eoa', verifiedBlock: '123' } });
    const get = await f.send(undefined, { method: 'GET' });
    expect(get.res.json()).toEqual(res.json()); expect(get.res.headers['cache-control']).toBe('public, max-age=1');
    expect(get.read).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled(); expect(f.code).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith('links_saved', { chainId: CHAIN, token: TOKEN, issuedAt: BODY.issuedAt, signerKind: 'eoa', block: '123' });
  });

  it.each(['non-creator', 'another token', 'another chain'])('rejects %s with 403 for an ordinary wallet without an ERC-1271 call', async kind => {
    const f = await setup(); f.code.mockResolvedValue('0x'); f.rpc.mockResolvedValue(ERC1271_MAGIC_WORD);
    const other = privateKeyToAccount(`0x${'01'.repeat(32)}`);
    const body = await signed({}, kind === 'another chain' ? CHAIN + 1 : CHAIN,
      kind === 'another token' ? `0x${'22'.repeat(20)}` : TOKEN, kind === 'non-creator' ? other : ACCOUNT);
    const { res } = await f.send(body);
    expect(res.status).toBe(403); expect(res.json()).toEqual({ error: 'not the creator' }); expect(f.rpc).not.toHaveBeenCalled();
    expect(f.code).toHaveBeenCalledExactlyOnceWith(ACCOUNT.address, HEAD.hash);
  });

  it('newer wins; same content/time keeps the stored signature even with different signature bytes', async () => {
    const f = await setup(); await f.send();
    const replay = await f.send({ ...BODY, signature: '0x' }); expect(replay.res.status).toBe(200);
    expect((replay.res.json()['record'] as typeof BODY).signature).toBe(SIGNATURE);
    for (const body of [{ ...BODY, issuedAt: '1' }, { ...BODY, x: 'changed' }]) {
      const { res } = await f.send(body); expect(res.status).toBe(409);
      expect(res.json()).toEqual({ error: 'not newer', savedIssuedAt: BODY.issuedAt });
    }
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('simultaneous POSTs serve the newest even when an older RETURNING completes last', async () => {
    const f = await setup(); const put = f.store.put.bind(f.store);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.store, 'put').mockImplementation(async value => {
      const saved = await put(value);
      if (value.issuedAt === BODY.issuedAt) { entered(); await held; }
      return saved;
    });
    const old = f.send(); await writing;
    const fresh = await signed({ issuedAt: String(HEAD.timestamp + 1n), x: 'newest' });
    expect((await f.send(fresh)).res.status).toBe(200); release(); expect((await old).res.status).toBe(200);
    expect((await f.send(undefined, { method: 'GET' })).res.json()['record']).toMatchObject(fresh);
  });

  it.each([false, true])('upsert losing a race re-reads and returns identical 200 or newer 409 (newer=%s)', async newer => {
    const f = await setup(); const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, 'put').mockImplementationOnce(async value => {
      await put({ ...value, issuedAt: newer ? String(BigInt(value.issuedAt) + 1n) : value.issuedAt, signature: '0x1234' });
      return null;
    });
    const { res } = await f.send();
    expect(res.status).toBe(newer ? 409 : 200);
    if (newer) expect(res.json()).toEqual({ error: 'not newer', savedIssuedAt: String(HEAD.timestamp + 1n) });
    else expect(res.json()['record']).toMatchObject({ ...BODY, signature: '0x1234' });
  });

  it('removal is a retained tombstone, with null public record and projection', async () => {
    const f = await setup(); expect((await f.send(undefined, { method: 'GET' })).res.json()['record']).toBeNull();
    await f.send();
    const body = await signed({ website: '', x: '', telegram: '', issuedAt: String(HEAD.timestamp + 1n) });
    const removed = await f.send(body); expect(removed.res.status).toBe(200); expect(removed.res.json()['record']).toBeNull();
    expect(f.service.visible(TOKEN)).toBeNull();
    expect((await f.send(undefined, { method: 'GET' })).res.json()['record']).toBeNull();
    expect((await f.send()).res.status).toBe(409);
  });

  it('accepts a year-old signature newer than the saved row, and the exact future boundary', async () => {
    const f = await setup();
    await f.service.save(row('1'));
    expect((await f.send(await signed({ issuedAt: String(HEAD.timestamp - 365n * 86400n) }))).res.status).toBe(200);
    expect((await f.send(await signed({ issuedAt: String(HEAD.timestamp + 300n) }))).res.status).toBe(200);
  });

  it.each([
    [{ issuedAt: String(HEAD.timestamp + 301n) }, 'issuedAt ahead of chain'],
    [{ issuedAt: '1e9' }, 'issuedAt format'], [{ issuedAt: '18446744073709551616' }, 'issuedAt format'],
    [{ issuedAt: '01' }, 'issuedAt format'], [{ issuedAt: '-1' }, 'issuedAt format'],
    [{ issuedAt: '1\n' }, 'issuedAt format'], [{ signature: '0xaa\n' }, 'signature format'],
    [{ website: 'https://A.com/' }, 'website not canonical'], [{ x: '@name' }, 'x not canonical'],
    [{ telegram: 't.me/name' }, 'telegram not canonical'], [{ signature: '0x0' }, 'signature format'],
    [{ signature: '0xzz' }, 'signature format'], [{ signature: `0x${'ab'.repeat(1025)}` }, 'signature format'],
    [{ unknown: '' }, 'bad keys'], [{ signature: 123 }, 'bad keys'],
  ])('bad field %j is refused without RPC', async (patch, reason) => {
    const f = await setup(); const { res } = await f.send({ ...BODY, ...patch });
    expect(res.status).toBe(400); expect(res.json()).toEqual({ error: reason }); expect(f.rpc).not.toHaveBeenCalled();
    expect(res.headers['cache-control']).toBe('no-store'); expect(f.log).toHaveBeenCalledWith('links_refused', { reason });
  });

  it('missing keys, non-objects and malformed JSON have fixed errors', async () => {
    const f = await setup();
    for (const body of [{ website: '', x: '', telegram: '', issuedAt: '0' }, null, [], 'hello']) {
      expect((await f.send(body)).res.json()).toEqual({ error: 'bad keys' });
    }
    expect((await f.send(BODY, { raw: '{' })).res.json()).toEqual({ error: 'bad json' });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('body text cannot impersonate the body reader errors', async () => {
    const f = await setup();
    for (const raw of ['body too large', 'body timeout']) {
      const { res } = await f.send(BODY, { raw });
      expect(res.status).toBe(400); expect(res.json()).toEqual({ error: 'bad json' });
    }
  });

  it('accepts a 1024-byte contract signature at the limit', async () => {
    const f = await setup(); f.rpc.mockResolvedValue(ERC1271_MAGIC_WORD);
    expect((await f.send({ ...BODY, signature: `0x${'aa'.repeat(1024)}` })).res.status).toBe(200);
    expect(f.rpc).toHaveBeenCalledOnce();
  });

  it('checks content type before length, Content-Length before reading, then counts UTF-8 bytes', async () => {
    const f = await setup();
    const form = await f.send(BODY, { type: 'application/x-www-form-urlencoded', length: '4097' });
    expect(form.res.status).toBe(415); expect(form.read).not.toHaveBeenCalled();
    const big = await f.send(BODY, { length: '4097' }); expect(big.res.status).toBe(413); expect(big.read).not.toHaveBeenCalled();
    for (const raw of ['a'.repeat(4097), 'é'.repeat(2049)]) expect((await f.send(BODY, { raw })).res.status).toBe(413);
    expect((await f.send(BODY, { raw: 'a'.repeat(4096) })).res.json()).toEqual({ error: 'bad json' });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('a stalled body times out in 5 s with 408 and detaches its body listeners', async () => {
    vi.useFakeTimers(); const f = await setup(); const pending = f.send(BODY, { stall: true });
    await vi.advanceTimersByTimeAsync(5000); const { res, req } = await pending;
    expect(res.status).toBe(408); expect(res.json()).toEqual({ error: 'body timeout' });
    expect(req.listenerCount('data')).toBe(0); expect(req.listenerCount('end')).toBe(0); expect(f.rpc).not.toHaveBeenCalled();
  });

  it('validates fields before liveness; liveness before box; box before time; time before replay', async () => {
    const f = await setup(); f.following.mockReturnValue(false);
    expect((await f.send({ ...BODY, x: '@bad' })).res.status).toBe(400);
    const stopped = await f.send(); expect(stopped.res.status).toBe(503); expect(stopped.res.headers['retry-after']).toBe('10');
    expect(stopped.res.json()).toEqual({ error: 'not following' }); expect(f.creatorOf).not.toHaveBeenCalled();
    f.following.mockReturnValue(true); f.creatorOf.mockReturnValue(null);
    expect((await f.send({ ...BODY, issuedAt: String(HEAD.timestamp + 301n) })).res.json()).toEqual({ error: 'no box' });
    f.creatorOf.mockReturnValue(ACCOUNT.address); await f.service.save(row(String(HEAD.timestamp + 301n)));
    expect((await f.send({ ...BODY, issuedAt: String(HEAD.timestamp + 301n) })).res.json()).toEqual({ error: 'issuedAt ahead of chain' });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each(['?x=1', '/', '/extra'])('rejects raw suffix %s for GET and POST before body or RPC', async suffix => {
    const f = await setup();
    for (const method of ['POST', 'GET']) { const r = await f.send(BODY, { url: PATH + suffix, method }); expect(r.res.status).toBe(404); expect(r.read).not.toHaveBeenCalled(); }
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('rejects encoded, doubled and noncanonical paths; other POSTs never read a body', async () => {
    const f = await setup();
    for (const url of [PATH.replace('/links', '%2Flinks'), `${PATH}%2F`, PATH.replace('/links', '/%6cinks'),
      PATH.replace('/boxes/', '/boxes//'), PATH.replace('/v2/', '//v2/'), PATH.replace(`/${CHAIN}/`, `/0${CHAIN}/`)]) {
      for (const method of ['POST', 'GET']) { const r = await f.send(BODY, { url, method }); expect(r.res.status, url).toBe(404); expect(r.read).not.toHaveBeenCalled(); }
    }
    const other = await f.send(BODY, { url: '/v2/feed' }); expect(other.res.status).toBe(405); expect(other.read).not.toHaveBeenCalled();
    const chain = await f.send(BODY, { url: PATH.replace(String(CHAIN), '1'), type: 'bad' });
    expect(chain.res.status).toBe(404); expect(chain.res.json()).toEqual({ error: 'no chain' }); expect(chain.read).not.toHaveBeenCalled();
    const unknown = PATH.replace(TOKEN, `0x${'22'.repeat(20)}`);
    expect((await f.send(BODY, { url: unknown })).res.status).toBe(404);
    expect((await f.send(BODY, { url: unknown, method: 'GET' })).res.status).toBe(404);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it('logs no signature, link text or client IP and exposes no library error from links or catch-all', async () => {
    const f = await setup(); await f.send();
    f.rpc.mockRejectedValue(new Error('HTTP https://rpc.invalid/secret-key'));
    const unavailable = await f.send({ ...BODY, issuedAt: String(HEAD.timestamp + 1n), signature: '0x' });
    expect(unavailable.res.status).toBe(503); expect(unavailable.res.json()).toEqual({ error: 'signature check unavailable' });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await f.send(undefined, { url: '/v1/feed', method: 'GET' });
    expect(failed.res.status).toBe(500); expect(failed.res.json()).toEqual({ error: 'internal error' }); expect(errorLog).toHaveBeenCalledOnce();
    expect(unavailable.res.body + failed.res.body).not.toContain('https://rpc');
    const logs = JSON.stringify(f.log.mock.calls);
    for (const privateText of [SIGNATURE, LINKS.website, LINKS.x, LINKS.telegram, '198.51.100.17']) expect(logs).not.toContain(privateText);
  });
});

describe('LINKS-SRV ERC-1271 scripted calls and caps', () => {
  it('accepts only the exact ABI magic word at the applied hash, including empty Safe signatures', async () => {
    const f = await setup(); f.rpc.mockResolvedValue(ERC1271_MAGIC_WORD);
    const { res } = await f.send({ ...BODY, signature: '0x' });
    expect(res.status).toBe(200); expect(res.json()['record']).toMatchObject({ signerKind: 'erc1271', verifiedBlock: '123', signature: '0x' });
    expect(f.rpc).toHaveBeenCalledOnce(); const args = requiredV2(f.rpc.mock.calls[0]);
    expect(args[0]).toBe(ACCOUNT.address); expect(args[2]).toBe(HEAD.hash);
    expect(decodeFunctionData({ abi: ERC1271_ABI, data: args[1] }).args).toEqual([boxLinksDigest(CHAIN, TOKEN, BODY, BODY.issuedAt), '0x']);
  });

  it.each(['0x', '0x1626ba7e', `0x${'ff'.repeat(32)}`, `${ERC1271_MAGIC_WORD}00`, 'echo', 'code3', 'revert'])('rejects %s with 403 after one read', async answer => {
    const f = await setup();
    if (answer === 'code3' || answer === 'revert') f.rpc.mockRejectedValue(new RpcRequestError({
      body: {}, url: 'https://keyless.invalid', error: { code: answer === 'code3' ? 3 : -32000, message: answer === 'code3' ? 'bad signature' : 'execution reverted' },
    }));
    else if (answer === 'echo') f.rpc.mockImplementation(async (_to, data) => data);
    else f.rpc.mockResolvedValue(answer as Hex);
    const { res } = await f.send({ ...BODY, signature: '0x' }); expect(res.status).toBe(403); expect(f.rpc).toHaveBeenCalledOnce();
  });

  it.each([null, 123, {}])('a malformed non-hex RPC result %j is not the magic word', async result => {
    const f = await setup(); f.rpc.mockResolvedValue(result as unknown as Hex);
    expect((await f.send({ ...BODY, signature: '0x' })).res.status).toBe(403);
  });

  it.each(['timeout', 'HTTP error', 'transport reset', 'JSON-RPC error'])('%s gives fixed 503 and Retry-After', async error => {
    const f = await setup(); f.rpc.mockRejectedValue(new Error(`${error} https://rpc.invalid/key`));
    const { res } = await f.send({ ...BODY, signature: '0x' }); expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('10'); expect(res.json()).toEqual({ error: 'signature check unavailable' }); expect(f.rpc).toHaveBeenCalledOnce();
  });

  it('non-low-s or non-27/28 signatures never use the EOA fast path', async () => {
    const f = await setup();
    const s = BigInt(`0x${SIGNATURE.slice(66, 130)}`);
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const high = `${SIGNATURE.slice(0, 66)}${(order - s).toString(16).padStart(64, '0')}1b`;
    for (const signature of [high, `${SIGNATURE.slice(0, -2)}01`]) expect((await f.send({ ...BODY, signature })).res.status).toBe(403);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });

  it('the fifth simultaneous call returns busy immediately, with no queue; EOA still succeeds', async () => {
    const f = await setup(); let release!: (value: Hex) => void;
    const held = new Promise<Hex>(resolve => { release = resolve; }); f.rpc.mockReturnValue(held);
    const jobs = Array.from({ length: 4 }, () => f.send({ ...BODY, signature: '0x' }));
    await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(4));
    const busy = await f.send({ ...BODY, signature: '0x' }); expect(busy.res.status).toBe(503);
    expect(busy.res.json()).toEqual({ error: 'signature check busy' }); expect(busy.res.headers['retry-after']).toBe('10');
    expect((await f.send()).res.status).toBe(200); expect(f.rpc).toHaveBeenCalledTimes(4);
    release('0x'); await Promise.all(jobs);
  });

  it('the 21st call in a sliding minute is busy, then expires at 60 seconds', async () => {
    vi.useFakeTimers(); const f = await setup();
    for (let i = 0; i < 20; i++) expect((await f.send({ ...BODY, signature: '0x' })).res.status).toBe(403);
    expect((await f.send({ ...BODY, signature: '0x' })).res.json()).toEqual({ error: 'signature check busy' });
    expect(f.rpc).toHaveBeenCalledTimes(20); await vi.advanceTimersByTimeAsync(60_000);
    expect((await f.send({ ...BODY, signature: '0x' })).res.status).toBe(403); expect(f.rpc).toHaveBeenCalledTimes(21);
  });

  it('separate viem transport uses Tenderly with the Sepolia defaults, no fallback/retries, exact gas/hash and 3 s timeout', async () => {
    const rpc = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
      expect(body.method).toBe('eth_call'); expect(body.params).toEqual([{ to: ACCOUNT.address, data: '0x1234', gas: '0xf4240' }, { blockHash: HEAD.hash, requireCanonical: true }]);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: ERC1271_MAGIC_WORD }));
    }); vi.stubGlobal('fetch', rpc);
    const call = erc1271Rpc(SEPOLIA_PUBLIC_RPC_URLS);
    expect(await call(ACCOUNT.address, '0x1234', HEAD.hash)).toBe(ERC1271_MAGIC_WORD);
    expect(rpc.mock.calls[0]?.[0]).toBe('https://sepolia.gateway.tenderly.co/');
    rpc.mockResolvedValue(new Response('unavailable', { status: 500 }));
    await expect(call(ACCOUNT.address, '0x1234', HEAD.hash)).rejects.toThrow(); expect(rpc).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    rpc.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
    const timeout = call(ACCOUNT.address, '0x1234', HEAD.hash); const rejected = expect(timeout).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3000); await rejected; expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls.every(([url]) => url === 'https://sepolia.gateway.tenderly.co/')).toBe(true);
  });

  it.each(['eth_getCode', 'eth_call'])('real viem %s: one deadline spans delayed headers and a body ignoring abort', async method => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      signal = requiredV2(init.signal ?? undefined);
      const rpc = JSON.parse(String(init.body)) as { id: number };
      await new Promise(resolve => setTimeout(resolve, 1500));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: ERC1271_MAGIC_WORD })));
          controller.close();
        };
      } }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const rpc = erc1271Rpc(['https://keyless.invalid']);
    const pending = method === 'eth_getCode' ? rpc.getCode(ACCOUNT.address, HEAD.hash) : rpc(ACCOUNT.address, '0x1234', HEAD.hash);
    const settled = vi.fn(); void pending.then(() => settled('resolved'), () => settled('rejected'));
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).not.toHaveBeenCalled(); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled.mock.calls).toEqual([['rejected']]); expect(signal?.aborted).toBe(true);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(settled.mock.calls).toEqual([['rejected']]); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['eth_getCode', 'eth_call'])('real viem %s: stalled response bodies expire, abort, retry and release all four slots', async stalledMethod => {
    vi.useFakeTimers();
    const streams: { signal: AbortSignal; body: ReadableStream<Uint8Array>; aborted: boolean }[] = [];
    let stall = true;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const rpc = JSON.parse(String(init.body)) as { id: number; method: string };
      if (stall && rpc.method === stalledMethod) {
        const signal = requiredV2(init.signal ?? undefined);
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","result":"0x'));
          signal.addEventListener('abort', () => {
            requiredV2(streams.find(stream => stream.signal === signal)).aborted = true;
            controller.error(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        } });
        streams.push({ signal, body, aborted: false });
        // Headers arrive immediately; the real viem reader consumes the partial JSON and waits for the rest.
        return new Response(body, { headers: { 'Content-Type': 'application/json' } });
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'eth_getCode' ? '0x6000' : ERC1271_MAGIC_WORD });
    });
    vi.stubGlobal('fetch', fetch);
    const f = await setup();
    const links = new LinksV2({ chainId: CHAIN, store: f.service,
      verifier: new Erc1271Verifier(erc1271Rpc(['https://follower.invalid', 'https://keyless.invalid'])),
      following: f.following, creatorOf: token => token as Hex, head: f.head, log: f.log });
    const tokens = Array.from({ length: 5 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex);
    const post = (token: Hex) => links.post(request({ ...BODY, signature: '0x' }).req, token);
    const replies: Awaited<ReturnType<typeof post>>[] = [];
    const jobs = tokens.slice(0, 4).map(token => post(token).then(reply => { replies.push(reply); }));
    await vi.advanceTimersByTimeAsync(0);
    expect(streams).toHaveLength(4);
    expect(streams.every(stream => stream.body.locked && !stream.signal.aborted)).toBe(true);
    if (stalledMethod === 'eth_getCode') {
      // A second caller shares the failed creator's promise, even while all four read slots are occupied.
      jobs.push(post(requiredV2(tokens[0])).then(reply => { replies.push(reply); }));
      await vi.advanceTimersByTimeAsync(0);
      expect(streams).toHaveLength(4);
    }
    expect(await post(requiredV2(tokens[4]))).toMatchObject({ status: 503, body: { error: 'signature check busy' } });
    await vi.advanceTimersByTimeAsync(2999);
    expect(replies).toHaveLength(0);
    expect(streams.every(stream => !stream.signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    // Check settlement before awaiting jobs, so the unfixed implementation fails without a runner timeout.
    expect(replies).toHaveLength(jobs.length);
    await Promise.all(jobs);
    for (const reply of replies) expect(reply).toEqual({ status: 503, body: { error: 'signature check unavailable' },
      cache: 'no-store', headers: { 'Retry-After': '10' } });
    expect(streams.every(stream => stream.signal.aborted && stream.aborted && !stream.body.locked)).toBe(true);
    expect(new Set(streams.map(stream => stream.signal)).size).toBe(4);
    expect(tokens.every(token => f.service.get(token) === null)).toBe(true);

    stall = false;
    // Retrying the same four creators needs every slot back and, for failed code reads, fresh cache entries.
    const recovered = await Promise.all(tokens.slice(0, 4).map(post));
    expect(recovered.map(reply => reply.status)).toEqual([200, 200, 200, 200]);
    const methods = fetch.mock.calls.map(([, init]) => (JSON.parse(String(init.body)) as { method: string }).method);
    expect(methods.filter(method => method === 'eth_getCode')).toHaveLength(stalledMethod === 'eth_getCode' ? 8 : 4);
    expect(methods.filter(method => method === 'eth_call')).toHaveLength(stalledMethod === 'eth_call' ? 8 : 4);
    expect((await post(requiredV2(tokens[4]))).status).toBe(200);
    expect(fetch.mock.calls.every(([url]) => url === 'https://keyless.invalid/')).toBe(true);
    const completedSignals = fetch.mock.calls.map(([, init]) => requiredV2(init.signal ?? undefined)).filter(signal => !signal.aborted);
    await vi.advanceTimersByTimeAsync(3000);
    expect(completedSignals.every(signal => !signal.aborted)).toBe(true);
  });
});

it('LINKS-SRV real indexer: listed creators, feed, box and next SSE snapshot; follower never verifies links', async () => {
  const f = await setup();
  // No art-wait rows since SH-NO-PICTURE-GATE: every code-checked box is listed at once.
  for (const waiting of [false]) {
    const original = serviceBoxV2(); const box = { ...original, record: { ...original.record, creator: ACCOUNT.address } };
    const token = requiredV2(box.record.contracts[1]);
    const world = new World('links'); world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]); world.to(105n);
    const reader = serviceChainV2(world, [box]);
    const indexer = new CoreChainIndexer({ reader, manifest: synthManifestV2() });
    await indexer.start(); disposals.push(async () => indexer.stop());
    const service = new LinksService(new MemoryLinks(), indexer.chainId); await service.start(); disposals.push(() => service.stop());
    expect(indexer.v2CreatorOf(token)).toBe(box.record.creator);
    const follower = vi.spyOn(reader, 'callAt'); follower.mockClear();
    const wired = coreGatewaySource(indexer, reader, null, 60_000, Date.now, { links: service }); wired.updated();
    f.rpc.mockResolvedValue(ERC1271_MAGIC_WORD);
    const links = new LinksV2({ chainId: indexer.chainId, store: service, verifier: new Erc1271Verifier(f.rpc),
      following: () => wired.source.health().following, head: () => indexer.head(), creatorOf: t => indexer.v2CreatorOf(t), log: f.log });
    const gateway = new CoreGateway({ source: wired.source, links, port: 0, host: '127.0.0.1' });
    const head = requiredV2(indexer.head() ?? undefined);
    const body = await signed({ issuedAt: head.timestamp.toString() }, indexer.chainId, token);
    const req = request(body, { url: `/v2/boxes/${indexer.chainId}/${token}/links` }); const res = new ResponseDouble();
    await gateway.route(req.req, res.asResponse()); expect(res.status).toBe(200); expect(follower).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled(); expect(res.json()['record']).toHaveProperty('signerKind', 'eoa');
    if (waiting) { expect(wired.source.v2Box?.(token)).toBeNull(); continue; }
    const expected = { ...LINKS, issuedAt: body.issuedAt };
    expect(wired.source.v2Feed?.().cards[0]).toHaveProperty('links', expected);
    const get = new ResponseDouble(); await gateway.route(request(undefined, { method: 'GET', url: `/v2/boxes/${indexer.chainId}/${token}` }).req, get.asResponse());
    expect(get.json()['links']).toEqual(expected);
    const stream = new ResponseDouble(); await gateway.route(request(undefined, { method: 'GET', url: `/v2/boxes/${indexer.chainId}/${token}/stream` }).req, stream.asResponse());
    expect(stream.body).toContain(JSON.stringify(expected)); stream.body = '';
    await service.save({ ...row(String(head.timestamp + 1n)), chainId: indexer.chainId, token: token.toLowerCase(), x: 'next' });
    // Same callback that gateway.start registers, without opening a listener.
    const broadcast = () => (gateway as unknown as { broadcast(): void }).broadcast();
    const unsubscribe = wired.source.subscribe(broadcast); wired.updated(); unsubscribe();
    expect(stream.body).toContain('"x":"next"'); stream.destroy();
  }
});

it('LINKS-SRV a refused v2 row has no link rights, even with missing pictures', async () => {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]);
  const world = new World('links-refused'); world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]); world.to(105n);
  const reader = serviceChainV2(world, [box]); reader.codeAnswers = () => '0x';
  const indexer = new CoreChainIndexer({ reader, manifest: synthManifestV2() });
  await indexer.start(); disposals.push(async () => indexer.stop());
  expect(indexer.allRows()[0]?.verdict.classification).toBe('refused');
  expect(indexer.v2CreatorOf(token)).toBeNull();
});


describe('LINKS-SRV fix round 1 security properties', () => {
  it('caches code per creator across tokens and casing, and ordinary-wallet failures cannot spend the contract budget', async () => {
    const f = await setup(); f.code.mockResolvedValueOnce('0x'); f.rpc.mockResolvedValue(ERC1271_MAGIC_WORD);
    f.creatorOf.mockReturnValue(ACCOUNT.address);
    for (let i = 0; i < 25; i++) {
      f.creatorOf.mockReturnValue(i % 2 ? ACCOUNT.address.toLowerCase() as Hex : ACCOUNT.address);
      const { res } = await f.send({ ...BODY, signature: '0x' }, { url: PATH.replace(TOKEN, `0x${i.toString(16).padStart(40, '0')}`) });
      expect(res.status).toBe(403);
    }
    expect(f.code).toHaveBeenCalledOnce(); expect(f.rpc).not.toHaveBeenCalled();
    f.creatorOf.mockReturnValue(`0x${'22'.repeat(20)}`);
    expect((await f.send({ ...BODY, signature: '0x' })).res.status).toBe(200);
    expect(f.code).toHaveBeenCalledTimes(2); expect(f.rpc).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent code reads; a failed read is fixed 503, never an ERC-1271 call, and can retry', async () => {
    const f = await setup(); let reject!: (error: Error) => void;
    f.code.mockReturnValueOnce(new Promise<Hex>((_resolve, fail) => { reject = fail; }));
    const requests = Array.from({ length: 4 }, () => f.send({ ...BODY, signature: '0x' }));
    await vi.waitFor(() => expect(f.code).toHaveBeenCalledOnce());
    reject(new Error('execution reverted https://rpc.invalid/secret'));
    for (const { res } of await Promise.all(requests)) {
      expect(res.status).toBe(503); expect(res.json()).toEqual({ error: 'signature check unavailable' });
      expect(res.headers['retry-after']).toBe('10');
    }
    expect(f.rpc).not.toHaveBeenCalled(); f.code.mockResolvedValue('0x');
    expect((await f.send({ ...BODY, signature: '0x' })).res.status).toBe(403);
    expect(f.code).toHaveBeenCalledTimes(2); expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [200, { error: { code: 3, message: 'bad signature' } }, 403],
    [200, { error: { code: -32000, message: 'execution reverted: bad signature' } }, 403],
    [200, { error: { code: -32603, message: 'execution reverted' } }, 403],
    [200, { error: { code: -32000, message: 'upstream revert service unavailable' } }, 503],
    [200, { error: { message: 'execution reverted' } }, 503],
    [200, { error: { code: -32603, message: 'internal error' } }, 503],
    [503, 'execution reverted in upstream HTTP body', 503],
    [500, { error: { code: 3, message: 'execution reverted' } }, 503],
    [200, 'transport', 503],
  ])('real viem client: HTTP %s / %j yields %s', async (httpStatus, reply, expected) => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string };
      if (body.method === 'eth_getCode') return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x6000' });
      if (reply === 'transport') throw Object.assign(new Error('execution reverted transport'), { code: 3 });
      return typeof reply === 'string' ? new Response(reply, { status: httpStatus })
        : Response.json({ jsonrpc: '2.0', id: body.id, ...reply }, { status: httpStatus });
    }); vi.stubGlobal('fetch', fetch);
    const f = await setup();
    const links = new LinksV2({ chainId: CHAIN, store: f.service, verifier: new Erc1271Verifier(erc1271Rpc(['https://keyless.invalid'])),
      following: f.following, creatorOf: f.creatorOf, head: f.head, log: f.log });
    const response = await links.post(request({ ...BODY, signature: '0x' }).req, TOKEN);
    expect(response.status).toBe(expected);
    expect(response.body).toEqual({ error: expected === 403 ? 'not the creator' : 'signature check unavailable' });
    if (expected === 503) expect(response.headers).toEqual({ 'Retry-After': '10' });
    expect(fetch.mock.calls.filter(([, init]) => JSON.parse(String(init.body)).method === 'eth_call')).toHaveLength(1);
  });

  it.each(['put error', 'put timeout', 'reread error', 'reread timeout'])('database %s returns a fixed 503 with Retry-After', async mode => {
    vi.useFakeTimers();
    const sql = { query: vi.fn(async () => ({ rows: [] as Record<string, unknown>[] })), end: vi.fn(async () => undefined) };
    const f = await setup(new PgLinks(sql));
    const failure = () => mode.endsWith('timeout') ? new Promise<{ rows: Record<string, unknown>[] }>(() => undefined)
      : Promise.reject(Object.assign(new Error('failing row'), { detail: JSON.stringify(BODY), code: '23514' }));
    if (mode.startsWith('reread')) sql.query.mockResolvedValueOnce({ rows: [] });
    sql.query.mockImplementationOnce(failure);
    let response: Awaited<ReturnType<typeof f.send>> | undefined;
    void f.send().then(value => { response = value; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(response).toBeDefined();
    const { res } = requiredV2(response);
    expect(res.status).toBe(503); expect(res.json()).toEqual({ error: 'links store unavailable' });
    expect(res.headers['retry-after']).toBe('10'); expect(res.headers['cache-control']).toBe('no-store');
    expect(f.service.get(TOKEN)).toBeNull();
  });

  it('catch-all logs only error class and code, excluding row details, message, stack and cause', async () => {
    const error = Object.assign(new Error(`failed ${BODY.website}`), { code: '23514', detail: JSON.stringify(BODY),
      cause: new Error(SIGNATURE), query: LINKS.x });
    const source = { chainId: CHAIN, feed: () => { throw error; } } as unknown as CoreGatewaySource;
    const gateway = new CoreGateway({ source, port: 0, host: '127.0.0.1' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = new ResponseDouble(); await gateway.route(request(undefined, { url: '/v1/feed', method: 'GET' }).req, res.asResponse());
    expect(res.status).toBe(500); expect(res.json()).toEqual({ error: 'internal error' });
    expect(log.mock.calls).toEqual([['[core-gateway]', { class: 'Error', code: '23514' }]]);
  });

  it.each(['/v2/stats?chain=', '/v1/feed?chain=', '/v2/feed?chain=', '/v1/wallets/', '/v1/boxes/', '/v2/boxes/'])('GET %s never echoes input in its error', async prefix => {
    const f = await setup();
    for (const input of ['secret-sentinel', '%3Cscript%3E', '999999999999']) {
      const url = prefix + input + (prefix.endsWith('/') ? `/${TOKEN}` : '');
      const { res } = await f.send(undefined, { url, method: 'GET' });
      expect(res.status).toBe(404); expect(res.json()).toEqual({ error: 'no chain here' });
    }
  });
});
