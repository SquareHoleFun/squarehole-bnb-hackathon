// @vitest-environment node
/**
 * The card's chain read without the indexer: the registry's rows scanned for the token (`boxCount`, `recordOf`), the
 * matching row's BoxSpec log at its creation block through the chain package's decoder, and the hook's `phase()`, all
 * at one block. Against a fake transport that answers from a table (as packages/chain core-reads.test.ts does).
 */
import { boxHookAbi, boxRegistryAbi } from '@squarehole/chain/abi';
import { boxRowFromRecord, type DeployedCoreManifest } from '@squarehole/chain';
import { labelAddress, labelHash, registryLogs, syntheticBox } from '@squarehole/chain/core/test-support';
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, type Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { boxOfRow, openingOf, type ShareCore } from './share-read';
import { MAX_DIRECT_ROWS, readDirectBox, type DirectClient } from './share-direct';

const REGISTRY = labelAddress('share:registry');
const OTHER = syntheticBox({ boxId: 0n, label: 'other', creationBlock: 400n });
const BOX = syntheticBox({ boxId: 1n, label: 'shared', creationBlock: 500n });
const ROW = boxRowFromRecord(BOX.record, BOX.encodedSpec, { chainId: 11_155_111, registry: REGISTRY, box0Registry: REGISTRY });
const TOKEN = (ROW.contracts.token as string).toLowerCase() as `0x${string}`;
const HEAD = { number: 1000n, timestamp: 1_790_000_000n };

const CORE: ShareCore = {
  network: 'local',
  chainId: 11_155_111,
  manifest: { versions: [{ version: 1, registry: { address: REGISTRY }, supportedTemplates: [ROW.templateId] }] } as unknown as DeployedCoreManifest,
  rpcUrls: ['http://127.0.0.1:8562'],
  indexerOrigin: null,
};

function client(options: { count?: bigint; phase?: number; calls?: string[] } = {}): DirectClient {
  const calls = options.calls ?? [];
  const [, spec] = registryLogs(BOX, { registry: REGISTRY, blockNumber: 500n, blockHash: labelHash('b500') });
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        calls.push(method);
        if (method === 'eth_getBlockByNumber') return { number: `0x${HEAD.number.toString(16)}`, hash: labelHash('b1000'), parentHash: labelHash('b999'), timestamp: `0x${HEAD.timestamp.toString(16)}`, transactions: [], logsBloom: `0x${'0'.repeat(512)}` };
        if (method === 'eth_getLogs') {
          const filter = params[0] as { topics: Hex[]; fromBlock: Hex };
          expect(filter.fromBlock).toBe('0x1f4');
          expect(filter.topics[1]).toBe(`0x${'1'.padStart(64, '0')}`);
          return [{ ...spec, blockNumber: '0x1f4', logIndex: `0x${spec.logIndex.toString(16)}`, transactionIndex: '0x0', removed: false }];
        }
        if (method === 'eth_call') {
          const [call, tag] = params as [{ to: Address; data: Hex }, Hex];
          expect(BigInt(tag)).toBe(HEAD.number);
          for (const abi of [boxRegistryAbi, boxHookAbi] as unknown as Abi[]) {
            try {
              const { functionName, args } = decodeFunctionData({ abi, data: call.data });
              calls.push(functionName);
              if (functionName === 'boxCount') return encodeFunctionResult({ abi, functionName, result: options.count ?? 2n } as never);
              if (functionName === 'recordOf') return encodeFunctionResult({ abi, functionName, result: (args?.[0] === 1n ? BOX : OTHER).record } as never);
              if (functionName === 'phase' && call.to === ROW.contracts.hook) return encodeFunctionResult({ abi, functionName, result: options.phase ?? 1 } as never);
            } catch {
              // another ABI
            }
          }
          throw new Error(`no answer for ${call.to} ${call.data.slice(0, 10)}`);
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  }) as DirectClient;
}

describe('the chain read behind a card', () => {
  it('finds the token\'s row among the registry\'s, decodes it, reads its phase at the same block', async () => {
    const calls: string[] = [];
    const found = await readDirectBox(client({ calls }), CORE, TOKEN);
    expect(found).not.toBeNull();
    expect(found?.row).toEqual({ ...ROW, origin: null });
    expect(found?.phase).toBe('upcoming');
    expect(found?.at).toEqual({ block: HEAD.number, timestamp: HEAD.timestamp });
    expect(calls.filter((c) => !c.startsWith('eth_'))).toEqual(['boxCount', 'recordOf', 'recordOf', 'phase']);
    expect(calls.filter((c) => c === 'eth_getLogs')).toHaveLength(1);
  });

  it('its card: the spec\'s names, and the opening from the row (about, from the read block, until rows carry openAt)', async () => {
    const found = await readDirectBox(client(), CORE, TOKEN);
    if (!found) throw new Error('no box');
    const box = boxOfRow(found.row, 'sepolia', found.phase, found.at);
    expect(box).toMatchObject({ name: 'The Misfits', ticker: 'FIT', chainLabel: 'Sepolia', demo: false, token: TOKEN });
    expect(box.state).toEqual({ kind: 'upcoming', ...openingOf(found.row, found.at) });
  });

  it('phases: 3 is open, 5 graduated; 6 (failed) does not exist in version 1', async () => {
    expect((await readDirectBox(client({ phase: 3 }), CORE, TOKEN))?.phase).toBe('bonding');
    expect((await readDirectBox(client({ phase: 5 }), CORE, TOKEN))?.phase).toBe('graduated');
    await expect(readDirectBox(client({ phase: 6 }), CORE, TOKEN)).rejects.toThrow(/phase 6/);
  });

  it('a token no row has: null (no log or phase read)', async () => {
    const calls: string[] = [];
    expect(await readDirectBox(client({ calls }), CORE, '0x00000000000000000000000000000000000000aa')).toBeNull();
    expect(calls).not.toContain('eth_getLogs');
    expect(calls).not.toContain('phase');
  });

  it(`a registry with more than ${MAX_DIRECT_ROWS} boxes is not scanned`, async () => {
    await expect(readDirectBox(client({ count: MAX_DIRECT_ROWS + 1n }), CORE, TOKEN)).rejects.toThrow(/at most 200/);
  });
});
