/**
 * SH-AI-PLAN: the Contents step's reader with a plan (art-files.ts `readArt`, art-plan.ts). Pictures with any names
 * and one plan become ids 1..N dealt by this browser's randomness (a test source here), a salt each, the plan's traits;
 * the numbered files' path is unchanged beside it. Problems point at rows, columns and files, at most three lines.
 */
import { sha256Hex } from '@squarehole/artwork';
import { describe, expect, it } from 'vitest';
import { SVG_WITH_SCRIPT, makePng } from '../../../../../packages/artwork/src/test-support/images';
import { BROWSER_ART, MAX_PROBLEM_LINES, readArt, type ArtEnvironment } from './art-files';
import { PLAN_WORDS } from './art-plan';
import { commitArt, type ArtState } from './create-model';
import { testRandomWords } from './test-support/test-words';

function env(label = 'deal'): ArtEnvironment {
  let salts = 0;
  return {
    digest: async (bytes) => sha256Hex(bytes),
    thumbnail: async (file) => `data:image/png;base64,${btoa((file as File).name ?? 'x')}`,
    encodeCover: async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()) }),
    salt: () => {
      salts += 1;
      return sha256Hex(new TextEncoder().encode(`salt-${salts}`));
    },
    randomWords: testRandomWords(label),
  };
}

const png = (width: number) => makePng({ width, height: 24, decodable: true });
const file = (name: string, bytes: Uint8Array | string, type = 'image/png') => new File([typeof bytes === 'string' ? bytes : bytes.slice().buffer], name, { type });
const plan = (rows: readonly string[], name = 'plan.csv') => file(name, rows.join('\n'), 'text/csv');
const PICTURES = { 'bisque.png': png(24), 'celadon.png': png(25), 'gold-seam.png': png(26) } as const;
const pictures = (names: readonly (keyof typeof PICTURES)[] = ['bisque.png', 'celadon.png', 'gold-seam.png']) => names.map((name) => file(name, PICTURES[name]));
const FROG = ['file,count,Glaze,Crack', 'bisque.png,44,Bisque,', 'celadon.png,44,Celadon,', 'gold-seam.png,8,Celadon,Gold seam'];
const shaOf = (name: keyof typeof PICTURES) => sha256Hex(PICTURES[name]);
const mapOf = (art: ArtState) => art.items.map((item) => item.imageSha256).join();

describe('readArt with a plan', () => {
  it('deals ids 1..N over the pictures by their counts, with the plan’s traits and a salt each', async () => {
    const kept: string[] = [];
    const progress: number[] = [];
    const art = await readArt([...pictures(), plan(FROG)], { env: env(), onItemFile: (sha256) => kept.push(sha256), onProgress: (done) => progress.push(done) });
    expect(art.problems).toEqual([]);
    expect(art.planned).toBe(true);
    expect(art.items.map((item) => item.id)).toEqual(Array.from({ length: 96 }, (_, i) => i + 1));
    const count = (name: keyof typeof PICTURES) => art.items.filter((item) => item.imageSha256 === shaOf(name)).length;
    expect([count('bisque.png'), count('celadon.png'), count('gold-seam.png')]).toEqual([44, 44, 8]);
    expect(art.items.find((item) => item.imageSha256 === shaOf('gold-seam.png'))?.traits).toEqual([{ trait: 'Glaze', value: 'Celadon' }, { trait: 'Crack', value: 'Gold seam' }]);
    expect(art.items.find((item) => item.imageSha256 === shaOf('bisque.png'))?.traits).toEqual([{ trait: 'Glaze', value: 'Bisque' }]);
    expect(art.salts).toHaveLength(96);
    expect(new Set(art.salts).size).toBe(96);
    // Each picture once, in the plan's order (never by number): the kept files and the thumbnails.
    expect(kept).toEqual([shaOf('bisque.png'), shaOf('celadon.png'), shaOf('gold-seam.png')]);
    expect(art.thumbs.map((url) => atob(url.split(',')[1] ?? ''))).toEqual(['bisque.png', 'celadon.png', 'gold-seam.png']);
    expect(art.totalBytes).toBe(44 * PICTURES['bisque.png'].byteLength + 44 * PICTURES['celadon.png'].byteLength + 8 * PICTURES['gold-seam.png'].byteLength);
    expect(progress.at(-1)).toBe(3);
    expect(commitArt(art, 'hidden')?.n).toBe(96);
  });

  it('two deals with other randomness differ; the same randomness repeats; file names and row order never matter', async () => {
    const one = await readArt([...pictures(), plan(FROG)], { env: env('one') });
    const again = await readArt([...pictures(), plan(FROG)], { env: env('one') });
    const two = await readArt([...pictures(), plan(FROG)], { env: env('two') });
    expect(mapOf(one)).toBe(mapOf(again));
    expect(mapOf(one)).not.toBe(mapOf(two));
    // Pictures named like numbered files, rows reversed: the same deal (numbers come from the randomness alone).
    const renamed = [file('3.png', PICTURES['bisque.png']), file('1.png', PICTURES['celadon.png']), file('2.png', PICTURES['gold-seam.png'])];
    const reordered = plan(['file,count,Glaze,Crack', '2.png,8,Celadon,Gold seam', '1.png,44,Celadon,', '3.png,44,Bisque,']);
    expect(mapOf(await readArt([...renamed, reordered], { env: env('one') }))).toBe(mapOf(one));
  });

  it('this browser’s own randomness: two real deals of the same plan differ, both valid', async () => {
    const real = { ...env(), randomWords: undefined };
    const a = await readArt([...pictures(), plan(FROG)], { env: real });
    const b = await readArt([...pictures(), plan(FROG)], { env: { ...real, randomWords: BROWSER_ART.randomWords } });
    expect(a.problems).toEqual([]);
    expect(b.problems).toEqual([]);
    expect(mapOf(a)).not.toBe(mapOf(b));
  });

  it('the public table is the same for every deal: it says nothing about which number is which', async () => {
    const tables = new Set<string>();
    for (const label of ['a', 'b', 'c', 'd']) {
      const commitment = commitArt(await readArt([...pictures(), plan(FROG)], { env: env(label) }), 'hidden');
      tables.add(JSON.stringify(commitment?.traitTypes));
    }
    expect([...tables]).toEqual([JSON.stringify([{ name: 'Crack', values: ['Gold seam'] }, { name: 'Glaze', values: ['Bisque', 'Celadon'] }])]);
  });

  it('names what is wrong: a picture not in the plan, a row with no picture, a picture refused, a bad cell', async () => {
    const big = new Uint8Array(1_048_577);
    big.set(png(24));
    const art = await readArt([...pictures(['bisque.png', 'celadon.png']), file('logo.png', png(30)), file('gold-seam.png', big), plan([...FROG, 'ember.png,8,Raku,Ember'])], { env: env() });
    expect(art.problems).toEqual(['logo.png is not in the plan.', 'Row 5: no picture named ember.png.', 'gold-seam.png is 1.1 MB. Max 1 MB. Save it as WebP or JPEG.']);
    expect(art.items).toEqual([]);
    expect(art.salts).toEqual([]);
    expect(art.planned).toBe(true);
    const cell = await readArt([...pictures(), plan(['file,count,Glaze,Crack', 'bisque.png,44,Bisque,', 'celadon.png,44,"Gold ✨",', 'gold-seam.png,8,Celadon,Gold seam'])], { env: env() });
    expect(cell.problems).toEqual(['Row 3, Glaze: "Gold ✨" has a character the box cannot store.']);
    const script = await readArt([...pictures(['bisque.png', 'celadon.png']), file('gold-seam.png', SVG_WITH_SCRIPT), plan(FROG)], { env: env() });
    expect(script.problems).toEqual([expect.stringMatching(/^gold-seam\.png: /)]);
  });

  it('refuses a plan that sets numbers or secrets, a plan beside a traits file, two plans, two pictures of one name', async () => {
    const numbers = await readArt([...pictures(), plan(['file,count,id,Glaze', 'bisque.png,44,1,Bisque', 'celadon.png,44,2,Celadon', 'gold-seam.png,8,3,Celadon'])], { env: env() });
    expect(numbers.problems).toEqual([PLAN_WORDS.numbers]);
    const secret = await readArt([...pictures(), plan(['file,count,Glaze,salt', 'bisque.png,44,Bisque,0x01', 'celadon.png,44,Celadon,0x02', 'gold-seam.png,8,Celadon,0x03'])], { env: env() });
    expect(secret.problems).toEqual([PLAN_WORDS.secret]);
    const traits = await readArt([...pictures(), plan(FROG), file('traits.csv', 'id,Glaze\n1,Bisque', 'text/csv')], { env: env() });
    expect(traits.problems).toEqual(['Use the plan or a traits file, not both.']);
    const metadata = await readArt([...pictures(), plan(FROG), file('1.json', '{"attributes":[]}', 'application/json')], { env: env() });
    expect(metadata.problems).toEqual(['Use the plan or a traits file, not both.']);
    const twice = await readArt([...pictures(), plan(FROG), plan(FROG, 'plan-2.csv')], { env: env() });
    expect(twice.problems).toEqual(['2 plans. Add one.']);
    const same = await readArt([...pictures(), file('BISQUE.png', png(31)), plan(FROG)], { env: env() });
    expect(same.problems).toEqual(['2 pictures named bisque.png.']);
  });

  it('too few or too many items, and no randomness: nothing is dealt', async () => {
    const few = await readArt([...pictures(['bisque.png']), plan(['file,count', 'bisque.png,8'])], { env: env() });
    expect(few.problems).toEqual(['8 items. A collection needs 10 to 10,000.']);
    const blind = await readArt([...pictures(), plan(FROG)], { env: { ...env(), randomWords: () => { throw new Error('No crypto.getRandomValues'); } } });
    expect(blind.problems).toEqual(['This browser cannot pick random numbers.']);
    expect(blind.items).toEqual([]);
  });

  it('groups many problems by rule, at most three lines', async () => {
    const rows = ['file,count,Glaze', ...Array.from({ length: 12 }, (_, i) => `p${i}.png,0,x`)];
    const files = [file('a.png', png(40)), file('b.png', png(41)), file('notes.txt', 'hi', 'text/plain'), file('.DS_Store', 'x', ''), plan(rows)];
    expect((await readArt(files, { env: env() })).problems).toEqual([
      'notes.txt: not a picture (PNG, JPEG or WebP) or a traits file.',
      '12 problems in the plan, e.g. Row 2, count: a whole number from 1 to 10,000.',
      '2 pictures are not in the plan, e.g. a.png.',
    ]);
    const art = await readArt([...files, file('traits.json', '[]', 'application/json')], { env: env() });
    expect(art.problems).toHaveLength(MAX_PROBLEM_LINES);
    expect(art.problems).toEqual([
      'notes.txt: not a picture (PNG, JPEG or WebP) or a traits file.',
      'Use the plan or a traits file, not both.',
      '…and 14 more problems.',
    ]);
  });

  // Fix round 1 (review F1): a plan is found as the parser reads it, past a BOM, blank lines and blanks before a cell.
  it.each([
    ['a leading line feed', `\n${FROG.join('\n')}`],
    ['a byte order mark, then CRLF lines', `\uFEFF\r\n${FROG.join('\r\n')}\r\n`],
    ['1,024 spaces before file,count,Glaze', `${' '.repeat(1024)}${FROG.join('\n')}`],
    ['20,000 blank lines (past the first read)', `${' \r\n'.repeat(20_000)}${FROG.join('\n')}`],
  ])('finds the plan after %s', async (_name, text) => {
    const art = await readArt([...pictures(), plan([text])], { env: env() });
    expect(art.problems).toEqual([]);
    expect(art.planned).toBe(true);
    expect(art.items).toHaveLength(96);
  });

  it('keeps the plan’s size guard: a plan over 8 MB is named as one, not read as traits', async () => {
    const big = `${FROG.join('\n')}\n${'\n'.repeat(8 * 1024 * 1024)}`;
    const art = await readArt([...pictures(), plan([big])], { env: env() });
    expect(art.problems).toEqual(['plan.csv is larger than 8 MB.']);
    expect(art.planned).toBe(true);
  });

  it('a traits CSV (first column id) still takes the numbered files’ path', async () => {
    const numbered = Array.from({ length: 10 }, (_, i) => file(`${i + 1}.png`, png(30 + i)));
    const art = await readArt([...numbered, file('traits.csv', ['id,Glaze', ...Array.from({ length: 10 }, (_, i) => `${i + 1},g${i}`)].join('\n'), 'text/csv')], { env: env() });
    expect(art.problems).toEqual([]);
    expect(art.planned).toBeUndefined();
    expect(art.items.map((item) => item.traits[0]?.value)).toEqual(Array.from({ length: 10 }, (_, i) => `g${i}`));
    expect(art.items.map((item) => item.imageSha256)).toEqual(Array.from({ length: 10 }, (_, i) => sha256Hex(png(30 + i))));
  });
});
