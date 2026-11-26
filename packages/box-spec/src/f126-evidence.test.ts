import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('F126 fix-round ownership evidence', () => {
  it('records the explicitly owned conformance manifest without claiming an outside-list exception', () => {
    // SH-box0-f126 af2 explicitly lists this manifest in its owned files.
    const manifest = 'docs/design/launch-pipeline/conformance-cases.json';
    const evidence = readFileSync(new URL('../../../docs/evidence/SH-box0-f126.md', import.meta.url), 'utf8');
    const outside = evidence.split('## Outside the owned list\n')[1]?.split('\n## ')[0];
    expect(outside, 'the evidence must classify any ownership exceptions').toBeDefined();
    expect(outside, 'the manifest is explicitly owned by af2').not.toContain(manifest);
    const owned = evidence.split('### Explicitly owned files\n')[1]?.split('\n##')[0];
    expect(owned, 'record the supplied authorization for retaining BC-065, BC-098 and BC-100').toContain(manifest);
  });
});
