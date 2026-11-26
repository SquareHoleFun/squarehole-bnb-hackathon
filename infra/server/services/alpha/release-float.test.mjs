import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFloat } from './release-float.mjs';
import { openStore } from './store.mjs';
import { FLOAT_REASON } from './sender/settings.mjs';
import { account, claim, desk, token, id, scratch } from '../../test/fixtures/alpha-sender/helpers.mjs';

async function fixture(status = 'refused', mode = 'live') {
  const paths = scratch(), c = await claim(1), dbPath = join(paths.state, 'alpha.sqlite');
  const api = openStore(dbPath);
  api.run('INSERT INTO signups VALUES(?,?,?,?,?,?,?,?)', c.xId, c.privyDid, 'test1', 'Tester', null, 'approved', c.requestedAt, c.requestedAt);
  api.run('INSERT INTO claims(id,xId,address,payload,acceptedAt,published) VALUES(?,?,?,?,?,1)', c.id, c.xId, c.address, JSON.stringify(c), c.requestedAt);
  paths.put(c);
  const outcome = { v: 1, id: c.id, status, admitTx: null, sendTx: null, reason: FLOAT_REASON, at: c.requestedAt };
  const receiptFile = join(paths.receipts, `${c.id}.json`), journalFile = join(paths.state, mode === 'live' ? 'journal.json' : 'journal.dry.json');
  const entry = status === 'refused' ? { id: c.id, reserved: false, outcome } : { id: c.id, reserved: true,
    xId: c.xId, address: c.address, days: ['2026-10-29'], needsAdmit: true,
    quote: { admitGas: '100000', sendGas: '21000', maxFeePerGas: '2', maxPriorityFeePerGas: '1' }, outcome };
  const journal = { v: 1, identity: `11155111:${desk.address}:${token}:${mode}`, entries: [entry] };
  const save = () => { writeFileSync(receiptFile, JSON.stringify(outcome)); writeFileSync(journalFile, JSON.stringify(journal)); };
  save();
  if (mode === 'dry-run') writeFileSync(join(paths.state, 'journal.json'), JSON.stringify({ ...journal, identity: `11155111:${desk.address}:${token}:live`, entries: [] }));
  return { ...paths, c, entry, journal, outcome, save, api, journalFile, receiptFile,
    opts: { ...paths, id: c.id, dbPath, address: desk.address, teth: token },
    reserved: () => api.get('SELECT reserved FROM claims WHERE id = ?', c.id).reserved };
}

for (const status of ['refused', 'failed']) {
  test(`releases only the reviewed unsigned ${status} outcome and preserves all final history`, async () => {
    const f = await fixture(status);
    try {
      const oldJournal = readFileSync(f.journalFile, 'utf8'), oldReceipt = readFileSync(f.receiptFile, 'utf8');
      const plan = await releaseFloat(f.opts);
      assert.equal(plan.executed, false); assert.equal(f.reserved(), 1);
      assert.equal(readFileSync(f.journalFile, 'utf8'), oldJournal); assert.equal(existsSync(join(f.state, 'sender.lock')), false);
      await assert.rejects(releaseFloat({ ...f.opts, execute: true, reviewed: plan.review }), /proof refused/);
      await assert.rejects(releaseFloat({ ...f.opts, execute: true, servicesStopped: true, reviewed: '0'.repeat(64) }), /proof refused/);
      assert.equal((await releaseFloat({ ...f.opts, execute: true, servicesStopped: true, reviewed: plan.review })).executed, true);
      assert.equal(f.reserved(), 0); assert.equal(readFileSync(f.receiptFile, 'utf8'), oldReceipt);
      assert.deepEqual(JSON.parse(readFileSync(join(f.queue, `${id(1)}.json`), 'utf8')), f.c);
      const released = JSON.parse(readFileSync(f.journalFile, 'utf8')).entries[0];
      assert.equal(released.reserved, false); assert.deepEqual(released.outcome, f.outcome);
      assert.equal(released.floatRelease.review, plan.review); assert.equal(released.address, undefined);
      await assert.rejects(releaseFloat(f.opts), /proof refused/);
    } finally { f.api.close(); }
  });
}

test('a historical dry-run release never changes the live journal', async () => {
  const f = await fixture('refused', 'dry-run');
  try {
    const live = readFileSync(join(f.state, 'journal.json'), 'utf8'), plan = await releaseFloat(f.opts);
    await releaseFloat({ ...f.opts, execute: true, servicesStopped: true, reviewed: plan.review });
    assert.equal(readFileSync(join(f.state, 'journal.json'), 'utf8'), live); assert.equal(f.reserved(), 0);
  } finally { f.api.close(); }
});

for (const [name, mutate] of Object.entries({
  signed: f => { f.entry.admit = { raw: 'signed bytes' }; },
  'null transaction field': f => { f.entry.send = null; },
  'receipt hash': f => { f.outcome.sendTx = `0x${'ab'.repeat(32)}`; },
  'another refusal': f => { f.outcome.reason = 'X account already claimed'; },
  'sent receipt': f => { f.outcome.status = 'sent'; },
  'unknown signing evidence': f => { f.entry.prepared = 'uncertain'; },
  'missing journal entry': f => { f.journal.entries = []; },
  'journal mismatch': f => { f.entry.outcome = { ...f.outcome, at: '2026-10-30T00:00:00.000Z' }; },
  'another live reservation': f => { f.journal.entries.push({ id: id(2), reserved: true, xId: '1', address: account(2).address,
    days: ['2026-10-29'], needsAdmit: false, quote: { admitGas: '0', sendGas: '21000', maxFeePerGas: '2', maxPriorityFeePerGas: '1' } }); },
})) {
  test(`refuses release with ${name}`, async () => {
    const f = await fixture();
    try { mutate(f); f.save(); await assert.rejects(releaseFloat(f.opts)); assert.equal(f.reserved(), 1); }
    finally { f.api.close(); }
  });
}

test('a sender lock, missing history, symlink, changed review or changed queue cannot be released', async () => {
  const f = await fixture();
  try {
    const plan = await releaseFloat(f.opts);
    const opts = { ...f.opts, execute: true, servicesStopped: true, reviewed: plan.review };
    const lock = join(f.state, 'sender.lock'); writeFileSync(lock, 'held');
    await assert.rejects(releaseFloat(opts), /sender lock held/);
    renameSync(lock, `${lock}.test-released`);
    renameSync(f.journalFile, `${f.journalFile}.backup`);
    await assert.rejects(releaseFloat(opts));
    symlinkSync(`${f.journalFile}.backup`, f.journalFile); await assert.rejects(releaseFloat(opts));
    renameSync(f.journalFile, `${f.journalFile}.link`); renameSync(`${f.journalFile}.backup`, f.journalFile);
    f.api.run('UPDATE claims SET acceptedAt = ? WHERE id = ?', '2026-10-30T00:00:00.000Z', f.c.id);
    await assert.rejects(releaseFloat(opts), /proof refused/);
    f.put({ ...f.c, signature: `0x${'00'.repeat(65)}` });
    await assert.rejects(releaseFloat(f.opts), /proof refused/); assert.equal(f.reserved(), 1);
  } finally { f.api.close(); }
});

test('a crash after sender release retains the API reservation; a fresh reviewed plan completes it', async () => {
  const f = await fixture('failed');
  try {
    const plan = await releaseFloat(f.opts);
    await assert.rejects(releaseFloat({ ...f.opts, execute: true, servicesStopped: true, reviewed: plan.review },
      { checkpoint: () => { throw new Error('interrupted'); } }), /interrupted/);
    assert.equal(f.reserved(), 1);
    const retry = await releaseFloat(f.opts); assert.notEqual(retry.review, plan.review);
    await releaseFloat({ ...f.opts, execute: true, servicesStopped: true, reviewed: retry.review });
    assert.equal(f.reserved(), 0); assert.equal(f.receipt(1).status, 'failed');
  } finally { f.api.close(); }
});
