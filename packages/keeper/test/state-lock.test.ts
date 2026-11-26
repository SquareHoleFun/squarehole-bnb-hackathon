import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { StateStore } from '../src/state';
import { show, adopt } from '../src/state-lock';
import { runTick, type ChainPort } from '../src/run';
import { addr, options, quiet, time } from './support/v2';
const scratch = () => { mkdirSync('.cache/tmp', { recursive: true }); return mkdtempSync(resolve('.cache/tmp/keeper-lock-')); };
it('writes a JSON lock, refuses visibly with exactly the safe record, then archives refusal on restart', () => {
  const dir = scratch(), file = `${dir}/state.json`;
  const store = new StateStore(file, 'test');
  const lock = JSON.parse(readFileSync(`${file}.lock`, 'utf8'));
  expect(lock).toEqual({ pid: process.pid, startedAt: expect.stringMatching(/^\d+$/), id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  expect(() => new StateStore(file, 'test')).toThrow(expect.objectContaining({ code: 'SH_KEEPER_LOCK_HELD', message: 'keeper state lock held' }));
  expect(JSON.parse(readFileSync(`${file}.lock-refused.json`, 'utf8'))).toEqual({ schema: 'squarehole.keeper-lock-refused.v1', at: expect.stringMatching(/^\d+$/), lockStartedAt: lock.startedAt });
  expect(statSync(`${file}.lock-refused.json`).mode & 0o777).toBe(0o600);
  store.close(); store.close(); expect(() => store.save({}, 0n)).toThrow('keeper state store closed');
  const next = new StateStore(file, 'test'); next.close();
  expect(readdirSync(dir).filter(n => n.startsWith('state.json.lock-refused.json.') && n.endsWith('.cleared'))).toHaveLength(1);
});
it('shows age and adopts only the current id; changed ids and malformed locks stay untouched', () => {
  const file = `${scratch()}/state.json`; const store = new StateStore(file, 'test');
  const text = readFileSync(`${file}.lock`, 'utf8'); const lock = JSON.parse(text);
  expect(show(file)).toContain(`id: ${lock.id}`); expect(show(file)).toContain(`pid: ${process.pid}`); expect(show(file)).toContain(`startedAt: ${lock.startedAt}`); expect(show(file)).toContain('age:');
  expect(adopt(file, 'changed')).toBe(false); expect(readFileSync(`${file}.lock`, 'utf8')).toBe(text);
  expect(adopt(file, lock.id)).toBe(true); expect(adopt(file, lock.id)).toBe(false);
  writeFileSync(`${file}.lock`, '{bad'); expect(adopt(file, lock.id)).toBe(false);
  expect(readFileSync(`${file}.lock`, 'utf8')).toBe('{bad');
  void store; // Deliberately model the stopped process; its lock was adopted manually.
});
it('handles the pid-only legacy format with no guessed start time', () => {
  const file = `${scratch()}/state.json`; writeFileSync(`${file}.lock`, '12345\n');
  expect(() => new StateStore(file, 'test')).toThrow('keeper state lock held');
  expect(JSON.parse(readFileSync(`${file}.lock-refused.json`, 'utf8')).lockStartedAt).toBeNull();
  expect(show(file)).toContain('pid-only lock'); expect(show(file)).toContain('pid:12345');
  expect(adopt(file, 'pid:12346')).toBe(false); expect(adopt(file, 'pid:12345')).toBe(true);
});
it('honours abort after candidate one without splitting checkpoint and send; final checkpoint still runs', async () => {
  const controller = new AbortController(); const checkpoint = vi.fn(async () => { controller.abort(); });
  const port: ChainPort = { read: async () => ({ block: { number: 1n, timestamp: time, baseFeePerGas: 1n }, boxes: [], fitGraduated: false,
    drand: [1, 2].map(n => ({ job: 'drandRequestWord', key: `request:${n}`, to: addr(n), fn: 'requestGraduationWord', args: [] })) }),
  simulate: async () => ({ ok: true, tipWei: null, estimate: 100000n }), send: vi.fn(async () => 'hash') };
  const out = await runTick(port, {}, { ...options(), dryRun: false, checkpoint, signal: controller.signal }, quiet);
  expect(port.send).toHaveBeenCalledTimes(1); expect(out.report.sent.map(c => c.key)).toEqual(['request:1']);
  expect(checkpoint).toHaveBeenLastCalledWith(out.state, time); expect(checkpoint).toHaveBeenCalledTimes(3);
});
