import { expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';
import { feeChoiceV2 } from '../../src/core/v2/views-v2';
import { receiverArgsHexLengthV21 } from '../../src/core/v2/pay-in-t-provenance-v21';
import { m3Fixture } from '../../src/core/v2/m3-fixture.test-support';

it('FM11 admits canonical directory ids and reserves both immutable snapshots in a mixed receiver', () => {
  const f = m3Fixture(false);
  const a = { leg: 1, dest: 9, legParams: '0x' as Hex, destParams: encodeAbiParameters(parseAbiParameters('uint32'), [4]) };
  const side = { ...f.spec.buyers, a };
  expect(feeChoiceV2(side)).toBe('module');
  expect(feeChoiceV2({ ...side, a: { ...a, leg: 2 } })).toBeNull();
  expect(feeChoiceV2({ ...side, a: { ...a, destParams: '0x' } })).toBeNull();
  expect(feeChoiceV2({ ...side, a: { ...a, destParams: encodeAbiParameters(parseAbiParameters('uint256'), [1n << 32n]) } })).toBeNull();
  expect(receiverArgsHexLengthV21({ ...f.spec, buyers: side })).toBe(782);
});

import { moduleSnapshotsV21 } from '../../src/core/v2/fee-modules-provenance-v21';
import { keccak256 } from 'viem';
it('FM13 preserves both snapshots and rejects changed tails or an unused side with authority', () => {
  const f = m3Fixture(false);
  const side = { ...f.spec.buyers, a: { leg: 1, dest: 9, legParams: '0x' as Hex, destParams: encodeAbiParameters(parseAbiParameters('uint32'), [4]) } };
  const spec = { ...f.spec, buyers: side };
  const module = `0x${'12'.repeat(20)}` as const, codeHash = keccak256('0x6000');
  const args = `${'00'.repeat(220)}0a${'00'.repeat(66)}${module.slice(2)}${codeHash.slice(2)}${'00'.repeat(52)}`;
  const runtime = `0x${'00'.repeat(45)}${args}` as Hex;
  expect(moduleSnapshotsV21(spec, runtime)).toEqual([{ module, codeHash }]);
  expect(() => moduleSnapshotsV21(spec, `${runtime}00`)).toThrow(/length/);
  expect(() => moduleSnapshotsV21(spec, `${runtime.slice(0, -2)}01` as Hex)).toThrow(/unused/);
});
