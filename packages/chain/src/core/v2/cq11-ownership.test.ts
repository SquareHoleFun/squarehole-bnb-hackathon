import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTRACTS_DIR } from './test-support/solidity-shapes';

const evidence = readFileSync(join(CONTRACTS_DIR, '../../docs/evidence/SH-V2-CQ11-0.md'), 'utf8');

// These pins check an honest review disposition, not whether an integrator granted ownership.
// Neither the evidence's own assertions nor a passing test can supply that authorization.
describe('CQ11-0 size-manifest authorization record', () => {
  it('corrects the unsupported exception claim in the reviewed round c', () => {
    const round = evidence.split('## Fix round — c\n')[1]?.split('\n## Fix round')[0];
    expect(round).toBeDefined();
    expect(round).not.toContain('this manifest edit uses the expressly supplied exception');
    expect(round).not.toContain('Reason permitted by this ticket\'s test-manifest exception');
    expect(round).not.toContain('in a separate exception commit');
    expect(round).toContain('Review correction');
    expect(round).toContain('authorization was not supplied');
  });

  it('withdraws c-af1\'s unsupported authorization claim without losing the change provenance', () => {
    const round = evidence.split('## Fix round — c-af1\n')[1]?.split('\n## Fix round')[0];
    expect(round).toBeDefined();
    expect(round).toContain('e697f2e9bc611e7d419cb7333cfc40f54617ac8f');
    expect(round).toContain('packages/contracts/size-budget.v2.json');
    expect(round).toContain('86015efc');
    expect(round).not.toContain('That is the authority for retaining this test manifest');
    expect(round).not.toContain('Reason covered by the current ticket\'s exception');
    expect(round).toContain('authorization claim is withdrawn');
    expect(round).toContain('test result cannot establish authorization');
  });

  it('records the explicit G0 integrator authorization and closes the finding', () => {
    const status = evidence.split('\n## Fix round')[0];
    expect(status).toContain('size-manifest authorization finding is closed');
    expect(status).not.toContain('size-manifest authorization remains open');

    const decision = evidence.split('## Fix round — G0\n')[1]?.split('\n## Fix round')[0];
    expect(decision).toBeDefined();
    expect(decision).toContain('Disposition: CLOSED');
    expect(decision).toContain('2026-10-09');
    expect(decision).toContain('explicitly authorized by the integrator');
    expect(decision).toContain('packages/contracts/size-budget.v2.json');
    expect(decision).toContain('86015efc');
    expect(decision).toContain('BoxTicketsV2Views');
    expect(decision).toContain('22,118 B');

    // Preserve the historical open disposition: G0 supplies the later decision.
    const round = evidence.split('## Fix round — c-af2\n')[1]?.split('\n## Fix round')[0];
    expect(round).toBeDefined();
    expect(round).toContain('56d31830f9f76d8b8e7f2e2fc5d54dc7bfea0f86');
    expect(round).toContain('packages/contracts/size-budget.v2.json');
    expect(round).toContain('86015efc');
    expect(round).toContain('Disposition: OPEN');
    expect(round).toContain('No explicit integrator authorization or authorized dependency has been supplied');
    expect(round).toContain('Inheritance is provenance, not authorization');
    expect(round).toContain('22,118 B');
  });
});

describe('CQ11-G0 fix-round reference record', () => {
  it('withdraws the unsupported Box 0 closure and preserves the failed review gate', () => {
    const gate = readFileSync(join(CONTRACTS_DIR, '../../docs/evidence/SH-V2-CQ11-G0.md'), 'utf8');
    const round = gate.split('## Fix round — cq11-g0-af1\n')[1]?.split('\n## ')[0];
    expect(round).toBeDefined();
    expect(round).toContain('G0-AF1-3: OPEN');
    expect(round).not.toContain('G0-AF1-3: CLOSED');
    expect(round).toContain('closure claim is withdrawn');
    expect(round).toContain('119a68d81c9e5b82e96151506608018d08812582');
    expect(round).toContain('the branch you were given is the reference');
    expect(round).toContain('Exit 0; empty output');
    expect(round).toContain('does not close the review finding');
    // This checks the record, not authorization or completion of the Box 0 gate.
    expect(gate).toContain('Gate fails: output is nonempty');
  });
});
