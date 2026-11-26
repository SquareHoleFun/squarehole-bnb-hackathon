import { expect, it } from 'vitest';
import { configure } from '../config.mjs';
import { ladder, rescueWork } from '../drand.mjs';
import { fixture, configInput, AT } from './drand-fixture.mjs';
const cfg = configure(configInput(fixture()), {});
for (const [label, version, source, drand, mismatch] of [
  ['box 0 through its pinned drand', 1, cfg.drandBackedSource, cfg.drandSource, false],
  ['box 0 through a different drand', 1, cfg.drandBackedSource, '0x' + 'ab'.repeat(20), true],
  ['box 0 on plain drand', 1, cfg.drandSource, cfg.drandSource, true],
  ['v2 on backed source', 2, cfg.drandBackedSource, cfg.drandSource, true],
  ['v2 on plain drand', 2, cfg.drandSource, cfg.drandSource, false],
  ['unknown version', 3, cfg.drandSource, cfg.drandSource, true],
]) it(`${label}: source mismatch is ${mismatch}`, () => {
  const t = { ...fixture().consumers[0], version, source, drand };
  const data = { timestamp: String(AT), block: '1950', consumers: [t] };
  const rows = ladder(data, cfg, AT).filter(r => r.reason === 'source-mismatch');
  expect(rows).toHaveLength(mismatch ? 1 : 0);
  if (mismatch) {
    expect(rows[0]).toMatchObject({ level: 'critical', subject: t.address });
    expect(rescueWork(data, cfg, AT + 604700n)).toBeNull();
  }
});
it('preserves the existing v2 mismatch row including its detail text', () => {
  const t = fixture().consumers[1]; t.source = cfg.drandBackedSource;
  expect(ladder({ consumers: [t], timestamp: String(AT) }, cfg, AT)).toEqual([{
    id: 'drand-words', status: 'alert', reason: 'source-mismatch', level: 'critical', subject: t.address,
    detail: `${t.name} tickets ${t.address}: source ${t.source} differs from configured drand source`,
  }]);
});
