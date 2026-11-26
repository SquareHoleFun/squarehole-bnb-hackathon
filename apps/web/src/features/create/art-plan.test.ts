/**
 * SH-AI-PLAN: the plan's reader, its limits and the dealing of the numbers (art-plan.ts). Every problem names its row
 * and column; the deal keeps each picture's count, is uniform (Fisher-Yates over rejection-sampled 32-bit words, as
 * the Misfits edition's `shuffleIds`), and never takes a number from the plan: neither its rows' order nor its file
 * names change who gets what. The randomness is a test source here (determinism); the page's is crypto.getRandomValues.
 */
import { sha256Hex } from '@squarehole/artwork';
import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, PLAN_WORDS, csvRecords, dealItems, isPlanHeader, parsePlan, planHeaderVerdict, uniformIndex, wordStream, type PlannedPicture, type PlanRow } from './art-plan';
import type { Hex } from './create-model';
import { testWords } from './test-support/test-words';

const sha = (text: string) => sha256Hex(new TextEncoder().encode(text)) as Hex;
const row = (file: string, count: number, traits: [string, string][] = [], at = 2): PlanRow => ({ row: at, file, count, traits: traits.map(([trait, value]) => ({ trait, value })) });
const picture = (file: string, count: number, traits: [string, string][] = [], at = 2): PlannedPicture => ({ row: row(file, count, traits, at), sha256: sha(file), bytes: 100 });
const FROG = ['file,count,Glaze,Crack', 'bisque.png,44,Bisque,', 'celadon.png,44,Celadon,', 'gold-seam.png,8,Celadon,Gold seam'].join('\n');

describe('csvRecords', () => {
  it('reads commas, quotes with "" escapes, CRLF and blank lines, with the line each record starts on', () => {
    const text = 'file,count,Name\r\n\r\n"a.png", 3 ,"Say ""hi"", then go"\r\nb.png,2,"two\nlines"\nc.png,1,  x  \n';
    expect(csvRecords(text)).toEqual({
      records: [
        { line: 1, cells: ['file', 'count', 'Name'] },
        { line: 3, cells: ['a.png', '3', 'Say "hi", then go'] },
        { line: 4, cells: ['b.png', '2', 'two\nlines'] },
        { line: 6, cells: ['c.png', '1', 'x'] },
      ],
      openQuote: null,
      cut: false,
    });
    expect(csvRecords('file,count\na.png,"3\n').openQuote).toBe(2);
    // `max` stops after that many records, each ended by its line end.
    expect(csvRecords('\n\nfile,count\na.png,3\n', 1)).toEqual({ records: [{ line: 3, cells: ['file', 'count'] }], openQuote: null, cut: true });
  });

  it('tells a plan from a traits file by its first cell', () => {
    expect(isPlanHeader('file,count,Glaze\nbisque.png,1,x')).toBe(true);
    expect(isPlanHeader('\uFEFF "File" ,count\r\n')).toBe(true);
    expect(isPlanHeader('id,Glaze\n1,x')).toBe(false);
    expect(isPlanHeader('filename,count\n')).toBe(false);
    // Fix round 1 (review F1): the first non-blank record, as the parser reads it.
    expect(isPlanHeader('\nfile,count,Glaze\n')).toBe(true);
    expect(isPlanHeader('\uFEFF\r\nfile,count,Glaze\r\n')).toBe(true);
    expect(isPlanHeader(`${' '.repeat(1024)}file,count,Glaze\n`)).toBe(true);
    expect(isPlanHeader(' \t \r\n\r\n "file" , count\n')).toBe(true);
    expect(isPlanHeader(',file,count\n')).toBe(false);
    expect(isPlanHeader('')).toBe(false);
  });

  it('asks for more of the file while its start may end inside the first record', () => {
    expect(planHeaderVerdict(' '.repeat(4096), false)).toBeNull();
    expect(planHeaderVerdict('\n\n\nfi', false)).toBeNull();
    expect(planHeaderVerdict('"file,count\n', false)).toBeNull();
    expect(planHeaderVerdict('\n\nfile,count\nbisque', false)).toBe(true);
    expect(planHeaderVerdict('id,Glaze\n', false)).toBe(false);
    // The whole text decides at its end: a last record without a line end counts.
    expect(planHeaderVerdict('\n\nfile,count', true)).toBe(true);
    expect(planHeaderVerdict(' '.repeat(4096), true)).toBe(false);
    expect(planHeaderVerdict('"file,count\n', true)).toBe(false);
  });
});

describe('parsePlan', () => {
  it('reads the rows: file, count and traits, an empty cell meaning no trait; the total is the sum of the counts', () => {
    const plan = parsePlan(FROG);
    expect(plan.issues).toEqual([]);
    expect(plan.total).toBe(96);
    expect(plan.rows).toEqual([
      { row: 2, file: 'bisque.png', count: 44, traits: [{ trait: 'Glaze', value: 'Bisque' }] },
      { row: 3, file: 'celadon.png', count: 44, traits: [{ trait: 'Glaze', value: 'Celadon' }] },
      { row: 4, file: 'gold-seam.png', count: 8, traits: [{ trait: 'Glaze', value: 'Celadon' }, { trait: 'Crack', value: 'Gold seam' }] },
    ]);
    expect([...plan.named]).toEqual(['bisque.png', 'celadon.png', 'gold-seam.png']);
    // Spaces around cells are dropped, the header is read in any case, a plan without traits is a plan.
    expect(parsePlan(' File , COUNT \n a_1.PNG , 10 \n').rows).toEqual([{ row: 2, file: 'a_1.PNG', count: 10, traits: [] }]);
  });

  it('refuses a column that sets the numbers or a secret: the page picks them', () => {
    for (const column of ['id', 'ID', 'token id', 'Token_ID', 'item-id', 'number', '#', 'nft id']) {
      expect(parsePlan(`file,count,${column},Glaze\na.png,10,1,x`).issues, column).toEqual([{ kind: 'plan', text: PLAN_WORDS.numbers }]);
    }
    for (const column of ['salt', 'Seed', 'seeds', 'secret', 'nonce']) {
      expect(parsePlan(`file,count,Glaze,${column}\na.png,10,x,0x01`).issues, column).toEqual([{ kind: 'plan', text: PLAN_WORDS.secret }]);
    }
    expect(PLAN_WORDS.numbers).toBe('Leave the numbers out. The page picks them.');
    expect(PLAN_WORDS.secret).toBe('This file tries to set a secret. The page makes its own.');
  });

  it('checks the header: file,count first, then trait names the box can hold, at most 16, none twice', () => {
    expect(parsePlan('picture,count\na.png,10').issues).toEqual([{ kind: 'plan', text: 'Row 1: start with file,count.' }]);
    expect(parsePlan('file,amount\na.png,10').issues).toEqual([{ kind: 'plan', text: 'Row 1: start with file,count.' }]);
    expect(parsePlan('').issues).toEqual([{ kind: 'plan', text: 'Row 1: start with file,count.' }]);
    const many = Array.from({ length: 17 }, (_, i) => `T${i}`).join(',');
    expect(parsePlan(`file,count,${many}\na.png,10${',x'.repeat(17)}`).issues).toEqual([{ kind: 'plan', text: '17 traits. A box holds 16.' }]);
    expect(parsePlan('file,count,Glaze ✨\na.png,10,x').issues).toEqual([{ kind: 'row', text: 'Row 1, column 3: "Glaze ✨" has a character the box cannot store.' }]);
    expect(parsePlan(`file,count,${'N'.repeat(65)}\na.png,10,x`).issues).toEqual([{ kind: 'row', text: 'Row 1, column 3: up to 64 characters.' }]);
    expect(parsePlan('file,count,Glaze,,Crack\na.png,10,x,y,z').issues).toEqual([{ kind: 'row', text: 'Row 1, column 4: name this trait.' }]);
    expect(parsePlan('file,count,Glaze,Glaze\na.png,10,x,y').issues).toEqual([{ kind: 'row', text: 'Row 1, column 4: Glaze is already column 3.' }]);
    expect(parsePlan('file,count,Glaze\n').issues).toEqual([{ kind: 'plan', text: 'The plan has no rows.' }]);
    expect(parsePlan('file,count,Glaze\na.png,"10\n').issues).toEqual([{ kind: 'plan', text: 'Row 2: a quote is not closed.' }]);
  });

  it('points at the row and the column of each problem', () => {
    const text = [
      'file,count,Glaze,Crack',
      'bisque.png,44,Bisque,',
      'gold.gif,8,Celadon,Gold seam',
      'my toad.png,8,Celadon,',
      'ember.png,8,"Gold ✨",',
      'BISQUE.png,4,Bisque,',
      'raku.png,0,Raku,',
      'ash.png,4.5,Ash,',
      'shino.png,10001,Shino,',
      'honey.png,2,Say "hi",',
      `oxblood.png,2,${'x'.repeat(129)},`,
      'speckle.png,2,Speckle',
      'tenmoku.png,2,"Te\\n",',
    ].join('\n');
    expect(parsePlan(text).issues.map((issue) => issue.text)).toEqual([
      'Row 3, file: use letters, digits, - and _, then .png, .jpg or .webp.',
      'Row 4, file: use letters, digits, - and _, then .png, .jpg or .webp.',
      'Row 5, Glaze: "Gold ✨" has a character the box cannot store.',
      'Row 6: BISQUE.png is already in row 2.',
      'Row 7, count: a whole number from 1 to 10,000.',
      'Row 8, count: a whole number from 1 to 10,000.',
      'Row 9, count: a whole number from 1 to 10,000.',
      'Row 10, Glaze: "Say "hi"" has a character the box cannot store.',
      'Row 11, Glaze: up to 128 characters.',
      'Row 12 has 3 cells. Row 1 has 4.',
      'Row 13, Glaze: "Te\\n" has a character the box cannot store.',
    ]);
    expect(parsePlan(text).issues.every((issue) => issue.kind === 'row' && /^Row \d+(, [^:]+)?[: ]/.test(issue.text))).toBe(true);
  });

  it('the box’s limits: 255 values per trait, 10 to 10,000 items, file names up to 128 characters', () => {
    const values = (n: number) => ['file,count,Shade', ...Array.from({ length: n }, (_, i) => `p${i}.png,1,n${i}`)].join('\n');
    expect(parsePlan(values(255)).issues).toEqual([]);
    expect(parsePlan(values(256)).issues).toEqual([{ kind: 'plan', text: 'Shade has 256 values. A box holds 255.' }]);
    expect(parsePlan('file,count\na.png,4\nb.png,4').issues).toEqual([{ kind: 'plan', text: '8 items. A collection needs 10 to 10,000.' }]);
    expect(parsePlan('file,count\na.png,9').issues).toEqual([{ kind: 'plan', text: '9 items. A collection needs 10 to 10,000.' }]);
    expect(parsePlan('file,count\na.png,10').issues).toEqual([]);
    expect(parsePlan('file,count\na.png,10000').issues).toEqual([]);
    expect(parsePlan('file,count\na.png,10000\nb.png,1').issues).toEqual([{ kind: 'plan', text: '10,001 items. A collection needs 10 to 10,000.' }]);
    expect(parsePlan(`file,count\n${'a'.repeat(124)}.png,10`).issues).toEqual([]);
    expect(parsePlan(`file,count\n${'a'.repeat(125)}.png,10`).issues.map((issue) => issue.text)).toEqual(['Row 2, file: use letters, digits, - and _, then .png, .jpg or .webp.']);
    expect(PLAN_LIMITS).toEqual({ traits: 16, values: 255, nameChars: 64, valueChars: 128, fileChars: 128 });
    // .jpg, .jpeg and .webp in any case; nothing else.
    expect(parsePlan('file,count\na.JPG,4\nb.jpeg,3\nc.WebP,3').issues).toEqual([]);
    for (const name of ['a.gif', 'a.svg', 'a.png.exe', '.png', 'dir/a.png', 'a.png?x=1', 'café.png']) {
      expect(parsePlan(`file,count\n${name},10`).issues.map((issue) => issue.text), name).toEqual(['Row 2, file: use letters, digits, - and _, then .png, .jpg or .webp.']);
    }
  });
});

describe('uniformIndex and wordStream', () => {
  it('draws a word again at or above the largest multiple of the bound (no modulo bias)', () => {
    const words = [2 ** 32 - 1, 2 ** 32 - 2, 7];
    // bound 3: 2^32 = 3 × 1431655765 + 1, so only 2^32 - 1 is drawn again.
    expect(uniformIndex(3, () => words.shift() as number)).toBe((2 ** 32 - 2) % 3);
    const again = [2 ** 32 - 1, 5];
    expect(uniformIndex(3, () => again.shift() as number)).toBe(2);
    expect(uniformIndex(1, () => 123)).toBe(0);
    expect(() => uniformIndex(0, () => 1)).toThrow();
    expect(() => uniformIndex(3, () => 2 ** 32)).toThrow();
    expect(() => uniformIndex(3, () => -1)).toThrow();
    expect(() => uniformIndex(3, () => 0.5)).toThrow();
  });

  it('every permutation once for every choice of indices (Fisher-Yates is a bijection)', () => {
    const pictures = [picture('a.png', 1), picture('b.png', 1), picture('c.png', 1), picture('d.png', 1)];
    const seen = new Set<string>();
    // n = 4: j₃ ∈ 0..3, j₂ ∈ 0..2, j₁ ∈ 0..1: 24 choices.
    for (let a = 0; a < 4; a += 1) for (let b = 0; b < 3; b += 1) for (let c = 0; c < 2; c += 1) {
      const words = [a, b, c];
      seen.add(dealItems(pictures, () => words.shift() as number).map((item) => item.imageSha256).join());
    }
    expect(seen.size).toBe(24);
  });

  it('fills a block of words at a time from the source', () => {
    let fills = 0;
    const next = wordStream((words) => {
      fills += 1;
      words.fill(fills);
    }, 4);
    expect(Array.from({ length: 9 }, () => next())).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3]);
  });
});

describe('dealItems', () => {
  const plan = [picture('bisque.png', 44, [['Glaze', 'Bisque']], 2), picture('celadon.png', 44, [['Glaze', 'Celadon']], 3), picture('gold-seam.png', 8, [['Glaze', 'Celadon'], ['Crack', 'Gold seam']], 4)];

  it('numbers 1..N, each picture exactly its count, with its own traits', () => {
    const items = dealItems(plan, testWords('one'));
    expect(items.map((item) => item.id)).toEqual(Array.from({ length: 96 }, (_, i) => i + 1));
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.imageSha256, (counts.get(item.imageSha256) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ [sha('bisque.png')]: 44, [sha('celadon.png')]: 44, [sha('gold-seam.png')]: 8 });
    for (const item of items) expect(item.traits).toEqual(plan.find((entry) => entry.sha256 === item.imageSha256)?.row.traits);
  });

  it('the same words give the same deal; other words another one', () => {
    const map = (words: () => number) => dealItems(plan, words).map((item) => item.imageSha256).join();
    expect(map(testWords('one'))).toBe(map(testWords('one')));
    expect(map(testWords('one'))).not.toBe(map(testWords('two')));
  });

  it('takes no number from the plan: its rows’ order and its file names change nothing', () => {
    const words = () => testWords('order');
    const deal = (pictures: readonly PlannedPicture[]) => dealItems(pictures, words()).map((item) => `${item.id}:${item.imageSha256}:${JSON.stringify(item.traits)}`);
    const reversed = [...plan].reverse().map((entry, i) => ({ ...entry, row: { ...entry.row, row: i + 2 } }));
    const renamed = plan.map((entry, i) => ({ ...entry, row: { ...entry.row, file: `${i + 1}.png` } }));
    expect(deal(reversed)).toEqual(deal(plan));
    expect(deal(renamed)).toEqual(deal(plan));
  });

  it('spreads the pictures evenly over the numbers (8,000 deals of 3 pictures: each id holds each picture about a third of the time)', () => {
    const three = [picture('a.png', 1), picture('b.png', 1), picture('c.png', 1)];
    const words = testWords('spread');
    const tally = [new Map<string, number>(), new Map<string, number>(), new Map<string, number>()];
    for (let run = 0; run < 8_000; run += 1) {
      dealItems(three, words).forEach((item, i) => tally[i]?.set(item.imageSha256, (tally[i]?.get(item.imageSha256) ?? 0) + 1));
    }
    for (const position of tally) for (const entry of three) expect(Math.abs((position.get(entry.sha256) ?? 0) - 8_000 / 3)).toBeLessThan(200);
  });

  it('deals 10,000 items; a source that fails or gives no words throws (the page then says so)', () => {
    const big = [picture('a.png', 5_000), picture('b.png', 4_999), picture('c.png', 1)];
    const items = dealItems(big, testWords('big'));
    expect(items).toHaveLength(10_000);
    expect(items.filter((item) => item.imageSha256 === sha('c.png'))).toHaveLength(1);
    expect(() => dealItems(big, () => Number.NaN)).toThrow();
    expect(() => dealItems(big, wordStream(() => { throw new Error('no crypto'); }))).toThrow('no crypto');
  });
});
