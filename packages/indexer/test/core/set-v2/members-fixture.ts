import { buildSetCommitment } from '@squarehole/box-spec';
import { boxTokenAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { setVaultV2Abi } from '@squarehole/chain/core/set-v2';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, zeroHash, type Abi, type Hex } from 'viem';
import { coordinatorV2Abi, hookV2Abi, receiverV2Abi, starterSetLoaderV2Abi } from '../../../src/core/v2/chain-v2';
import type { CoreReader } from '../../../src/core/core-reader';
import type { RawLog } from '../../../src/events';
import type { BlockHeader } from '../../../src/model';
import { fixture, hash, creationTime } from './fixture';

/** ABI-shaped block reads, independent of the membership reducer; no RPC or listeners. */
export function membersFixture(count = 40) {
  const base = fixture().row;
  const ids = [0n, (1n << 256n) - 1n, ...Array.from({ length: count - 2 }, (_, i) => BigInt(i) * 101n + 7n)];
  const { commitment, pages } = buildSetCommitment(base.spec.collection, ids, 32);
  const row = { ...base, spec: { ...base.spec, ...commitment } };
  const reads = { loaded: 0, inside: 0n, remainingHash: row.spec.setHash, totalSupply: 1_000_000n };
  const abis: readonly [string | null, Abi][] = [
    [row.poolManager, poolManagerAbi], [row.contracts.vault, setVaultV2Abi],
    [row.contracts.starterSetLoader, starterSetLoaderV2Abi], [row.contracts.coordinator, coordinatorV2Abi],
    [row.contracts.token, boxTokenAbi], [row.contracts.hook, hookV2Abi], [row.contracts.receiver, receiverV2Abi],
  ];
  const reader: Pick<CoreReader, 'callAt'> = {
    async callAt(to, data) {
      const abi = abis.find(([address]) => address?.toLowerCase() === to.toLowerCase())?.[1];
      if (!abi) throw new Error('fixture target');
      const { functionName } = decodeFunctionData({ abi, data });
      const fn = abi.find(f => f.type === 'function' && f.name === functionName);
      if (!fn || fn.type !== 'function') throw new Error('fixture function');
      const values: Record<string, unknown> = {
        extsload: zeroHash, buyersChoice: 3, sellersChoice: 3, inside: reads.inside,
        totalSupply: reads.totalSupply, seedReady: reads.loaded === count,
        progress: [reads.loaded, reads.remainingHash, false],
      };
      const defaults = fn.outputs.map(o => o.type === 'bool' ? false : o.type === 'address' ? row.creator : o.type === 'uint8' ? 0 : 0n);
      return encodeFunctionResult({ abi, functionName, result: values[functionName] ?? (defaults.length === 1 ? defaults[0] : defaults) } as never);
    },
  };
  const header = (number: bigint): BlockHeader => ({
    number, hash: hash(`members:${number}`), parentHash: hash(`members:${number - 1n}`), timestamp: creationTime + number * 12n,
  });
  function log(name: string, args: Record<string, unknown>, block: BlockHeader, logIndex = 0): RawLog {
    const event = setVaultV2Abi.find(e => e.type === 'event' && e.name === name);
    if (!event || event.type !== 'event' || !row.contracts.vault) throw new Error('fixture event');
    return {
      address: row.contracts.vault, blockNumber: block.number, blockHash: block.hash,
      transactionHash: hash(`members-tx:${block.number}`), transactionIndex: 0, logIndex, removed: false,
      topics: encodeEventTopics({ abi: [event], eventName: name, args } as never) as Hex[],
      data: encodeAbiParameters(event.inputs.filter(i => !i.indexed), event.inputs.filter(i => !i.indexed).map(i => args[i.name])),
    };
  }
  const loads = (start: number, end: number, block: BlockHeader) => ids.slice(start, end).map((id, i) =>
    log('SetLoaded', { index: BigInt(start + i), collection: row.spec.collection, id }, block, i));
  return { row, ids, pages, reads, reader, header, log, loads };
}
