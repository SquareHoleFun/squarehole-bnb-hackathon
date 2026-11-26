/**
 * SH-076: who holds an item, read lazily for the rows on screen. After `forgetOwners()` (every action does it) a row
 * reads its holder again, and a read begun before that never replaces the newer one.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetOwners, useItemOwner } from './set-owners';

const COLLECTION = '0x00000000000000000000000000000000000c0113' as Address;
const BEFORE = '0x00000000000000000000000000000000000000b1';
const AFTER = '0x00000000000000000000000000000000000000a2';

/** One ownerOf answer per call, released by the test in any order. */
function answers() {
  const pending: ((owner: string) => void)[] = [];
  const read = vi.fn(() => new Promise<unknown>((resolve) => { pending.push(resolve); }));
  return { reads: { read }, read, answer: (call: number, owner: string) => act(async () => { pending[call]?.(owner); }) };
}

afterEach(() => forgetOwners());

describe('item holders', () => {
  it('after forgetOwners the row reads its holder again, and the read begun before never replaces the newer one', async () => {
    const { reads, read, answer } = answers();
    const { result } = renderHook(() => useItemOwner(reads, 31337, COLLECTION, 7n));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    // An action ends (the item moved): the holders are forgotten while the first read is still on its way.
    act(() => forgetOwners());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await answer(1, AFTER);
    await waitFor(() => expect(result.current).toBe(AFTER.toLowerCase()));
    // The first read answers last, with the holder from before: it is not kept.
    await answer(0, BEFORE);
    expect(result.current).toBe(AFTER.toLowerCase());
  });
});
