/**
 * The card's chain read when the indexer gateway does not answer (C19: the site works without our service): the box's
 * registry row and its hook's phase at ONE block, through a keyless public RPC. Read-only, no key.
 *
 * A token does not name its box (the registry indexes boxes by coordinator), so the rows are scanned: `boxCount`, then
 * `recordOf(id)` for each (one Multicall3 call per batch on Sepolia), the matching row's `BoxSpec` log at its creation
 * block (decoded by the chain package's row decoder: the spec against its hash, Q, roles), and `phase()`. A registry
 * holding more than `MAX_DIRECT_ROWS` boxes is not scanned (the generic card then; the indexer is the way past that).
 */
import { boxHookAbi, boxRegistryAbi } from '@squarehole/chain/abi';
import { boxRowFromRecord, ROLE, SEPOLIA_CHAIN_ID, viemChain, type RegistryRecord } from '@squarehole/chain';
import { CONTRACT_PHASE, type CorePhase } from '@squarehole/indexer/client';
import { createPublicClient, decodeEventLog, encodeEventTopics, fallback, http, toHex, type Hex, type PublicClient } from 'viem';
import type { DirectBox, ShareCore } from './share-read';

export const MAX_DIRECT_ROWS = 200n;
const SPEC_TOPIC = encodeEventTopics({ abi: boxRegistryAbi, eventName: 'BoxSpec' })[0] as Hex;

export type DirectClient = Pick<PublicClient, 'readContract' | 'getBlock' | 'request'>;

/** A public client for the core's RPC list (each tried in turn; Multicall3 batching on Sepolia). */
export function shareClient(core: ShareCore, timeoutMs: number): DirectClient {
  // Each RPC once, in order: viem's fallback otherwise retries the whole list three times with backoff (about 1 s).
  const transport = fallback(core.rpcUrls.map((url) => http(url, { timeout: timeoutMs, retryCount: 0 })), { retryCount: 0 });
  if (core.network === 'sepolia' && core.chainId === SEPOLIA_CHAIN_ID) {
    return createPublicClient({ chain: viemChain(SEPOLIA_CHAIN_ID, core.rpcUrls), transport, batch: { multicall: true } }) as DirectClient;
  }
  return createPublicClient({ transport }) as DirectClient;
}

/** One box by its token, read at the latest block; null when no row of the manifest's registries has that token. */
export async function readDirectBox(client: DirectClient, core: ShareCore, token: `0x${string}`): Promise<DirectBox | null> {
  const head = await client.getBlock({ blockTag: 'latest' });
  const blockNumber = head.number;
  const box0Registry = core.manifest.versions.find((v) => v.version === 1)?.registry.address ?? null;
  for (const version of core.manifest.versions) {
    const registry = version.registry.address;
    const count = (await client.readContract({ address: registry, abi: boxRegistryAbi, functionName: 'boxCount', blockNumber })) as bigint;
    if (count > MAX_DIRECT_ROWS) throw new Error(`registry ${registry} holds ${count} boxes; the card reads at most ${MAX_DIRECT_ROWS} without the indexer`);
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
    const records = (await Promise.all(ids.map((id) => client.readContract({ address: registry, abi: boxRegistryAbi, functionName: 'recordOf', args: [id], blockNumber })))) as unknown as RegistryRecord[];
    const id = records.findIndex((r) => (r.contracts[ROLE.token] ?? '').toLowerCase() === token);
    const record = records[id];
    if (id < 0 || record === undefined) continue;
    const at = toHex(record.creationBlock);
    const logs = (await client.request({
      method: 'eth_getLogs',
      params: [{ address: registry, fromBlock: at, toBlock: at, topics: [SPEC_TOPIC, `0x${id.toString(16).padStart(64, '0')}`] }],
    } as never)) as { topics: Hex[]; data: Hex }[];
    const log = logs[0];
    if (!log) throw new Error(`box ${id}: no BoxSpec log in its creation block`);
    const decoded = decodeEventLog({ abi: boxRegistryAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    if (decoded.eventName !== 'BoxSpec') throw new Error(`box ${id}: not a BoxSpec log`);
    const row = boxRowFromRecord({ ...record, contracts: [...record.contracts], codeHashes: [...record.codeHashes] }, decoded.args.encodedSpec, { chainId: core.chainId, registry, box0Registry });
    const hook = row.contracts.hook;
    if (hook === null) throw new Error(`box ${id}: no hook`);
    const code = Number(await client.readContract({ address: hook, abi: boxHookAbi, functionName: 'phase', blockNumber }));
    const phase = CONTRACT_PHASE[code];
    if (phase === undefined || phase === 'failed') throw new Error(`box ${id}: the hook reports phase ${code}, which version 1 does not have`);
    return { row, phase: phase as CorePhase, at: { block: blockNumber, timestamp: head.timestamp } };
  }
  return null;
}

/** The direct reader (the Pages function and the card service): a fresh client per read (clients are cheap). */
export function chainShareReader(timeoutMs: number): { box(core: ShareCore, token: `0x${string}`): Promise<DirectBox | null> } {
  return { box: (core, token) => readDirectBox(shareClient(core, timeoutMs), core, token) };
}
