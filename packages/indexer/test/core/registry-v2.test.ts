/**
 * M1-52, added after the red tests: from registry v2's logs to a discovered box, and the look-alikes that never get
 * that far (core-v2-m1-tickets.md § 2, M1-52 "a v1 look-alike refused"; BC-073's rule for v2):
 * - `BoxCreated` and `BoxSpec` from the release's registry decode, and their record and spec pass discovery;
 * - v1's `BoxCreated` (13 roles, another topic) at the v2 registry's address decodes to nothing;
 * - v2's `BoxCreated` from an address no release names decodes to nothing;
 * - F99: the creator's unused items the vault hands back after a failure are listed on the box's view.
 */
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { boxRegistryAbi } from '@squarehole/chain/abi';
import type { RawLog } from '../../src/events';
import { checkBoxV2 } from '../../src/core/v2/discovery-v2';
import { boxViewContextV2, boxViewV2 } from '../../src/core/v2/views-v2';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { vaultV2Abi, type BoxRecordV2 } from '../../src/core/v2/chain-v2';
import { boxLogsV2, synthBoxV2, synthManifestV2, SynthReaderV2, V2 } from '../../../chain/src/core/v2/test-support/synth-v2';

const manifest = synthManifestV2();
const first = manifest.releases[0];
if (!first) throw new Error('synthetic release');
const release = first;
let logIndex = 0;
const at = (log: { address: Address; topics: readonly Hex[]; data: Hex }, block = 100n): RawLog => ({ ...log, blockNumber: block, blockHash: keccak256(toHex(block)), transactionHash: keccak256(toHex(block + 9n)), transactionIndex: 0, logIndex: logIndex++ });

describe('M1-52 registry v2 logs to discovery', () => {
  it("M1-52 BoxCreated and BoxSpec from the release's registry decode and their box passes discovery", async () => {
    const box = synthBoxV2({ boxId: 21n });
    const [created, spec] = boxLogsV2(box).map((l) => at(l));
    const events = decodeV2Logs([created as RawLog, spec as RawLog], routeV2(release, manifest, [], []));
    expect(events.map((e) => [e.source, e.name])).toEqual([
      ['registry', 'BoxCreated'],
      ['registry', 'BoxSpec'],
    ]);
    const record = events[0]?.args.record as BoxRecordV2;
    const encodedSpec = events[1]?.args.encodedSpec as Hex;
    const verdict = await checkBoxV2(new SynthReaderV2().addBox(box), manifest, { registry: events[0]?.address as Address, record, encodedSpec }, { creationHash: keccak256('0x15'), headHash: keccak256('0x16'), reviewed: [] });
    expect(verdict).toMatchObject({ classification: 'shown', reason: null, marks: [] });
  });

  it("M1-52 v1's BoxCreated at the v2 registry, and v2's from a look-alike registry, decode to nothing", () => {
    const route = routeV2(release, manifest, [], []);
    const event = boxRegistryAbi.find((x) => x.type === 'event' && x.name === 'BoxCreated');
    if (!event || event.type !== 'event') throw new Error('v1 BoxCreated');
    const v1Record = { boxId: 1n, templateId: keccak256('0x01'), specHash: keccak256('0x02'), creator: V2.weth, q: V2.weth, raise: 1n, poolManager: V2.poolManager, poolId: keccak256('0x03'), creationBlock: 1n, openAt: 1n, randomness: V2.randomness, contracts: Array.from({ length: 13 }, () => V2.weth), codeHashes: Array.from({ length: 13 }, () => keccak256('0x04')) };
    const v1Log = at({
      address: V2.registry,
      topics: encodeEventTopics({ abi: [event], eventName: 'BoxCreated', args: { boxId: 1n, templateId: v1Record.templateId, specHash: v1Record.specHash } } as never) as Hex[],
      data: encodeAbiParameters([event.inputs[3] as never], [v1Record] as never),
    });
    expect(decodeV2Logs([v1Log], route)).toEqual([]);
    const [lookAlike] = boxLogsV2(synthBoxV2({ boxId: 22n }), '0x1000000000000000000000000000000000000001');
    expect(decodeV2Logs([at(lookAlike as { address: Address; topics: readonly Hex[]; data: Hex })], route)).toEqual([]);
  });

  it("M1-52 F99: the creator's unused items handed back after a failure are listed on the box's view", () => {
    const box = synthBoxV2({ boxId: 23n });
    const vault = box.record.contracts[3] as Address;
    const event = vaultV2Abi.find((x) => x.type === 'event' && x.name === 'ReleasedToCreator');
    if (!event || event.type !== 'event') throw new Error('ReleasedToCreator');
    const log = at({
      address: vault,
      topics: encodeEventTopics({ abi: [event], eventName: 'ReleasedToCreator', args: { creator: box.record.creator } }) as Hex[],
      data: encodeAbiParameters([event.inputs[1] as never], [[1n, 2n, 3n]] as never),
    });
    const events = decodeV2Logs([log], routeV2(release, manifest, [], [box.record]));
    const view = boxViewV2(events, boxViewContextV2(box.record, box.spec, 18));
    expect(view.releasedToCreator).toEqual([1n, 2n, 3n]);
  });
});
