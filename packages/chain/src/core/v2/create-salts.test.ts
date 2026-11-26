import * as viem from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCreate2Address, isAddress, toHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import { HOOK_PAUSE_EVERY_TRIES, findCreateSaltsV2, isHookHashV2, type CreateSaltInputsV2, type CreateSaltsV2 } from './create-salts';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { vectors, reserved } from '../../../test/fixtures/create-v2/vectors';

vi.mock('viem', async (original) => ({ ...await original<typeof import('viem')>() }));

const address = (n: bigint) => toHex(n, { size: 20 });
const provider = (token = address(2n)) => vi.fn(async () => [address(40n), token, zeroHash] as const);

afterEach(() => vi.restoreAllMocks());

describe('factory salt search', () => {
  it.each(vectors)('reproduces the Solidity predictBox sequence and first mined pair ($cs)', async v => {
    const seen: string[] = [];
    const result = await findCreateSaltsV2({ priceToken: v.priceToken, tokenAddressLimit: v.tokenAddressLimit,
      predictBox: async cs => {
        seen.push(cs);
        const p = v.predictions.find((_, index) => BigInt(index) === BigInt(cs));
        if (!p) throw new Error('unexpected prediction');
        return [p.coordinator, p.token, p.initHash];
      } });
    expect(result).toEqual({ cs: v.cs, hs: v.hs, coordinator: v.coordinator, token: v.token, hook: v.hook });
    expect(seen).toEqual(v.predictions.map((_, i) => toHex(i, { size: 32 })));
  });

  it('rejects both token boundaries and stops after the exact coordinator budget', async () => {
    for (const token of [address(1n), address(3n)]) {
      const predictBox = provider(token);
      await expect(findCreateSaltsV2({ priceToken: address(1n), tokenAddressLimit: address(3n), predictBox,
        maxCoordinatorAttempts: 2n })).rejects.toThrow('coordinator salt search exhausted');
      expect(predictBox.mock.calls).toHaveLength(2);
    }
  });

  it('stops after the hook budget, without probing a second coordinator', async () => {
    const predictBox = provider();
    await expect(findCreateSaltsV2({ priceToken: zeroAddress, tokenAddressLimit: address(3n), predictBox,
      maxHookAttempts: 1n })).rejects.toThrow('hook salt search exhausted');
    expect(predictBox).toHaveBeenCalledTimes(1);
  });

  it('bounds inputs and propagates a failed prediction without retrying', async () => {
    for (const overrides of [{ maxCoordinatorAttempts: 0n }, { maxCoordinatorAttempts: 4097n },
      { maxHookAttempts: 0n }, { maxHookAttempts: 1_000_001n }, { coordinatorSaltStart: -1n },
      { coordinatorSaltStart: (1n << 256n) - 1n }, { priceToken: '0x1234' as Address }]) {
      const predictBox = provider();
      await expect(findCreateSaltsV2({ priceToken: zeroAddress, tokenAddressLimit: address(3n), predictBox, ...overrides })).rejects.toThrow();
      expect(predictBox).not.toHaveBeenCalled();
    }
    const predictBox = vi.fn(async () => { throw new Error('pinned read failed'); });
    await expect(findCreateSaltsV2({ priceToken: zeroAddress, tokenAddressLimit: address(3n), predictBox })).rejects.toThrow('pinned read failed');
    expect(predictBox).toHaveBeenCalledTimes(1);
  });

  it('never returns the reserved 0x91 prefix even with correct hook flags', async () => {
    expect(getCreate2Address({ from: reserved.coordinator, salt: reserved.hs, bytecodeHash: reserved.initHash })).toBe(reserved.hook);
    expect(BigInt(reserved.hook) >> 152n).toBe(0x91n);
    expect(BigInt(reserved.hook) & 0x3fffn).toBe(0x2ae0n);
    await expect(findCreateSaltsV2({ priceToken: zeroAddress, tokenAddressLimit: address(3n), predictBox: provider(),
      hookSaltStart: BigInt(reserved.hs), maxHookAttempts: 1n })).rejects.toThrow('hook salt search exhausted');
  });
});

/** The search as it was before SH-212 (hex strings and getCreate2Address on every try): the reference the fast one must equal. */
async function referenceSearch(input: CreateSaltInputsV2): Promise<CreateSaltsV2> {
  const { priceToken, tokenAddressLimit, predictBox, coordinatorSaltStart = 0n, hookSaltStart = 0n,
    maxCoordinatorAttempts = 4096n, maxHookAttempts = 1_000_000n } = input;
  const range = (start: bigint, attempts: bigint, cap: bigint) => start >= 0n && attempts > 0n
    && attempts <= cap && start + attempts <= 1n << 256n;
  if (!isAddress(priceToken) || !isAddress(tokenAddressLimit) || BigInt(tokenAddressLimit) <= BigInt(priceToken)
    || !range(coordinatorSaltStart, maxCoordinatorAttempts, 4096n) || !range(hookSaltStart, maxHookAttempts, 1_000_000n)) {
    throw new RangeError('invalid creation salt search bounds');
  }
  for (let i = 0n; i < maxCoordinatorAttempts; i++) {
    const cs = toHex(coordinatorSaltStart + i, { size: 32 });
    const [coordinator, token, initHash] = await predictBox(cs);
    if (!isAddress(coordinator) || coordinator === zeroAddress || !isAddress(token) || !/^0x[\da-f]{64}$/i.test(initHash)) {
      throw new Error('invalid predictBox result');
    }
    if (BigInt(token) <= BigInt(priceToken) || BigInt(token) >= BigInt(tokenAddressLimit)) continue;
    for (let j = 0n; j < maxHookAttempts; j++) {
      const hs = toHex(hookSaltStart + j, { size: 32 });
      const hook = getCreate2Address({ from: coordinator, salt: hs, bytecodeHash: initHash });
      if ((BigInt(hook) & 0x3fffn) === 0x2ae0n && BigInt(hook) >> 152n !== 0x91n) return { cs, hs, coordinator, token, hook };
    }
    throw new Error('hook salt search exhausted');
  }
  throw new Error('coordinator salt search exhausted');
}

/** A seeded generator (mulberry32), so a failure replays. */
function prng(seed: number) {
  let a = seed >>> 0;
  const u32 = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0); };
  const bytes = (n: number): Hex => `0x${Array.from({ length: n }, () => (u32() & 0xff).toString(16).padStart(2, '0')).join('')}`;
  const bits = (n: number): bigint => { let v = 0n; for (let i = 0; i < n; i += 32) v = (v << 32n) | BigInt(u32()); return v & ((1n << BigInt(n)) - 1n); };
  return { u32, bytes, bits };
}
const outcome = async (run: () => Promise<CreateSaltsV2>) => { try { return { ok: await run() }; } catch (e) { return { error: (e as Error).message }; } };
const providing = (coordinator: Address, initHash: Hex) => async () => [coordinator, address(2n), initHash] as const;
const search = (coordinator: Address, initHash: Hex, extra: Partial<CreateSaltInputsV2> = {}): CreateSaltInputsV2 =>
  ({ priceToken: zeroAddress, tokenAddressLimit: address(3n), predictBox: providing(coordinator, initHash), ...extra });
const FIXTURE = { coordinator: '0x00000000000000000000000000000000000c0071' as Address,
  initHash: '0x56570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea7432' as Hex,
  hs: '0x000000000000000000000000000000000000000000000000000000000000c0a1' as Hex, hook: '0x324885317fD50E9bDB989CF0525271afBF002AE0' as Address, tries: 49_314n };
const lastOf = (hs: Hex) => BigInt(hs);

describe('the fast search equals the old one (SH-212)', () => {
  it('pins the browser fixture: found after 49,314 tries, the same hook, and the reference agrees', { timeout: shLimit(60_000) }, async () => {
    const fast = await findCreateSaltsV2(search(FIXTURE.coordinator, FIXTURE.initHash));
    expect(fast).toEqual({ cs: toHex(0n, { size: 32 }), hs: FIXTURE.hs, coordinator: FIXTURE.coordinator, token: address(2n), hook: FIXTURE.hook });
    expect(lastOf(fast.hs) + 1n).toBe(FIXTURE.tries);
    expect(await referenceSearch(search(FIXTURE.coordinator, FIXTURE.initHash))).toEqual(fast);
    // One try fewer than the hit: exhausted; exactly up to the hit: found.
    await expect(findCreateSaltsV2(search(FIXTURE.coordinator, FIXTURE.initHash, { hookSaltStart: lastOf(FIXTURE.hs) - 3n, maxHookAttempts: 3n })))
      .rejects.toThrow('hook salt search exhausted');
    expect((await findCreateSaltsV2(search(FIXTURE.coordinator, FIXTURE.initHash, { hookSaltStart: lastOf(FIXTURE.hs) - 3n, maxHookAttempts: 4n }))).hs).toBe(FIXTURE.hs);
  });

  it('equals the reference on 300 random pairs with random start salts (full output or the same error)', { timeout: shLimit(120_000) }, async () => {
    const r = prng(0x5e212);
    for (let n = 0; n < 300; n++) {
      const coordinator = toHex(r.bits(160) | 1n, { size: 20 });
      const initHash = r.bytes(32);
      const attempts = 1n + r.bits(32) % 400n;
      const width = 1 + r.u32() % 256;
      const hookSaltStart = r.bits(width) % ((1n << 256n) - attempts + 1n);
      const coordinatorSaltStart = r.bits(1 + r.u32() % 60);
      const input = search(coordinator, initHash, { hookSaltStart, maxHookAttempts: attempts, coordinatorSaltStart, maxCoordinatorAttempts: 3n });
      const expected = await outcome(() => referenceSearch(input));
      expect(await outcome(() => findCreateSaltsV2(input)), `pair ${n}`).toEqual(expected);
    }
  });

  it('finds hits across the counter carries and returns what the reference returns', { timeout: shLimit(120_000) }, async () => {
    const r = prng(0xca77);
    const boundaries = [0x100n, 0x10000n, 1n << 24n, 1n << 32n, 1n << 40n, 1n << 64n, 1n << 128n, 1n << 255n, (1n << 256n) - 256n];
    for (const boundary of boundaries) {
      let seen = false;
      for (let trial = 0; trial < 4000 && !seen; trial++) {
        const coordinator = toHex(r.bits(160) | 1n, { size: 20 });
        const initHash = r.bytes(32);
        const input = search(coordinator, initHash, { hookSaltStart: boundary - 20n, maxHookAttempts: 250n });
        const got = await outcome(() => findCreateSaltsV2(input));
        if (got.ok === undefined || BigInt(got.ok.hs) < boundary) continue; // the hit must come after the carry
        seen = true;
        expect(await referenceSearch(input), `boundary ${boundary.toString(16)}`).toEqual(got.ok);
      }
      expect(seen, `a hit after the carry at ${boundary.toString(16)}`).toBe(true);
    }
  });

  it('equals the reference at the carry boundaries and the top of the range with tiny attempt limits', async () => {
    const r = prng(0xb0b);
    const starts = [0xffn, 0xfffen, 0xffffn, 0xffffffn, (1n << 32n) - 1n, (1n << 64n) - 1n, (1n << 128n) - 1n, (1n << 255n) - 1n,
      (1n << 256n) - 3n, (1n << 256n) - 2n, (1n << 256n) - 1n];
    for (const start of starts) {
      for (let n = 0; n < 8; n++) {
        const attempts = BigInt(1 + n % 3);
        const input = search(toHex(r.bits(160) | 1n, { size: 20 }), r.bytes(32), { hookSaltStart: start, maxHookAttempts: attempts });
        expect(await outcome(() => findCreateSaltsV2(input))).toEqual(await outcome(() => referenceSearch(input)));
      }
    }
    // The range check is unchanged at the top: one past 2^256 is refused before anything is asked.
    const predictBox = provider();
    await expect(findCreateSaltsV2({ priceToken: zeroAddress, tokenAddressLimit: address(3n), predictBox, hookSaltStart: (1n << 256n) - 1n, maxHookAttempts: 2n })).rejects.toThrow(RangeError);
    expect(predictBox).not.toHaveBeenCalled();
  });

  it('gives the same exhaustion errors with small limits, and the same bounds errors', async () => {
    const r = prng(0xe4);
    for (const overrides of [{ maxHookAttempts: 1n }, { maxHookAttempts: 7n, hookSaltStart: 5n }, { maxCoordinatorAttempts: 1n, maxHookAttempts: 2n },
      { maxCoordinatorAttempts: 0n }, { maxCoordinatorAttempts: 4097n }, { maxHookAttempts: 0n }, { maxHookAttempts: 1_000_001n },
      { hookSaltStart: -1n }, { coordinatorSaltStart: (1n << 256n) - 1n }, { hookSaltStart: (1n << 256n) - 1n, maxHookAttempts: 2n },
      { priceToken: '0x1234' as Address }, { priceToken: address(3n) }]) {
      const input = search(toHex(r.bits(160) | 1n, { size: 20 }), r.bytes(32), overrides);
      expect(await outcome(() => findCreateSaltsV2(input)), JSON.stringify(overrides, (_, v) => typeof v === 'bigint' ? v.toString() : v))
        .toEqual(await outcome(() => referenceSearch(input)));
    }
    await expect(findCreateSaltsV2(search(address(40n), zeroHash, { maxHookAttempts: 2n }))).rejects.toThrow('hook salt search exhausted');
    await expect(findCreateSaltsV2({ ...search(address(40n), zeroHash), priceToken: address(1n), predictBox: async () => [address(40n), address(1n), zeroHash] as const, maxCoordinatorAttempts: 2n }))
      .rejects.toThrow('coordinator salt search exhausted');
  });

  it('refuses an invalid pause interval and does not call predictBox for it', async () => {
    for (const pauseEveryTries of [0, -1, 1.5, Number.NaN, Infinity]) {
      const predictBox = provider();
      await expect(findCreateSaltsV2({ priceToken: zeroAddress, tokenAddressLimit: address(3n), predictBox, pauseEveryTries })).rejects.toThrow(RangeError);
      expect(predictBox).not.toHaveBeenCalled();
    }
  });
});

describe('the hook rule on hash bytes (SH-212)', () => {
  const hashWith = (fill: (h: Uint8Array) => void) => { const h = new Uint8Array(32); fill(h); return h; };
  const rule = (h: Uint8Array) => { const a = BigInt(`0x${Buffer.from(h.subarray(12)).toString('hex')}`); return (a & 0x3fffn) === 0x2ae0n && a >> 152n !== 0x91n; };

  it('accepts the low 14 bits 0x2ae0 and nothing else, and refuses the reserved first byte 0x91', () => {
    const ok = (first: number, b30: number, b31: number) => isHookHashV2(hashWith(h => { h[12] = first; h[30] = b30; h[31] = b31; }));
    expect(ok(0x12, 0x2a, 0xe0)).toBe(true);
    expect(ok(0x00, 0x2a, 0xe0)).toBe(true);
    expect(ok(0x90, 0x2a, 0xe0)).toBe(true);
    expect(ok(0x92, 0x2a, 0xe0)).toBe(true);
    expect(ok(0xff, 0x2a, 0xe0)).toBe(true);
    expect(ok(0x91, 0x2a, 0xe0)).toBe(false); // right flags, reserved prefix
    expect(ok(0x91, 0x2a, 0xe1)).toBe(false);
    expect(ok(0x12, 0xea, 0xe0)).toBe(true); // the two high bits of byte 30 are outside the 14 bits
    expect(ok(0x12, 0x6a, 0xe0)).toBe(true);
    expect(ok(0x12, 0xaa, 0xe0)).toBe(true);
    expect(ok(0x12, 0x2b, 0xe0)).toBe(false);
    expect(ok(0x12, 0x2a, 0xe1)).toBe(false);
    expect(ok(0x12, 0x2a, 0xf0)).toBe(false);
    expect(ok(0x12, 0x0a, 0xe0)).toBe(false);
    expect(ok(0x12, 0x3a, 0xe0)).toBe(false);
    expect(isHookHashV2(new Uint8Array(31))).toBe(false);
  });

  it('agrees with the bigint rule on 4,000 random hashes, half of them with the right low bits', () => {
    const r = prng(0x91);
    let hits = 0;
    for (let n = 0; n < 4000; n++) {
      const h = Uint8Array.from({ length: 32 }, () => r.u32() & 0xff);
      if (n % 2 === 0) { h[30] = ((h[30] ?? 0) & 0xc0) | 0x2a; h[31] = 0xe0; }
      if (n % 8 === 0) h[12] = 0x91;
      expect(isHookHashV2(h), `hash ${n}`).toBe(rule(h));
      if (rule(h)) hits++;
    }
    expect(hits).toBeGreaterThan(1000);
  });

  it('excludes the reserved prefix in the search itself (the pinned reserved pair)', async () => {
    const hook = await findCreateSaltsV2(search(reserved.coordinator, reserved.initHash, { hookSaltStart: BigInt(reserved.hs) + 1n, maxHookAttempts: 400_000n }));
    expect(BigInt(hook.hook) >> 152n).not.toBe(0x91n);
    expect(BigInt(hook.hs)).toBeGreaterThan(BigInt(reserved.hs));
  }, shLimit(60_000));
});

describe('pausing a long search (SH-212)', () => {
  const near = (tries: bigint) => ({ hookSaltStart: lastOf(FIXTURE.hs) + 1n - tries, maxHookAttempts: tries + 5n });

  it('keeps the default pause interval between 256 and 4,096 tries', () => {
    // Integrator decision (SH-212): 2,048. The bounds are a guard against an accidental change, not a timing promise.
    expect(HOOK_PAUSE_EVERY_TRIES).toBeGreaterThanOrEqual(256);
    expect(HOOK_PAUSE_EVERY_TRIES).toBeLessThanOrEqual(4_096);
  });

  it('calls the pause after each interval of tries while the search goes on, never for a short search', async () => {
    const pause = vi.fn(async () => undefined);
    const base = search(FIXTURE.coordinator, FIXTURE.initHash, { pauseEveryTries: 1000, pause });
    // Found at try 999, 1000: no pause (the pause comes before the next try); at try 1001: one; 2500: two; 3000: two; 3001: three.
    for (const [tries, calls] of [[1n, 0], [999n, 0], [1000n, 0], [1001n, 1], [2500n, 2], [3000n, 2], [3001n, 3]] as const) {
      pause.mockClear();
      const got = await findCreateSaltsV2({ ...base, ...near(tries) });
      expect(got.hs, `${tries} tries`).toBe(FIXTURE.hs);
      expect(pause, `${tries} tries`).toHaveBeenCalledTimes(calls);
    }
    // Exhaustion after 2,000 tries: one pause, before try 1001; none after the last try.
    pause.mockClear();
    await expect(findCreateSaltsV2({ ...base, hookSaltStart: 0n, maxHookAttempts: 2000n })).rejects.toThrow('hook salt search exhausted');
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('waits for the pause before the next try, and the result is the same with and without it', async () => {
    let release: () => void = () => undefined;
    const events: string[] = [];
    const pause = vi.fn(() => { events.push('pause'); return new Promise<void>(resolve => { release = resolve; }); });
    const input = search(FIXTURE.coordinator, FIXTURE.initHash, { pauseEveryTries: 500, pause, ...near(900n) });
    const running = findCreateSaltsV2(input).then(v => { events.push('done'); return v; });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(events).toEqual(['pause']);
    release();
    const paused = await running;
    expect(events).toEqual(['pause', 'done']);
    expect(await findCreateSaltsV2(search(FIXTURE.coordinator, FIXTURE.initHash, near(900n)))).toEqual(paused);
    expect(paused.hook).toBe(FIXTURE.hook);
  });

  it('pauses after every default interval on the 49,314-try fixture, and an error from the pause ends the search with it', { timeout: shLimit(60_000) }, async () => {
    const pause = vi.fn(async () => undefined);
    const got = await findCreateSaltsV2(search(FIXTURE.coordinator, FIXTURE.initHash, { pause }));
    expect(got.hook).toBe(FIXTURE.hook);
    // Before try N + 1, 2N + 1, ... while tries remain: floor((49,314 - 1) / N) pauses.
    expect(pause).toHaveBeenCalledTimes(Math.floor((49_314 - 1) / HOOK_PAUSE_EVERY_TRIES));
    expect(pause).toHaveBeenCalledTimes(24);
    await expect(findCreateSaltsV2(search(FIXTURE.coordinator, FIXTURE.initHash, { pause: async () => { throw new Error('page closed'); }, pauseEveryTries: 10, ...near(100n) })))
      .rejects.toThrow('page closed');
  });
});

describe('SH-212 af1 prediction and hit checks', () => {
  it.each([`0X${'00'.repeat(32)}`, `0x${'00'.repeat(31)}`, `0x${'00'.repeat(33)}`, `0x${'gg'.repeat(32)}`, `${'00'.repeat(32)}`, `0x${'00'.repeat(32)}\n`, null, { toString: () => zeroHash }])(
    'refuses malformed init hash %s before a hook try', async (initHash) => {
      const hash = vi.spyOn(viem, 'keccak256');
      const predictBox = vi.fn(() => [address(40n), address(2n), initHash as unknown as Hex] as const);
      await expect(findCreateSaltsV2({ priceToken: address(0n), tokenAddressLimit: address(3n), predictBox }))
        .rejects.toThrow('invalid predictBox result');
      expect(predictBox).toHaveBeenCalledOnce();
      expect(hash).not.toHaveBeenCalled();
    },
  );

  it('refuses a byte hit when getCreate2Address disagrees', async () => {
    const hit = new Uint8Array(32);
    hit[30] = 0x2a; hit[31] = 0xe0;
    vi.spyOn(viem, 'keccak256').mockReturnValue(hit as never);
    const crossCheck = vi.spyOn(viem, 'getCreate2Address').mockReturnValue(address(1n));
    await expect(findCreateSaltsV2(search(address(40n), zeroHash, { maxHookAttempts: 1n })))
      .rejects.toThrow('hook salt search disagrees with CREATE2');
    expect(crossCheck).toHaveBeenCalledOnce();
  });
});
