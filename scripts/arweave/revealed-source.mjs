import { createRequire } from 'node:module';
import { boxCollectionAbi } from '../../packages/chain/src/abi/boxCollection.ts';
import { rawCidV1 } from '../ipfs/pin-raw-lib.mjs';
import { decimal, exact, fail, hash, httpsUrl, jsonRequest, MAX_FILE, object, sha256 } from './common.mjs';

const { decodeEventLog, encodeFunctionData, decodeFunctionResult } = createRequire(new URL('../../packages/indexer/package.json', import.meta.url))('viem');
const ROLES = ['image', 'avatar', 'model'];
export const CONTENT_TYPES = { image: 'image/webp', avatar: 'image/webp', model: 'model/gltf-binary', metadata: 'application/json' };
const quantity = (s) => {
  if (typeof s !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(s)) fail('invalid Ethereum RPC quantity');
  return BigInt(s);
};

export function deployment(env, allowMainnet) {
  const chainId = env.SH_ARWEAVE_CHAIN_ID;
  const collection = env.SH_ARWEAVE_COLLECTION?.toLowerCase();
  if (!decimal(chainId) || BigInt(chainId) === 0n || !/^0x[0-9a-f]{40}$/.test(collection ?? '') || /^0x0+$/.test(collection)) fail('explicit chain and collection required');
  if (chainId === '1' && allowMainnet !== true) fail('chain 1 requires --allow-mainnet');
  return { chainId, collection };
}

/** Feed entries are hints. The pin job state authorizes only completed two-provider
 * pins; finalized canonical RPC receipts remain the reveal authority on every run.
 * No render directory, private assignment, salts, or unrevealed art is read.
 */
export async function readRevealedItems({ env, publicFile, feed, pinState, scope, fetch }) {
  const { chainId, collection } = scope;
  const n = publicFile?.n;
  if (publicFile?.format !== 'squarehole.box0-commitment/1' || !Number.isSafeInteger(n) || n < 1 || n > 8192
      || publicFile.depth !== Math.ceil(Math.log2(n)) || !hash(publicFile.root)) fail('invalid public commitment');
  // The reveal watcher's /2 checkpoint (SH-MN-01) adds its scan cursor, bound to this root; references stay hints in both.
  const v2 = feed?.format === 'squarehole.reveal-pin-feed/2';
  if (!exact(feed, ['format', 'chainId', 'collection', 'events', ...(v2 ? ['scan'] : [])]) || (!v2 && feed.format !== 'squarehole.reveal-pin-feed/1')
      || (v2 && (!object(feed.scan) || feed.scan.root !== publicFile.root))
      || feed.chainId !== chainId || feed.collection !== collection || !Array.isArray(feed.events) || feed.events.length > 20_000) fail('invalid reveal feed binding');
  if (pinState?.format !== 'squarehole.reveal-pin-state/1' || !object(pinState.items) || Object.keys(pinState.items).length > n
      || pinState.scope?.chainId !== chainId || pinState.scope?.collection !== collection || pinState.scope?.root !== publicFile.root) fail('invalid pin state binding');
  const refs = new Map();
  for (const ref of feed.events) {
    if (!exact(ref, ['transactionHash', 'logIndex']) || !hash(ref.transactionHash) || !decimal(ref.logIndex)) fail('invalid reveal feed reference');
    refs.set(`${ref.transactionHash}:${ref.logIndex}`, ref);
  }
  if (!refs.size) return [];
  const rpcUrl = httpsUrl(env.SH_ARWEAVE_RPC_URL, false);
  let sequence = 0;
  const rpc = async (method, params) => {
    const id = ++sequence;
    const res = await jsonRequest(fetch, rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    if (res?.jsonrpc !== '2.0' || res.id !== id || res.error || !Object.hasOwn(res, 'result')) fail('invalid RPC response');
    return res.result;
  };
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(chainId)) fail('RPC chain differs from configured chain');
  const head = await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!head || !hash(head.hash)) fail('RPC finalized block unavailable');
  const height = quantity(head.number);
  const call = async (functionName, args = []) => {
    const data = encodeFunctionData({ abi: boxCollectionAbi, functionName, args });
    const result = await rpc('eth_call', [{ to: collection, data }, { blockHash: head.hash, requireCanonical: true }]);
    try { return decodeFunctionResult({ abi: boxCollectionAbi, functionName, data: result }); }
    catch { fail('invalid collection read response'); }
  };
  if (await call('revealRoot') !== publicFile.root || await call('collectionSize') !== BigInt(n) || await call('firstId') !== 1n) fail('collection differs from public commitment');
  const items = new Map();
  let batchBytes = 0n;
  for (const ref of refs.values()) {
    const receipt = await rpc('eth_getTransactionReceipt', [ref.transactionHash]);
    if (!receipt || receipt.status !== '0x1' || receipt.transactionHash !== ref.transactionHash || !hash(receipt.blockHash) || !Array.isArray(receipt.logs)) fail('invalid reveal receipt');
    const blockNumber = quantity(receipt.blockNumber);
    if (blockNumber > height) fail('reveal is not finalized');
    const canonical = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    if (!canonical || quantity(canonical.number) !== blockNumber || canonical.hash !== receipt.blockHash) fail('reveal is not canonical');
    const logs = receipt.logs.filter((log) => quantity(log.logIndex).toString() === ref.logIndex);
    const log = logs[0];
    if (logs.length !== 1 || log.removed !== false || typeof log.address !== 'string' || log.address.toLowerCase() !== collection
        || log.transactionHash !== ref.transactionHash || log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber
        || !Array.isArray(log.topics) || log.topics.length !== 2 || typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{256}$/.test(log.data)) fail('invalid reveal log origin');
    let decoded;
    try { decoded = decodeEventLog({ abi: boxCollectionAbi, data: log.data, topics: log.topics, strict: true }); }
    catch { fail('invalid collection event'); }
    if (decoded.eventName !== 'Revealed' || decoded.args.id < 1n || decoded.args.id > BigInt(n)) fail('not an edition reveal');
    const id = decoded.args.id.toString();
    if (items.has(id)) fail('conflicting reveal references');
    const event = { transactionHash: ref.transactionHash, logIndex: ref.logIndex, blockNumber: blockNumber.toString(), blockHash: receipt.blockHash };
    const pinned = pinState.items[id];
    if (!exact(pinned, ['event', 'files']) || !exact(pinned.event, Object.keys(event)) || Object.keys(event).some((key) => pinned.event[key] !== event[key])
        || !exact(pinned.files, ROLES)) fail('reveal does not match pin state');
    if (await call('isRevealed', [BigInt(id)]) !== true) fail('item is not revealed at finality');
    const files = {};
    for (const role of ROLES) {
      const p = pinned.files[role];
      const digest = decoded.args[`${role}Hash`]?.toLowerCase();
      if (!hash(digest) || p?.sha256 !== digest || p.cid !== rawCidV1(digest) || !decimal(p.bytes) || BigInt(p.bytes) < 1n || BigInt(p.bytes) > BigInt(MAX_FILE)
          || p.pins?.kubo !== 'pinned' || p.pins?.pinata !== 'pinned') fail('file differs from revealed hash or is not pinned by both providers');
      files[role] = { sha256: digest, size: p.bytes, cid: p.cid };
      batchBytes += BigInt(p.bytes);
    }
    const uri = await call('tokenURI', [BigInt(id)]);
    const prefix = 'data:application/json;base64,';
    if (typeof uri !== 'string' || !uri.startsWith(prefix)) fail('metadata must be on-chain JSON data URI');
    const encoded = uri.slice(prefix.length);
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE || bytes.toString('base64') !== encoded) fail('invalid metadata bytes');
    let metadata;
    try { metadata = JSON.parse(bytes.toString('utf8')); }
    catch { fail('invalid published JSON metadata'); }
    if (metadata.image !== `ipfs://${files.image.cid}` || metadata.animation_url !== `ipfs://${files.model.cid}`) fail('metadata differs from revealed art');
    // The v1 leaf has three art hashes. Metadata has on-chain provenance, not a
    // fourth leaf digest; never reserialize or rewrite its immutable IPFS links.
    files.metadata = { sha256: sha256(bytes), size: String(bytes.length), bytes };
    batchBytes += BigInt(bytes.length);
    if (batchBytes > 67_108_864n) fail('batch exceeds 64 MiB; split the reveal feed and retain the same archive state');
    items.set(id, { id, event, files });
  }
  return [...items.values()];
}
