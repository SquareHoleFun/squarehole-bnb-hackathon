import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryV2Abi } from './abi-v2';
import { CONTRACTS_DIR } from './test-support/solidity-shapes';

const root = join(CONTRACTS_DIR, 'src/box-v2/interfaces');
describe('CQ11-0 documented money contract', () => {
  it('separates the fixed creator remainder from permanently retained late money (RC5-A)', () => {
    const text = readFileSync(join(root, 'IBoxCoordinatorV2.sol'), 'utf8');
    expect(text).not.toContain('No-holder failure uses the same rule');
    expect(text).toContain('initial no-holder remainder belongs to the creator');
    const claim = text.slice(text.indexOf('/// @notice Anyone after failure'), text.indexOf('function claim('));
    expect(claim).toContain('creator');
    expect(claim).toContain('t = 0');
    expect(claim).toContain('initial no-holder remainder');
    expect(text).not.toContain('sweepAfterLastClaim');
    expect(text).toContain('without expiry');
    expect(text).toContain('remain locked forever');
  });

  it('documents delivery custody separately for graduation and failure', () => {
    const text = readFileSync(join(root, 'IBoxVaultV2.sol'), 'utf8');
    const delivery = text.slice(text.indexOf('/// @notice A drawn item'), text.indexOf('function deliverTicket('));
    expect(delivery).toContain('Normal delivery retains T principal in vault escrow');
    expect(delivery).toContain('after failure');
    expect(delivery).toContain('creator');
  });

  it('removes the superseded coordinator and factory contract', () => {
    const text = readFileSync(join(root, 'IBoxCoordinatorV2.sol'), 'utf8');
    for (const removed of ['enterClosing', 'redeemHeldT', 'closing range', 'IConverter', 'markUsed', 'PLUG_IN_CODE_HASH']) {
      expect(text, removed).not.toContain(removed);
    }
    for (const required of ['pot lives in the coordinator', 'min(K,', 'creator payee', 'seven days', 'real P', 'reserve is split as fees']) {
      expect(text, required).toContain(required);
    }
  });

  it('does not publish factory errors for removed plug-in checks', () => {
    const errors = factoryV2Abi.filter((entry) => entry.type === 'error').map((entry) => entry.name);
    for (const retired of ['PLUG_IN_CODE_HASH', 'PlugInDelegated', 'PlugInNoCode']) expect(errors).not.toContain(retired);
  });

  it('documents each declared interface function, error and event at its member', () => {
    const missing: string[] = [];
    for (const file of readdirSync(root).filter((f) => f.endsWith('.sol'))) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(function|error|event)\s/.test(line) && !/^\s*\/\/\//.test(lines[i - 1] ?? '')) missing.push(`${file}:${i + 1}`);
      });
    }
    expect(missing).toEqual([]);
  });
});
