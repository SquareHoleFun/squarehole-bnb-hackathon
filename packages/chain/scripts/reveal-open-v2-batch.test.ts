import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeFunctionData, erc20Abi, toHex, type Hex } from 'viem';
import { boxCollectionAbi } from '../src/abi/boxCollection';
import { DEFAULT_PER_BATCH, MULTICALL3, foldReveals, multicall3Abi, readRevealCalls, writeBatches } from './reveal-open-v2-batch';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const collection = '0x0000000000000000000000000000000000000300';
const word = (n: bigint) => toHex(n, { size: 32 });
const revealData = (id: bigint): Hex => encodeFunctionData({ abi: boxCollectionAbi, functionName: 'reveal',
  args: [id, id * 7n, word(id), word(id + 1000n), word(id + 2000n), word(id + 3000n), Array.from({ length: 9 }, (_, i) => word(BigInt(i) + id * 16n))] });
const row = (calls: Record<string, unknown>[], i: number): Record<string, unknown> => { const r = calls[i]; if (!r) throw new Error(`no row ${i}`); return r; };
const file = (n = 500, edit: (calls: Record<string, unknown>[]) => void = () => {}) => {
  const calls: Record<string, unknown>[] = Array.from({ length: n }, (_, i) => ({ id: String(i + 1), to: collection, value: '0', data: revealData(BigInt(i + 1)) }));
  edit(calls);
  return { format: 'squarehole.open-reveal-calls/1', chainId: '11155111', boxId: '5', collection, calls };
};

describe('reveal-open-v2-batch', () => {
  it('folds 500 reveals into thirteen aggregate3 calls of at most 40, in order, each failing as a whole', () => {
    const source = readRevealCalls(file());
    const batches = foldReveals(source.calls);
    expect(DEFAULT_PER_BATCH).toBe(40);
    expect(batches.map((b) => [b.index, b.ids.length, b.ids[0], b.ids.at(-1), b.to, b.value])).toEqual(
      Array.from({ length: 13 }, (_, k) => [k + 1, k < 12 ? 40 : 20, String(k * 40 + 1), String(k < 12 ? (k + 1) * 40 : 500), MULTICALL3, '0']));
    const inner = batches.flatMap((b) => {
      const decoded = decodeFunctionData({ abi: multicall3Abi, data: b.data });
      expect(decoded.functionName).toBe('aggregate3');
      return [...decoded.args[0]];
    });
    expect(inner.map((c) => [c.target.toLowerCase(), c.allowFailure])).toEqual(Array(500).fill([collection, true]));
    expect(inner.map((c) => c.callData)).toEqual(source.calls.map((c) => c.data));
    expect(inner.map((c) => decodeFunctionData({ abi: boxCollectionAbi, data: c.callData }).args[0])).toEqual(source.calls.map((c) => BigInt(c.id)));
  });

  it('keeps a short last batch and refuses batch sizes outside 1 to 40', () => {
    expect(foldReveals(readRevealCalls(file(250)).calls, 25).map((b) => b.ids.length)).toEqual(Array(10).fill(25));
    expect(foldReveals(readRevealCalls(file(90)).calls).map((b) => b.ids.length)).toEqual([40, 40, 10]);
    expect(foldReveals(readRevealCalls(file(1)).calls, 1).map((b) => b.ids)).toEqual([['1']]);
    const calls = readRevealCalls(file(3)).calls;
    for (const bad of [0, 41, 100, 1.5, Number.NaN]) expect(() => foldReveals(calls, bad)).toThrow(/per batch/);
  });

  it('refuses anything but checked reveal calls on one collection', () => {
    const cases: [string, unknown][] = [
      ['format', { ...file(2), format: 'squarehole.open-reveal-calls/2' }],
      ['chain', { ...file(2), chainId: '1' }],
      ['empty', file(0)],
      ['other target', file(2, (c) => { row(c, 1).to = '0x0000000000000000000000000000000000000301'; })],
      ['value', file(2, (c) => { row(c, 0).value = '1'; })],
      ['not a reveal', file(2, (c) => { row(c, 0).data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [collection, 1n] }); })],
      ['id differs', file(2, (c) => { row(c, 1).id = '3'; })],
      ['repeat', file(3, (c) => { c[2] = { ...row(c, 1) }; })],
      ['order', file(3, (c) => { [c[1], c[2]] = [row(c, 2), row(c, 1)]; })],
      ['data', file(2, (c) => { row(c, 0).data = '0x'; })],
    ];
    for (const [name, input] of cases) expect(() => readRevealCalls(input), name).toThrow();
  });

  it('writes one calldata file per batch and a summary, and never into an existing folder', () => {
    const source = readRevealCalls(file(90));
    const batches = foldReveals(source.calls);
    const dir = join(root, `.cache/tmp/reveal-batch-${process.pid}-${Date.now()}`);
    writeBatches(dir, source, batches);
    const summary = JSON.parse(readFileSync(join(dir, 'batches.json'), 'utf8'));
    expect(summary).toMatchObject({ format: 'squarehole.open-reveal-batches/1', boxId: '5', multicall3: MULTICALL3, allowFailure: true, reveals: 90 });
    expect(summary.batches.map((b: { count: number; firstId: string; lastId: string }) => [b.count, b.firstId, b.lastId])).toEqual([[40, '1', '40'], [40, '41', '80'], [10, '81', '90']]);
    batches.forEach((b) => expect(readFileSync(join(dir, `batch-0${b.index}.calldata`), 'utf8')).toBe(`${b.data}\n`));
    expect(() => writeBatches(dir, source, batches)).toThrow();
  });

  it('runs as a command and refuses a bad file without writing batches', () => {
    const dir = join(root, `.cache/tmp/reveal-batch-cli-${process.pid}-${Date.now()}`);
    const input = join(root, `.cache/tmp/reveal-batch-calls-${process.pid}-${Date.now()}.json`);
    // Written in-process: 150 reveals are ~180 KB of JSON, over Linux's 128 KiB limit for one command-line argument (E2BIG).
    writeFileSync(input, JSON.stringify(file(150)));
    const args = ['--import', './packages/chain/scripts/register-ts.mjs', 'packages/chain/scripts/reveal-open-v2-batch.ts', '--calls', input];
    expect(execFileSync(process.execPath, [...args, '--out', dir], { cwd: root, encoding: 'utf8' })).toBe(`150 reveals in 4 batches to ${MULTICALL3}\n`);
    expect(JSON.parse(readFileSync(join(dir, 'batches.json'), 'utf8')).batches).toHaveLength(4);
    expect(() => execFileSync(process.execPath, [...args, '--out', `${dir}-x`, '--per-batch', '500'], { cwd: root, stdio: 'pipe' })).toThrow();
  }, shLimit(60_000));
});
