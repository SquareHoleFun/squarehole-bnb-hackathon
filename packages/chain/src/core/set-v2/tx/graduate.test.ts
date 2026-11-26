import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Address } from 'viem';
import { core, identityInput, setManifestInput, hash, required, address } from '../test-support';
import { parseSetManifest } from '../manifest-set-v2';
import { coordinatorV2Abi, hookV2Abi } from '../../v2/abi-v2';
import type { ChainReader } from '../../../write/rpc';
import { assertSendableSetCallV2, setCall, setGraduateCalls, type SetTargetV2 } from './index';

function fixture() {
  const target: SetTargetV2 = { chainId: core.chainId, core, release: parseSetManifest(setManifestInput(), core), identity: identityInput() };
  const coordinator = required(target.identity.roles[0]), hook = required(target.identity.roles[2]);
  const state = { closed: true, graduated: false, failed: false };
  const reader = {
    chainId: vi.fn(async (): Promise<number> => core.chainId), blockNumber: vi.fn(async () => 51n),
    getBlock: vi.fn(async () => ({ number: 51n, hash: hash('block'), timestamp: 100n })),
    call: vi.fn(async (req: {to: Address; data: `0x${string}`}, block: unknown) => {
      expect(block).toBe(51n);
      const abi = req.to === hook ? hookV2Abi : coordinatorV2Abi;
      expect([coordinator, hook]).toContain(req.to);
      const { functionName, args } = decodeFunctionData({abi, data: req.data});
      const result = functionName === 'registry' ? target.identity.registry
        : functionName === 'roleAddress' ? target.identity.roles[Number(args?.[0])]
        : state[functionName as keyof typeof state];
      return encodeFunctionResult({abi, functionName, result} as never);
    }),
  };
  return { target, coordinator, hook, state, reader, read: reader as unknown as ChainReader };
}

describe('E09C-GRADUATE client', () => {
  it('admits the own coordinator when the pinned observation is eligible', () => {
    const f = fixture();
    const scoped = {...f.target, graduation: {blockNumber:51n, blockHash:hash('block'),
      coordinator:f.coordinator, hook:f.hook, ...f.state}};
    expect(() => assertSendableSetCallV2(setCall(f.coordinator, coordinatorV2Abi, 'graduate'), scoped, address('holder'))).not.toThrow();
  });
  it('builds a canonical permissionless call from one pinned snapshot and admits any sender', async () => {
    const f = fixture();
    const prepared = await setGraduateCalls(f.read, f.target, address('unrelated holder'));
    expect(prepared.call).toEqual(setCall(f.coordinator, coordinatorV2Abi, 'graduate'));
    expect(prepared.target.graduation).toMatchObject({blockNumber: 51n, blockHash: hash('block'), coordinator: f.coordinator, hook: f.hook});
    expect(f.reader.call).toHaveBeenCalledTimes(6);
    for (const from of [f.target.identity.creator, address('other')]) {
      expect(() => assertSendableSetCallV2(prepared.call, prepared.target, from)).not.toThrow();
    }
    for (const bad of [{...prepared.call, to: address('foreign coordinator')}, {...prepared.call, value: 1n},
      {...prepared.call, data: `${prepared.call.data}00` as const}]) {
      expect(() => assertSendableSetCallV2(bad, prepared.target, address('other'))).toThrow();
    }
    expect(() => assertSendableSetCallV2(prepared.call, f.target, address('other'))).toThrow();
    for (const over of [{closed: false}, {graduated: true}, {failed: true}, {coordinator: address('foreign')}, {hook: address('foreign')}]) {
      expect(() => assertSendableSetCallV2(prepared.call, {...prepared.target,
        graduation: {...prepared.target.graduation, ...over}}, address('other'))).toThrow();
    }
  });
  it.each(['closed', 'graduated', 'failed'] as const)('refuses an ineligible pinned %s state', async key => {
    const f = fixture(); f.state[key] = key !== 'closed';
    await expect(setGraduateCalls(f.read, f.target, address('holder'))).rejects.toThrow();
  });
  it('refuses wrong chain, missing or reorged block, mismatched coordinator bindings and unreadable state', async () => {
    const f = fixture();
    f.reader.chainId.mockResolvedValueOnce(1);
    await expect(setGraduateCalls(f.read, f.target, address('holder'))).rejects.toThrow(/chain/);
    expect(f.reader.call).not.toHaveBeenCalled();
    f.reader.getBlock.mockResolvedValueOnce(null as never);
    await expect(setGraduateCalls(f.read, f.target, address('holder'))).rejects.toThrow(/block/);
    f.reader.getBlock.mockResolvedValueOnce({number:51n,hash:hash('block'),timestamp:100n})
      .mockResolvedValueOnce({number:51n,hash:hash('reorg'),timestamp:100n});
    await expect(setGraduateCalls(f.read, f.target, address('holder'))).rejects.toThrow(/block/);
    f.reader.call.mockRejectedValueOnce(new Error('unreadable'));
    await expect(setGraduateCalls(f.read, f.target, address('holder'))).rejects.toThrow(/unreadable/);
    f.reader.call.mockResolvedValueOnce(encodeFunctionResult({abi:coordinatorV2Abi,functionName:'registry',result:address('foreign')}));
    await expect(setGraduateCalls(f.read, f.target, address('holder'))).rejects.toThrow();
  });
});
