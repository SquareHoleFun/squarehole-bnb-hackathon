/**
 * The box 0 commitment: per id traitsPacked through the table, 32-byte CSPRNG salts, the six-word BoxCollection leaf,
 * the fixed-depth tree (depth 13 for 4,269) and every proof; the render records must belong to the frozen set's ids and
 * traits, and no placeholder, stand-in generator, test table or test root gets through.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { boxLeaf, verifyBoxProof } from '../box-commitment';
import type { Hex32 } from '../hash';
import { FIXTURE_GENERATOR_TREE, sha256Hex } from '../misfits-commitment';
import {
  TEST_GENERATOR_TREE,
  messageOf,
  randomTestSet,
  readR7,
  readR7Json,
  renderHeader,
  renderText,
  testRender,
  testSalt,
  testSet,
} from '../test-support/box0-export';
import { sealArchive } from './archive';
import { buildBox0Commitment, type Box0Input } from './commitment';
import { parseFrozenSet, parseTraitTable } from './inputs';
import { publicCommitment } from './outputs';
import { parseRenderHashes } from './renders';
import { packAttributes, traitIndex } from './traits';

const r7 = readR7();
const table = parseTraitTable(readR7Json());
const runtimeTree = randomBytes(20).toString('hex');
const ZERO: Hex32 = `0x${'0'.repeat(64)}`;
const sepoliaBox0 = JSON.parse(readFileSync(new URL('../../../contracts/test/vectors/box/sepolia-box0-test-set.json', import.meta.url), 'utf8')) as {
  metadataTable: string;
  traitTypes: { name: string; values: string[] }[];
  samples: { imageSha256: string }[];
};

function inputOf(n: number, edit?: (set: ReturnType<typeof testSet>) => { frozenSet?: unknown; renders?: string }): Box0Input {
  const set = randomTestSet(n, r7.types, n < 100 ? [3, 11] : [], runtimeTree);
  const changed = edit?.(set) ?? {};
  return {
    frozenSet: parseFrozenSet(changed.frozenSet ?? set.frozenSet, n),
    renders: parseRenderHashes(changed.renders ?? set.renders, n),
    table,
    generator: { tree: runtimeTree },
  };
}

const withRecord = (id: number, patch: (r: ReturnType<typeof testRender>) => object) => (set: ReturnType<typeof testSet>) => ({
  renders: renderText(renderHeader({ generatorTree: runtimeTree }), set.records.map((r) => (r.id === id ? patch(r) : r))),
});

describe('box 0 commitment: a small set', () => {
  const n = 13;
  const input = inputOf(n);
  const c = buildBox0Commitment(input, { n, testSalt });

  it('packs every id through the table and commits the six-word leaf at depth ⌈log₂ N⌉', () => {
    expect(c.n).toBe(13);
    expect(c.depth).toBe(4);
    expect(c.testSalts).toBe(true);
    expect(c.tableHash).toBe(table.hash);
    expect(c.generatorHash).toBe(`0x${runtimeTree}${'0'.repeat(24)}`);
    const index = traitIndex(table.table);
    c.records.forEach((r, i) => {
      expect(r.id).toBe(i + 1);
      expect(r.traitsPacked).toBe(packAttributes(input.frozenSet[i]?.attributes, index, `id ${r.id}`));
      expect(r.salt).toBe(testSalt(r.id));
      expect(r.leaf).toBe(boxLeaf(r, n));
      const proof = c.proof(r.id);
      expect(proof).toHaveLength(4);
      expect(verifyBoxProof(r.id, r.leaf, proof, c.root, n)).toBe(true);
    });
    // The one-of-ones carry only Character, Role and Environment.
    expect(c.records[2]?.attributes.map((a) => a.trait_type)).toEqual(['Character', 'Role', 'Environment']);
  });

  it('draws real salts with node:crypto by default: 32 bytes each, all different, a new root every run', () => {
    const a = buildBox0Commitment(input, { n });
    const b = buildBox0Commitment(input, { n });
    expect(a.testSalts).toBe(false);
    expect(a.root).not.toBe(b.root);
    expect(a.root).not.toBe(c.root);
    const salts = new Set(a.records.map((r) => r.salt));
    expect(salts.size).toBe(n);
    for (const s of salts) expect(s).toMatch(/^0x[0-9a-f]{64}$/);
    for (const r of a.records) expect(verifyBoxProof(r.id, r.leaf, a.proof(r.id), a.root, n)).toBe(true);
  });

  it('puts a zero avatar in every leaf when the encoding has none (MF-10 answered no)', () => {
    const set = randomTestSet(n, r7.types, [3, 11], runtimeTree);
    const header = renderHeader({ generatorTree: runtimeTree, encoding: { image: { format: 'webp', size: 512, quality: 90 }, avatar: null, model: { format: 'glb' } } });
    const expected = { image: { format: 'webp', size: 512, quality: 90 }, avatar: null, model: { format: 'glb' } } as const;
    const renders = parseRenderHashes(renderText(header, set.records.map((r) => ({ ...r, avatar: null }))), n, expected);
    const noAvatar = buildBox0Commitment({ ...input, renders }, { n, testSalt });
    expect(noAvatar.records.every((r) => r.avatarSha256 === ZERO)).toBe(true);
    expect(noAvatar.root).not.toBe(c.root);
  });

  it('takes generatorHash = 0 only when asked (MF-17 answered zero)', () => {
    const zero = buildBox0Commitment({ ...input, generator: { zero: true } }, { n, testSalt });
    expect(zero.generatorHash).toBe(ZERO);
    expect(zero.generatorTree).toBeNull();
    expect(zero.root).toBe(c.root);
  });
});

describe('box 0 commitment: the 4,269-leaf shape (fixed test salts)', () => {
  const n = 4_269;
  const input = inputOf(n);
  const c = buildBox0Commitment(input, { n, testSalt });

  it('is depth 13, the same root on every build, and every one of the 4,269 proofs checks', () => {
    expect(c.depth).toBe(13);
    expect(buildBox0Commitment(input, { n, testSalt }).root).toBe(c.root);
    for (const r of c.records) {
      const proof = c.proof(r.id);
      expect(proof.length).toBe(13);
      if (!verifyBoxProof(r.id, r.leaf, proof, c.root, n)) throw new Error(`proof of id ${r.id} fails`);
    }
    expect(verifyBoxProof(2, c.records[0]?.leaf as Hex32, c.proof(1), c.root, n)).toBe(false);
  });

  it('defaults N to 4,269 and refuses a set of another size', () => {
    expect(buildBox0Commitment(input, { testSalt }).root).toBe(c.root);
    expect(messageOf(() => buildBox0Commitment(inputOf(13), { testSalt }))).toMatch(/the frozen set has 13 ids; N is 4269/);
  });
});

describe('box 0 commitment: refusals', () => {
  const n = 13;

  it('refuses render records whose attributes are not the frozen set`s for that id (naming the id only)', () => {
    const swap = (set: ReturnType<typeof testSet>) => ({
      renders: renderText(renderHeader({ generatorTree: runtimeTree }), set.records.map((r) => (r.id === 4 ? { ...r, attributes: set.records[4]?.attributes } : r))),
    });
    expect(messageOf(() => buildBox0Commitment(inputOf(n, swap), { n, testSalt }))).toMatch(/id 4: the render record's attributes differ from the frozen set's/);
  });

  it('refuses placeholder file hashes: zero, the empty file, a test set`s, a fixture`s', () => {
    const cases: [string, (r: ReturnType<typeof testRender>) => object, RegExp][] = [
      ['image', (r) => ({ ...r, image: { ...r.image, sha256: ZERO } }), /id 2: the image sha256 is a placeholder \(zero\)/],
      ['avatar', (r) => ({ ...r, avatar: { sha256: sha256Hex(new Uint8Array()), bytes: 1 } }), /id 2: the avatar sha256 is a placeholder \(the empty file\)/],
      ['model', (r) => ({ ...r, model: { ...r.model, sha256: sha256Hex(new TextEncoder().encode('misfit-image-1')) } }), /id 2: the model sha256 is a placeholder \(a test set or fixture hash\)/],
    ];
    for (const [, patch, message] of cases) {
      expect(messageOf(() => buildBox0Commitment(inputOf(n, withRecord(2, patch)), { n, testSalt }))).toMatch(message);
    }
  });

  it('refuses two ids with the same traits or the same picture unless allowed; never two equal salts', () => {
    const sameTraits = (set: ReturnType<typeof testSet>) => {
      const entries = set.frozenSet.entries.map((e) => (e.id === 9 ? { ...e, attributes: set.frozenSet.entries[2]?.attributes ?? [] } : e));
      const records = set.records.map((r) => (r.id === 9 ? { ...r, attributes: entries[8]?.attributes ?? [] } : r));
      return { frozenSet: { ...set.frozenSet, entries }, renders: renderText(renderHeader({ generatorTree: runtimeTree }), records) };
    };
    expect(messageOf(() => buildBox0Commitment(inputOf(n, sameTraits), { n, testSalt }))).toMatch(/ids 3 and 9 have the same traits/);
    expect(() => buildBox0Commitment(inputOf(n, sameTraits), { n, testSalt, allowDuplicateTraits: true })).not.toThrow();
    const samePicture = (set: ReturnType<typeof testSet>) => ({
      renders: renderText(renderHeader({ generatorTree: runtimeTree }), set.records.map((r) => (r.id === 9 ? { ...r, image: set.records[2]?.image } : r))),
    });
    expect(messageOf(() => buildBox0Commitment(inputOf(n, samePicture), { n, testSalt }))).toMatch(/ids 3 and 9 have the same image/);
    expect(() => buildBox0Commitment(inputOf(n, samePicture), { n, testSalt, allowDuplicateImages: true })).not.toThrow();
    expect(messageOf(() => buildBox0Commitment(inputOf(n), { n, testSalt: (id) => testSalt(id === 2 ? 1 : id) }))).toMatch(/ids 1 and 2 have the same salt/);
    expect(messageOf(() => buildBox0Commitment(inputOf(n), { n, testSalt: () => ZERO }))).toMatch(/id 1: the salt is a placeholder/);
  });

  it('refuses the stand-in generator, a render made by another generator and a test table', () => {
    const fixture = { ...inputOf(n), generator: { tree: FIXTURE_GENERATOR_TREE } };
    expect(messageOf(() => buildBox0Commitment(fixture, { n, testSalt }))).toMatch(/is a stand-in generator hash/);
    const other = { ...inputOf(n), generator: { tree: 'c'.repeat(40) } };
    expect(messageOf(() => buildBox0Commitment(other, { n, testSalt }))).toMatch(/the renders name generator tree [0-9a-f]{40}; the commitment names c{40}/);
    const twin = parseTraitTable({
      format: 'squarehole.box-trait-table/1',
      types: sepoliaBox0.traitTypes.map((t) => ({ name: t.name, list: t.values })),
      table: sepoliaBox0.metadataTable,
    });
    expect(messageOf(() => buildBox0Commitment({ ...inputOf(n), table: twin }, { n, testSalt }))).toMatch(/is a test or fixture table/);
  });

  it('checks the render file`s generator tree whichever MF-17 answer is chosen (generatorHash = 0 too)', () => {
    const fixtureRenders = (set: ReturnType<typeof testSet>) => ({ renders: renderText(renderHeader({ generatorTree: FIXTURE_GENERATOR_TREE }), set.records) });
    const zero = { ...inputOf(n, fixtureRenders), generator: { zero: true } as const };
    expect(messageOf(() => buildBox0Commitment(zero, { n, testSalt }))).toMatch(
      new RegExp(`the render file's generator tree ${FIXTURE_GENERATOR_TREE} is a stand-in generator hash \\(fixtureTree\\)`),
    );
    const tree = { ...inputOf(n, fixtureRenders), generator: { tree: FIXTURE_GENERATOR_TREE } };
    expect(messageOf(() => buildBox0Commitment(tree, { n, testSalt }))).toMatch(/the render file's generator tree [0-9a-f]{40} is a stand-in generator hash/);
    const ok = buildBox0Commitment({ ...inputOf(n), generator: { zero: true } }, { n, testSalt });
    expect(ok.generatorHash).toBe(ZERO);
    expect(ok.render.generatorTree).toBe(runtimeTree);
  });

  it('refuses the Sepolia box 0 test set`s hashes fed back in', () => {
    const image = { sha256: sepoliaBox0.samples[0]?.imageSha256 as string, bytes: 100 };
    expect(messageOf(() => buildBox0Commitment(inputOf(n, withRecord(1, (r) => ({ ...r, image }))), { n, testSalt }))).toMatch(
      /id 1: the image sha256 is a placeholder \(a test set or fixture hash\)/,
    );
  });
});

describe('exporter fixtures fed back through production validation', () => {
  const n = 4_269;
  const fixture = testSet(n, r7.types);
  const input: Box0Input = {
    frozenSet: parseFrozenSet(fixture.frozenSet, n),
    renders: parseRenderHashes(fixture.renders, n),
    table,
    generator: { tree: TEST_GENERATOR_TREE },
  };

  it('refuses all 4,269 fixtures with fresh CSPRNG salts in either generator mode', () => {
    expect(() => buildBox0Commitment(input)).toThrow(/stand-in generator/);
    expect(() => buildBox0Commitment({ ...input, generator: { zero: true } })).toThrow(/stand-in generator/);
  });

  it.each(['image', 'avatar', 'model'] as const)('refuses a fixture %s even with an unknown generator and fresh salts', (field) => {
    const tree = randomBytes(20).toString('hex');
    const renders = {
      ...input.renders,
      header: { ...input.renders.header, generatorTree: tree },
      records: input.renders.records.map((r, i) => ({
        ...r,
        ...Object.fromEntries(
          (['image', 'avatar', 'model'] as const).map((kind) => [
            kind,
            i === 4_268 && kind === field ? r[kind] : { bytes: 128, sha256: `0x${randomBytes(32).toString('hex')}` },
          ]),
        ),
      })),
    };
    expect(() => buildBox0Commitment({ ...input, renders, generator: { tree } })).toThrow(
      new RegExp(`id 4269: the ${field} sha256 is a placeholder`),
    );
  });

  it('requires fixed test salts for an explicit fixture bypass, and output writers refuse its result', () => {
    const bypass = { testOnlyAllowExporterFixtures: true };
    expect(() => buildBox0Commitment(input, bypass)).toThrow(/fixture bypass requires test salts/);
    const c = buildBox0Commitment(input, { ...bypass, testSalt });
    expect(c.testSalts).toBe(true);
    const key = new Uint8Array(randomBytes(32));
    expect(() => sealArchive(c, key, { escrowIntent: 'floor-only' })).toThrow(/test salts/);
    expect(() => publicCommitment(c, {
      file: 'test.enc.json',
      sha256: c.root,
      keyId: c.root,
      escrowIntent: 'floor-only',
      keySplit: 'none',
    })).toThrow(/test salts/);
  });
});
