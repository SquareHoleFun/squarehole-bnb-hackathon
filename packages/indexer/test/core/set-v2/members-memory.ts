import { applySetBlock, type SetStateV2 } from '../../../src/core/set-v2/state';
import { membersFixture } from './members-fixture';

// Run in a fresh Node process with --expose-gc: Vitest's own allocations must not affect the heap bound.
if (!globalThis.gc) throw new Error('membership heap probe needs --expose-gc');
const f = membersFixture(10_000);
let state: SetStateV2 | undefined;
let block = 51n;
for (const page of f.pages) {
  const start = f.reads.loaded;
  f.reads.loaded += page.ids.length;
  f.reads.inside = BigInt(f.reads.loaded);
  f.reads.remainingHash = page.nextHash;
  const header = f.header(block++);
  state = (await applySetBlock(state, header, f.loads(start, f.reads.loaded, header), f.row, f.reader)).state;
}
if (!state || state.membership.root !== f.row.spec.setHash) throw new Error('loaded root mismatch');
// Warm the empty-block path and release loading garbage before measuring retained history.
for (let i = 0; i < 16; i++) state = (await applySetBlock(state, f.header(block++), [], f.row, f.reader)).state;
globalThis.gc();
const before = process.memoryUsage().heapUsed;
const snapshots: SetStateV2[] = [];
const start = performance.now();
for (let i = 0; i < 129; i++) {
  state = (await applySetBlock(state, f.header(block++), [], f.row, f.reader)).state;
  snapshots.push(state);
}
const elapsedMs = performance.now() - start;
globalThis.gc();
const retainedBytes = process.memoryUsage().heapUsed - before;
process.stdout.write(JSON.stringify({
  count: state.membership.members.length, blocks: snapshots.length,
  arrays: new Set(snapshots.map(s => s.membership.members)).size,
  memberships: new Set(snapshots.map(s => s.membership)).size,
  positions: new Set(snapshots.map(s => s.membership.positions)).size,
  retainedBytes, elapsedMs,
}));
