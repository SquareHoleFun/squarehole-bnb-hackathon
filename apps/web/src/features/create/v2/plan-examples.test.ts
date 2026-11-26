/**
 * SH-AI-PLAN, end to end in the page's own code: our two hidden examples, Frog Kiln (12 pictures, 420 items) and Paper
 * Certificates (12 pictures, 1,929 items), go through the plan path. Their real pictures and plan.csv (examples/boxes/
 * <kit>/) are read by the Contents step's reader, dealt by this browser's randomness, committed, built into the v2 spec
 * and saved as the reveal file; the box page's reveal reader then takes the file against the spec's root, and every
 * item's proof is checked again with viem's keccak, apart from the artwork package. Today's numbered files (the kits'
 * own example deal) build the same kind of spec and reveal file. Two real deals differ, each with valid proofs.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxLeaf, sha256Hex, verifyBoxProof } from '@squarehole/artwork';
import { ArtMode } from '@squarehole/box-spec';
import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { parseRevealFile } from '../../core/v2/reveal-file';
import { BROWSER_ART, readArt, type ArtEnvironment } from '../art-files';
import { buildSpec, commitArt, revealFile, type ArtState } from '../create-model';
import { testRandomWords } from '../test-support/test-words';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';
import { buildSpecV2, v2Issues } from './model';
import { BoxTypeV2, encodeBoxSpecV2 } from './spec-types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const two = (i: number) => String(i + 1).padStart(2, '0');

interface Kit {
  readonly id: 'frog-kiln' | 'paper-certificates';
  readonly n: number;
  readonly VARIANT_NAMES: readonly string[];
  readonly COUNTS: readonly bigint[];
  readonly TRAITS: readonly (readonly string[])[];
  readonly assignment: () => { readonly items: readonly { readonly id: string; readonly variant: string }[] };
}

async function kit(id: Kit['id'], n: number): Promise<Kit> {
  const module = (await import(/* @vite-ignore */ resolve(ROOT, `examples/boxes/${id}/assign.mjs`))) as Omit<Kit, 'id' | 'n'>;
  return { id, n, VARIANT_NAMES: module.VARIANT_NAMES, COUNTS: module.COUNTS, TRAITS: module.TRAITS, assignment: module.assignment };
}

/** The kit's trait names, as its own traits.csv and the plan name them. */
const traitNames = (k: Kit): string[] => (k.id === 'frog-kiln' ? ['Glaze', 'Crack'] : ['Company', 'Ink', 'Series']);

/** The kit's traits for variant i (an empty value: no such trait). */
function traitsOf(k: Kit, i: number): { trait: string; value: string }[] {
  const names = traitNames(k);
  const values = k.id === 'frog-kiln' ? [...(k.TRAITS[i] ?? [])] : [k.VARIANT_NAMES[i] as string, ...(k.TRAITS[i] ?? [])];
  return names.flatMap((trait, t) => (values[t] ? [{ trait, value: values[t] as string }] : []));
}

const pictureBytes = (k: Kit, i: number) => new Uint8Array(readFileSync(resolve(ROOT, `examples/boxes/${k.id}/art/items/variant-${two(i)}.png`)));
const fileOf = (name: string, bytes: Uint8Array, type = 'image/png') => new File([bytes.slice().buffer], name, { type });
/** The 12 pictures as the kit names them, and its plan.csv: what a creator adds on Contents. */
const planFiles = (k: Kit) => [...Array.from({ length: 12 }, (_, i) => fileOf(`variant-${two(i)}.png`, pictureBytes(k, i))), fileOf('plan.csv', new Uint8Array(readFileSync(resolve(ROOT, `examples/boxes/${k.id}/plan.csv`))), 'text/csv')];
/** Today's numbered files from the kit's own public example deal (assign.mjs, its example seed), with traits.csv. */
function numberedFiles(k: Kit): File[] {
  const items = k.assignment().items;
  const names = traitNames(k);
  const rows = items.map((item) => {
    const traits = traitsOf(k, Number(item.variant) - 1);
    return [item.id, ...names.map((name) => traits.find((t) => t.trait === name)?.value ?? '')].join(',');
  });
  const pictures = Array.from({ length: 12 }, (_, i) => pictureBytes(k, i));
  return [...items.map((item) => fileOf(`${item.id}.png`, pictures[Number(item.variant) - 1] as Uint8Array)), fileOf('traits.csv', new TextEncoder().encode([['id', ...names].join(','), ...rows].join('\n')), 'text/csv')];
}

const env = (randomWords: ArtEnvironment['randomWords']): ArtEnvironment => ({ ...BROWSER_ART, digest: async (bytes) => sha256Hex(bytes), thumbnail: async () => null, randomWords });
const HIDDEN = CONFIGURATIONS.find((config) => config.hidden === true);

/** The page's own path from art to the v2 spec and the reveal file (CreateV2Flow: buildSpecV2, saveReveal). */
function build(k: Kit, art: ArtState) {
  // The hidden configuration: the page commits with its art mode (CreateV2Flow `commitArt(art, form.artMode)`).
  const commitment = commitArt(art, 'hidden');
  if (!commitment || !HIDDEN) throw new Error('no commitment');
  const base = inputV2Of(HIDDEN, {}, { name: k.id === 'frog-kiln' ? 'Frog Kiln' : 'Gold Certificates', ticker: k.id === 'frog-kiln' ? 'KILN' : 'SCRIP' });
  const input = { ...base, art, commitment };
  const spec = buildSpecV2(input);
  const reveal = revealFile(buildSpec(input), art, commitment);
  return { input, spec, commitment, reveal, body: JSON.parse(reveal.text) as { items: Record<string, string>[]; traitTypes: unknown; n: string } & Record<string, unknown> };
}

/** An item's proof checked apart from the artwork package: its leaf abi-encoded and folded with viem's keccak. */
function viemVerifies(id: number, item: { traitsPacked: bigint; imageHash: Hex; avatarHash: Hex; modelHash: Hex; salt: Hex; proof: readonly Hex[] }, root: Hex): boolean {
  let node = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }], [BigInt(id), item.traitsPacked, item.imageHash, item.avatarHash, item.modelHash, item.salt]));
  let index = id - 1;
  for (const sibling of item.proof) {
    node = keccak256(index & 1 ? concat([sibling, node]) : concat([node, sibling]));
    index >>= 1;
  }
  return node === root.toLowerCase();
}

/** Every check of one deal: counts and traits as planned, a valid hidden v2 spec, a reveal file the box page takes, every proof. */
function checkDeal(k: Kit, art: ArtState) {
  expect(art.problems).toEqual([]);
  expect(art.planned).toBe(true);
  expect(art.items.map((item) => item.id)).toEqual(Array.from({ length: k.n }, (_, i) => i + 1));
  for (let i = 0; i < 12; i += 1) {
    const sha = sha256Hex(pictureBytes(k, i));
    const items = art.items.filter((item) => item.imageSha256 === sha);
    expect(items.length, `variant ${two(i)}`).toBe(Number(k.COUNTS[i]));
    for (const item of items) expect(item.traits).toEqual(traitsOf(k, i));
  }
  const { input, spec, commitment, body, reveal } = build(k, art);
  expect(spec.boxType).toBe(BoxTypeV2.NEW_COLLECTION);
  expect(spec.artMode).toBe(ArtMode.HIDDEN);
  expect(spec.n).toBe(k.n);
  expect(spec.revealRoot).toBe(commitment.revealRoot);
  expect(spec.revealListId).toBe(`0x${'0'.repeat(64)}`);
  expect(encodeBoxSpecV2(spec)).toMatch(/^0x[0-9a-f]+$/);
  // The page's own checks: nothing on Contents (the art, the table, the hidden texts) or anywhere else.
  expect(v2Issues({ ...input, revealSaved: true })).toEqual([]);
  expect(reveal.name).toBe(k.id === 'frog-kiln' ? 'kiln-reveal-file.json' : 'scrip-reveal-file.json');
  const file = parseRevealFile(reveal.text, spec.revealRoot as Hex, BigInt(k.n));
  expect(file.n).toBe(k.n);
  let verified = 0;
  for (let id = 1; id <= k.n; id += 1) {
    const item = file.revealOf(BigInt(id));
    if (!item) throw new Error(`no reveal for ${id}`);
    const leaf = boxLeaf({ id, traitsPacked: item.traitsPacked, imageSha256: item.imageHash, avatarSha256: item.avatarHash, modelSha256: item.modelHash, salt: item.salt }, k.n);
    if (verifyBoxProof(id, leaf, item.proof, spec.revealRoot, k.n) && viemVerifies(id, item, spec.revealRoot as Hex)) verified += 1;
  }
  expect(verified).toBe(k.n);
  expect(body.items[0]?.salt).toMatch(/^0x[0-9a-f]{64}$/);
  return { spec, body };
}

const mapOf = (art: ArtState) => art.items.map((item) => item.imageSha256).join();
const changedIds = (a: ArtState, b: ArtState) => a.items.filter((item, i) => item.imageSha256 !== b.items[i]?.imageSha256).length;

describe.each([
  ['frog-kiln', 420],
  ['paper-certificates', 1_929],
] as const)('%s through the plan path', (id, n) => {
  it(`its plan.csv is the kit's own: 12 pictures, ${n} items, the kit's counts and traits`, async () => {
    const k = await kit(id, n);
    const text = readFileSync(resolve(ROOT, `examples/boxes/${id}/plan.csv`), 'utf8');
    const names = traitNames(k);
    const rows = Array.from({ length: 12 }, (_, i) => {
      const traits = traitsOf(k, i);
      return [`variant-${two(i)}.png`, String(k.COUNTS[i]), ...names.map((name) => traits.find((t) => t.trait === name)?.value ?? '')].join(',');
    });
    expect(text).toBe(`${[['file', 'count', ...names].join(','), ...rows].join('\n')}\n`);
    expect(k.COUNTS.reduce((sum, c) => sum + c, 0n)).toBe(BigInt(n));
  });

  it('two deals with this browser’s randomness: different numbers, each a valid hidden spec and reveal file with every proof', async () => {
    const k = await kit(id, n);
    const first = await readArt(planFiles(k), { env: env(undefined) });
    const second = await readArt(planFiles(k), { env: env(BROWSER_ART.randomWords) });
    const a = checkDeal(k, first);
    const b = checkDeal(k, second);
    // Different deals: most ids hold another picture; the roots differ; the public table is the same.
    expect(mapOf(first)).not.toBe(mapOf(second));
    expect(changedIds(first, second)).toBeGreaterThan(n / 2);
    expect(a.spec.revealRoot).not.toBe(b.spec.revealRoot);
    expect(a.spec.metadataTable).toBe(b.spec.metadataTable);
    expect(new Set(first.salts).size).toBe(n);
  }, shLimit(120_000));

  it('the same kind of spec and reveal file as today’s numbered files; the same randomness repeats its deal', async () => {
    const k = await kit(id, n);
    const planned = await readArt(planFiles(k), { env: env(testRandomWords(`${id}-one`)) });
    expect(mapOf(await readArt(planFiles(k), { env: env(testRandomWords(`${id}-one`)) }))).toBe(mapOf(planned));
    const today = await readArt(numberedFiles(k), { env: env(undefined) });
    expect(today.problems).toEqual([]);
    expect(today.planned).toBeUndefined();
    const plan = build(k, planned);
    const numbered = build(k, today);
    // Every field but the root (its own deal and salts): hidden art's table is sorted on both paths (fix round 1).
    expect({ ...plan.spec, revealRoot: '-' }).toEqual({ ...numbered.spec, revealRoot: '-' });
    expect(plan.spec.metadataTable).toBe(numbered.spec.metadataTable);
    expect(Object.keys(plan.body)).toEqual(Object.keys(numbered.body));
    expect(Object.keys(plan.body.items[0] ?? {})).toEqual(Object.keys(numbered.body.items[0] ?? {}));
    expect(plan.body.n).toBe(numbered.body.n);
    const sets = (types: unknown) => (types as { name: string; values: string[] }[]).map((type) => `${type.name}:${[...type.values].sort().join('|')}`).sort();
    expect(sets(plan.body.traitTypes)).toEqual(sets(numbered.body.traitTypes));
    checkDeal(k, planned);
  }, shLimit(120_000));
});
