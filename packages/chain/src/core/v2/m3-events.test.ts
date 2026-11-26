import { readFileSync } from 'node:fs';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import * as generated from './abi-v2';
import { EVENT_ABI_V2 } from './events-v2';

const built = (file: string, name = file): Abi => (JSON.parse(readFileSync(new URL(`../../../../contracts/out/${file}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi }).abi;
const parts = [
  ['itemLedgerV2Abi', 'ItemLedgerV2', 'ItemLedgerV2', 'itemLedger'],
  ['pileVaultV2Abi', 'PileVaultV2', 'PileVaultV2', 'vault'],
  ['receiverItemsV2Abi', 'IBoxReceiverV2', 'IBoxReceiverItemsV2', 'receiver'],
  ['vaultItemsV2Abi', 'IBoxVaultV2', 'IBoxVaultItemsV2', 'vault'],
  ['factoryPileV2Abi', 'IBoxCoordinatorV2', 'IBoxFactoryPileV2', null],
] as const;

describe('M352-ABI: built parts and declared integration companions', () => {
  it.each(parts)('%s equals the compiled ABI', (key, file, name) => {
    expect((generated as unknown as Record<string, Abi>)[key], key).toEqual(built(file, name));
  });
  it.each(parts.filter(p => p[3]))('routes every event of %s with full-width amounts', (_key, file, name, role) => {
    if (!role) throw new Error('event role required');
    for (const event of built(file, name).filter((e): e is AbiEvent => e.type === 'event')) {
      const values = event.inputs.map(p => p.type === 'address' ? `0x${'11'.repeat(20)}` : p.type === 'bytes32' ? `0x${'ab'.repeat(32)}` : p.type === 'uint8' ? 2 : 2n ** 50n + 1n);
      const args = Object.fromEntries(event.inputs.map((p, i) => [p.name, values[i]]));
      const topics = encodeEventTopics({ abi: [event], eventName: event.name, args }) as [Hex, ...Hex[]];
      const data = encodeAbiParameters(event.inputs.filter(p => !p.indexed), values.filter((_, i) => !event.inputs[i]?.indexed));
      const decoded = decodeEventLog({ abi: EVENT_ABI_V2[role] ?? [], topics, data, strict: true });
      expect(decoded.eventName).toBe(event.name);
      expect(decoded.args ?? {}).toEqual(args);
    }
  });
  it('includes failed ledger notices and royalty forwarding without mistaking either for an item claim', () => {
    const names = EVENT_ABI_V2.vault?.filter(e => e.type === 'event').map(e => e.name);
    expect(names).toContain('ItemLedgerCallFailed');
    expect(names).toContain('ItemPayoutForwarded');
  });
});
