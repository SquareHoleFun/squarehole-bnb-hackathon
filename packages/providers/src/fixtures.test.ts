import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HANDOFF_FIXTURE_SHA256 = 'c4fb3196a98b543dd35bfa30efb44bc5901fb0142adb627d9b63d14932eddd04';
const copyPath = fileURLToPath(new URL('./fixtures/feed.json', import.meta.url));
const handoffRoot = fileURLToPath(new URL('../../../square-hole-handoff/', import.meta.url));
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('bundled demo fixture', () => {
  it('is a byte-for-byte copy of the handoff fixture (sha256 pinned)', () => {
    expect(sha256(readFileSync(copyPath))).toBe(HANDOFF_FIXTURE_SHA256);
  });

  it('matches the MANIFEST.sha256 entry for fixtures/feed.json', () => {
    const manifest = readFileSync(`${handoffRoot}MANIFEST.sha256`, 'utf8');
    const entry = manifest.split('\n').find((line) => line.endsWith('  fixtures/feed.json'));
    expect(entry?.split('  ')[0]).toBe(HANDOFF_FIXTURE_SHA256);
    expect(readFileSync(copyPath).equals(readFileSync(`${handoffRoot}fixtures/feed.json`))).toBe(true);
  });
});
