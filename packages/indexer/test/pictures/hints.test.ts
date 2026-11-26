import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { PictureHints, HINT_LIMITS } from '../../src/pictures/hints';
import { PictureCopiesService } from '../../src/pictures/service';
import { MemoryPictureCopies } from '../../src/pictures/store';
import { RAW_GATEWAYS } from '../../src/pictures/discovery';

const bytes = new Uint8Array(128 * 1024).fill(7);
const hash = createHash('sha256').update(bytes).digest('hex');
const box = `0x${'a'.repeat(40)}`;
const id = 'b'.repeat(43);
const spec = { coverSha256: hash, collectionCoverSha256: hash };
const body = { chainId: 11155111, box, kind: 'logo', arweaveId: id };
const request = (value: unknown = body, headers: Record<string, string> = {}) => Object.assign(
  Readable.from([typeof value === 'string' ? value : JSON.stringify(value)]),
  { headers: { 'content-type': 'application/json', ...headers }, complete: true },
) as unknown as IncomingMessage;
function setup(fetcher: typeof fetch = vi.fn(async () => new Response(bytes))) {
  const store = new MemoryPictureCopies();
  const service = new PictureCopiesService(store, { fetch: fetcher });
  let now = 0;
  const options = { chainId: body.chainId, pictures: service, following: () => true,
    specOf: (address: string) => address === box ? spec : null, now: () => now };
  const hints = new PictureHints(options);
  return { store, service, fetcher, options, hints, advance: () => { now += 60_000; } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['logo', 'cover'])('accepts %s only after hashing up to 128 KiB; replay is free and another verified ID cannot replace it', async kind => {
  const f = setup();
  const accepted = await f.hints.post(request({ ...body, kind }), 'client');
  expect(accepted).toMatchObject({ status: 200, body: { arweaveId: id } });
  expect(await f.store.get(hash)).toBe(id);
  expect(f.service.visible(spec)).toHaveProperty(`pictureCopies.${kind}.arweaveId`, id);
  expect(await f.hints.post(request({ ...body, kind }), 'client')).toEqual(accepted);
  expect(await f.hints.post(request({ ...body, arweaveId: 'c'.repeat(43) }), 'client'))
    .toMatchObject({ status: 409, body: { error: 'already verified' } });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  await f.service.stop();
  const fetcher = vi.fn<typeof fetch>();
  const restarted = new PictureCopiesService(f.store, { fetch: fetcher });
  await restarted.run([spec]);
  expect(restarted.visible(spec)).toHaveProperty('pictureCopies.logo.arweaveId', id);
  await restarted.run([]); expect(restarted.visible(spec)).toEqual({});
  await restarted.run([spec]);
  expect(restarted.visible(spec)).toHaveProperty('pictureCopies.logo.arweaveId', id);
  expect(fetcher).not.toHaveBeenCalled();
  await restarted.stop();
});

it.each(['wrong', 'oversized', 'declared', 'redirect'])('refuses %s bytes, never records, and never leaves the gateway allowlist', async mode => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(RAW_GATEWAYS).toContain(new URL(String(input)).origin);
    expect(new URL(String(input)).pathname).toBe(`/${id}`);
    expect(init?.redirect).toBe('error');
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/picture' } });
    return new Response(mode === 'oversized' ? new Uint8Array(128 * 1024 + 1) : mode === 'wrong' ? 'wrong' : bytes,
      { headers: mode === 'declared' ? { 'content-length': '131073' } : {} });
  });
  const f = setup(fetcher);
  if (mode === 'oversized') {
    const largeHash = createHash('sha256').update(new Uint8Array(128 * 1024 + 1)).digest('hex');
    f.options.specOf = () => ({ ...spec, coverSha256: largeHash });
  }
  expect(await f.hints.post(request(), 'client')).toMatchObject({ status: 422, body: { error: 'unverified picture' } });
  expect(await f.store.get(hash)).toBeNull(); expect(f.service.visible(spec)).toEqual({});
  expect(fetcher).toHaveBeenCalledTimes(2); await f.service.stop();
});

it.each([
  [{ ...body, box: `0x${'c'.repeat(40)}` }, 404, 'no box'],
  [{ ...body, chainId: 1 }, 404, 'no chain'],
  [{ ...body, kind: 'avatar' }, 400, 'bad hint'],
  [{ ...body, arweaveId: 'https://evil.invalid/image' }, 400, 'bad hint'],
  [{ ...body, hash }, 400, 'bad hint'],
  ['{', 400, 'bad json'],
] as const)('refuses invalid hints before fetching: %j', async (value, status, reason) => {
  const f = setup();
  expect(await f.hints.post(request(value), 'client')).toMatchObject({ status, body: { error: reason } });
  expect(f.fetcher).not.toHaveBeenCalled(); expect(await f.store.get(hash)).toBeNull(); await f.service.stop();
});

it('requires JSON, bounds declared and streamed bodies, and times out stalled bodies', async () => {
  const f = setup();
  expect((await f.hints.post(request(body, { 'content-type': 'text/plain' }), 'client')).status).toBe(415);
  expect((await f.hints.post(request(body, { 'content-encoding': 'gzip' }), 'client')).status).toBe(415);
  expect((await f.hints.post(request(body, { 'content-length': '9999999999999999999999' }), 'client')).status).toBe(413);
  expect((await f.hints.post(request(' '.repeat(HINT_LIMITS.bodyBytes + 1)), 'client')).status).toBe(413);
  vi.useFakeTimers();
  const req = Object.assign(new Readable({ read() { /* stall */ } }), { headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
  const pending = f.hints.post(req, 'client');
  await vi.advanceTimersByTimeAsync(HINT_LIMITS.bodyMs);
  expect(await pending).toMatchObject({ status: 408, body: { error: 'body timeout' } });
  expect(f.fetcher).not.toHaveBeenCalled(); await f.service.stop(); expect(vi.getTimerCount()).toBe(0);
});

it('bounds per-client and global starts, expires them, and caps active requests without queueing', async () => {
  const f = setup();
  for (let n = 0; n < HINT_LIMITS.perClient; n++) expect((await f.hints.post(request('{'), 'one')).status).toBe(400);
  expect((await f.hints.post(request(), 'one')).status).toBe(429);
  for (let n = HINT_LIMITS.perClient; n < HINT_LIMITS.perMinute; n++) await f.hints.post(request('{'), `client-${n}`);
  expect((await f.hints.post(request(), 'new')).status).toBe(503);
  f.advance(); expect((await f.hints.post(request(), 'one')).status).toBe(200);
  expect(f.fetcher).toHaveBeenCalledTimes(1); await f.service.stop();
  vi.useFakeTimers();
  const held = setup(vi.fn(async () => new Promise<Response>(() => undefined)));
  const pending = Array.from({ length: HINT_LIMITS.concurrent }, (_, n) => held.hints.post(request(), `client-${n}`));
  expect((await held.hints.post(request(), 'extra')).status).toBe(503);
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await Promise.all(pending)).every(reply => reply.status === 422)).toBe(true);
  expect(held.fetcher).toHaveBeenCalledTimes(HINT_LIMITS.concurrent * 2);
  await held.service.stop(); expect(vi.getTimerCount()).toBe(0);
});

it('requires a current commitment and refuses a reorg during byte verification', async () => {
  const f = setup();
  f.options.specOf = () => ({ ...spec, coverSha256: '0'.repeat(64) });
  expect((await f.hints.post(request(), 'client')).status).toBe(422);
  f.options.following = () => false;
  expect((await f.hints.post(request(), 'client')).status).toBe(503);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.options.following = () => true; f.options.specOf = () => spec;
  vi.mocked(f.fetcher).mockImplementation(async () => { f.options.specOf = () => null; return new Response(bytes); });
  expect(await f.hints.post(request(), 'client')).toMatchObject({ status: 409, body: { error: 'box changed' } });
  expect(await f.store.get(hash)).toBeNull(); await f.service.stop();
});

it('publishes nothing on store failure and keeps the winner if discovery races a hint', async () => {
  const f = setup();
  vi.spyOn(f.store, 'put').mockRejectedValueOnce(new Error('offline'));
  expect((await f.hints.post(request(), 'client')).status).toBe(503);
  expect(f.service.visible(spec)).toEqual({}); expect(await f.store.get(hash)).toBeNull();
  vi.mocked(f.fetcher).mockImplementation(async () => { await f.store.put(hash, 'c'.repeat(43)); return new Response(bytes); });
  expect((await f.hints.post(request(), 'client')).status).toBe(409);
  expect(await f.store.get(hash)).toBe('c'.repeat(43)); await f.service.stop();
});


it('falls back after a stalled body and aborts outstanding verification on shutdown', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const f = setup(vi.fn(async input => String(input).startsWith(RAW_GATEWAYS[0] as string)
    ? new Response(new ReadableStream({ cancel })) : new Response(bytes)));
  const pending = f.hints.post(request(), 'client');
  await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).status).toBe(200); expect(cancel).toHaveBeenCalledTimes(1);
  await f.service.stop();
  const stopping = setup(vi.fn(async () => new Promise<Response>(() => undefined)));
  const refused = stopping.hints.post(request(), 'client');
  await vi.advanceTimersByTimeAsync(0);
  await stopping.service.stop();
  expect((await refused).status).not.toBe(200);
  expect(await stopping.store.get(hash)).toBeNull(); expect(vi.getTimerCount()).toBe(0);
});

it('maps logo to field 23 and cover to field 28 with different commitments', async () => {
  const f = setup();
  const logoHash = createHash('sha256').update('a different logo').digest('hex');
  const separate = { coverSha256: logoHash, collectionCoverSha256: hash };
  f.options.specOf = () => separate;
  expect((await f.hints.post(request(), 'client')).status).toBe(422);
  expect(await f.store.get(logoHash)).toBeNull();
  expect((await f.hints.post(request({ ...body, kind: 'cover' }), 'client')).status).toBe(200);
  expect(f.service.visible(separate)).toEqual({ pictureCopies: { cover: { arweaveId: id } } });
  await f.service.stop();
});
