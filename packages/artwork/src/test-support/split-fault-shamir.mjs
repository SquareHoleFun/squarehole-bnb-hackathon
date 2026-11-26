/**
 * TEST ONLY: shamir-secret-sharing as split-fault-preload.mjs serves it to the box 0 CLI. `split` is the library's.
 * The first `combine` (the trustee splitter's first recovery proof, when the three share files exist; on `recover`, the
 * second, as the first rebuilds the key from the old shares) first does what BOX0_TEST_AT_COMBINE says, then goes on
 * with the library's `combine`. BOX0_TEST_AT_COMBINE_CALL picks another call (1 is the first):
 *   signal:<NAME>  sends that signal to this process (Ctrl-C, kill) and waits for it to act;
 *   file:<path>    writes a file that is not the CLI's there (something that appears after the checks);
 *   folder:<path>  makes a folder there holding such a file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const real = await import(new URL(import.meta.url).searchParams.get('real'));

export const split = real.split;

let calls = 0;

async function act(order) {
  const at = order.indexOf(':');
  const kind = order.slice(0, at);
  const arg = order.slice(at + 1);
  if (kind === 'signal') {
    process.kill(process.pid, arg);
    await new Promise((done) => setTimeout(done, 5000));
  } else if (kind === 'file') {
    writeFileSync(arg, 'not ours\n');
  } else if (kind === 'folder') {
    mkdirSync(arg);
    writeFileSync(join(arg, 'not-ours.txt'), 'not ours\n');
  } else {
    throw new Error(`unknown BOX0_TEST_AT_COMBINE ${order}`);
  }
}

export async function combine(shares) {
  const order = process.env.BOX0_TEST_AT_COMBINE;
  calls += 1;
  if (order && calls === Number(process.env.BOX0_TEST_AT_COMBINE_CALL ?? '1')) await act(order);
  return real.combine(shares);
}
