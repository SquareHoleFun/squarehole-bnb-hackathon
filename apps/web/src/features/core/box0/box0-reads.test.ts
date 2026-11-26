/**
 * Review of SH-BOX0-ACTIONS: the panel's reads stay up when the indexer's list is a block behind the chain. A placeholder
 * opened (burned) since the list was made makes numberOf/getApproved revert; it is left out instead of failing the read.
 */
import { zeroAddress, type Address } from 'viem';
import { describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  readContract: vi.fn(),
  getBlock: vi.fn(async () => ({ timestamp: 1_800_000_000n })),
}));
vi.mock('viem', async (original) => ({ ...(await original<object>()), createPublicClient: () => client }));

const { readBox0 } = await import('./box0-reads');

const me = '0x00000000000000000000000000000000000000a1' as Address;
const roles = {
  chainId: 11155111,
  token: '0x0000000000000000000000000000000000000f17',
  tickets: '0x0000000000000000000000000000000000007777',
  stream: '0x0000000000000000000000000000000000005555',
  vault: '0x0000000000000000000000000000000000003333',
  service: null,
} as const;

describe('SH-BOX0-ACTIONS review: box 0 reads', () => {
  it('leaves out a placeholder the chain no longer has, and still reads the rest', async () => {
    client.readContract.mockImplementation(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case 'phase': return 3;
        case 'status': return { wordAcceptedAt: 1_700_000_000n };
        case 'quoteTake': return [1_000n, 10n];
        case 'numberOf':
        case 'getApproved':
          if (args?.[0] === 8n) throw new Error('NonexistentToken(8)');
          return functionName === 'numberOf' ? 77n : zeroAddress;
        case 'owedOf': return 0n;
        case 'balanceOf': return 10n ** 24n;
        default: throw new Error(`unexpected ${functionName}`);
      }
    });
    const r = await readBox0('http://127.0.0.1:1', roles, me, { tickets: [7n, 8n], draws: [], items: [] });
    expect(r.placeholders).toEqual([{ id: 7n, number: 77n, approved: null }]);
    expect(r.quote).toBe(1_010n);
  });
});
