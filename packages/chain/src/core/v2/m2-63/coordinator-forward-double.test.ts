import { readFileSync } from 'node:fs';
import { parseAbiItem, toEventSelector, type Abi } from 'viem';
import { expect, it, vi } from 'vitest';
import { CORE_TOPIC0_V2, EVENT_ABI_V2 } from '../events-v2';
import { decodeV2Log, decodeV2Logs, routeV2 } from '../../../../../indexer/src/core/v2/events-v2';
import { applyV2Block } from '../../../../../indexer/src/core/v2/views-v2';
import { A, H, logM2, m2Fixture } from '../../../../../indexer/src/core/v2/m2-fixture.test-support';

// OC-04 handoff only: the three shared ABI source files are outside this lane's ownership.
// Supply the missing selection locally; use the real authenticated decoder and activity projector.
vi.mock('../events-v2', async importOriginal => {
  const actual = await importOriginal<typeof import('../events-v2')>();
  const event = parseAbiItem('event ClaimsForwarded(address indexed to,uint256 amount)');
  return { ...actual,
    EVENT_ABI_V2: { ...actual.EVENT_ABI_V2, coordinator: [...(actual.EVENT_ABI_V2.coordinator ?? []), event] },
    CORE_TOPIC0_V2: { ...actual.CORE_TOPIC0_V2, coordinator: [...(actual.CORE_TOPIC0_V2.coordinator ?? []), toEventSelector(event)] },
  };
});

it('OC-04 local supplement: actual reserve event retains authentication, bigint amount and activity', () => {
  const artifact = JSON.parse(readFileSync(new URL('../../../../../contracts/out/BoxCoordinatorV2.sol/BoxCoordinatorV2.json', import.meta.url), 'utf8')) as { abi: Abi };
  const event = artifact.abi.find(e => e.type === 'event' && e.name === 'ClaimsForwarded');
  if (!event || event.type !== 'event') throw new Error('production reserve event missing');
  const selected = EVENT_ABI_V2.coordinator?.find(e => e.type === 'event' && e.name === event.name);
  expect(selected?.type).toBe('event');
  if (!selected || selected.type !== 'event') throw new Error('local supplement missing');
  expect(selected.inputs.map(({ name, type, indexed }) => ({ name, type, indexed: !!indexed })))
    .toEqual(event.inputs.map(({ name, type, indexed }) => ({ name, type, indexed: !!indexed })));
  expect(CORE_TOPIC0_V2.coordinator).toContain(toEventSelector(event));

  const f = m2Fixture(), route = routeV2(f.release, f.manifest, [], [f.record]);
  const amount = 2n ** 120n + 1n, raw = logM2(event, f.at(0), { to: f.at(5), amount }, 1);
  expect(decodeV2Log(raw, route)).toMatchObject({ source: 'coordinator', boxId: f.row.boxId,
    name: 'ClaimsForwarded', args: { to: f.at(5), amount } });
  for (const address of [A, f.at(5), f.at(17)]) expect(decodeV2Log({ ...raw, address }, route)).toBeNull();
  expect(decodeV2Log({ ...raw, removed: true }, route)).toBeNull();
  expect(decodeV2Log({ ...raw, data: '0x' }, route)).toBeNull();
  const events = decodeV2Logs([raw, raw], route);
  expect(events).toHaveLength(1);
  const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1700000100n };
  const projected = applyV2Block(undefined, header, events, f.row);
  expect(projected.activity).toHaveLength(1);
  expect(projected.activity[0]?.data).toMatchObject({ source: 'coordinator', event: 'ClaimsForwarded',
    to: f.at(5), amount: amount.toString() });
  expect(applyV2Block(projected.state, header, events, f.row).activity).toEqual([]);
});
