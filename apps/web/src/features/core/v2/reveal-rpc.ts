/** SH-202 production reads. Every state request names a tag to resolve or an exact canonical block hash.
 * RPC bodies are bounded to 2 MiB and 15 seconds, including body consumption. Bulk calls use <=40 rows.
 */
import { decodeFunctionResult, encodeFunctionData, isHex, keccak256, zeroHash, type Abi, type Address, type Hex } from 'viem';
import { boxCollectionAbi, boxTicketsAbi, drandSourceAbi } from '@squarehole/chain/abi';
import { registryV2Abi } from '../../../../../../packages/chain/src/core/v2/abi-v2';
import { encodeBoxSpecV2 } from '../../../../../../packages/chain/src/core/v2/spec-v2';
import { rolesOfV2, type BoxRecordV2 } from '../../../../../../packages/chain/src/core/v2/record-v2';
import { createChainReader, createHttpRequest } from '../../../../../../packages/chain/src/write/rpc';
import { quantity, toQuantity, type Eip1193Request } from '../../../../../../packages/chain/src/write/eip1193';
import { readsGasPrice, type SendFeeReader } from '../../../../../../packages/chain/src/write/executor';
import { multicall3Abi } from '../../../../../../packages/chain/src/core/v2/reveal-batch-calls-v2';
import type { WriteCallV2 } from '../../../../../../packages/chain/src/core/v2/write-calls-v2';
import type { V2Source, V2Snapshot } from './indexer-v2';
import { hiddenDrawStatus, type HiddenRevealReads } from './reveal-hidden';
import { checkRevealSnapshot, sameRevealValue, settleRevealReads, RevealRefusal, type RevealBlock, type RevealIdentity, type RevealReads, type RevealSnapshot } from './reveal-items';
import type { RevealAssetPorts, RevealAssetItem } from './reveal-assets';

import { requireRevealValue } from './reveal-items-store';
import { revealTestOverride } from './reveal-test-seam';

export const REVEAL_RPC_BYTES = 2 * 1024 * 1024;
export const REVEAL_RPC_DEADLINE_MS = 15_000;
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
export type RevealBox = Pick<V2Snapshot, 'record' | 'spec' | 'release'>;
export function boundedRevealRequest(url: string, fetcher: typeof fetch = fetch): Eip1193Request {
  return createHttpRequest(url, { timeoutMs: REVEAL_RPC_DEADLINE_MS, fetch: async (url, init) => {
    const controller = new AbortController(); let reject!: (error: Error) => void;
    const deadline = new Promise<never>((_, no) => { reject = no; });
    const abort = () => { controller.abort(); reject(new Error('rpc-deadline')); };
    const timer = setTimeout(abort, REVEAL_RPC_DEADLINE_MS); init?.signal?.addEventListener('abort', abort, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await Promise.race([fetcher(url, { ...init, credentials: 'omit', redirect: 'error', signal: controller.signal }), deadline]);
      const bytes = new Uint8Array(REVEAL_RPC_BYTES); let length = 0;
      reader = response.body?.getReader();
      if (reader) for (;;) {
        const part = await Promise.race([reader.read(), deadline]); if (part.done) break;
        if (length + part.value.length > bytes.length) throw new Error('rpc-response-limit');
        bytes.set(part.value, length); length += part.value.length;
      }
      return new Response(bytes.subarray(0, length), { status: response.status, headers: { 'content-type': 'application/json' } });
    } finally {
      clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); controller.abort();
      if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
  } });
}
export function createRevealRPC(source: Pick<V2Source, 'manifest' | 'rpc'>, box: RevealBox) {
  const request = revealTestOverride(source)?.rpc ?? boundedRevealRequest(source.rpc);
  const release = source.manifest.releases.find(r => sameRevealValue(r.registry.address, box.release.registry.address));
  if (!release || source.manifest.chainId <= 0) throw new Error('wrong-registry');
  const reader = createChainReader(request), roles = rolesOfV2(box.record).contracts;
  if (!roles.token || !roles.collection) throw new Error('wrong-mode');
  const identity: RevealIdentity = Object.freeze({ chainId: source.manifest.chainId, registry: release.registry.address,
    boxId: box.record.boxId, token: roles.token, creator: box.record.creator, specHash: box.record.specHash });
  const head = async (tag: 'latest' | 'finalized') => { const b = await reader.getBlock(tag); if (!b) throw new Error('read-failed'); return b; };
  const blockArg = (b: RevealBlock) => ({ blockHash: b.hash, requireCanonical: true });
  const code = async (address: Address, b: RevealBlock): Promise<Hex> => {
    const value = await request({ method: 'eth_getCode', params: [address, blockArg(b)] });
    if (typeof value !== 'string' || !isHex(value)) throw new Error('read-failed'); return value;
  };
  const call = async (to: Address, abi: Abi, fn: string, args: readonly unknown[], b: RevealBlock): Promise<unknown> => {
    const data = encodeFunctionData({ abi, functionName: fn, args });
    const result = await request({ method: 'eth_call', params: [{ to, data }, blockArg(b)] });
    if (typeof result !== 'string' || !isHex(result)) throw new Error('read-failed');
    return decodeFunctionResult({ abi, functionName: fn, data: result });
  };
  const canonical = async (b: RevealBlock): Promise<boolean> => sameRevealValue((await reader.getBlock(b.number))?.hash, b.hash);
  const receipt: RevealReads['receipt'] = async hash => {
    const [r, tx] = await settleRevealReads([reader.getReceipt(hash), reader.getTransaction(hash)]);
    if (!r) return null;
    if (!tx || !tx.to || !sameRevealValue(tx.hash, hash) || !sameRevealValue(r.transactionHash, hash)
      || tx.blockNumber !== r.blockNumber || !sameRevealValue(tx.blockHash ?? undefined, r.blockHash)
      || !sameRevealValue(tx.from, r.from) || !sameRevealValue(tx.to, r.to ?? undefined)) throw new Error('invalid-receipt');
    return { hash: tx.hash, from: tx.from, to: tx.to, nonce: tx.nonce, input: tx.input, value: tx.value,
      block: { number: r.blockNumber, hash: r.blockHash }, status: r.status, logs: r.logs };
  };
  const traits = async (collection: Address, ids: readonly bigint[], b: RevealBlock): Promise<RevealAssetItem[]> => {
    if (ids.length > 10_000 || ids.some(id => id < 1n || id > 10_000n)) throw new Error('invalid-ids');
    const out: RevealAssetItem[] = [];
    for (let start = 0; start < ids.length; start += 40) {
      const calls = ids.slice(start, start + 40).map(id => ({ target: collection, allowFailure: false,
        callData: encodeFunctionData({ abi: boxCollectionAbi, functionName: 'traitsOf', args: [id] }) }));
      const result = await call(MULTICALL, multicall3Abi, 'aggregate3', [calls], b) as readonly { success: boolean; returnData: Hex }[];
      if (result.length !== calls.length) throw new Error('invalid-bulk');
      for (const row of result) {
        if (!row.success) throw new Error('invalid-bulk');
        const [revealed, , image, model] = decodeFunctionResult({ abi: boxCollectionAbi, functionName: 'traitsOf', data: row.returnData });
        out.push({ revealed, image, avatar: zeroHash, model });
      }
    }
    if (!await canonical(b)) throw new Error('reorg'); return out;
  };
  const readIdentity = async (b: RevealBlock): Promise<RevealSnapshot> => {
    if (keccak256(await code(identity.registry, b)).toLowerCase() !== release.registry.codeHash.toLowerCase()) throw new Error('wrong-registry');
    const record = await call(identity.registry, registryV2Abi, 'recordOf', [identity.boxId], b) as BoxRecordV2;
    const actual = rolesOfV2(record).contracts; if (!actual.collection || !actual.token) throw new Error('wrong-token');
    for (const role of ['token', 'collection', 'tickets', 'vault'] as const) {
      if (actual[role]?.toLowerCase() !== roles[role]?.toLowerCase()) throw new Error('wrong-code');
    }
    const [collectionCode, root, size, firstId, triggers] = await settleRevealReads([code(actual.collection, b),
      call(actual.collection, boxCollectionAbi, 'revealRoot', [], b), call(actual.collection, boxCollectionAbi, 'collectionSize', [], b),
      call(actual.collection, boxCollectionAbi, 'firstId', [], b), call(actual.collection, boxCollectionAbi, 'revealTriggers', [], b)]);
    for (const role of ['tickets', 'vault'] as const) if (actual[role]) {
      if (keccak256(await code(actual[role], b)).toLowerCase() !== rolesOfV2(record).codeHashes[role]?.toLowerCase()) throw new Error('wrong-code');
    }
    const snapshot = { ...identity, creator: record.creator, token: actual.token, specHash: record.specHash, block: { number: b.number, hash: b.hash },
      record, encodedSpec: encodeBoxSpecV2(box.spec), collectionCode, root, size, firstId, triggers } as RevealSnapshot;
    checkRevealSnapshot(identity, snapshot, identity.creator, box.spec.artMode === 1 ? 1 : 2);
    if (!await canonical(b)) throw new Error('reorg'); return snapshot;
  };
  let anchored: RevealSnapshot | undefined;
  let initializing: Promise<RevealSnapshot> | undefined;
  // Identity comes from frozen coordinator roles and clone arguments. Only loss of the finalized
  // anchor can replace that deployment. The RPC chain ID is a separate live read used by
  // preparation and each send preflight. Item traits, draw state, fees and balances stay fresh.
  const finalIdentity = async (b: RevealBlock): Promise<RevealSnapshot> => {
    if (anchored?.block.hash === b.hash) return anchored;
    if (anchored && b.number > anchored.block.number && await canonical(anchored.block)) {
      anchored = { ...anchored, block: b }; return anchored;
    }
    if (await reader.chainId() !== identity.chainId) throw new RevealRefusal('read-chain-changed');
    anchored = await readIdentity(b); return anchored;
  };
  const chain: RevealReads = {
    chainId: reader.chainId,
    heads: async () => { const [latest, finalized] = await settleRevealReads([head('latest'), head('finalized')]); return { latest, finalized }; },
    snapshot: async (wanted, tag) => {
      if (!anchored) {
        initializing ??= head('finalized').then(finalIdentity).finally(() => { initializing = undefined; });
        await initializing;
      }
      const b = await head(tag);
      const facts = tag === 'finalized' ? await finalIdentity(b) : requireRevealValue(anchored);
      const snapshot = { ...facts, block: { number: b.number, hash: b.hash } };
      checkRevealSnapshot(wanted, snapshot, wanted.creator, box.spec.artMode === 1 ? 1 : 2);
      return snapshot;
    },
    canonical, revealed: async (collection, ids, b) => (await traits(collection, ids, b)).map(t => t.revealed),
    nonce: (account, tag) => reader.getTransactionCount(account, tag), receipt,
  };
  const execution = async (c: WriteCallV2, account: Address, gas?: bigint): Promise<Hex | bigint> => {
    const b = await head('latest');
    const result = await request({ method: gas === undefined ? 'eth_estimateGas' : 'eth_call', params: [{ from: account, to: c.to, data: c.data,
      value: toQuantity(c.value), ...(gas === undefined ? {} : { gas: toQuantity(gas) }) }, blockArg(b)] });
    if (!await canonical(b)) throw new Error('reorg');
    if (gas === undefined) return quantity(result, 'estimate');
    if (typeof result !== 'string' || !isHex(result)) throw new Error('invalid-simulation'); return result;
  };
  // SH-258 fix round 2: a chain whose price floors the fee (BNB Chain testnet) reads its fee the ordinary way, the gas
  // price included; the median reward of the latest block, often 0 there, is never its tip. Sepolia's reader as it was.
  const feeReader: SendFeeReader = readsGasPrice(identity.chainId) ? {
    getBlock: reader.getBlock,
    maxPriorityFeePerGas: reader.maxPriorityFeePerGas,
    ...(reader.gasPrice ? { gasPrice: reader.gasPrice } : {}),
    getBalance: async (account, tag) => {
      const b = await reader.getBlock(tag); if (!b) throw new Error('read-failed');
      const balance = quantity(await request({ method: 'eth_getBalance', params: [account, blockArg(b)] }), 'balance');
      if (!await canonical(b)) throw new Error('reorg'); return balance;
    },
  } : {
    getBlock: reader.getBlock,
    maxPriorityFeePerGas: async () => {
      const b = await head('latest');
      const value = await request({ method: 'eth_feeHistory', params: ['0x1', toQuantity(b.number), [50]] }) as { reward?: unknown[][] };
      const tip = quantity(value?.reward?.[0]?.[0], 'fee-tip'); if (!await canonical(b)) throw new Error('reorg'); return tip;
    },
    getBalance: async (account, tag) => {
      const b = await reader.getBlock(tag); if (!b) throw new Error('read-failed');
      const balance = quantity(await request({ method: 'eth_getBalance', params: [account, blockArg(b)] }), 'balance');
      if (!await canonical(b)) throw new Error('reorg'); return balance;
    },
  };
  const hidden: HiddenRevealReads = {
    canonical, receipt,
    snapshot: async tag => {
      if (!roles.tickets) throw new Error('wrong-mode');
      const b = await head(tag); const status = await call(roles.tickets, boxTicketsAbi, 'status', [], b) as { drawsRequested: number | bigint };
      const requested = BigInt(status.drawsRequested); if (requested < 0n || requested > 10_000n) throw new Error('invalid-draw-count');
      return { block: { number: b.number, hash: b.hash }, timestamp: b.timestamp, requested };
    },
    draw: async (id, b) => {
      if (!roles.tickets) throw new Error('wrong-mode');
      const draw = await call(roles.tickets, boxTicketsAbi, 'drawTicket', [id], b) as { drawer: Address; status: number; itemId: bigint; revealFallbackAt: bigint };
      const status = hiddenDrawStatus(draw.status); let posted = false;
      if (status === 'requested') {
        const source = await call(roles.tickets, boxTicketsAbi, 'source', [], b) as Address;
        const request = await call(source, drandSourceAbi, 'requestOf', [roles.tickets, id], b) as readonly bigint[];
        const beacon = await call(source, drandSourceAbi, 'beaconOf', [request[1]], b) as readonly bigint[];
        posted = (beacon[1] ?? 0n) > 0n;
      }
      return { ...draw, id, status, posted, drawerCode: await code(draw.drawer, b) };
    },
  };
  const assetRead: RevealAssetPorts['read'] = async (scope, tag) => {
    const b = await head(tag); const rows = await traits(scope.collection, scope.ids, b);
    return { block: { number: b.number, hash: b.hash }, items: new Map(scope.ids.map((id, n) => [id, requireRevealValue(rows[n])])) };
  };
  return { identity, roles, chain, hidden, feeReader, assetRead, canonical,
    transaction: async (hash: Hex) => { const tx = await reader.getTransaction(hash); if (tx && !sameRevealValue(tx.hash, hash)) throw new Error('invalid-transaction'); return tx; }, latest: () => head('latest'), finalized: () => head('finalized'),
    estimate: (c: WriteCallV2, a: Address) => execution(c, a) as Promise<bigint>,
    simulate: (c: WriteCallV2, a: Address, gas: bigint) => execution(c, a, gas) as Promise<Hex> };
}
