import { expect, it, vi } from 'vitest';
import { settings, runLoop } from '../services/runtime.mjs';
it('uses the keeper poll interval and backs off repeated failures, resetting after success', async () => {
  const cfg = settings('keeper', { SH_SERVICE_ENABLED: '1', SH_KEEPER_POLL_MS: '30000' });
  expect(cfg.interval).toBe(30000);
  const sleeps = [];
  const cycle = vi.fn().mockRejectedValueOnce(new Error()).mockRejectedValueOnce(new Error()).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error());
  await runLoop(cfg, { cycle }, { stopped: () => sleeps.length === 4, sleep: async ms => { sleeps.push(ms); }, random: () => 0, publish: () => {}, log: () => {} });
  expect(sleeps).toEqual([30000, 60000, 30000, 30000]);
});
it('rejects malformed poll intervals', () => {
  for (const value of ['0', '-1', 'NaN', '1.5']) expect(() => settings('keeper', { SH_KEEPER_POLL_MS: value })).toThrow();
});
