import { readFileSync } from 'node:fs';
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import * as generated from './abi-v2';
import { EVENT_ABI_V2 } from './events-v2';

const built = (name: string): Abi => (JSON.parse(readFileSync(new URL(`../../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi }).abi;
const parts = [
  ['holderLedgerV2Abi', 'HolderLedgerV2', 'holderLedger'],
  ['holderTokenV2Abi', 'BoxTokenV2Ledger', 'token'],
  ['shopVaultV2Abi', 'ShopVaultV2', 'vault'],
  ['starterSetLoaderV2Abi', 'StarterSetLoaderV2', 'starterSetLoader'],
] as const;

describe('M252-ABI: merged M2 contracts', () => {
  it.each(parts)('%s is generated from %s, including implementation-only events and reads', (key, contract) => {
    expect((generated as unknown as Record<string, Abi>)[key], key).toEqual(built(contract));
  });

  it.each(parts)('decodes every %s event at its actual role without monetary coercion', (_key, contract, role) => {
    for (const event of built(contract).filter((e): e is AbiEvent => e.type === 'event' && e.name !== 'Approval')) {
      const values = event.inputs.map(p => p.type === 'address' ? `0x${'11'.repeat(20)}` : p.type === 'bytes32' ? `0x${'cd'.repeat(32)}` : p.type === 'uint8' || p.type === 'uint32' ? 3 : 2n ** 120n + 1n);
      const topics = encodeEventTopics({ abi: [event], eventName: event.name, args: Object.fromEntries(event.inputs.map((p, i) => [p.name, values[i]])) }) as [Hex, ...Hex[]];
      const data = encodeAbiParameters(event.inputs.filter(p => !p.indexed), values.filter((_, i) => !event.inputs[i]?.indexed));
      const decoded = decodeEventLog({ abi: EVENT_ABI_V2[role] ?? [], topics, data, strict: true });
      expect(decoded.eventName).toBe(event.name);
      expect(Object.values(decoded.args ?? {})).toEqual(values);
    }
  });

  it('reads receiver net funding and coordinator completion, without treating progress as completion', () => {
    const names = (role: keyof typeof EVENT_ABI_V2) => EVENT_ABI_V2[role]?.filter(e => e.type === 'event').map(e => e.name);
    expect(names('receiver')).toContain('HolderBatchFunded');
    expect(names('coordinator')).toContain('StarterSetLoaded');
    expect(names('starterSetLoader')).toContain('StarterProgress');
  });
});
