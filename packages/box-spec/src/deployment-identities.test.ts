import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const pins = JSON.parse(read('../../contracts/script/config/core-v1-identity-pins.json')) as Record<
  'mainnet' | 'rehearsal', { templateId: string; versionCodeHash: string }
>;
const runbook = read('../../../docs/runbooks/sepolia-core-v1.md');

describe('F126 deployment identities (compiled and checked by DeployCoreV1Identities.t.sol)', () => {
  for (const profile of ['mainnet', 'rehearsal'] as const) {
    it(`Step 2 names the ${profile} candidate verified by the local deployment`, () => {
      for (const field of ['templateId', 'versionCodeHash'] as const) {
        const label = field === 'templateId' ? 'template id:' : 'versionCodeHash:';
        const row = runbook.split('\n').find((line) => line.startsWith(`| \`${label}\` |`));
        expect(row).toContain(pins[profile][field]);
      }
    });
  }
});
