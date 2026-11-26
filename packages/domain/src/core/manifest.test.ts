/**
 * GOV-02 "Production gate": unresolved money-moving gates fail deployment validation, and mock intent cannot become
 * live. Also: live manifests need verified chain/address evidence.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { DataValidationError } from '../errors';
import { readCoreV2Json } from '../test-support/core-v2';
import {
  CODE_HASH,
  FIT_ADDRESS,
  GATE_IDS,
  MISFITS_ADDRESS,
  VAULT_ADDRESS,
  evidenceFor,
  hash32,
  liveProductionManifest,
  liveTestnetManifest,
  type Json,
} from '../test-support/core-fixtures';
import {
  CORE_GATES,
  CoreModelError,
  EMPTY_CODE_HASH,
  MISFITS_COUNT,
  RELEASE_EVIDENCE_ITEMS,
  V2_INTENT_MISFITS_COUNT,
  isLiveReady,
  mockAssetId,
  parseCoreManifest,
  parseLiveManifest,
  parseMockIntent,
  requireLiveReady,
  safeParseLiveManifest,
  safeParseMockIntent,
  type LiveDeploymentManifest,
  type LiveReadyManifest,
  type MockIntentManifest,
} from './index';

const mockIntent = (): Json => readCoreV2Json('examples/misfits-intent.mock.json') as Json;
const at = (root: Json, ...path: (string | number)[]): Json => path.reduce<Json>((node, key) => node[key] as Json, root);
const change = (base: () => Json, apply: (copy: Json) => void): Json => {
  const copy = base();
  apply(copy);
  return copy;
};
const messages = (input: unknown): string[] => {
  const result = safeParseLiveManifest(input);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
};

describe('mock intent (v2 schemas/intent.schema.json)', () => {
  it("parses v2's mock example as a non-live intent", () => {
    const intent = parseMockIntent(mockIntent());
    expect(intent.environment).toBe('mock');
    expect(intent.liveReady).toBe(false);
    expect(intent.q.assetId).toBe('mock:Q');
    expect(parseCoreManifest(mockIntent()).kind).toBe('mock');
  });

  it("keeps v2's example size while real records carry the edition (F35: 4,200)", () => {
    expect(V2_INTENT_MISFITS_COUNT).toBe(10_000);
    expect(parseMockIntent(mockIntent()).collection.count).toBe(V2_INTENT_MISFITS_COUNT);
    expect(MISFITS_COUNT).toBe(4_200);
    expect(parseLiveManifest(liveTestnetManifest()).collection.count).toBe(MISFITS_COUNT);
  });

  it.each([
    ['liveReady true', (m: Json) => (m.liveReady = true)],
    ['a production environment', (m: Json) => (m.environment = 'production')],
    ['a live chain', (m: Json) => (m.chainId = 1)],
    ['a real Q address', (m: Json) => (at(m, 'q').address = FIT_ADDRESS)],
    ['a mint after initialization', (m: Json) => (at(m, 'token').mintAfterInitialization = true)],
    ['a surplus sweep', (m: Json) => (at(m, 'vault').surplus = 'SWEEP_TO_TEAM')],
    ['rarity-weighted principal', (m: Json) => (at(m, 'collection').rarityAffectsPrincipal = true)],
    ['a float supply', (m: Json) => (at(m, 'token').initialSupplyRaw = 1e27)],
    ['no open gate', (m: Json) => (m.openGates = [])],
    ['an extra field', (m: Json) => (m.addresses = {})],
  ])('rejects %s', (_name, apply) => {
    expect(safeParseMockIntent(change(mockIntent, apply)).ok).toBe(false);
  });
});

describe('GOV-02: mock intent cannot become live', () => {
  it('a mock intent is never a live manifest, even with its flags flipped', () => {
    expect(() => parseLiveManifest(mockIntent())).toThrow(DataValidationError);
    const flipped = change(mockIntent, (m) => Object.assign(m, { environment: 'production', liveReady: true, chainId: 1 }));
    expect(safeParseMockIntent(flipped).ok).toBe(false);
    expect(safeParseLiveManifest(flipped).ok).toBe(false);
  });

  it("v2's deployment field list (NOT_A_DEPLOYMENT, addresses null) is rejected", () => {
    expect(safeParseLiveManifest(readCoreV2Json('examples/deployment.required-fields.json')).ok).toBe(false);
    expect(() => parseCoreManifest(readCoreV2Json('examples/deployment.required-fields.json'))).toThrow(DataValidationError);
  });

  it.each([
    ['a mock Q asset', (m: Json) => (at(m, 'assets', 'q').assetId = 'mock:Q'), 'mock'],
    ['a mock FIT asset', (m: Json) => (at(m, 'assets', 'fit').assetId = 'mock:FIT'), 'mock'],
    ['a mock value anywhere', (m: Json) => (at(m, 'release').externalRoutes = 'mock:route'), 'mock'],
    ['the demo chain', (m: Json) => (m.chainId = 31_337), 'chainId'],
    ['a mock environment', (m: Json) => (m.environment = 'mock'), 'environment'],
    ['a local environment', (m: Json) => (m.environment = 'local'), 'environment'],
    ['a null address', (m: Json) => (at(m, 'contracts').vault = null), 'contracts.vault'],
    ['the zero address', (m: Json) => (at(m, 'contracts').vault = '0x0000000000000000000000000000000000000000'), 'contracts.vault'],
    ['a NOT_A_DEPLOYMENT marker', (m: Json) => (m.NOT_A_DEPLOYMENT = true), ''],
    ['an openGates list from an intent', (m: Json) => (m.openGates = ['G01']), ''],
  ])('a live manifest with %s is rejected', (_name, apply, path) => {
    const problems = messages(change(liveTestnetManifest, apply));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => problem.startsWith(path) || problem.includes(path))).toBe(true);
  });

  it('keeps the two kinds apart in the type system', () => {
    expectTypeOf<MockIntentManifest['liveReady']>().toEqualTypeOf<false>();
    expectTypeOf<MockIntentManifest>().not.toExtend<LiveDeploymentManifest>();
    expectTypeOf<LiveDeploymentManifest>().not.toExtend<LiveReadyManifest>();
  });

  it('refuses a document that claims to be both or neither', () => {
    expect(() => parseCoreManifest({ ...mockIntent(), schema: 'squarehole.core-deployment/v2' })).toThrow(DataValidationError);
    expect(() => parseCoreManifest({})).toThrow(DataValidationError);
    expect(() => parseCoreManifest(null)).toThrow(DataValidationError);
  });
});

describe('live manifests need verified chain/address evidence', () => {
  it('accepts a complete testnet record with open gates, but it is not live-ready', () => {
    const manifest = parseLiveManifest(liveTestnetManifest());
    expect(manifest.environment).toBe('testnet');
    expect(parseCoreManifest(liveTestnetManifest()).kind).toBe('live');
    expect(isLiveReady(manifest)).toBe(false);
    expect(() => requireLiveReady(manifest)).toThrow(CoreModelError);
  });

  it.each([
    ['a contract without evidence', (m: Json) => (m.evidence = (m.evidence as Json[]).slice(1)), 'evidence'],
    ['evidence from another chain', (m: Json) => (at(m, 'evidence', 0).chainId = 1), 'evidence.0.chainId'],
    ['an address with no code', (m: Json) => (at(m, 'evidence', 0).codeHash = EMPTY_CODE_HASH), 'evidence.0.codeHash'],
    ['a zero code hash', (m: Json) => (at(m, 'evidence', 0).codeHash = hash32('00')), 'evidence.0.codeHash'],
    ['code that differs from the reviewed build', (m: Json) => (at(m, 'evidence', 0).expectedCodeHash = hash32('dd')), 'evidence.0.expectedCodeHash'],
    ['duplicate evidence', (m: Json) => (m.evidence = [...(m.evidence as Json[]), evidenceFor(11_155_111, FIT_ADDRESS, 'confirmed', false)]), 'evidence'],
    ['evidence for an unused address', (m: Json) => (m.evidence = [...(m.evidence as Json[]), evidenceFor(11_155_111, '0x00000000000000000000000000000000000000f9', 'confirmed', false)]), 'evidence'],
    ['pending evidence', (m: Json) => (at(m, 'evidence', 0).finality = 'pending'), 'evidence.0.finality'],
    ['a FIT asset at another address', (m: Json) => (at(m, 'contracts').fit = '0x00000000000000000000000000000000000000f9'), 'assets.fit'],
    ['a collection at another address', (m: Json) => (at(m, 'contracts').misfits = VAULT_ADDRESS), 'collection'],
    ['4,199 Misfits', (m: Json) => (at(m, 'collection').count = 4_199), 'collection.count'],
    ["v2's 10,000 Misfits (F35: 4,200)", (m: Json) => (at(m, 'collection').count = 10_000), 'collection.count'],
    ['another FIT supply', (m: Json) => (at(m, 'assets', 'fit').initialSupplyRaw = '999'), 'assets.fit.initialSupplyRaw'],
    ['a Q on another chain', (m: Json) => (at(m, 'assets', 'q').assetId = 'eip155:1/slip44:60'), 'assets.q'],
    ['native ETH with 6 decimals', (m: Json) => (at(m, 'assets', 'q').decimals = 6), 'assets.q.decimals'],
    ['an ERC-20 Q without evidence', (m: Json) => (at(m, 'assets', 'q').assetId = 'eip155:11155111/erc20:0x00000000000000000000000000000000000000f9'), 'evidence'],
    ['a missing gate', (m: Json) => (m.gates = (m.gates as Json[]).slice(1)), 'gates'],
    ['a duplicate gate', (m: Json) => (m.gates = [...(m.gates as Json[]), { id: 'G01', status: 'OPEN' }]), 'gates'],
    ['a closed gate with no ADR', (m: Json) => ((m.gates as Json[])[1] = { id: 'G02', status: 'CLOSED', evidence: ['x'] }), 'gates.1'],
    ['testnet on mainnet', (m: Json) => (m.chainId = 1), 'chainId'],
  ])('rejects %s', (_name, apply, path) => {
    const problems = messages(change(liveTestnetManifest, apply));
    expect(problems.some((problem) => problem.startsWith(path)), problems.join('\n')).toBe(true);
  });

  it('accepts an ERC-20 Q when its address has evidence', () => {
    const q = '0x00000000000000000000000000000000000000f9';
    const manifest = change(liveTestnetManifest, (m) => {
      at(m, 'assets', 'q').assetId = `eip155:11155111/erc20:${q}`;
      m.evidence = [...(m.evidence as Json[]), evidenceFor(11_155_111, q, 'confirmed', false)];
    });
    expect(messages(manifest)).toEqual([]);
  });
});

describe('GOV-02: unresolved money-moving gates fail deployment validation', () => {
  it('accepts a production record only when everything is closed, approved, evidenced and authorized', () => {
    const manifest = parseLiveManifest(liveProductionManifest());
    expect(isLiveReady(manifest)).toBe(true);
    const ready: LiveReadyManifest = requireLiveReady(manifest);
    expect(ready.chainId).toBe(1);
  });

  it.each([
    ['missing release evidence', (m: LiveDeploymentManifest): LiveDeploymentManifest => ({ ...m, release: { ...m.release, securityReview: null } })],
    ['unfinalized evidence', (m: LiveDeploymentManifest): LiveDeploymentManifest => ({ ...m, evidence: m.evidence.map((entry) => ({ ...entry, finality: 'confirmed' as const })) })],
    ['an unresolved fee order', (m: LiveDeploymentManifest): LiveDeploymentManifest => ({ ...m, policies: { ...m.policies, quote: { ...m.policies.quote, feeOrder: 'UNRESOLVED' } } })],
    ['a mock Q', (m: LiveDeploymentManifest): LiveDeploymentManifest => ({ ...m, assets: { ...m.assets, q: { ...m.assets.q, assetId: mockAssetId('Q') } } })],
  ])('never brands a record that skipped or left parsing as live-ready: %s', (_name, edit) => {
    const edited = edit(parseLiveManifest(liveProductionManifest()));
    expect(isLiveReady(edited)).toBe(false);
    expect(() => requireLiveReady(edited)).toThrow(/invalid live manifest/);
  });

  it.each(GATE_IDS)('an open %s fails production validation', (id) => {
    const open = change(liveProductionManifest, (m) => {
      m.gates = (m.gates as Json[]).map((gate) => (gate.id === id ? { id, status: 'OPEN' } : gate));
    });
    expect(messages(open).join('\n')).toContain(`${id} is OPEN`);
    const answered = change(liveProductionManifest, (m) => {
      m.gates = (m.gates as Json[]).map((gate) => (gate.id === id ? { id, status: 'ANSWERED', founderRows: ['F23'] } : gate));
    });
    expect(messages(answered).join('\n')).toContain(`${id} is ANSWERED`);
  });

  it.each([
    ['production without liveReady', (m: Json) => (m.liveReady = false), 'liveReady'],
    ['testnet claiming liveReady', (m: Json) => Object.assign(m, liveTestnetManifest(), { liveReady: true }), 'liveReady'],
    ['production off mainnet', (m: Json) => (m.chainId = 11_155_111), 'chainId'],
    ['the F23 fee policy (founder answered, not approved)', (m: Json) => (at(m, 'policies').fee = at(liveTestnetManifest(), 'policies').fee), 'policies.fee'],
    ['an unresolved selection rule', (m: Json) => (at(m, 'policies', 'vault', 'selection').mode = 'UNRESOLVED'), 'policies.vault'],
    ['an unresolved fee order', (m: Json) => (at(m, 'policies', 'quote').feeOrder = 'UNRESOLVED'), 'policies.quote'],
    ['missing release evidence', (m: Json) => (at(m, 'release').securityReview = null), 'release.securityReview'],
    ['no human authorization', (m: Json) => (m.authorization = null), 'authorization'],
    ['unfinalized evidence', (m: Json) => (at(m, 'evidence', 2).finality = 'confirmed'), 'evidence.2.finality'],
    ['no reviewed bytecode hash', (m: Json) => (at(m, 'evidence', 1).expectedCodeHash = null), 'evidence.1.expectedCodeHash'],
  ])('rejects %s', (_name, apply, path) => {
    const problems = messages(change(liveProductionManifest, apply));
    expect(problems.some((problem) => problem.startsWith(path)), problems.join('\n')).toBe(true);
  });

  it('marks the money-moving gates, and lists all 14 as in v2 decisions/gates.json', () => {
    const v2 = readCoreV2Json('decisions/gates.json') as { id: string; title: string }[];
    expect(CORE_GATES.map(({ id, title }) => ({ id, title }))).toEqual(v2.map(({ id, title }) => ({ id, title })));
    expect(CORE_GATES.filter((gate) => !gate.moneyMoving).map((gate) => gate.id)).toEqual(['G12', 'G13']);
  });

  it("covers each of v2's ten required release evidence items", () => {
    const v2 = readCoreV2Json('examples/deployment.required-fields.json') as { requiredEvidence: string[] };
    expect(RELEASE_EVIDENCE_ITEMS.map((item) => item.v2)).toEqual(v2.requiredEvidence);
  });

  it('uses the evidence code hash constant for keccak256 of empty code', () => {
    expect(EMPTY_CODE_HASH).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(CODE_HASH).not.toBe(EMPTY_CODE_HASH);
    expect([FIT_ADDRESS, MISFITS_ADDRESS, VAULT_ADDRESS]).toHaveLength(3);
  });
});
