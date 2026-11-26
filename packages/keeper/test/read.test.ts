import { describe, expect, it } from 'vitest';
import { ViemChain, checkChainId } from '../src/chain';
import { loadConfig } from '../src/config';
import { fakeClient, fakeNode } from './support/fake-rpc';
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
describe('Box 0 adapter reads', () => {
  it('refuses an RPC on another chain (L7)', async () => {
    await expect(checkChainId(fakeClient(fakeNode({ chainId: 1 })), 11_155_111)).rejects.toThrow(/chain id 1/);
    await expect(checkChainId(fakeClient(fakeNode()), 11_155_111)).resolves.toBeUndefined();
  });

  it('times box 0\'s top-up from its newest checkpoint, not its latest sample (L4)', async () => {
    const [CO, HK, RC, EX, PM] = [addr(1), addr(2), addr(3), addr(5), addr(6)];
    const node = fakeNode();
    node.calls = {
      [`${HK}:poolId`]: () => `0x${'11'.repeat(32)}`, [`${HK}:poolManager`]: () => PM, [`${HK}:closed`]: () => true,
      [`${CO}:graduated`]: () => true, [`${RC}:fitOwed`]: () => 0n, [`${RC}:platformOwed`]: () => 0n, [`${RC}:fitWaitingT`]: () => 0n,
      [`${EX}:fitGraduated`]: () => true, [`${PM}:extsload`]: () => `0x${'00'.repeat(32)}`,
      [`${EX}:oracle`]: () => ({ tick: 5, time: 1_791_302_000, tickCumulative: 0n, head: 2, filled: 3 }),
      [`${EX}:checkpointAt`]: ([i]) => ({ time: i === 2n ? 1_791_301_500 : 7, tickCumulative: 0n }),
    };
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_BOX0: [CO, HK, RC, EX].join(',') });
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const w = await new ViemChain(cfg, fakeClient(node), addr(0xbeef), { public: null, private: null }, null, quiet).read();
    expect(w.boxes.map((b) => [b.id, b.checkpointTime, b.sampleTick])).toEqual([[0n, 1_791_301_500n, 5]]);
  });

});
