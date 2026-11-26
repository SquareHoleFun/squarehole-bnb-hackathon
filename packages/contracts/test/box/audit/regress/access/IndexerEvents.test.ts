import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE_EVENTS } from '../../../../../../chain/src/core/roles';
import * as chainAbi from '../../../../../../chain/src/abi/index';
import surface from './write-surface.json';
import eventBehavior from './event-behavior.json';

const inventory: Record<string, { id: string; test?: string; unreachable?: string }> = eventBehavior;

interface Field {
  name: string;
  type: string;
  indexed?: boolean;
  components?: Field[];
}
interface Entry {
  type: string;
  name?: string;
  anonymous?: boolean;
  stateMutability?: string;
  inputs?: Field[];
}

const contracts: Record<string, string> = {
  registry: 'BoxRegistry', poolManager: 'PoolManager', hook: 'BoxHook', launchRouter: 'BoxLaunchRouter',
  coordinator: 'BoxCoordinator', receiver: 'BoxReceiver', vault: 'BoxVault', collection: 'BoxCollection',
  tickets: 'BoxTickets', itemStream: 'BoxItemStream', executor: 'FitBuybackExecutor', randomness: 'DrandSource',
  royaltyRouter: 'BoxRoyaltyRouter', token: 'BoxToken', backedSource: 'BoxBackedSource',
};
const artifact = (name: string): Entry[] => (JSON.parse(readFileSync(new URL(`../../../../../out/${name}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Entry[] }).abi;
const typeOf = (f: Field): string => f.type.startsWith('tuple') ? `(${(f.components ?? []).map(typeOf).join(',')})${f.type.slice(5)}` : f.type;
const shape = (f: Field): object => ({ name: f.name, type: f.type, indexed: f.indexed ?? false, ...(f.components ? { components: f.components.map(shape) } : {}) });

// Review deliverables are part of this ticket: schema checks must never stand in for behavioral pins.
// Each entry identifies an executable test or the precise box0 guard that prevents emission.
describe('fix-round coverage obligations', () => {
  it('AR-21 maps every selected event to a behavioral test or a box0-unreachable guard', () => {
    const path = new URL('./event-behavior.json', import.meta.url);
    expect(existsSync(path), 'missing behavioral event inventory').toBe(true);
    const selected = Object.entries(CORE_EVENTS).flatMap(([role, names]) => names.map((name) => `${role}.${name}`));
    expect(Object.keys(inventory).sort()).toEqual(selected.sort());
    // E01-E77 retain the original review table's order; F143 appends E78-E80.
    expect(new Set(Object.values(inventory).map((pin) => pin.id)).size).toBe(80);
    expect(Object.values(inventory).filter((pin) => pin.test)).toHaveLength(76);
    for (const [event, pin] of Object.entries(inventory)) {
      expect(pin.id, event).toMatch(/^E[0-9]{2}$/);
      expect(Boolean(pin.test) !== Boolean(pin.unreachable), event).toBe(true);
      if (pin.test) {
        const [file, name] = pin.test.split(':');
        expect(name, event).toContain(`_${pin.id}_`);
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        expect(source, event).toContain(`function ${name}(`);
      } else {
        expect(pin.unreachable, event).toMatch(/\.sol:\d+.*\S/);
      }
    }
  });

  it('AR-22 documents the hook fee-note caller and its distinct Q-only pending ledger', () => {
    const report = readFileSync(new URL('../../../../../../../docs/reviews/BOX0-REVIEW-2026-10-09-access.md', import.meta.url), 'utf8');
    const row = report.split('\n').find((line) => line.startsWith('| Receiver `noteModuleFees`'));
    expect(row).toMatch(/hook/);
    expect(row).toMatch(/hookFeesPending/);
    expect(row).toMatch(/clips.*T/);
  });
});

describe('the compiled contracts supply every event selected by the core-v1 indexer', () => {
  for (const [role, names] of Object.entries(CORE_EVENTS)) {
    for (const name of names) {
      it(`AR-21 ${inventory[`${role}.${name}`]?.id ?? "UNMAPPED"} ${role}.${name}: exact fields, order, indexed bits and tuple layout`, () => {
        const contract = contracts[role];
        expect(contract).toBeDefined();
        const exportedName = role === 'backedSource' ? 'backedSourceAbi'
          : `${contract.charAt(0).toLowerCase()}${contract.slice(1)}Abi`;
        const exported = (chainAbi as unknown as Record<string, Entry[]>)[exportedName];
        expect(exported, exportedName).toBeDefined();
        const consumer = exported.filter((e) => e.type === 'event' && e.name === name);
        const producer = artifact(contract).filter((e) => e.type === 'event' && e.name === name);
        expect(consumer).toHaveLength(1);
        expect(producer).toHaveLength(1);
        // Sensitivity check: a renamed avatar commitment would silently change the reducer's object key.
        if (process.env.SH_EVENT_NEGATIVE_CONTROL === '1' && role === 'collection' && name === 'Revealed') {
          producer[0] = { ...producer[0], inputs: producer[0].inputs?.map((f) => f.name === 'avatarHash' ? { ...f, name: 'salt' } : f) };
        }
        expect(producer[0].inputs?.map(shape)).toEqual(consumer[0].inputs?.map(shape));
        expect(producer[0].anonymous).toBe(false);
        // Presence is a static pin only; runtime values are separately checked in the Solidity suites.
        const files = role === 'poolManager' ? ['../../../../../lib/v4-core/src/PoolManager.sol']
          : ['randomness', 'backedSource'].includes(role) ? [`../../../../../src/box/randomness/${contract}.sol`]
            : [`../../../../../src/box/${contract}.sol`, ...(role === 'hook' ? ['../../../../../src/box/BoxHookBase.sol', '../../../../../src/box/BoxHookExtension.sol'] : []), ...(role === 'receiver' ? ['../../../../../src/box/BoxReceiverExtension.sol'] : []), ...(role === 'tickets' ? ['../../../../../src/box/BoxPlaceholderToken.sol'] : [])];
        const source = files.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        expect(source).toMatch(new RegExp(`\\bemit\\s+(?:[A-Za-z0-9_]+\\.)?${name}\\s*\\(`));
      });
    }
  }
});

describe('every external write entry point is in the reviewed caller inventory', () => {
  for (const [contract, expected] of Object.entries(surface)) {
    it(`AR-22 ${contract}`, () => {
      const writes = artifact(contract).filter((e) => ['function', 'receive', 'fallback'].includes(e.type) && !['view', 'pure'].includes(e.stateMutability ?? ''));
      const actual = writes.map((e) => `${e.type === 'function' ? `${e.name}(${(e.inputs ?? []).map(typeOf).join(',')})` : e.type}:${e.stateMutability}`).sort();
      expect(actual).toEqual(expected);
    });
  }
});
