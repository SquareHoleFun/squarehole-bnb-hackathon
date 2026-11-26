import { describe, expect, it } from 'vitest';
import { coordinatorV2Abi, hookV2Abi, listingRegistryV2Abi, receiverV2Abi } from './abi-v2';
import { EVENT_ABI_V2 } from './events-v2';

const names = (abi: readonly { type: string; name?: string }[]) => abi.map((entry) => entry.name);
describe('CQ11-0 ABI shape pins', () => {
  it('exports standalone hook events and close/harvest/step views', () => {
    expect(names(hookV2Abi)).toEqual(expect.arrayContaining(['Closed', 'SaleFee', 'HarvestedV2', 'MigratedV2', 'close', 'harvest', 'lastProtocolBlock', 'POOL_FEE']));
    expect(names(EVENT_ABI_V2.hook ?? [])).not.toEqual(expect.arrayContaining(['Migrated', 'Harvested', 'ClosingRangeEntered']));
  });
  it('exports the two protocol Safes, the burn buy-back and failure claim', () => {
    expect(names(receiverV2Abi)).toEqual(expect.arrayContaining(['FIT_SAFE', 'PLATFORM_SAFE', 'buyBack', 'fundRoyalty']));
    expect(names(receiverV2Abi)).not.toContain('CONVERSION_SAFE');
    expect(names(receiverV2Abi)).not.toContain('forwardRoyalty');
    expect(names(coordinatorV2Abi)).toEqual(expect.arrayContaining(['claim', 'quoteClaim', 'claimState', 'PotFixed', 'Claimed']));
  });
  it('has one manual listing and raise updates without route or converter reads', () => {
    expect(names(listingRegistryV2Abi)).toEqual(expect.arrayContaining(['add', 'updateRaise', 'RaiseUpdated']));
    expect(names(listingRegistryV2Abi)).not.toContain('route');
    expect(names(listingRegistryV2Abi)).not.toContain('converterOf');
    expect(names(coordinatorV2Abi)).not.toContain('sweepAfterLastClaim');
    expect(names(coordinatorV2Abi)).not.toContain('LatePotToFit');
    expect(names(EVENT_ABI_V2.coordinator ?? [])).not.toContain('LatePotToFit');
  });
});
