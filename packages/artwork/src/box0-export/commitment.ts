/**
 * Box 0's commitment (readiness plan step 6) on main's library (box-commitment.ts): per id, traitsPacked through the
 * trait table, the image, avatar and model sha256 from the render-hash file, and a fresh 32-byte salt from node:crypto
 * randomBytes; leaf = keccak256(abi.encode(id, traitsPacked, imageSha256, avatarSha256, modelSha256, salt)) exactly as
 * BoxCollection.leafOf; the fixed-depth tree over positions id − 1 (depth 13 for 4,269) and every proof, each checked
 * before the result is returned.
 *
 * Refused: a frozen set and render file of other sizes or ids; a render record whose attributes are not the frozen
 * set's for that id; a placeholder file hash (placeholders.ts); two ids with the same traits or the same picture
 * (unless allowed); two equal salts; a stand-in generator; a test table; a test root. Salts are never printed and no
 * error carries a hash or a trait value. `testSalt` is for tests only: the archive and the public file refuse its
 * result.
 */
import { randomBytes } from 'node:crypto';
import { boxLeaf, boxTreeDepth, buildBoxTree, verifyBoxProof, type BoxLeafEntry } from '../box-commitment';
import type { Hex32 } from '../hash';
import { generatorHashFromGitTree } from '../misfits-commitment';
import { BOX0_N, type FrozenEntry, type TraitTable } from './inputs';
import { KNOWN_TEST_GENERATOR_HASHES, KNOWN_TEST_ROOTS, assertNotTestGenerator, assertNotTestRoot, assertNotTestTable, isExporterFixtureDigest, placeholderReason } from './placeholders';
import type { RenderHashes, RenderHeader, RenderRecord } from './renders';
import { attributesOf, packAttributes, traitIndex, type Attribute, type TraitIndex } from './traits';

/** MF-17: the sealed release tree id (default) or an explicit zero. */
export type GeneratorChoice = { readonly tree: string } | { readonly zero: true };

export interface Box0Input {
  readonly frozenSet: readonly FrozenEntry[];
  readonly renders: RenderHashes;
  readonly table: TraitTable;
  readonly generator: GeneratorChoice;
}

export interface Box0Options {
  /** N (default 4,269, F49 E8). */
  readonly n?: number;
  readonly allowDuplicateTraits?: boolean;
  readonly allowDuplicateImages?: boolean;
  /** TESTS ONLY: fixed salts. The archive and the public file refuse a commitment built with them. */
  readonly testSalt?: (id: number) => Hex32;
  /** TESTS ONLY: allow this exporter's fixtures to rebuild contract vectors. Requires testSalt; outputs refuse them. */
  readonly testOnlyAllowExporterFixtures?: boolean;
}

export interface Box0Record extends BoxLeafEntry {
  /** The id's attributes in table order (as tokenJSON lists them). */
  readonly attributes: readonly Attribute[];
  readonly leaf: Hex32;
  readonly bytes: { readonly image: number; readonly avatar: number | null; readonly model: number };
}

export interface Box0Commitment {
  readonly n: number;
  readonly depth: number;
  readonly root: Hex32;
  readonly table: TraitTable;
  readonly tableHash: Hex32;
  readonly valueOrderHash: Hex32;
  readonly generatorHash: Hex32;
  /** The committed tree; null when MF-17 chose generatorHash = 0. */
  readonly generatorTree: string | null;
  /** The render file's header; its generatorTree is the tree that made the committed files, in either MF-17 mode. */
  readonly render: RenderHeader;
  readonly testSalts: boolean;
  /** Index id − 1. */
  readonly records: readonly Box0Record[];
  proof(id: number): Hex32[];
}

const ZERO: Hex32 = `0x${'0'.repeat(64)}`;
const csprngSalt = (): Hex32 => `0x${randomBytes(32).toString('hex')}`;

/**
 * The committed generator (MF-17) after checking the tree that rendered the files: whichever answer is chosen, the
 * render header must not name a stand-in generator. Its tree stays in `render.generatorTree`, which the archive and the
 * public file record as renderGeneratorTree (the archive is the source of truth for re-rendering).
 */
function generatorOf(choice: GeneratorChoice, header: RenderHeader, testFixtures: boolean): { generatorHash: Hex32; generatorTree: string | null } {
  const renderTree = header.generatorTree.toLowerCase();
  const renderHash = generatorHashFromGitTree(renderTree);
  if (!testFixtures || renderHash !== KNOWN_TEST_GENERATOR_HASHES.box0Exporter) {
    assertNotTestGenerator(renderHash, `the render file's generator tree ${renderTree}`);
  }
  if ('zero' in choice) return { generatorHash: ZERO, generatorTree: null };
  const tree = choice.tree.toLowerCase();
  const generatorHash = generatorHashFromGitTree(tree);
  if (!testFixtures || generatorHash !== KNOWN_TEST_GENERATOR_HASHES.box0Exporter) assertNotTestGenerator(generatorHash);
  if (tree !== header.generatorTree) throw new Error(`the renders name generator tree ${header.generatorTree}; the commitment names ${tree}`);
  return { generatorHash, generatorTree: tree };
}

function fileDigest(hash: Hex32, what: string, field: string, testFixtures: boolean): Hex32 {
  const reason = placeholderReason(hash);
  if (reason && !(testFixtures && isExporterFixtureDigest(hash))) throw new Error(`${what}: the ${field} sha256 is a placeholder (${reason})`);
  return hash;
}

function saltOf(id: number, source: (id: number) => Hex32): Hex32 {
  const salt = source(id).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(salt)) throw new Error(`id ${id}: the salt must be 32 bytes`);
  if (/^0x([0-9a-f]{2})\1{31}$/.test(salt)) throw new Error(`id ${id}: the salt is a placeholder (one repeated byte)`);
  return salt as Hex32;
}

interface Context {
  readonly n: number;
  readonly index: TraitIndex;
  readonly table: TraitTable;
  readonly salt: (id: number) => Hex32;
  readonly testFixtures: boolean;
}

function recordOf(entry: FrozenEntry | undefined, render: RenderRecord | undefined, id: number, ctx: Context): Box0Record {
  if (!entry || entry.id !== id) throw new Error(`the frozen set has no entry for id ${id}`);
  if (!render || render.id !== id) throw new Error(`the render file has no record for id ${id}`);
  const what = `id ${id}`;
  const traitsPacked = packAttributes(entry.attributes, ctx.index, what);
  if (packAttributes(render.attributes, ctx.index, `${what} (render record)`) !== traitsPacked) {
    throw new Error(`${what}: the render record's attributes differ from the frozen set's`);
  }
  const leafEntry: BoxLeafEntry = {
    id,
    traitsPacked,
    imageSha256: fileDigest(render.image.sha256, what, 'image', ctx.testFixtures),
    avatarSha256: render.avatar ? fileDigest(render.avatar.sha256, what, 'avatar', ctx.testFixtures) : ZERO,
    modelSha256: fileDigest(render.model.sha256, what, 'model', ctx.testFixtures),
    salt: saltOf(id, ctx.salt),
  };
  return {
    ...leafEntry,
    attributes: attributesOf(traitsPacked, ctx.table.table),
    leaf: boxLeaf(leafEntry, ctx.n),
    bytes: { image: render.image.bytes, avatar: render.avatar?.bytes ?? null, model: render.model.bytes },
  };
}

function checkDistinct(records: readonly Box0Record[], key: (r: Box0Record) => string, label: string): void {
  const seen = new Map<string, number>();
  for (const r of records) {
    const first = seen.get(key(r));
    if (first !== undefined) throw new Error(`ids ${first} and ${r.id} have the same ${label}`);
    seen.set(key(r), r.id);
  }
}

export function buildBox0Commitment(input: Box0Input, options: Box0Options = {}): Box0Commitment {
  const testFixtures = options.testOnlyAllowExporterFixtures === true;
  if (testFixtures && !options.testSalt) throw new Error('the fixture bypass requires test salts; never use it for production');
  const n = options.n ?? BOX0_N;
  const depth = boxTreeDepth(n);
  if (input.frozenSet.length !== n) throw new Error(`the frozen set has ${input.frozenSet.length} ids; N is ${n}`);
  if (input.renders.records.length !== n) throw new Error(`the render file has ${input.renders.records.length} records; N is ${n}`);
  const { generatorHash, generatorTree } = generatorOf(input.generator, input.renders.header, testFixtures);
  assertNotTestTable(input.table.hash);
  const ctx: Context = { n, index: traitIndex(input.table.table), table: input.table, salt: options.testSalt ?? csprngSalt, testFixtures };
  const records = Array.from({ length: n }, (_, i) => recordOf(input.frozenSet[i], input.renders.records[i], i + 1, ctx));
  if (!options.allowDuplicateTraits) checkDistinct(records, (r) => r.traitsPacked.toString(), 'traits');
  if (!options.allowDuplicateImages) checkDistinct(records, (r) => r.imageSha256, 'image');
  checkDistinct(records, (r) => r.salt, 'salt');
  const tree = buildBoxTree(
    records.map((r) => r.leaf),
    n,
  );
  for (const r of records) {
    if (!verifyBoxProof(r.id, r.leaf, tree.proof(r.id), tree.root, n)) throw new Error(`id ${r.id}: its proof does not check against the root`);
  }
  if (!testFixtures || (tree.root !== KNOWN_TEST_ROOTS.box0ExporterSmall && tree.root !== KNOWN_TEST_ROOTS.box0ExporterFull)) assertNotTestRoot(tree.root);
  return {
    n,
    depth,
    root: tree.root,
    table: input.table,
    tableHash: input.table.hash,
    valueOrderHash: input.table.valueOrderHash,
    generatorHash,
    generatorTree,
    render: input.renders.header,
    testSalts: options.testSalt !== undefined,
    records,
    proof: (id: number) => tree.proof(id),
  };
}
