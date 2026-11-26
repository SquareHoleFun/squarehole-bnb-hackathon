import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { purgePlan, executePurge } from './purge.mjs';
import { scratch, id } from '../../test/fixtures/alpha-sender/helpers.mjs';

test('retention includes progress records only in receipts and keeps deletion behind the existing gate', () => {
  const p = scratch(), root = dirname(p.queue), ended = '2026-10-01T00:00:00.000Z', now = Date.parse('2026-11-01T00:00:00.000Z');
  const file = join(p.receipts, `${id(1)}.progress.json`); writeFileSync(file, '{}');
  const plan = purgePlan(root, ended, now); assert.deepEqual(plan.files, [file]);
  const erased = [];
  assert.throws(() => executePurge(plan, { uid: 0, erase: path => erased.push(path), now }));
  assert.deepEqual(erased, []);
  executePurge(plan, { uid: 0, stopped: true, erase: path => erased.push(path), now });
  assert.deepEqual(erased, [file]);
  writeFileSync(join(p.queue, `${id(1)}.progress.json`), '{}');
  assert.throws(() => purgePlan(root, ended, now));
});


test('SH-198 retention includes counts snapshots and shared sender status, never unknown files', () => {
  const p = scratch(), root = dirname(p.queue), ended = '2026-10-01T00:00:00.000Z', now = Date.parse('2026-11-01T00:00:00.000Z');
  const files = [join(p.receipts, 'sender-status.json'), join(p.state, 'monitor.json'), join(p.state, 'monitor.json.new')];
  for (const file of files) writeFileSync(file, '{}');
  assert.deepEqual(purgePlan(root, ended, now).files.sort(), files.sort());
  writeFileSync(join(p.state, 'other.json'), '{}');
  assert.throws(() => purgePlan(root, ended, now));
});
