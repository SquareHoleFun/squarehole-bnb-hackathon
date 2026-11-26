import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { read } from './model.mjs';

// S7's fork watch (security review F2 of SH-BOX0-BACKUP-SOURCE, F143's note; rc8 part 2b): a start in the about 264
// blocks before a fork that changes how a header is hashed or what it carries commits to a target nobody can prove.
const section = () => {
  const text = read('docs/runbooks/never-stuck.md');
  const start = text.indexOf('\n## Fork watch (box 0, S7)\n');
  assert.ok(start >= 0, 'never-stuck.md has the fork watch section');
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
};
const flat = s => s.replace(/\s+/g, ' ');

test('the fork watch names its four triggers, its window and drand before day 5', () => {
  const s = flat(section());
  for (const phrase of ['**header hashing**', "**the header's field order**", '**EIP-2935**', '**PREVRANDAO**',
    'at least a week before its activation until after it', 'posted on drand **before day 5**', 'about 264 blocks',
    'the hourly second poster', 'the laptop fallback']) assert.ok(s.includes(phrase), phrase);
});

test('the fork watch names both header encoders by path and the refusal each prints', () => {
  const s = flat(section());
  for (const [path, refusal] of [['packages/keeper/src/backup-header.ts', 'backup header mismatch'],
    ['scripts/box/drand-rescue/header.mjs', 'backup header refused']]) {
    assert.ok(s.includes(`\`${path}\``), path);
    assert.ok(existsSync(new URL(`../../../../${path}`, import.meta.url)), `${path} exists`);
    assert.ok(read(path).includes(`'${refusal}'`), `${path} prints ${refusal}`);
    assert.ok(s.includes(`\`${refusal}\``), refusal);
    assert.ok(read(path).includes("'requestsHash'"), `${path} lists the header's fields`);
  }
});

test('the fork watch records its check: each round posted before day 5 and its backup unstarted', () => {
  const s = section();
  for (const call of ["cast call \"$SOURCE\" 'requestOf(address,uint256)(uint64,uint64)' <tickets> <key>",
    "cast call \"$SOURCE\" 'wordOf(address,uint256)(bytes32,uint64)' <tickets> <key>",
    "cast call \"$SOURCE\" 'backupOf(uint256)(uint64,uint64,uint64,bytes32)' <round>"]) assert.ok(s.includes(call), call);
  const f = flat(s);
  for (const phrase of ["the round's time + 432000", 'startedAt is 0', 'Record', "the fork's name and activation",
    'once a day through the watch and once after the activation']) assert.ok(f.includes(phrase), phrase);
  assert.ok(read('packages/contracts/src/box/randomness/BoxBackedSource.sol').includes('uint256 public constant BACKUP_AFTER = 5 days;'));
});
