import { expect, it, vi } from 'vitest';
import { toHex, type Hex, type PublicClient } from 'viem';
import { HookCodeCache } from '../src/hook-code';
import { addr } from './support/v2';

const clone = `0x363d3d373d3d3d363d73${'ab'.repeat(20)}5af43d82803e903d91602b57fd5bf3` as Hex;
const hash = (n: bigint) => toHex(n, { size: 32 });
const fixture = (code: Hex | undefined = clone) => {
  const getBytecode = vi.fn(async (): Promise<Hex | undefined> => code);
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: hash(blockNumber) }));
  const pub = { getBytecode, getBlock } as unknown as PublicClient;
  return { cache: new HookCodeCache(), pub, getBytecode, getBlock };
};

it('BATCH-3 replaces three verified clone-code reads with one canonicality check per advancing block', async () => {
  const f = fixture();
  await f.cache.begin(f.pub, 10n, hash(10n));
  for (const hook of [addr(1), addr(2), addr(3)]) expect(await f.cache.minimum(f.pub, hook, 10n)).toBeUndefined();
  expect(f.getBytecode).toHaveBeenCalledTimes(3);
  await f.cache.begin(f.pub, 12n, hash(12n));
  for (const hook of [addr(1), addr(2), addr(3)]) expect(await f.cache.minimum(f.pub, hook, 12n)).toBeUndefined();
  expect(f.getBytecode).toHaveBeenCalledTimes(3);
  expect(f.getBlock).toHaveBeenCalledExactlyOnceWith({ blockNumber: 10n });
});

it.each([undefined, '0x', '0x6080604052'] as const)('BATCH-3 never retains absent or unverified hook code: %s', async code => {
  const f = fixture(code);
  f.getBytecode.mockResolvedValue(code);
  for (const n of [10n, 11n]) {
    await f.cache.begin(f.pub, n, hash(n));
    expect(await f.cache.minimum(f.pub, addr(1), n)).toBeUndefined();
  }
  expect(f.getBytecode).toHaveBeenCalledTimes(2);
  expect(f.getBlock).not.toHaveBeenCalled();
});

it('BATCH-3 drops cached code when the old anchor cannot be checked and retries failed code reads', async () => {
  const f = fixture();
  await f.cache.begin(f.pub, 10n, hash(10n));
  await f.cache.minimum(f.pub, addr(1), 10n);
  f.getBlock.mockRejectedValueOnce(new Error('header unavailable'));
  await f.cache.begin(f.pub, 12n, hash(12n));
  f.getBytecode.mockRejectedValueOnce(new Error('code unavailable'));
  await expect(f.cache.minimum(f.pub, addr(1), 12n)).rejects.toThrow('code unavailable');
  await f.cache.minimum(f.pub, addr(1), 12n);
  expect(f.getBytecode).toHaveBeenCalledTimes(3);
});

it('BATCH-3 cannot cache without a canonical snapshot hash', async () => {
  const f = fixture();
  for (const n of [10n, 11n]) {
    await f.cache.begin(f.pub, n, undefined);
    await f.cache.minimum(f.pub, addr(1), n);
  }
  expect(f.getBytecode).toHaveBeenCalledTimes(2);
});
