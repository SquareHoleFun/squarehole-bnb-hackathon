import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boxCollectionAbi } from '../../../packages/chain/src/abi/boxCollection.ts';
import { rawCidV1 } from '../../../scripts/ipfs/pin-raw-lib.mjs';

const { encodeEventTopics, encodeAbiParameters, decodeFunctionData, encodeFunctionResult } =
  createRequire(new URL('../../../packages/indexer/package.json', import.meta.url))('viem');
export const digest = value => `0x${createHash('sha256').update(value).digest('hex')}`;
const hex = value => `0x${value.toString(16)}`;
const roles = ['image', 'avatar', 'model'];

/** Real receipt/ABI/art/provider boundary, entirely in memory; each response costs 100 ms of simulated latency. */
export async function revealFixture({ count = 400, n = 4269, saved = true, mode = 'dry-run' } = {}) {
  await mkdir('.cache/tmp', { recursive: true });
  const dir = await mkdtemp('.cache/tmp/reveal-service-');
  const collection = `0x${'12'.repeat(20)}`;
  const encoding = { image: { format: 'webp', size: 512, quality: 90 }, avatar: { format: 'webp', size: 256, quality: 90 }, model: { format: 'glb' } };
  const publicFile = { format: 'squarehole.box0-commitment/1', n, depth: 13, root: digest('root'), encoding,
    renderGeneratorTree: 'a'.repeat(40), platform: 'fake-test-platform' };
  const art = Object.fromEntries(roles.map(role => [role, Buffer.from(`obviously fake ${role}`)]));
  const header = { format: 'squarehole.misfits-render-hashes/1', generatorTree: publicFile.renderGeneratorTree, platform: publicFile.platform, encoding };
  const rows = Array.from({ length: count }, (_, i) => ({ id: i + 1, curationId: 'fake-test-art',
    ...Object.fromEntries(roles.map(role => [role, { sha256: digest(art[role]), bytes: art[role].length }])) }));
  for (const folder of ['commitment', 'images', 'avatars', 'model']) await mkdir(join(dir, folder));
  await writeFile(join(dir, 'commitment/render-hashes.jsonl'), [header, ...rows].map(JSON.stringify).join('\n'));
  for (const role of roles) await writeFile(join(dir, role === 'model' ? 'model/fake-test-art.glb' : `${role}s/fake-test-art.webp`), art[role]);
  const logs = rows.map(({ id }) => ({ address: collection, transactionHash: digest(`fake tx ${id}`), blockHash: digest('block 200'),
    blockNumber: '0xc8', logIndex: hex(BigInt(id)), removed: false,
    topics: encodeEventTopics({ abi: boxCollectionAbi, eventName: 'Revealed', args: { id: BigInt(id) } }),
    data: encodeAbiParameters([{ type: 'uint128' }, ...roles.map(() => ({ type: 'bytes32' }))], [1n, ...roles.map(role => digest(art[role]))]),
  }));
  const feed = { format: 'squarehole.reveal-pin-feed/2', chainId: '11155111', collection,
    events: logs.map(log => ({ transactionHash: log.transactionHash, logIndex: BigInt(log.logIndex).toString() })),
    scan: { root: publicFile.root, n: String(publicFile.n), depth: '13', startBlock: '1', through: { number: '400', hash: digest('block 400') } } };
  const env = { SH_SERVICE_ENABLED: '1', SH_SERVICE_MODE: mode, SH_REVEAL_CHAIN_ID: '11155111', SH_REVEAL_COLLECTION: collection,
    SH_REVEAL_FROM_BLOCK: '1', SH_REVEAL_RPC_URL: 'https://rpc.invalid/fake-test-only', SH_TEST_DIRECTORY: dir,
    SH_REVEAL_KUBO_API: 'https://kubo.invalid', SH_REVEAL_PINATA_ACCOUNT: 'fake-test-account', SH_REVEAL_PINATA_JWT: 'obviously-fake-test-token' };
  await writeFile(join(dir, 'public.json'), JSON.stringify(publicFile));
  if (saved) await writeFile(join(dir, 'feed.json'), JSON.stringify(feed));
  const h = { dir, env, logs, elapsed: 0, requests: [], uploads: [], head: 400n, changedBlock: null, failProvider: false, interrupt: null };
  const blockNumbers = new Map(Array.from({ length: 1000 }, (_, i) => [digest(`block ${i}`), BigInt(i)]));
  h.state = async () => JSON.parse(await readFile(join(dir, 'feed.json.work'), 'utf8'));
  h.fetch = async (url, options) => {
    options.signal.throwIfAborted();
    h.elapsed += 100;
    if (url.startsWith('https://rpc.invalid/')) {
      const { id, method, params } = JSON.parse(options.body);
      h.requests.push({ method, params });
      h.interrupt?.(method);
      options.signal.throwIfAborted();
      let result;
      if (method === 'eth_chainId') result = '0xaa36a7';
      else if (method === 'eth_getBlockByNumber') {
        const number = params[0] === 'finalized' ? h.head : BigInt(params[0]);
        result = { number: hex(number), hash: digest(number === h.changedBlock ? 'reorg' : `block ${number}`) };
      } else if (method === 'eth_getLogs') result = (h.discoveryLogs ?? logs).filter(log => BigInt(log.blockNumber) >= BigInt(params[0].fromBlock) && BigInt(log.blockNumber) <= BigInt(params[0].toBlock));
      else if (method === 'eth_getTransactionReceipt') {
        const log = logs.find(log => log.transactionHash === params[0]);
        result = { status: '0x1', transactionHash: log.transactionHash, blockHash: log.blockHash, blockNumber: log.blockNumber, logs: [log] };
      } else if (method === 'eth_call') {
        if (params[1].requireCanonical !== true) throw new Error('canonical read required');
        const { functionName } = decodeFunctionData({ abi: boxCollectionAbi, data: params[0].data });
        const at = blockNumbers.get(params[1].blockHash);
        if (at === undefined || at === h.changedBlock) throw new Error('noncanonical hash');
        const values = { revealRoot: publicFile.root, collectionSize: BigInt(publicFile.n), firstId: 1n,
          revealedCount: at >= 200n ? BigInt(count) : 0n, isRevealed: at >= 200n };
        result = encodeFunctionResult({ abi: boxCollectionAbi, functionName, result: values[functionName] });
      } else throw new Error('unexpected RPC');
      return Response.json({ jsonrpc: '2.0', id, result });
    }
    if (mode !== 'live') throw new Error('dry mode contacted a provider');
    if (options.method === 'GET') return Response.json({ rows: [] });
    const car = Buffer.from(await options.body.get('file').arrayBuffer());
    const role = roles.find(role => car.subarray(-art[role].length).equals(art[role]));
    if (!role) throw new Error('unexpected art');
    const provider = url.startsWith('https://kubo.invalid') ? 'kubo' : 'pinata';
    if (h.failProvider && provider === 'pinata') throw new Error('fake provider failure');
    h.uploads.push({ provider, role });
    const cid = rawCidV1(digest(art[role]));
    return Response.json(provider === 'kubo' ? { Root: { Cid: { '/': cid }, PinErrorMsg: '' } } : { IpfsHash: cid });
  };
  return h;
}
