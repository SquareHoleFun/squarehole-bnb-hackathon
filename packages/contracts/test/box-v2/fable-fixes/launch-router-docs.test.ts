import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const router = readFileSync('packages/contracts/src/box-v2/BoxLaunchRouterV2.sol', 'utf8');

describe('Fable item 11: failure sweep contract', () => {
  it('documents the coordinator pot for every caller and takes no obsolete hook argument', () => {
    const helper = router.match(/(?: {4}\/\/\/[^\n]*\n)+ {4}function _failureSweepTo[^}]+}/)?.[0];
    expect(helper).toBeDefined();
    expect(helper).toMatch(/coordinator.{0,20}pot/);
    expect(helper).toMatch(/any caller/);
    expect(helper).not.toMatch(/creator|closing range|closing pool/);
    expect(helper).toContain('function _failureSweepTo()');
    expect(router).toContain('to = _failureSweepTo();');
  });
});
