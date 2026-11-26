/**
 * Differential test: v2's intent JSON Schema (square-hole-core-v2/schemas/intent.schema.json; ajv 8.20.0, draft
 * 2020-12) versus the runtime `parseMockIntent` on the same inputs. Every mutation is classified up front:
 *   both_reject  – the schema's own rules, which the runtime parser must also enforce;
 *   zod_stricter – rules the schema does not state; ajv accepts, zod rejects (reason documented);
 *   both_accept  – valid variants the runtime parser must not over-reject.
 */
import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { readCoreV2Json } from '../test-support/core-v2';
import { safeParseMockIntent } from './index';

// allowUnionTypes: the v2 schema types `q.productionCandidate` as ["string", "null"] (valid 2020-12).
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const ajvValidate = ajv.compile(readCoreV2Json('schemas/intent.schema.json') as object);

type Json = Record<string, unknown>;
type Expected = 'both_reject' | 'zod_stricter' | 'both_accept';
interface Mutation {
  readonly name: string;
  readonly expected: Expected;
  readonly apply: (intent: Json) => void;
  readonly reason?: string;
}

const at = (root: Json, ...path: string[]): Json => path.reduce<Json>((node, key) => node[key] as Json, root);
const set = (path: string[], value: unknown) => (intent: Json) => {
  const parent = at(intent, ...path.slice(0, -1));
  parent[path.at(-1) as string] = value;
};
const del = (path: string[]) => (intent: Json) => {
  Reflect.deleteProperty(at(intent, ...path.slice(0, -1)), path.at(-1) as string);
};
const reject = (name: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'both_reject', apply });
const accept = (name: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'both_accept', apply });
const stricter = (name: string, reason: string, apply: Mutation['apply']): Mutation => ({ name, expected: 'zod_stricter', reason, apply });

const MUTATIONS: readonly Mutation[] = [
  reject('schemaVersion 1.0', set(['schemaVersion'], '1.0')),
  reject('environment testnet', set(['environment'], 'testnet')),
  reject('environment production', set(['environment'], 'production')),
  reject('liveReady true', set(['liveReady'], true)),
  reject('chainId 1', set(['chainId'], 1)),
  reject('chainId as string', set(['chainId'], '31337')),
  reject('missing token', del(['token'])),
  reject('extra top-level field', set(['addresses'], null)),
  reject('token name ORCHARD', set(['token', 'name'], 'ORCHARD')),
  reject('initial supply as a number', set(['token', 'initialSupplyRaw'], 1e27)),
  reject('another initial supply', set(['token', 'initialSupplyRaw'], '1000000000')),
  reject('decimals 6', set(['token', 'decimals'], 6)),
  reject('mint after initialization', set(['token', 'mintAfterInitialization'], true)),
  reject('9,999 Misfits', set(['collection', 'count'], 9_999)),
  reject('rarity weight', set(['collection', 'financialWeight'], 'rarity')),
  reject('rarity affects principal', set(['collection', 'rarityAffectsPrincipal'], true)),
  reject('real Q asset id', set(['q', 'assetId'], 'eip155:1/slip44:60')),
  reject('Q address', set(['q', 'address'], '0x00000000000000000000000000000000000000f9')),
  reject('Q decimals 37', set(['q', 'decimals'], 37)),
  reject('Q decimals fractional', set(['q', 'decimals'], 1.5)),
  reject('ETH-only curve', set(['launch', 'marketFromStart'], 'FIT/ETH')),
  reject('target in Q set', set(['launch', 'targetQRaw'], '1')),
  reject('allocation approved', set(['launch', 'allocationStatus'], 'APPROVED')),
  reject('burn/mint mechanism', set(['vault', 'mechanism'], 'BURN_MINT')),
  reject('surplus sweep', set(['vault', 'surplus'], 'SWEEP_TO_TEAM')),
  reject('empty-vault policy chosen', set(['vault', 'emptyPolicy'], 'BLOCK_LAST_WITHDRAWAL')),
  reject('slot weights by rarity', set(['revenue', 'slotWeights'], 'rarity')),
  reject('rate approved', set(['revenue', 'rateStatus'], 'APPROVED')),
  reject('no open gates', set(['openGates'], [])),
  reject('duplicate gate', set(['openGates'], ['G01', 'G01'])),
  reject('gate G1', set(['openGates'], ['G1'])),
  stricter('unknown gate G15', 'v2 lists G01–G14 only (decisions/gates.json); the schema pattern allows G00–G99', set(['openGates'], ['G15'])),
  stricter('gate G00', 'no gate G00 exists; the schema pattern allows it', set(['openGates'], ['G00'])),
  accept('environment local', set(['environment'], 'local')),
  accept('no production candidate', set(['q', 'productionCandidate'], null)),
  accept('Q decimals 6', set(['q', 'decimals'], 6)),
  accept('one open gate', set(['openGates'], ['G08'])),
];

const base = (): Json => readCoreV2Json('examples/misfits-intent.mock.json') as Json;

describe('mock intent: v2 JSON Schema vs runtime parser', () => {
  it('both accept the unmodified v2 example', () => {
    expect(ajvValidate(base())).toBe(true);
    expect(safeParseMockIntent(base()).ok).toBe(true);
  });

  it.each(MUTATIONS.map((mutation) => [mutation.name, mutation] as const))('%s', (_name, mutation) => {
    const intent = base();
    mutation.apply(intent);
    const ajvOk = ajvValidate(intent);
    const zodOk = safeParseMockIntent(intent).ok;
    const expected: Record<Expected, [boolean, boolean]> = { both_reject: [false, false], zod_stricter: [true, false], both_accept: [true, true] };
    expect([ajvOk, zodOk]).toEqual(expected[mutation.expected]);
    if (mutation.expected === 'zod_stricter') expect(mutation.reason).toBeTruthy();
  });
});
