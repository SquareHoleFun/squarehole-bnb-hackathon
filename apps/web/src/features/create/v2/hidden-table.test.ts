/**
 * SH-AI-PLAN fix round 1 (integrator): hidden art's public trait table (the spec's metadataTable, on chain at
 * creation) is sorted on every path, numbered files as well as plans, so it says nothing about which number holds
 * which picture. Frog Kiln and Paper Certificates, 200 deals each from their own assign.mjs (numbered files, as the
 * kits make them today), give exactly one table; its first values no longer follow item 1; its types and values are in
 * code-point order; every item's packed traits decode back to its traits; every proof verifies. Open art keeps its
 * first-appearance table, byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxLeaf, sha256Hex, unpackTraits, verifyBoxProof } from '@squarehole/artwork';
import { renderHook } from '@testing-library/react';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { decodeMetadataTable } from '../../boxes/spec-record';
import { parseRevealFile } from '../../core/v2/reveal-file';
import { readArt, type ArtEnvironment } from '../art-files';
import { commitArt, metadataTableHex, revealFile, traitTable, type ArtState } from '../create-model';
import { EMPTY_DRAFT } from '../draft';
import { NOW, OWNER, artOf, formOf } from '../test-support/fixtures';
import { useCreateModel } from '../use-create-flow';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const two = (i: number) => String(i + 1).padStart(2, '0');
const DEALS = 200;

interface KitModule {
  readonly VARIANT_NAMES: readonly string[];
  readonly TRAITS: readonly (readonly string[])[];
  readonly assignment: (seed?: string) => { readonly items: readonly { readonly id: string; readonly variant: string }[] };
}

async function kit(id: 'frog-kiln' | 'paper-certificates') {
  const module = (await import(/* @vite-ignore */ resolve(ROOT, `examples/boxes/${id}/assign.mjs`))) as KitModule;
  const names = id === 'frog-kiln' ? ['Glaze', 'Crack'] : ['Company', 'Ink', 'Series'];
  const traits = (variant: string) => {
    const i = Number(variant) - 1;
    const values = id === 'frog-kiln' ? [...(module.TRAITS[i] ?? [])] : [module.VARIANT_NAMES[i] as string, ...(module.TRAITS[i] ?? [])];
    return names.flatMap((trait, t) => (values[t] ? [{ trait, value: values[t] as string }] : []));
  };
  const bytes = Array.from({ length: 12 }, (_, i) => new Uint8Array(readFileSync(resolve(ROOT, `examples/boxes/${id}/art/items/variant-${two(i)}.png`))));
  const shas = bytes.map((b) => sha256Hex(b));
  const n = module.assignment('x').items.length;
  const salts = Array.from({ length: n }, (_, i) => sha256Hex(new TextEncoder().encode(`fix-1 salt ${i + 1}`)));
  /** The kit's numbered files for one deal, as the page reads them: ids 1..N in order, each its variant's picture and traits. */
  const deal = (seed: string): ArtState => {
    const items = module.assignment(seed).items.map((item) => ({ id: Number(item.id), imageSha256: shas[Number(item.variant) - 1] as `0x${string}`, traits: traits(item.variant), bytes: 1 }));
    return { items, salts, thumbs: [], totalBytes: items.length, problems: [] };
  };
  return { module, names, traits, bytes, n, deal };
}

const byCodePoint = (values: readonly string[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/** Whether a table's first value of each of item 1's traits is item 1's own (what a first-appearance table always tells). */
const firstValuesAreItemOne = (types: readonly { name: string; values: readonly string[] }[], art: ArtState) =>
  (art.items[0]?.traits ?? []).every((t) => types.find((type) => type.name === t.trait)?.values[0] === t.value);

describe.each(['frog-kiln', 'paper-certificates'] as const)('%s, hidden, from numbered files', (id) => {
  it(`${DEALS} deals give exactly one table, in code-point order; it no longer follows item 1 (open art still does)`, async () => {
    const k = await kit(id);
    const tables = new Set<string>();
    let hiddenFollows = 0;
    let openFollows = 0;
    let itemOneHoldsTheFirstValues = 0;
    for (let d = 0; d < DEALS; d += 1) {
      const art = k.deal(`fix-1 deal ${d} ${'x'.repeat(32)}`);
      const hidden = commitArt(art, 'hidden');
      if (!hidden) throw new Error('no commitment');
      tables.add(metadataTableHex('', hidden.traitTypes) ?? 'none');
      if (firstValuesAreItemOne(hidden.traitTypes, art)) hiddenFollows += 1;
      if (firstValuesAreItemOne(traitTable(art.items).traitTypes, art)) openFollows += 1;
      // A sorted table "matches" item 1 only when item 1 holds each of its traits' first value in code-point order.
      const sortedFirst = (name: string) => byCodePoint([...new Set(art.items.flatMap((item) => item.traits.filter((t) => t.trait === name).map((t) => t.value)))])[0];
      if ((art.items[0]?.traits ?? []).every((t) => sortedFirst(t.trait) === t.value)) itemOneHoldsTheFirstValues += 1;
    }
    expect(tables.size).toBe(1);
    expect(openFollows).toBe(DEALS);
    expect(hiddenFollows).toBe(itemOneHoldsTheFirstValues);
    expect(hiddenFollows).toBeLessThan(DEALS / 4);
    const table = decodeMetadataTable([...tables][0] as `0x${string}`);
    if (!table) throw new Error('not a table');
    expect(table.traitTypes.map((type) => type.name)).toEqual(byCodePoint(k.names));
    for (const type of table.traitTypes) expect(type.values).toEqual(byCodePoint(type.values));
  }, shLimit(180_000));

  it('every item’s packed traits decode back to its traits; the reveal file proves every item; the page’s reader gives the same table', async () => {
    const k = await kit(id);
    const art = k.deal(`fix-1 proof ${'y'.repeat(32)}`);
    const commitment = commitArt(art, 'hidden');
    if (!commitment) throw new Error('no commitment');
    art.items.forEach((item, i) => {
      const indices = unpackTraits(commitment.packed[i] ?? 0n, commitment.traitTypes.length);
      const decoded = indices.flatMap((v, t) => (v === 0 ? [] : [{ trait: commitment.traitTypes[t]?.name, value: commitment.traitTypes[t]?.values[v - 1] }]));
      expect(byCodePoint(decoded.map((d) => `${d.trait}=${d.value}`))).toEqual(byCodePoint(item.traits.map((t) => `${t.trait}=${t.value}`)));
    });
    const text = revealFile({ collectionName: id, collectionSymbol: 'X' } as Parameters<typeof revealFile>[0], art, commitment).text;
    const file = parseRevealFile(text, commitment.revealRoot as Hex, BigInt(k.n));
    let verified = 0;
    for (let i = 1; i <= k.n; i += 1) {
      const item = file.revealOf(BigInt(i));
      if (!item) throw new Error(`no reveal for ${i}`);
      const leaf = boxLeaf({ id: i, traitsPacked: item.traitsPacked, imageSha256: item.imageHash, avatarSha256: item.avatarHash, modelSha256: item.modelHash, salt: item.salt }, k.n);
      if (verifyBoxProof(i, leaf, item.proof, commitment.revealRoot, k.n)) verified += 1;
    }
    expect(verified).toBe(k.n);
    // Today's numbered files through the page's own reader (the kit's example deal): the same single table.
    const items = k.module.assignment().items;
    const rows = items.map((item) => [item.id, ...k.names.map((name) => k.traits(item.variant).find((t) => t.trait === name)?.value ?? '')].join(','));
    const files = [...items.map((item) => new File([(k.bytes[Number(item.variant) - 1] as Uint8Array).slice().buffer], `${item.id}.png`, { type: 'image/png' })), new File([[['id', ...k.names].join(','), ...rows].join('\n')], 'traits.csv', { type: 'text/csv' })];
    const env: ArtEnvironment = { digest: async (bytes) => sha256Hex(bytes), thumbnail: async () => null, encodeCover: async () => ({ error: 'none' }), salt: () => `0x${'1'.repeat(64)}` };
    const read = await readArt(files, { env });
    expect(read.problems).toEqual([]);
    expect(metadataTableHex('', commitArt(read, 'hidden')?.traitTypes ?? [])).toBe(metadataTableHex('', commitment.traitTypes));
  }, shLimit(180_000));
});

describe('the art mode decides the order', () => {
  it('open art keeps its first-appearance table byte for byte; a plan’s or numbered art sorts only when hidden; nothing else is accepted', () => {
    const items = [1, 2, 3, 4].map((n) => ({ id: n, imageSha256: sha256Hex(new TextEncoder().encode(`p${n}`)), traits: [{ trait: 'Tone', value: n % 2 ? 'Zinc' : 'Amber' }, { trait: 'Band', value: n < 3 ? 'North' : 'East' }], bytes: 1 }));
    const art: ArtState = { items, salts: items.map((item) => sha256Hex(new TextEncoder().encode(`s${item.id}`))), thumbs: [], totalBytes: 4, problems: [] };
    expect(commitArt(art, 'open')?.traitTypes).toEqual([{ name: 'Tone', values: ['Zinc', 'Amber'] }, { name: 'Band', values: ['North', 'East'] }]);
    expect(commitArt(art, 'hidden')?.traitTypes).toEqual([{ name: 'Band', values: ['East', 'North'] }, { name: 'Tone', values: ['Amber', 'Zinc'] }]);
    expect(commitArt({ ...art, planned: true }, 'open')?.traitTypes).toEqual(commitArt(art, 'open')?.traitTypes);
    expect(commitArt({ ...art, planned: true }, 'hidden')?.revealRoot).toBe(commitArt(art, 'hidden')?.revealRoot);
    expect(() => commitArt(art, 'shown' as 'open')).toThrow();
  });

  it('v1’s page model (use-create-flow) commits hidden art sorted and open art as it is', () => {
    for (const [artMode, colours] of [['hidden', ['Gold', 'Red', 'Teal']], ['open', ['Red', 'Teal', 'Gold']]] as const) {
      const draft = { ...EMPTY_DRAFT, form: formOf({ artMode }), art: artOf() };
      const { result } = renderHook(() => useCreateModel({ draft, step: 'overview', nowMs: NOW, demo: true, connected: OWNER, chainId: 31337, dataLabel: 'Local chain 31337', created: [], network: 'demo' }));
      expect(result.current.commitment?.traitTypes[0]?.values, artMode).toEqual(colours);
      expect(decodeMetadataTable(result.current.spec.metadataTable as `0x${string}`)?.traitTypes[0]?.values, artMode).toEqual(colours);
    }
  });
});
