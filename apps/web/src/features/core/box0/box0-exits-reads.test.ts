/**
 * SH-BOX0-EXITS: the panel's reads for the ways out. The dead head is the contract's own answer (a simulated
 * `enterTerminal`, an eth_call: the page never sends it, F142), read only to keep a draw that would revert off the page;
 * terminal mode adds the release quote and one hidden item for a take. A read that fails leaves its
 * exit off, never on, and never fails the panel.
 */
import { boxTicketsAbi } from '@squarehole/chain/abi';
import { encodeFunctionData, zeroAddress, type Address } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PHASE, TAKE_DELAY } from './box0-model';

const client = vi.hoisted(() => ({
  readContract: vi.fn(),
  call: vi.fn(),
  getBlock: vi.fn(async () => ({ timestamp: 1_800_000_000n })),
}));
vi.mock('viem', async (original) => ({ ...(await original<object>()), createPublicClient: () => client }));

const { readBox0 } = await import('./box0-reads');

const NOW = 1_800_000_000n;
const me = '0x00000000000000000000000000000000000000a1' as Address;
const roles = {
  chainId: 11155111,
  token: '0x0000000000000000000000000000000000000f17',
  tickets: '0x0000000000000000000000000000000000007777',
  stream: '0x0000000000000000000000000000000000005555',
  vault: '0x0000000000000000000000000000000000003333',
  service: null,
} as const;
const none = { tickets: [], draws: [], items: [] };

function chain(phase: number, status: Record<string, bigint>, over: Partial<Record<string, (args?: readonly unknown[]) => unknown>> = {}) {
  client.readContract.mockImplementation(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    const custom = over[functionName];
    if (custom) return custom(args);
    switch (functionName) {
      case 'phase': return phase;
      case 'status': return { slots: 0n, wordRequestedAt: 0n, wordAcceptedAt: 0n, terminalAt: 0n, drawsSettled: 0n, ...status };
      case 'quoteTake': return [1_000n, 10n];
      case 'quoteHandBack': return [999n, 0n];
      case 'graduationWord': return `0x${'00'.repeat(32)}`;
      case 'firstId': return 4100n;
      case 'collectionSize': return 64n;
      case 'poolPositionAt': return (args?.[0] as bigint) + 0n;
      case 'isHidden': return (args?.[0] as bigint) === 4102n;
      case 'owedOf': return 0n;
      case 'balanceOf': return 0n;
      case 'getApproved': return zeroAddress;
      default: throw new Error(`unexpected ${functionName}`);
    }
  });
}

beforeEach(() => {
  client.readContract.mockReset();
  client.call.mockReset();
});

describe('SH-BOX0-EXITS box 0 reads', () => {
  it('reads a dead head from the chain’s own answer to a simulated enterTerminal, and a live one as live', async () => {
    chain(PHASE.Drawing, { slots: 4n, wordRequestedAt: NOW - 9n * 86_400n, wordAcceptedAt: NOW - 9n * 86_400n });
    client.call.mockResolvedValueOnce({ data: '0x' });
    const dead = await readBox0('http://127.0.0.1:1', roles, me, none);
    expect(dead).toMatchObject({ headDead: true, slots: 4n, wordRequestedAt: NOW - 9n * 86_400n, terminalAt: 0n, refund: null, take: null });
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ to: roles.tickets, data: encodeFunctionData({ abi: boxTicketsAbi, functionName: 'enterTerminal' }) }));
    client.call.mockRejectedValueOnce(new Error('HeadNotDead(2, 1800604800)'));
    expect((await readBox0('http://127.0.0.1:1', roles, me, none)).headDead).toBe(false);
  });

  it('does not simulate enterTerminal outside drawing', async () => {
    chain(PHASE.Curve, {});
    expect((await readBox0('http://127.0.0.1:1', roles, null, none)).headDead).toBe(false);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('in terminal mode reads the release quote, and from TAKE_DELAY one hidden item to take', async () => {
    chain(PHASE.Terminal, { terminalAt: NOW - TAKE_DELAY, drawsSettled: 1n });
    const r = await readBox0('http://127.0.0.1:1', roles, null, none);
    // No placeholders (q = 0): pool index i holds position i; item 4102 is the first hidden one.
    expect(r).toMatchObject({ headDead: false, refund: 999n, take: { itemId: 4102n, poolIndex: 2n }, terminalAt: NOW - TAKE_DELAY });
    chain(PHASE.Terminal, { terminalAt: NOW - TAKE_DELAY + 1n });
    expect((await readBox0('http://127.0.0.1:1', roles, null, none)).take).toBeNull();
  });

  it('leaves an exit off when its read fails, and still reads the rest', async () => {
    chain(PHASE.Terminal, { terminalAt: NOW - TAKE_DELAY }, { quoteHandBack: () => { throw new Error('InvalidQuantity(1, 0)'); }, poolPositionAt: () => { throw new Error('rpc down'); } });
    const r = await readBox0('http://127.0.0.1:1', roles, null, none);
    expect(r).toMatchObject({ refund: null, take: null, quote: 1_010n });
  });
});
