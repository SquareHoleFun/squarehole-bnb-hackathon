/**
 * SH-249 A7: the quiet case stays as it is. With every reply arriving, the saved-before-sent keeper sends the same
 * transactions (byte for byte), in the same order, at the same nonces, and charges the same as the line, whose result
 * was recorded once (`SH_RECORD_LINE=1` on b5c72fba1's src writes the fixture).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quietRun } from './support/sent-quiet';
import { durableWiring } from './support/sent-harness';

const FIXTURE = join(import.meta.dirname, 'fixtures/sent-quiet-line.json');

describe('SH-249 A7: the quiet case', () => {
  it('sends, orders, numbers and charges exactly as the line', async () => {
    if (process.env.SH_RECORD_LINE === '1') {
      writeFileSync(FIXTURE, JSON.stringify(await quietRun(), null, 1) + '\n');
      return;
    }
    const line = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(await quietRun(durableWiring(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'sent-quiet-'))))).toEqual(line);
  });
});
