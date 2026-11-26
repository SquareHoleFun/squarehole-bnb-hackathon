import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { PICTURE_BUDGET } from '@squarehole/artwork/box-picture';
import { pictureFixture } from '../../artwork/src/picture-fixtures';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { WEBP_CHILD_ARGS } from './webp-decoder';

const path = (name: string) => fileURLToPath(new URL(`./webp-fixtures/${name}`, import.meta.url)).replace(/^\/@fs\//, '/');
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  }
});

it.each([
  ['non-WebP', pictureFixture('ordinary.png')],
  ['oversized', new Uint8Array(PICTURE_BUDGET.bytes + 1)],
  ['over pixel budget', pictureFixture('pixel-budget.webp')],
] as const)('direct child refuses %s before constructing sharp', async (_name, bytes) => {
  const child = spawn(process.execPath, ['--import', path('sharp-contract.mjs'), ...WEBP_CHILD_ARGS], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('child pipes absent');
  const calls: unknown[] = [], output: Buffer[] = [];
  child.on('message', value => calls.push(value));
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.resume();
  child.stdin.on('error', () => {}); // Oversized input can be refused before the writer finishes.
  const closed = once(child, 'close');
  child.stdin.end(bytes);
  expect(await closed).toEqual([1, null]);
  expect(calls).toEqual([]);
  expect(Buffer.concat(output)).toHaveLength(0);
});

it('direct child constructor observer sees an admitted WebP', async () => {
  const child = spawn(process.execPath, ['--import', path('sharp-contract.mjs'), ...WEBP_CHILD_ARGS], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('child pipes absent');
  const calls: unknown[] = [];
  child.on('message', value => calls.push(value));
  child.stdout.resume(); child.stderr.resume();
  const closed = once(child, 'close');
  child.stdin.end(pictureFixture('lossless.webp'));
  expect(await closed).toEqual([0, null]);
  expect(calls).toEqual(['sharp-constructed']);
});

const state = (pid: number) => {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] ?? 'unknown'; }
  catch { return 'gone'; }
};
const waitFor = async (check: () => boolean, ms: number) => {
  const end = performance.now() + ms;
  while (!check() && performance.now() < end) await new Promise<void>(resolve => setImmediate(resolve));
  expect(check()).toBe(true);
};

it.runIf(process.platform === 'linux').each(['ipc', 'stdin'])('parent death kills a blocked native worker through %s', async channel => {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'sh211-native-'));
  const fifo = join(dir, 'worker.fifo'), ready = join(dir, 'ready');
  expect(spawnSync('mkfifo', [fifo], { timeout: shLimit(1000) }).status).toBe(0);
  const parent = spawn(process.execPath, [path('native-block-parent.mjs'), channel], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, SH_WEBP_FIFO: fifo, SH_WEBP_READY: ready },
  });
  children.push(parent);
  let childPid = 0;
  parent.on('message', value => { childPid = Number(value); });
  try {
    await waitFor(() => {
      try { return childPid > 0 && Number(readFileSync(ready, 'utf8')) === childPid; }
      catch { return false; }
    }, shLimit(5000));
    // The ready file alone only proves work was queued. Require a worker sleeping inside FIFO open.
    await waitFor(() => readdirSync(`/proc/${childPid}/task`).some(tid => {
      try { return readFileSync(`/proc/${childPid}/task/${tid}/wchan`, 'utf8').includes('wait_for_partner'); }
      catch { return false; }
    }), shLimit(5000));
    const closed = once(parent, 'close');
    parent.kill('SIGKILL');
    await waitFor(() => ['gone', 'Z'].includes(state(childPid)), shLimit(1000));
    await closed;
    // An orphan can wait as a zombie for the host init to reap it; it has no threads or allocations.
    expect(['gone', 'Z']).toContain(state(childPid));
  } finally {
    if (childPid && !['gone', 'Z'].includes(state(childPid))) process.kill(childPid, 'SIGKILL');
  }
}, shLimit(5000) + shLimit(5000) + shLimit(1000));
