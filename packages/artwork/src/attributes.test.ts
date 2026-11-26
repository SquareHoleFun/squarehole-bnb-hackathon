/**
 * Attribute files (SH-010; ART-02, ART-03): JSON or CSV, strict shape, per-item id, key/value length limits, no
 * duplicate ids or traits, ≤ 2,000 items in the demo. Unknown fields are rejected by name, so metadata can never
 * carry launch terms (reward side, fees, quote asset) into the wizard.
 */
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_LIMITS, DEMO_MAX_ITEMS, parseAttributes, type AttributesResult } from './index';

const ok = (result: AttributesResult) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.errors.join(' | ')}`);
  return result;
};
const errors = (result: AttributesResult): readonly string[] => (result.ok ? [] : result.errors);
const asJson = (value: unknown) => JSON.stringify(value);

describe('parseAttributes: JSON', () => {
  it('reads an array of items with OpenSea-style trait lists', () => {
    const result = ok(
      parseAttributes(
        'traits.json',
        asJson([
          { id: 1, attributes: [{ trait_type: 'Background', value: 'Blue' }, { trait_type: 'Level', value: 3 }] },
          { id: '2', attributes: [{ trait_type: 'Shiny', value: true }] },
          { id: 3, attributes: [] },
        ]),
      ),
    );
    expect(result.format).toBe('json');
    expect([...result.items.keys()]).toEqual(['1', '2', '3']);
    expect(result.items.get('1')).toEqual([
      { trait: 'Background', value: 'Blue' },
      { trait: 'Level', value: '3' },
    ]);
    expect(result.items.get('2')).toEqual([{ trait: 'Shiny', value: 'true' }]);
    expect(result.items.get('3')).toEqual([]);
  });

  it('reads an object keyed by id with trait maps', () => {
    const result = ok(parseAttributes('traits.json', asJson({ '1': { Background: 'Green' }, '0002': { Background: 'Red', Hat: 'Cap' } })));
    expect(result.items.get('2')).toEqual([
      { trait: 'Background', value: 'Red' },
      { trait: 'Hat', value: 'Cap' },
    ]);
  });

  it('detects duplicate ids, also after normalising leading zeros (ART-02)', () => {
    expect(errors(parseAttributes('a.json', asJson([{ id: 1, attributes: [] }, { id: '01', attributes: [] }])))).toEqual([
      'Item 2: duplicate id 1 (also item 1).',
    ]);
  });

  it.each([
    ['a zero id', [{ id: 0, attributes: [] }], /id must be a whole number from 1/],
    ['a negative id', [{ id: -3, attributes: [] }], /id must be a whole number from 1/],
    ['a fractional id', [{ id: 1.5, attributes: [] }], /id must be a whole number from 1/],
    ['a text id', [{ id: 'seven', attributes: [] }], /id must be a whole number from 1/],
    ['a missing id', [{ attributes: [] }], /missing its id/],
    ['a financial field on an item', [{ id: 1, attributes: [], rewardSide: 'T' }], /unknown field "rewardSide"/],
    ['an image URL field', [{ id: 1, attributes: [], image: 'javascript:alert(1)' }], /unknown field "image"/],
    ['an unknown trait field', [{ id: 1, attributes: [{ trait_type: 'A', value: 'b', display_type: 'number' }] }], /unknown field "display_type"/],
    ['a nested value', [{ id: 1, attributes: [{ trait_type: 'A', value: { x: 1 } }] }], /value must be text, a number or true\/false/],
    ['a trait name that is too long', [{ id: 1, attributes: { ['k'.repeat(ATTRIBUTE_LIMITS.key.max + 1)]: 'v' } }], /trait name must be 1-64 characters/],
    ['a value that is too long', [{ id: 1, attributes: { k: 'v'.repeat(ATTRIBUTE_LIMITS.value.max + 1) } }], /value must be 1-128 characters/],
    ['an empty value', [{ id: 1, attributes: { k: '' } }], /value must be 1-128 characters/],
    ['a control character', [{ id: 1, attributes: { k: 'a\u0007b' } }], /control characters/],
    ['a bidi override', [{ id: 1, attributes: { k: 'abc\u202Edef' } }], /bidirectional/],
    ['a duplicate trait', [{ id: 1, attributes: [{ trait_type: 'A', value: '1' }, { trait_type: 'A', value: '2' }] }], /duplicate trait "A"/],
    ['an infinite number', [{ id: 1, attributes: [{ trait_type: 'A', value: 'INFINITE' }] }], /value must be text, a number or true\/false/],
  ])('rejects %s', (_name, value, message) => {
    const found = errors(parseAttributes('a.json', asJson(value).replace('"INFINITE"', '1e400')));
    expect(found.join('\n')).toMatch(message);
  });

  it('limits traits per item', () => {
    const traits = Object.fromEntries(Array.from({ length: ATTRIBUTE_LIMITS.maxPerItem + 1 }, (_, i) => [`t${i}`, 'v']));
    expect(errors(parseAttributes('a.json', asJson([{ id: 1, attributes: traits }]))).join()).toMatch(/at most 32 traits/);
  });

  it(`accepts ${DEMO_MAX_ITEMS} items and rejects one more (demo limit)`, () => {
    const items = (n: number) => asJson(Array.from({ length: n }, (_, i) => ({ id: i + 1, attributes: { Rank: String(i + 1) } })));
    expect(ok(parseAttributes('a.json', items(DEMO_MAX_ITEMS))).items.size).toBe(DEMO_MAX_ITEMS);
    expect(errors(parseAttributes('a.json', items(DEMO_MAX_ITEMS + 1))).join()).toMatch(/at most 2,000 items/);
  });

  it('takes the caller’s limits: a box’s 10,000 items in JSON and CSV, one more refused, and its own text size (SH-AI-PLAN)', () => {
    const json = (n: number) => asJson(Array.from({ length: n }, (_, i) => ({ id: i + 1, attributes: { Rank: String(i % 7) } })));
    const csv = (n: number) => ['id,Rank', ...Array.from({ length: n }, (_, i) => `${i + 1},${i % 7}`)].join('\n');
    const box = { maxItems: 10_000, maxFileChars: 16 * 1024 * 1024 };
    expect(ok(parseAttributes('a.json', json(10_000), box)).items.size).toBe(10_000);
    expect(ok(parseAttributes('traits.csv', csv(10_000), box)).items.size).toBe(10_000);
    expect(errors(parseAttributes('a.json', json(10_001), box)).join()).toMatch(/at most 10,000 items \(found 10,001\)/);
    expect(errors(parseAttributes('traits.csv', csv(10_001), box)).join()).toMatch(/at most 10,000 items \(found 10,001\)/);
    // The demo's own limits stay the default.
    expect(errors(parseAttributes('traits.csv', csv(DEMO_MAX_ITEMS + 1))).join()).toMatch(/at most 2,000 items/);
    const large = ' '.repeat(ATTRIBUTE_LIMITS.maxFileChars + 1);
    expect(errors(parseAttributes('a.json', `${large}[]`, box)).join()).not.toMatch(/too large/);
    expect(errors(parseAttributes('a.json', ' '.repeat(box.maxFileChars + 1), box)).join()).toMatch(/more than 16 MB of text/);
  });

  it('rejects the launch terms dressed up as an attributes file (ART-03)', () => {
    const terms = { rewardSide: 'T', feePolicyId: 'NONE', quoteAddress: '0x0000000000000000000000000000000000000001' };
    expect(errors(parseAttributes('terms.json', asJson(terms))).join('\n')).toMatch(/"rewardSide" is not an item id/);
  });

  it.each([
    ['malformed JSON', '[{"id": 1,'],
    ['a bare string', '"hello"'],
    ['null', 'null'],
    ['an empty file', '   '],
  ])('rejects %s', (_name, text) => {
    expect(errors(parseAttributes('a.json', text)).length).toBeGreaterThan(0);
  });

  it('keeps the list of errors short and says how many more there are', () => {
    const many = asJson(Array.from({ length: 50 }, () => ({ id: 0, attributes: [] })));
    const found = errors(parseAttributes('a.json', many));
    expect(found.length).toBeLessThanOrEqual(ATTRIBUTE_LIMITS.maxReportedErrors + 1);
    expect(found.at(-1)).toMatch(/and \d+ more/);
  });

  it('rejects oversized files before parsing', () => {
    expect(errors(parseAttributes('a.json', ' '.repeat(ATTRIBUTE_LIMITS.maxFileChars + 1))).join()).toMatch(/too large/);
  });
});

describe('parseAttributes: CSV', () => {
  it('reads an id column plus one column per trait, with quotes and CRLF', () => {
    const csv = 'id,Background,"Hat, style"\r\n1,Blue,"Cap, red"\r\n2,"Say ""hi""",\r\n3,,\r\n';
    const result = ok(parseAttributes('traits.csv', csv));
    expect(result.format).toBe('csv');
    expect(result.items.get('1')).toEqual([
      { trait: 'Background', value: 'Blue' },
      { trait: 'Hat, style', value: 'Cap, red' },
    ]);
    expect(result.items.get('2')).toEqual([{ trait: 'Background', value: 'Say "hi"' }]);
    expect(result.items.get('3')).toEqual([]);
  });

  it.each([
    ['no id column', 'name,Background\n1,Blue', /first column must be "id"/],
    ['a duplicate column', 'id,A,A\n1,x,y', /duplicate trait column "A"/],
    ['a short row', 'id,A,B\n1,x', /line 2 has 2 fields; the header has 3/],
    ['a duplicate id', 'id,A\n1,x\n1,y', /duplicate id 1/],
    ['an unterminated quote', 'id,A\n1,"x', /unterminated quote/],
    ['a bad id', 'id,A\nabc,x', /id must be a whole number from 1/],
    ['only a header', 'id,A\n', /no items/],
  ])('rejects %s', (_name, csv, message) => {
    expect(errors(parseAttributes('traits.csv', csv)).join('\n')).toMatch(message);
  });

  it('picks the format from the content when the name has no known extension', () => {
    expect(ok(parseAttributes('traits.txt', 'id,A\n1,x')).format).toBe('csv');
    expect(ok(parseAttributes('traits.txt', '[{"id":1,"attributes":[]}]')).format).toBe('json');
  });
});
