import { describe, expect, it } from 'vitest';
import { ViemChain } from '../../src/chain';
import { EIP7825_GAS_CAP } from '../../src/gas';
import { runTick, type KeeperState } from '../../src/run';
import { fakeClient, fakeNode } from '../support/fake-rpc';
import { addr, box, keeper, options, quiet, v2, world } from '../support/v2';

const c = { job: 'shopReturn', to: addr(70), fn: 'returnStarter', args: [[0n]], key: 'destination-return' } as const;

describe('FINAL2-OC02 destination constraints through the production runner', () => {
  it('reads the pending block allowance and takes fork/state rules from an explicit destination reader', async () => {
    const node = fakeNode();
    const pub = fakeClient(node);
    const chain = new ViemChain(options(), pub, keeper, { public: null, private: null }, null, quiet,
      async (candidate, estimate, block) => {
        expect(candidate).toBe(c);
        expect(estimate).toBe(24_000_000n);
        expect(block.timestamp).toBe(node.block.timestamp);
        return { fork: 'amsterdam', transactionCap: EIP7825_GAS_CAP, stateGas: 10_000_000n };
      });
    expect(await chain.gasConstraints(c, 24_000_000n)).toEqual({ fork: 'amsterdam',
      transactionCap: EIP7825_GAS_CAP, stateGas: 10_000_000n, blockGasLimit: 30_000_000n });
  });

  it.each(['osaka', 'amsterdam', 'no room', 'unknown rules', 'checkpoint failure', 'ambiguous send'] as const)(
    'uses one admitted envelope through the production runner: %s', async mode => {
      const saved: KeeperState[] = [];
      const sent: bigint[] = [];
      const constraintsFor: string[] = [];
      const expected = mode === 'amsterdam' ? 25_000_000n : 14_500_000n;
      const estimate = mode === 'amsterdam' ? 24_000_000n : 14_000_000n;
      const port = {
        read: async () => world(box({ failed: true, v2: { ...v2, m2: [c] } })),
        simulate: async (candidate: typeof c | { job: string }) => ({ ok: candidate.job === c.job, estimate, tipWei: null }),
        gasConstraints: async (candidate: { job: string }, supplied: bigint) => {
          constraintsFor.push(candidate.job);
          expect(supplied).toBe(estimate);
          if (mode === 'unknown rules') throw new Error('no destination rules');
          return { fork: mode === 'amsterdam' ? 'amsterdam' as const : 'osaka' as const, transactionCap: EIP7825_GAS_CAP,
            blockGasLimit: mode === 'no room' ? estimate - 1n : expected,
            stateGas: mode === 'amsterdam' ? 10_000_000n : 0n };
        },
        send: async (_candidate: unknown, gas: bigint) => {
          expect(saved.at(-1)?.budget?.totalWei).toBe(expected * 3n);
          expect(gas).toBe(expected);
          sent.push(gas);
          if (mode === 'ambiguous send') throw new Error('accepted then timeout');
          return 'local';
        },
      };
      const tick = runTick(port, {}, { ...options(), dryRun: false, priorityFeeWei: 1n,
        checkpoint: async state => {
          if (mode === 'checkpoint failure') throw new Error('disk failure');
          saved.push(state);
        } }, quiet);
      if (mode === 'checkpoint failure') {
        await expect(tick).rejects.toThrow('disk failure');
        expect(sent).toEqual([]);
        return;
      }
      const out = await tick;
      expect(constraintsFor).toEqual([c.job]);
      const defer = mode === 'no room' || mode === 'unknown rules';
      expect(sent).toEqual(defer ? [] : [expected]);
      expect(out.state.budget.totalWei).toBe(defer ? 0n : expected * 3n);
    });
});
