// @vitest-environment node
/** SH-294: the launch link's form as the platform reads it (the launch page's own form; anything else is no picture). */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePictureLink } from './launch-picture';

const ID = 'A'.repeat(43); const HEX = 'ab'.repeat(32);
describe('a launch link', () => {
  it('reads the launch page\'s form, on either gateway, with or without /raw/', () => {
    expect(parsePictureLink(`https://arweave.net/${ID}#sha256=${HEX}`)).toEqual({ id: ID, sha256: HEX });
    expect(parsePictureLink(`https://turbo-gateway.com/raw/${ID}#sha256=${HEX}`)).toEqual({ id: ID, sha256: HEX });
  });
  it('anything else is no picture', () => {
    for (const other of ['', null, undefined, `https://evil.example/${ID}#sha256=${HEX}`, `https://arweave.net/${ID}`, `ipfs://bafy`, `https://arweave.net/${ID}#sha256=${HEX.toUpperCase()}`]) expect(parsePictureLink(other)).toBeNull();
  });
  it('is the same rule as the launch page\'s own (bounties/app/src/lib/pictures/publish.ts, read as text)', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const original = readFileSync(resolve(root, 'bounties/app/src/lib/pictures/publish.ts'), 'utf8');
    const copy = readFileSync(resolve(root, 'apps/web/src/features/launch-cards/launch-picture.ts'), 'utf8');
    const rule = /\/\^https:[^\n]*\$\//.exec(original)?.[0];
    expect(rule).toBeTruthy();
    expect(copy).toContain(rule ?? "no rule");
  });
});
