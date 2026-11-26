import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as generated from './abi-v2';
import { NOT_READ_V2 } from './events-v2';
import { canonicalInputs, canonicalOutputs } from '../../../../keeper/src/abi';

type Item = { type: string; name?: string; inputs?: unknown[]; outputs?: unknown[]; stateMutability?: string };
const normalize = (abi: readonly Item[]) => abi.map((item) => JSON.stringify(item)).sort();
const artifact = (source: string, name: string) => JSON.parse(readFileSync(new URL(`../../../../contracts/out/${source}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Item[] };

describe('CQ11-E1 regenerated ABI drift', () => {
  it('pins the authorized neutral name and unchanged fields of the reserved vault event', () => {
    const events = generated.vaultV2Abi.filter((item) => item.type === 'event');
    expect(events.find((item) => item.name === 'ItemPayoutForwarded')).toEqual({
      type: 'event', name: 'ItemPayoutForwarded', anonymous: false,
      inputs: [
        { name: 'token', type: 'address', internalType: 'address', indexed: true },
        { name: 'amount', type: 'uint256', internalType: 'uint256', indexed: false },
        { name: 'receiver', type: 'address', internalType: 'address', indexed: false },
      ],
    });
    expect(events.map((item) => item.name)).not.toContain('EarnedForwarded');
    expect(NOT_READ_V2.some(e => e.name === 'ItemPayoutForwarded')).toBe(false);
  });

  it('matches every frozen shape including launch-router calls', () => {
    for (const [key, source, name] of [
      ['registryV2Abi', 'IBoxRegistryV2', 'IBoxRegistryV2'],
      ['listingRegistryV2Abi', 'IListingRegistry', 'IListingRegistry'],
      ['coordinatorV2Abi', 'IBoxCoordinatorV2', 'IBoxCoordinatorV2'],
      ['factoryV2Abi', 'IBoxCoordinatorV2', 'IBoxFactoryV2'],
      ['hookV2Abi', 'IBoxHookV2', 'IBoxHookV2'],
      ['receiverV2Abi', 'IBoxReceiverV2', 'IBoxReceiverV2'],
      ['vaultV2Abi', 'IBoxVaultV2', 'IBoxVaultV2'],
      ['launchRouterV2Abi', 'IBoxPeripheryV2', 'IBoxLaunchRouterV2'],
    ] as const) {
      expect(normalize((generated as unknown as Record<string, Item[]>)[key] ?? []), key).toEqual(normalize(artifact(source, name).abi));
    }
  });
  it('decodes all merged receiver and coordinator implementation errors', () => {
    for (const [key, name] of [['receiverV2ErrorsAbi', 'BoxReceiverV2'], ['coordinatorV2ErrorsAbi', 'BoxCoordinatorV2']] as const) {
      expect(normalize((generated as unknown as Record<string, Item[]>)[key] ?? []), key).toEqual(normalize(artifact(name, name).abi.filter((i) => i.type === 'error')));
    }
  });
  it('pins the shapes to the merged B and C callable surfaces and event topics', () => {
    for (const [abi, name] of [[generated.receiverV2Abi, 'BoxReceiverV2'], [generated.coordinatorV2Abi, 'BoxCoordinatorV2']] as const) {
      const built = artifact(name, name).abi;
      for (const item of abi) {
        if (item.type !== 'function' && item.type !== 'event') continue;
        const found = built.find((i) => i.type === item.type && i.name === item.name && canonicalInputs(i) === canonicalInputs(item));
        expect(found, `${name}.${item.name}`).toBeDefined();
        if (item.type === 'function') expect(canonicalOutputs(found ?? {}), item.name).toBe(canonicalOutputs(item));
        else expect(found?.inputs?.map((i) => (i as { indexed: boolean }).indexed)).toEqual(item.inputs.map((i) => i.indexed));
      }
    }
  });
});
