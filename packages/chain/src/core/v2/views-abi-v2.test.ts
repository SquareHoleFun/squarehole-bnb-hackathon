/**
 * M1-52, added after the red tests: the rest of what the indexer reads is checked against the frozen Solidity text too.
 * - each view the v2 ABIs call (`listing`, `route`, `fixedRateRoute`, `recordOf`, `ledger`, `deadSince`, `chunkState`,
 *   `humbleCounter`, ...) is declared by its frozen interface with the same input and output types;
 * - each recipe params tuple the spec decoder reads is its RecipeTypes.sol struct's members, in order;
 * - the collection's events, read with v1's ABI (no v2 interface is frozen for it), are v1's `IBoxCollection`'s;
 * - each source's topic filter has one topic per event and nothing twice.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toEventSignature, type Abi, type AbiEvent, type AbiFunction, type AbiParameter } from 'viem';
import { describe, expect, it } from 'vitest';
import { coordinatorV2Abi, hookV2Abi, listingRegistryV2Abi, PARAMS_V2, receiverV2Abi, registryV2Abi } from './abi-v2';
import { CORE_TOPIC0_V2, EVENT_ABI_V2, V1_COPY_EVENTS_V2 } from './events-v2';
import { CONTRACTS_DIR, frozenV2Shapes, loadSolidityShapes } from './test-support/solidity-shapes';

const shapes = frozenV2Shapes();

function abiType(p: AbiParameter): string {
  const m = /^tuple((?:\[\d*\])*)$/.exec(p.type);
  if (!m) return p.type;
  return `(${('components' in p ? p.components : []).map(abiType).join(',')})${m[1] ?? ''}`;
}

/** `function name(inputs) … returns (outputs);` of one interface, canonical. */
function solidityFunctions(file: string, container: string): Map<string, { inputs: string; outputs: string }> {
  const code = readFileSync(join(CONTRACTS_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const start = code.search(new RegExp(`\\binterface ${container}\\b`));
  expect(start, container).toBeGreaterThanOrEqual(0);
  const body = code.slice(start, code.indexOf('\n}', start));
  const types = (list: string): string =>
    list
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => shapes.canonical(s.split(/\s+/).filter((w) => !['memory', 'calldata'].includes(w))[0] ?? ''))
      .join(',');
  const out = new Map<string, { inputs: string; outputs: string }>();
  for (const m of body.matchAll(/\bfunction\s+(\w+)\s*\(([^)]*)\)([^;]*);/g)) {
    const returns = /returns\s*\(([\s\S]*)\)\s*$/.exec(m[3] ?? '');
    out.set(m[1] ?? '', { inputs: types(m[2] ?? ''), outputs: types(returns?.[1] ?? '') });
  }
  return out;
}

describe('M1-52 v2 views, params and copied events against the frozen text', () => {
  it('M1-52 each view the v2 ABIs call is its frozen interface\'s, inputs and outputs', () => {
    const cases: [Abi, string, string][] = [
      [registryV2Abi as Abi, 'src/box-v2/interfaces/IBoxRegistryV2.sol', 'IBoxRegistryV2'],
      [listingRegistryV2Abi as Abi, 'src/box-v2/interfaces/IListingRegistry.sol', 'IListingRegistry'],
      [coordinatorV2Abi as Abi, 'src/box-v2/interfaces/IBoxCoordinatorV2.sol', 'IBoxCoordinatorV2'],
      [receiverV2Abi as Abi, 'src/box-v2/interfaces/IBoxReceiverV2.sol', 'IBoxReceiverV2'],
      [hookV2Abi as Abi, 'src/box-v2/interfaces/IBoxHookV2.sol', 'IBoxHookV2'],
    ];
    let checked = 0;
    for (const [abi, file, container] of cases) {
      const frozen = solidityFunctions(file, container);
      const inherited = container === 'IBoxCoordinatorV2'
        ? solidityFunctions('src/box/interfaces/IBoxCoordinator.sol', 'IBoxCoordinator')
        : container === 'IBoxHookV2'
          ? solidityFunctions('src/box-v2/interfaces/IBoxCoordinatorV2.sol', 'IBoxOpenGateV2')
          : new Map<string, { inputs: string; outputs: string }>();
      if (container === 'IBoxCoordinatorV2' || container === 'IBoxHookV2') {
        for (const [name, fn] of solidityFunctions('lib/v4-core/src/interfaces/callback/IUnlockCallback.sol', 'IUnlockCallback')) inherited.set(name, fn);
      }
      for (const [name, fn] of inherited) if (!frozen.has(name)) frozen.set(name, fn);
      for (const fn of abi.filter((x): x is AbiFunction => x.type === 'function' && (x.stateMutability === 'view' || x.stateMutability === 'pure'))) {
        const sol = frozen.get(fn.name);
        expect(sol, `${container}.${fn.name}`).toBeDefined();
        expect(fn.inputs.map(abiType).join(','), `${container}.${fn.name} inputs`).toBe(sol?.inputs);
        expect(fn.outputs.map(abiType).join(','), `${container}.${fn.name} outputs`).toBe(sol?.outputs);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it('M1-52 each recipe params tuple is its RecipeTypes.sol struct, member for member', () => {
    const cases: [keyof typeof PARAMS_V2, string][] = [
      ['holdersDest', 'HoldersDestParams'],
    ];
    for (const [key, struct] of cases) {
      const members = shapes.structs.get(struct);
      expect(members, struct).toBeDefined();
      expect(PARAMS_V2[key].map((p) => `${abiType(p)} ${p.name}`), struct).toEqual(members?.map((m) => `${shapes.canonical(m.type)} ${m.name}`));
    }
  });

  it("M1-52 the collection's events, read with v1's ABI, are v1's IBoxCollection's", () => {
    const v1 = loadSolidityShapes(['src/box/interfaces/BoxTypes.sol', 'src/box/interfaces/IBoxCollection.sol']);
    for (const { source, container, name } of V1_COPY_EVENTS_V2) {
      const event = (EVENT_ABI_V2[source] ?? []).find((x): x is AbiEvent => x.type === 'event' && x.name === name);
      expect(event && toEventSignature(event), `${container}.${name}`).toBe(v1.event(container, name)?.signature);
    }
  });

  it('M1-52 each source reads one topic per event, none twice', () => {
    for (const [source, topics] of Object.entries(CORE_TOPIC0_V2)) {
      expect(new Set(topics).size, source).toBe(topics?.length);
      expect(topics?.length, source).toBe(EVENT_ABI_V2[source as keyof typeof EVENT_ABI_V2]?.length);
    }
  });
});
