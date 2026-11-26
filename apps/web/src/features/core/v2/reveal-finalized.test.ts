// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { completedReveal } from './reveal-finalized';
import type { KeptReveal } from '../../create/v2/reveal-keep';
import type { V2Source } from './indexer-v2';
import { addr, digest } from './reveal-items.test-support';
const client = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), readContract: vi.fn(), getCode: vi.fn() }));
vi.mock('viem', async original => ({ ...await original<typeof import('viem')>(), createPublicClient: () => client }));
afterEach(() => vi.clearAllMocks());
it.each([false, true])('L5 rechecks the pinned finalized hash before cleanup, absent=%s', async absent => {
  const copy = { chainId: 11155111, token: addr(2), specHash: digest(1), revealRoot: digest(2), n: 4, discardWhenAbsent: absent } as KeptReveal;
  client.getChainId.mockResolvedValue(11155111);
  client.getBlock.mockResolvedValueOnce({ number: 100n, hash: digest(100) }).mockResolvedValue({ number: 100n, hash: digest(999) });
  client.getCode.mockResolvedValue('0x');
  client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => ({ initialHolder: addr(3), specHash: copy.specHash, collection: addr(5), revealRoot: copy.revealRoot, collectionSize: 4n, revealedCount: 4n })[functionName]);
  expect(await completedReveal(copy, { rpc: 'http://unused.invalid' } as V2Source)).toBe(false);
  expect(client.getBlock).toHaveBeenLastCalledWith({ blockNumber: 100n });
});

it('L5 permits cleanup only while the pinned finalized hash stays canonical', async () => {
  const copy = { chainId: 11155111, token: addr(2), specHash: digest(1), revealRoot: digest(2), n: 4 } as KeptReveal;
  client.getChainId.mockResolvedValue(11155111); client.getBlock.mockResolvedValue({ number: 100n, hash: digest(100) });
  client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => ({ initialHolder: addr(3), specHash: copy.specHash, collection: addr(5), revealRoot: copy.revealRoot, collectionSize: 4n, revealedCount: 4n })[functionName]);
  expect(await completedReveal(copy, { rpc: 'http://unused.invalid' } as V2Source)).toBe(true);
  expect(client.getBlock).toHaveBeenLastCalledWith({ blockNumber: 100n });
});
