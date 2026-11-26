/**
 * ART-02: every NFT id 1 … N needs exactly one image and one attributes entry. Missing, duplicate and out-of-range ids
 * are reported with the file names involved.
 */
import { describe, expect, it } from 'vitest';
import { checkCollection, compactIdRanges, itemIdFromFileName } from './index';

const files = (...names: string[]) =>
  names.map((fileName) => {
    const parsed = itemIdFromFileName(fileName);
    if (!parsed.ok) throw new Error(parsed.message);
    return { fileName, id: parsed.id };
  });
const traits = (...ids: string[]) => new Map(ids.map((id) => [id, []]));

describe('itemIdFromFileName', () => {
  it.each([
    ['1.png', '1'],
    ['0007.JPG', '7'],
    ['42.jpeg', '42'],
    ['2000.webp', '2000'],
    ['4294967294.png', '4294967294'],
  ])('%s → id %s', (name, id) => {
    expect(itemIdFromFileName(name)).toEqual({ ok: true, id });
  });

  it.each(['0.png', 'cat.png', '1.gif', '1.svg', '1.png.html', '12', '-1.png', '1 .png', '4294967295.png', '١.png', '../1.png'])('rejects %s', (name) => {
    const result = itemIdFromFileName(name);
    expect(result.ok).toBe(false);
  });
});

describe('compactIdRanges', () => {
  it('joins consecutive ids into ranges and caps the list', () => {
    expect(compactIdRanges([1n, 2n, 3n, 5n, 7n, 8n])).toBe('1–3, 5, 7–8');
    expect(compactIdRanges(Array.from({ length: 30 }, (_, i) => BigInt(i * 2 + 1)), 3)).toBe('1, 3, 5 and 27 more');
    expect(compactIdRanges([])).toBe('');
  });
});

describe('checkCollection', () => {
  it('passes when ids 1 … N each have one image and one attributes entry', () => {
    const report = checkCollection({ collectionSize: 3n, images: files('1.png', '2.png', '3.webp'), attributes: traits('1', '2', '3') });
    expect(report).toEqual({ ok: true, problems: [] });
  });

  it('lists missing images and missing attributes as id ranges', () => {
    const report = checkCollection({ collectionSize: 6n, images: files('1.png', '2.png', '6.png'), attributes: traits('1', '2', '3', '4', '5', '6') });
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual(['Missing images for ids 3–5.']);
    const noTraits = checkCollection({ collectionSize: 3n, images: files('1.png', '2.png', '3.png'), attributes: traits('2') });
    expect(noTraits.problems).toEqual(['Missing attributes for ids 1, 3.']);
  });

  it('names the files that claim the same id', () => {
    const report = checkCollection({ collectionSize: 2n, images: files('1.png', '01.jpg', '2.png'), attributes: traits('1', '2') });
    expect(report.problems).toEqual(['Id 1 has more than one image: 1.png, 01.jpg.']);
  });

  it('rejects ids beyond the collection size, in images and in attributes', () => {
    const report = checkCollection({ collectionSize: 2n, images: files('1.png', '2.png', '3.png'), attributes: traits('1', '2', '9') });
    expect(report.problems).toEqual(['Images for ids beyond the collection size of 2: 3.', 'Attributes for ids beyond the collection size of 2: 9.']);
  });

  it('asks for an attributes file and for images', () => {
    expect(checkCollection({ collectionSize: 1n, images: [], attributes: null }).problems).toEqual(['Add one image per NFT (ids 1–1).', 'Add an attributes file (JSON or CSV).']);
  });

  it('refuses collections larger than the demo upload limit without enumerating them', () => {
    const report = checkCollection({ collectionSize: 10n ** 9n, images: files('1.png'), attributes: traits('1') });
    expect(report.problems).toEqual(['This demo accepts uploads for up to 2,000 NFTs; the collection size is 1,000,000,000.']);
  });
});
