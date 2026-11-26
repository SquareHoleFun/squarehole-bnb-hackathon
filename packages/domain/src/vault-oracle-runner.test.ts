import { describe, expect, it } from 'vitest';
import { runPython } from './test-support/vault-oracle';

// The oracle helper must never hold `pnpm verify` open: a stalled python3 is killed and the test fails instead.
describe('runPython', () => {
  it('kills a run past its time limit and throws', () => {
    const started = Date.now();
    expect(() => runPython(['-c', 'import time; time.sleep(30)'], { timeoutMs: 300 })).toThrow(/python3 could not run/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('closes stdin when no input is given, so a reader sees end of input', () => {
    const run = runPython(['-c', 'import sys; print(len(sys.stdin.read()))'], { timeoutMs: 10_000 });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('0');
  });
});
