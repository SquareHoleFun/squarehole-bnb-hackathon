/**
 * M1-52 red tests (core-v2-m1-tickets.md § 2, M1-52 "Red first": "each frozen event decoded from M1-00's pinned topics
 * and data"). The indexer reads only what M1-00 froze (ADR-0017 § 12), so its ABIs are checked against the frozen
 * Solidity text, never against a build of contracts that wave 1 is still writing:
 * - every v2 event the indexer reads has the frozen interface's canonical signature and indexed arguments;
 * - every event signature M1-00's shape tests pin, for an event the indexer reads, is in its ABI;
 * - an event inherited from v1 is v1's interface's (the copies keep v1's interfaces whole, ADR-0017 § 10);
 * - each struct the indexer decodes (the record, the spec, a listing, a hop, a ledger) is the frozen struct's tuple;
 * - the enum names the indexer prints follow the frozen members, in order;
 * - each read event decodes from topics and data built from the Solidity text alone;
 * - every frozen v2 event is either read or listed as not read in M1/M2, with its reason (review round 1).
 */
import { decodeEventLog, encodeAbiParameters, keccak256, parseAbiParameter, toBytes, toEventSignature, type Abi, type AbiEvent, type AbiParameter, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { hookV2Abi, boxSpecV2Parameter, listingRecordV2Parameter, boxRecordV2Parameter } from './abi-v2';
import { CORE_EVENTS_V2, EVENT_ABI_V2, FROZEN_EVENTS_V2, INHERITED_EVENTS_V2, NOT_READ_V2 } from './events-v2';
import { ENUM_NAMES_V2 } from './spec-v2';
import { frozenV2Shapes, loadSolidityShapes, type SolShapes } from './test-support/solidity-shapes';

const shapes = frozenV2Shapes();

function fragment(source: keyof typeof EVENT_ABI_V2, name: string): AbiEvent {
  const abi = EVENT_ABI_V2[source] as Abi | undefined;
  const entry = FROZEN_EVENTS_V2.find(e => e.source === source && e.name === name);
  const signature = entry && shapes.event(entry.container, name)?.signature;
  // Shop role 3 adds different GateOpened/FailureEntered signatures; retain the frozen vault pins.
  const found = abi?.filter((item): item is AbiEvent => item.type === 'event' && item.name === name && (!signature || toEventSignature(item) === signature)) ?? [];
  expect(found, `${source}.${name} in the v2 ABI`).toHaveLength(1);
  return found[0] as AbiEvent;
}

/** The canonical ABI type of a viem parameter (tuples spelled out). */
function abiType(p: AbiParameter): string {
  const m = /^tuple((?:\[\d*\])*)$/.exec(p.type);
  if (!m) return p.type;
  return `(${('components' in p ? p.components : []).map(abiType).join(',')})${m[1] ?? ''}`;
}

/** A sample value for a canonical type (deterministic, in range for every enum). */
function sample(type: string, seed: number): unknown {
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array) {
    const n = array[2] === '' ? 2 : Number(array[2]);
    return Array.from({ length: n }, (_, i) => sample(array[1] ?? '', seed + i + 1));
  }
  if (type.startsWith('(')) return inner(type).map((t, i) => sample(t, seed * 7 + i + 1));
  if (type === 'address') return `0x${(seed + 0x1000).toString(16).padStart(40, '0')}`;
  if (type === 'bool') return seed % 2 === 1;
  if (type === 'string') return `s${seed}`;
  if (type === 'bytes') return `0x${(seed % 256).toString(16).padStart(2, '0')}beef`;
  if (/^bytes\d+$/.test(type)) return `0x${(seed % 256).toString(16).padStart(2, '0').repeat(Number(type.slice(5)))}`;
  // viem reads integers of up to 48 bits as numbers, wider ones as bigints.
  const int = /^(u?)int(\d+)$/.exec(type);
  if (int) {
    const value = int[1] === 'u' ? (seed % 3) + 1 : -(seed % 100);
    return Number(int[2]) <= 48 ? value : BigInt(value);
  }
  throw new Error(`no sample for ${type}`);
}

/** The member types of a canonical tuple type "(a,b,(c,d))". */
function inner(tuple: string): string[] {
  const body = tuple.slice(1, tuple.lastIndexOf(')'));
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

function structType(s: SolShapes, name: string): string {
  return s.canonical(name);
}

describe('M1-52 v2 events against the frozen Solidity text', () => {
  it('M1-52 every v2 event the indexer reads has its frozen signature and indexed arguments', () => {
    expect(FROZEN_EVENTS_V2.length).toBeGreaterThan(30);
    for (const { source, container, name } of FROZEN_EVENTS_V2) {
      const sol = shapes.event(container, name);
      expect(sol, `${container}.${name} is declared`).toBeDefined();
      const abi = fragment(source, name);
      expect(toEventSignature(abi), `${source}.${name}`).toBe(sol?.signature);
      expect(abi.inputs.map((i) => i.indexed === true), `${source}.${name} indexed`).toEqual(sol?.params.map((p) => p.indexed));
      expect(CORE_EVENTS_V2[source], `${source} reads ${name}`).toContain(name);
    }
  });

  it('RC6-af1 exposes the deferred seller journal as uint256 views', () => {
    for (const name of ['tradeBatchPendingT', 'tradeBatchTotalP']) {
      const entry = (hookV2Abi as Abi).find(item => item.type === 'function' && item.name === name);
      expect(entry).toMatchObject({
        type: 'function', name, stateMutability: 'view',
        inputs: name === 'tradeBatchPendingT' ? [{ name: 'batchId', type: 'uint256' }] : [],
        outputs: [{ name: '', type: 'uint256' }],
      });
    }
  });

  it('CQ11-0 every pinned surviving event has its ABI signature', () => {
    const pinned = [
      'HarvestedV2(bytes32,uint256,uint256,uint256)',
      'MigratedV2(bytes32,uint128,uint256,uint256)',
      'Closed(bytes32,uint256,uint256)',
      'SaleFee(bytes32,address,uint256)', // historical releases
      'FeesSold(bytes32,address,uint256,uint256,uint256)',
      'PotFixed(uint256,uint256,uint256,address)',
      'ListingAdded(uint32,address,uint8,uint8,uint256)',
      'RaiseUpdated(uint32,uint256,uint256)',
    ];
    for (const signature of pinned) {
      const name = signature.slice(0, signature.indexOf('('));
      const entries = FROZEN_EVENTS_V2.filter((e) => e.name === name);
      expect(entries.map((e) => toEventSignature(fragment(e.source, name))), signature).toContain(signature);
    }
  });

  it("M1-52 an event inherited from v1 is v1's interface's", () => {
    const v1 = loadSolidityShapes([
      'src/box/interfaces/BoxTypes.sol',
      'src/box/interfaces/IBoxCoordinator.sol',
      'src/box/interfaces/IBoxHook.sol',
      'src/box/interfaces/IBoxLaunchRouter.sol',
      'src/box/interfaces/IBoxTickets.sol',
      'src/box/interfaces/IBoxRoyaltyRouter.sol',
      'src/box/interfaces/IBoxToken.sol',
      'lib/v4-core/src/types/PoolId.sol',
    ]);
    expect(INHERITED_EVENTS_V2.length).toBeGreaterThan(10);
    for (const { source, container, name } of INHERITED_EVENTS_V2) {
      const sol = v1.event(container, name);
      expect(sol, `${container}.${name}`).toBeDefined();
      expect(toEventSignature(fragment(source, name)), `${source}.${name}`).toBe(sol?.signature);
    }
  });

  it('M1-52 each struct the indexer decodes is the frozen tuple', () => {
    const cases: [AbiParameter, string][] = [
      [boxRecordV2Parameter, 'BoxRecordV2'],
      [boxSpecV2Parameter, 'BoxSpec'],
      [listingRecordV2Parameter, 'ListingRecord'],
    ];
    for (const [parameter, name] of cases) expect(abiType(parameter), name).toBe(structType(shapes, name));
  });

  it('M1-52 the enum names the indexer prints are the frozen members in order', () => {
    // TODO(CQ11-E): remove the remaining legacy converter/cap view models and their enum labels.
    const current = ['Leg', 'Dest', 'Split', 'BoxType', 'ListingClass', 'ListingKind', 'ChunkPart', 'FailCause', 'HeldKind', 'FailRoute'] as const;
    for (const name of current) {
      const members = ENUM_NAMES_V2[name];
      const frozen = shapes.enums.get(name);
      expect(frozen, name).toBeDefined();
      expect(members, name).toEqual(frozen);
    }

  });

  it('M1-52 each read v2 event decodes from topics and data built from the Solidity text alone', () => {
    let decoded = 0;
    for (const { source, container, name } of FROZEN_EVENTS_V2) {
      const sol = shapes.event(container, name);
      if (!sol) throw new Error(`${container}.${name}`);
      const values = sol.params.map((p, i) => sample(p.type, i + 3));
      const topics: Hex[] = [keccak256(toBytes(sol.signature))];
      sol.params.forEach((p, i) => {
        if (p.indexed) topics.push(encodeAbiParameters([parseAbiParameter(`${p.type} x`)], [values[i]]));
      });
      const data = encodeAbiParameters(
        sol.params.filter((p) => !p.indexed).map((p) => parseAbiParameter(`${p.type} x`)),
        sol.params.map((p, i) => [p, values[i]] as const).filter(([p]) => !p.indexed).map(([, v]) => v),
      );
      const out = decodeEventLog({ abi: EVENT_ABI_V2[source] as Abi, topics: topics as [Hex, ...Hex[]], data, strict: true });
      expect(out.eventName, `${source}.${name}`).toBe(name);
      const args = out.args as unknown as Record<string, unknown>;
      sol.params.forEach((p, i) => {
        if (p.type.startsWith('(')) return;
        const got = args[p.name];
        const want = values[i];
        expect(typeof got === 'string' ? got.toLowerCase() : got, `${source}.${name}.${p.name}`).toEqual(typeof want === 'string' ? want.toLowerCase() : want);
      });
      decoded += 1;
    }
    expect(decoded).toBe(FROZEN_EVENTS_V2.length);
  });

  it('M1-52 every frozen v2 event is read, or listed as not read in M1/M2 with its reason', () => {
    const outside = new Set(loadSolidityShapes(['src/box/interfaces/BoxTypes.sol', 'lib/v4-core/src/types/PoolId.sol']).events.map((e) => `${e.container}.${e.name}`));
    const frozen = new Set(shapes.events.map((e) => `${e.container}.${e.name}`).filter((k) => !outside.has(k)));
    const read = new Set(FROZEN_EVENTS_V2.map((e) => `${e.container}.${e.name}`));
    const notRead = new Map(NOT_READ_V2.map((e) => [`${e.container}.${e.name}`, e.reason]));
    expect(notRead.size, 'each not-read event once').toBe(NOT_READ_V2.length);
    for (const key of notRead.keys()) {
      expect(frozen.has(key), `${key} is frozen`).toBe(true);
      expect(read.has(key), `${key} is not also read`).toBe(false);
      expect((notRead.get(key) ?? '').length, `${key}'s reason`).toBeGreaterThanOrEqual(12);
    }
    for (const container of ['IHolderLedgerV2', 'IShopVaultV2']) {
      expect(NOT_READ_V2.filter(e => e.container === container).every(e => /M2/.test(e.reason))).toBe(true);
    }
    expect([...frozen].filter((k) => !read.has(k) && !notRead.has(k)), 'frozen events neither read nor listed').toEqual([]);
    // The M1 events wave 2's block loop needs (BC-078's vault activity, the module's money steps, the payee) are read.
    for (const key of ['IBoxVaultV2.Withdrawn', 'IBoxVaultV2.TicketDelivered', 'IBoxReceiverV2.CreatorPayeeChanged', 'IBoxCoordinatorV2.Claimed', 'IListingRegistry.RaiseUpdated']) expect(read.has(key), key).toBe(true);
  });
});
