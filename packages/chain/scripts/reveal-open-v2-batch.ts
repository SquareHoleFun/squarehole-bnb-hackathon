/**
 * SH-RENT-FREE-SEPOLIA. Offline: folds reveal-open-v2.ts's unsigned calls.json into a few Multicall3 `aggregate3`
 * calls, so an open collection's every item reveals in a few sends instead of one send per item (Rent Free: 500 in 13).
 * `reveal` is open to any caller (BoxCollectionV2.sol `reveal`: no sender check), so Multicall3 as the caller changes
 * nothing. Each call has allowFailure true (review wf_eda63cf5-a13): the chain checks every reveal against the
 * collection's revealRoot and refuses a second reveal, so a failing call (an item someone revealed first, or a rerun
 * before finality) can neither reveal wrong data nor stop its batch's other items. Re-run reveal-open-v2.ts after
 * finality, which skips what is revealed and lists what is left, and fold again.
 *
 * Every input call is checked before anything is written: the file's format and chain, one collection, no value, the
 * reveal selector, the call's id equal to its row and to the decoded id, ids distinct and in order. No RPC, signer,
 * send or estimate here: simulate a batch (`cast call`/`cast estimate`) before signing it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decodeFunctionData, getAddress, isAddress, type Address, type Hex } from 'viem';
import { boxCollectionAbi } from '../src/abi/boxCollection';
import { DEFAULT_PER_BATCH, MULTICALL3, foldReveals, type RevealBatch, type RevealCall } from '../src/core/v2/reveal-batch-calls-v2';
export { DEFAULT_PER_BATCH, MAX_PER_BATCH, MULTICALL3, multicall3Abi, foldReveals, type RevealCall, type RevealBatch } from '../src/core/v2/reveal-batch-calls-v2';

/** Checks a reveal-open-v2.ts calls.json and returns its calls (in order). */
export function readRevealCalls(input: unknown): { readonly collection: Address; readonly boxId: string; readonly calls: readonly RevealCall[] } {
  assert.ok(input !== null && typeof input === 'object' && !Array.isArray(input), 'calls.json must be an object');
  const file = input as Record<string, unknown>;
  assert.equal(file.format, 'squarehole.open-reveal-calls/1', 'not a reveal-open-v2.ts calls file');
  assert.equal(file.chainId, '11155111', 'Sepolia only');
  assert.ok(typeof file.collection === 'string' && isAddress(file.collection), 'collection address required');
  assert.ok(typeof file.boxId === 'string' && /^(0|[1-9][0-9]*)$/.test(file.boxId), 'box id required');
  assert.ok(Array.isArray(file.calls) && file.calls.length > 0, 'no calls to fold');
  const collection = getAddress(file.collection);
  let last = 0n;
  const calls = (file.calls as unknown[]).map((raw, i) => {
    assert.ok(raw !== null && typeof raw === 'object', `call ${i} malformed`);
    const call = raw as Record<string, unknown>;
    assert.ok(typeof call.id === 'string' && /^[1-9][0-9]*$/.test(call.id), `call ${i}: id`);
    assert.ok(typeof call.to === 'string' && isAddress(call.to) && getAddress(call.to) === collection, `call ${i}: not the collection`);
    assert.equal(call.value, '0', `call ${i}: carries value`);
    assert.ok(typeof call.data === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(call.data), `call ${i}: data`);
    const decoded = decodeFunctionData({ abi: boxCollectionAbi, data: call.data as Hex });
    assert.equal(decoded.functionName, 'reveal', `call ${i}: not a reveal`);
    const id = BigInt(call.id);
    assert.equal(decoded.args[0], id, `call ${i}: id differs from its calldata`);
    assert.ok(id > last, `call ${i}: ids must be distinct and ascending`);
    last = id;
    return { id: call.id, to: collection, value: '0', data: call.data as Hex };
  });
  return { collection, boxId: file.boxId, calls };
}

/** Writes batches.json and one batch-NN.calldata (hex, for `cast send MULTICALL3 $(cat batch-NN.calldata)`) per batch. */
export function writeBatches(directory: string, source: ReturnType<typeof readRevealCalls>, batches: readonly RevealBatch[]): void {
  mkdirSync(directory, { mode: 0o700 });
  const write = (name: string, contents: string) => writeFileSync(resolve(directory, name), contents, { flag: 'wx', mode: 0o600 });
  for (const batch of batches) write(`batch-${String(batch.index).padStart(2, '0')}.calldata`, `${batch.data}\n`);
  write('batches.json', `${JSON.stringify({ format: 'squarehole.open-reveal-batches/1', chainId: '11155111', boxId: source.boxId,
    collection: source.collection, multicall3: MULTICALL3, allowFailure: true, reveals: source.calls.length,
    batches: batches.map(({ index, ids, data }) => ({ index, file: `batch-${String(index).padStart(2, '0')}.calldata`, count: ids.length,
      firstId: ids[0], lastId: ids.at(-1), bytes: (data.length - 2) / 2 })) }, null, 2)}\n`);
}

function main() {
  const { values } = parseArgs({ options: { calls: { type: 'string' }, out: { type: 'string' }, 'per-batch': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    process.stdout.write('node --import ./packages/chain/scripts/register-ts.mjs packages/chain/scripts/reveal-open-v2-batch.ts --calls RUN/calls.json --out NEW_DIRECTORY [--per-batch 40]\nFolds reveal-open-v2.ts calls into Multicall3 aggregate3 batches (allowFailure true). Offline: no RPC, signing or sending. Simulate each batch before signing.\n');
    return;
  }
  assert.ok(values.calls && values.out, 'missing --calls or --out');
  const perBatch = values['per-batch'] === undefined ? DEFAULT_PER_BATCH : Number(values['per-batch']);
  const source = readRevealCalls(JSON.parse(readFileSync(values.calls, 'utf8')));
  const batches = foldReveals(source.calls, perBatch);
  writeBatches(values.out, source, batches);
  process.stdout.write(`${source.calls.length} reveals in ${batches.length} batches to ${MULTICALL3}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { process.stderr.write(`reveal-open-v2-batch: refused (${(error as Error).message}); nothing sent.\n`); process.exitCode = 1; }
}
