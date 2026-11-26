import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Run forge first: these are compiler ABI checks, never source-text selector guesses.
const out = new URL('../../../out/', import.meta.url);
const baseline = JSON.parse(readFileSync(new URL('./existing-abi.json', import.meta.url), 'utf8')) as {
  reference: string;
  interfaces: { source: string; name: string; abiSha256: string; selectors: Record<string, string> }[];
};
type Parameter = { name: string; type: string; internalType: string; indexed?: boolean; components?: Parameter[] };
type Member = { type: string; name?: string; inputs?: Parameter[]; outputs?: Parameter[]; stateMutability?: string; anonymous?: boolean };
type Artifact = { abi: Member[]; methodIdentifiers: Record<string, string> };
function artifact(source: string, name: string): Artifact {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`${source}/${name}.json`, out)), 'utf8')) as Artifact;
}
function member(abi: Member[], name: string): Member {
  const found = abi.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing ABI member: ${name}`);
  return found;
}
const ledgerAdditions = new Set(['insidePolicies', 'lifecycleCursor', 'ItemSyncPending']);

describe('SH-V2-M3-SHAPES: all incoming interface ABIs', () => {
  it('F127: neither payout interface exposes a third-party claim', () => {
    for (const name of ['IHolderLedgerV2', 'IItemLedgerV2']) {
      const actual = artifact(`${name}.sol`, name);
      expect(actual.abi.some((entry) => entry.name === 'claimFor'), name).toBe(false);
    }
  });
  for (const pin of baseline.interfaces) {
    it(`${pin.name}: every retained selector, tuple, event and error stays pinned after F127`, () => {
      const actual = artifact(pin.source, pin.name);
      const additions = pin.name === 'IItemLedgerV2' ? ['insidePolicies()', 'lifecycleCursor()'] : [];
      expect(Object.keys(actual.methodIdentifiers).sort()).toEqual([...Object.keys(pin.selectors), ...additions].sort());
      for (const [signature, selector] of Object.entries(pin.selectors)) {
        expect(actual.methodIdentifiers[signature], signature).toBe(selector);
      }
      const oldAbi = pin.name === 'IItemLedgerV2'
        ? actual.abi.filter((member) => !ledgerAdditions.has(member.name ?? '')) : actual.abi;
      expect(createHash('sha256').update(JSON.stringify(oldAbi)).digest('hex')).toBe(pin.abiSha256);
    });
  }
});

const fundingFields = [
  ['batchId', 'uint256'], ['lifecycleCursor', 'uint256'], ['choiceP', 'uint256'], ['ledgerP', 'uint256'],
  ['insideCount', 'uint32'], ['hiddenCount', 'uint32'], ['side', 'uint8'], ['source', 'uint8'],
];
const lifecycleFields = [
  ['ticketKey', 'bytes32'], ['itemId', 'uint256'], ['fundingCursor', 'uint256'], ['at', 'uint64'], ['kind', 'uint8'],
];
const additions = [
  { source: 'IBoxReceiverV2.sol', name: 'IBoxReceiverItemsV2', functions: ['itemFundingCount()', 'itemFunding(uint256)'] },
  { source: 'IBoxVaultV2.sol', name: 'IBoxVaultItemsV2', functions: ['itemLifecycleCount()', 'itemLifecycle(uint256)', 'ITEM_BATCH_MAX()'] },
  { source: 'IBoxPeripheryV2.sol', name: 'IBoxTicketsItemsV2', functions: ['activeItemTicket(uint256)'] },
  { source: 'IBoxCoordinatorV2.sol', name: 'IBoxFactoryPileV2', functions: ['isPileVault(address)'] },
];

describe('SH-V2-M3-SHAPES: additive read contracts', () => {
  for (const pin of additions) {
    it(`${pin.name}: exact read-only surface without a new money entry`, () => {
      const actual = artifact(pin.source, pin.name);
      expect(Object.keys(actual.methodIdentifiers).sort()).toEqual([...pin.functions].sort());
      for (const member of actual.abi.filter((entry) => entry.type === 'function')) {
        expect(member.stateMutability, member.name).toBe('view');
      }
    });
  }

  it('S1/S4: ledger adds exactly the two reads and the retry error', () => {
    const old = baseline.interfaces.find((entry) => entry.name === 'IItemLedgerV2');
    if (!old) throw new Error('Missing incoming IItemLedgerV2 baseline');
    const actual = artifact(old.source, old.name);
    expect(Object.keys(actual.methodIdentifiers).filter((key) => !(key in old.selectors)).sort())
      .toEqual(['insidePolicies()', 'lifecycleCursor()']);
    const fresh = actual.abi.filter((member) => ledgerAdditions.has(member.name ?? ''));
    expect(fresh.map((entry) => [entry.type, entry.name]).sort()).toEqual([
      ['error', 'ItemSyncPending'], ['function', 'insidePolicies'], ['function', 'lifecycleCursor'],
    ]);
    for (const member of fresh.filter((entry) => entry.type === 'function')) expect(member.stateMutability).toBe('view');
    const policies = member(fresh, 'insidePolicies');
    expect(policies.outputs?.map(({ name, type }) => [name, type])).toEqual([['buyers', 'uint8'], ['sellers', 'uint8']]);
    expect(fresh.find((member) => member.name === 'lifecycleCursor')?.outputs?.map(({ type }) => type)).toEqual(['uint256']);
    expect(fresh.find((member) => member.name === 'ItemSyncPending')?.inputs?.map(({ name, type }) => [name, type]))
      .toEqual([['receiptCursor', 'uint256'], ['lifecycleCursor', 'uint256']]);
  });

  it('S2: funding output widths/order and indexed event fields', () => {
    const abi = artifact('IBoxReceiverV2.sol', 'IBoxReceiverItemsV2').abi;
    const record = member(abi, 'itemFunding');
    expect(record.outputs?.map(({ type, internalType }) => [type, internalType])).toEqual([['tuple', 'struct ItemFundingV2']]);
    expect(record.outputs?.[0].components?.map(({ name, type }) => [name, type])).toEqual(fundingFields);
    const event = member(abi, 'ItemFunded');
    expect(event.anonymous).toBe(false);
    expect(event.inputs?.map(({ name, type, indexed }) => [name, type, indexed])).toEqual([
      ['receiptId', 'uint256', true], ['batchId', 'uint256', true], ['side', 'uint8', false],
      ['source', 'uint8', false], ['choiceP', 'uint256', false], ['ledgerP', 'uint256', false],
    ]);
    expect(abi.find((member) => member.name === 'itemFundingCount')?.outputs?.map(({ type }) => type)).toEqual(['uint256']);
  });

  it('S3: lifecycle output widths/order, indexed event fields and batch error', () => {
    const abi = artifact('IBoxVaultV2.sol', 'IBoxVaultItemsV2').abi;
    const record = member(abi, 'itemLifecycle');
    expect(record.outputs?.map(({ type, internalType }) => [type, internalType])).toEqual([['tuple', 'struct ItemLifecycleV2']]);
    expect(record.outputs?.[0].components?.map(({ name, type }) => [name, type])).toEqual(lifecycleFields);
    expect(member(abi, 'ItemLifecycleRecorded').anonymous).toBe(false);
    expect(abi.find((member) => member.name === 'ItemLifecycleRecorded')?.inputs?.map(({ name, type, indexed }) => [name, type, indexed]))
      .toEqual([['sequence', 'uint256', true], ['ticketKey', 'bytes32', true], ['itemId', 'uint256', true],
        ['fundingCursor', 'uint256', false], ['at', 'uint64', false], ['kind', 'uint8', false]]);
    expect(abi.find((member) => member.name === 'ItemBatchTooLarge')?.inputs?.map(({ name, type }) => [name, type]))
      .toEqual([['count', 'uint256'], ['max', 'uint256']]);
    for (const name of ['itemLifecycleCount', 'ITEM_BATCH_MAX']) {
      expect(abi.find((member) => member.name === name)?.outputs?.map(({ type }) => type)).toEqual(['uint256']);
    }
  });

  it('S3/S5: adapter key and factory predicate return shapes', () => {
    const adapter = artifact('IBoxPeripheryV2.sol', 'IBoxTicketsItemsV2').abi;
    const factory = artifact('IBoxCoordinatorV2.sol', 'IBoxFactoryPileV2').abi;
    expect(adapter.find((member) => member.name === 'activeItemTicket')?.outputs?.map(({ name, type }) => [name, type]))
      .toEqual([['ticketKey', 'bytes32']]);
    expect(factory.find((member) => member.name === 'isPileVault')?.outputs?.map(({ type }) => type)).toEqual(['bool']);
  });
});
