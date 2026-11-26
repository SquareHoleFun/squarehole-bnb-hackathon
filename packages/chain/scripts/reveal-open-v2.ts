/** SH-EX-L4. Read-only Sepolia preparation. No wallet, signer, send, pin or private-file support. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createPublicClient, http, keccak256, zeroHash, type Address, type Hex, type PublicClient } from 'viem';
import { validateOpenBoxSpecV2 } from '../src/core/v2/open-reveal-spec-v2';
import { boxCollectionAbi } from '../src/abi/boxCollection';
import { registryV2Abi } from '../src/core/v2/abi-v2';
import { checkedRevealCallV2, collectionTargetV2 } from '../src/core/v2/collection-calls-v2';
import { ROLE_V2 } from '../src/core/roles';
import type { BoxRecordV2 } from '../src/core/v2/record-v2';

const REGISTRY = '0x5D2866EF084d801aE734D3A2A6E4F7179898737C';
/** R74-ART expectations only. Final commitments must come from each created box's own download. */
export const OPEN_REVEAL_SETS = {
  'rent-free': { itemCount: '500', modelHashes: 'nonzero' },
  'bag-holders': { itemCount: '420', modelHashes: 'nonzero' },
  'link-marines-v2': { itemCount: '420', modelHashes: 'zero' },
  'exit-liquidity': { itemCount: '404', modelHashes: 'zero' },
} as const;
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78);
const json = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v, 2);
/** Decode FINAL downloaded ABI bytes and check the displayed spec, exact list and optional kit expectations. */
export function readOpenBoxSpec(input: unknown, kit?: string) {
  const result = validateOpenBoxSpecV2(input, { maxListBytes: 1_048_576 });
  const { list } = result;
  if (kit !== undefined) {
    assert.ok(Object.hasOwn(OPEN_REVEAL_SETS, kit), 'unknown open kit');
    const expected = OPEN_REVEAL_SETS[kit as keyof typeof OPEN_REVEAL_SETS];
    assert.equal(list.n, expected.itemCount, 'kit item count mismatch');
    assert.equal(new Set(list.items.map(item => item.imageSha256.toLowerCase())).size, list.items.length, 'kit requires distinct image hashes');
    assert.ok(list.items.every(item => (item.modelSha256.toLowerCase() === zeroHash) === (expected.modelHashes === 'zero')),
      `kit requires ${expected.modelHashes} model hashes`);
  }
  return result;
}

/** Re-running at a new finalized block is the resume operation. Never trust a local "sent" cursor. */
export async function prepareOpenReveals(input: unknown, options: { client: PublicClient; from: Address; boxId: bigint; kit?: string }) {
  const { spec, specHash, list, tree, revealListBytes } = readOpenBoxSpec(input, options.kit);
  const { client, from, boxId } = options;
  assert.ok(boxId >= 0n, 'invalid box id');
  assert.equal(await client.getChainId(), 11155111, 'Sepolia only');
  const block = await client.getBlock({ blockTag: 'finalized' });
  assert.ok(block.number !== null && block.hash !== null, 'finalized block required');
  const blockNumber = block.number;
  const record = await client.readContract({ address: REGISTRY, abi: registryV2Abi, functionName: 'recordOf', args: [boxId], blockNumber }) as BoxRecordV2;
  assert.equal(record.boxId, boxId, 'wrong registry record');
  // The finalized registry specHash binds the encoded spec's revealListId; the collection has no list-id getter.
  assert.equal(record.specHash.toLowerCase(), specHash.toLowerCase(), 'download does not belong to this box');
  const target = collectionTargetV2(11155111, record, from);
  const code = await client.getCode({ address: target.collection, blockNumber });
  assert.ok(code && code !== '0x', 'collection code missing');
  assert.equal(keccak256(code), record.codeHashes[ROLE_V2.collection]?.toLowerCase(), 'collection code hash mismatch');
  const read = { address: target.collection, abi: boxCollectionAbi, blockNumber } as const;
  const [root, size, firstId, triggers] = await Promise.all([
    client.readContract({ ...read, functionName: 'revealRoot' }), client.readContract({ ...read, functionName: 'collectionSize' }),
    client.readContract({ ...read, functionName: 'firstId' }), client.readContract({ ...read, functionName: 'revealTriggers' }),
  ]);
  assert.equal(root.toLowerCase(), spec.revealRoot.toLowerCase(), 'on-chain revealRoot mismatch');
  assert.equal(size, BigInt(spec.n), 'on-chain size mismatch');
  assert.equal(firstId, spec.firstId, 'on-chain firstId mismatch');
  assert.equal(triggers, 4, 'collection must reveal always (open art)');
  const calls: { id: string; to: Address; value: string; data: Hex }[] = [];
  const skipped: string[] = [];
  for (let offset = 0; offset < list.items.length; offset += 20) {
    const items = list.items.slice(offset, offset + 20);
    const states = await Promise.all(items.map(item => client.readContract({ ...read, functionName: 'revealState', args: [BigInt(item.id)] })));
    items.forEach((item, i) => {
      const state = states[i];
      assert.ok(state && state.length === 4 && state.every(v => typeof v === 'boolean'), 'invalid reveal state');
      if (state[2]) { skipped.push(item.id); return; }
      assert.ok(state[3], `item ${item.id} is not revealable`);
      const call = checkedRevealCallV2(target, BigInt(item.id), {
        traitsPacked: BigInt(item.traitsPacked), imageHash: item.imageSha256, avatarHash: item.avatarSha256,
        modelHash: item.modelSha256, salt: item.salt, proof: tree.proof(offset + i + 1),
      }, { root, size, firstId }, from);
      calls.push({ id: item.id, ...call, value: call.value.toString() });
    });
  }
  assert.equal((await client.getBlock({ blockNumber })).hash, block.hash, 'finalized block changed; retry');
  return { format: 'squarehole.open-reveal-calls/1', chainId: '11155111', registry: REGISTRY, boxId: boxId.toString(),
    from, collection: target.collection, kit: options.kit ?? null, specHash, revealRoot: root, revealListId: spec.revealListId,
    blockNumber: blockNumber.toString(), blockHash: block.hash, calls, skipped, revealListBytes };
}

/** A new directory for each run makes partial writes and old proposals visibly distinct. No overwrite or upload. */
export function writeOpenReveals(plan: Awaited<ReturnType<typeof prepareOpenReveals>>, directory: string) {
  mkdirSync(directory, { mode: 0o700 });
  const { revealListBytes, ...report } = plan;
  const write = (name: string, contents: string) => writeFileSync(resolve(directory, name), contents, { flag: 'wx', mode: 0o600 });
  write('reveal-list.json', revealListBytes); // Exact canonical bytes: no trailing newline.
  write('pin.json', `${json({ files: [{ path: 'reveal-list.json', role: 'file', sha256: plan.revealListId }] })}\n`);
  write('calls.json', `${json(report)}\n`);
}

async function main() {
  const { values } = parseArgs({ options: { spec: { type: 'string' }, 'box-id': { type: 'string' }, from: { type: 'string' }, out: { type: 'string' }, kit: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    process.stdout.write('node --import ./packages/chain/scripts/register-ts.mjs packages/chain/scripts/reveal-open-v2.ts --spec FINAL_BOX_DOWNLOAD --box-id ID --from ADDRESS --out NEW_DIRECTORY [--kit KIT]\nUse --kit for W: rent-free, bag-holders, link-marines-v2, exit-liquidity (distinct pictures and required model policy).\nRead-only RPC: SH_REVEAL_RPC_URL. Outputs unsigned calls.json, canonical reveal-list.json and pin.json. No simulation, gas estimate, signing, sending or pinning. Publish the exact list; simulate and estimate before signing. Re-run after finality to resume.\n');
    return;
  }
  assert.ok(values.spec && values['box-id'] && values.from && values.out && process.env.SH_REVEAL_RPC_URL, 'missing arguments or SH_REVEAL_RPC_URL');
  assert.ok(statSync(values.spec).size <= 256 * 1024 * 1024, 'download too large');
  const client = createPublicClient({ transport: http(process.env.SH_REVEAL_RPC_URL, { retryCount: 0 }) });
  const result = await prepareOpenReveals(JSON.parse(readFileSync(values.spec, 'utf8')), {
    client, from: values.from as Address, boxId: BigInt(decimal.parse(values['box-id'])), ...(values.kit === undefined ? {} : { kit: values.kit }),
  });
  writeOpenReveals(result, values.out);
  process.stdout.write(`${result.calls.length} unsigned calls; ${result.skipped.length} already revealed.\n`);
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('reveal-open-v2: preparation failed; no calls sent, no files pinned.\n'); process.exitCode = 1; });
}
