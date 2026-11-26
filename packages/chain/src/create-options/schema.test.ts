import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CREATE_OPTIONS_MAX_BYTES, parseCreateOptions } from './schema';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const empty = JSON.parse(fixture('empty')) as Record<string, unknown>;
const parse = (patch: Record<string, unknown>) => parseCreateOptions(JSON.stringify({ ...empty, ...patch }));
const address = `0x${'ab'.repeat(20)}`;

describe('Create options document', () => {
  it('keeps the initial empty fixture at revision 1', () => expect(empty).toMatchObject({ revision: 1, off: [] }));
  it('accepts the largest positive safe-integer chainId and revision', () => {
    expect(parse({ chainId: 9007199254740991, revision: 9007199254740991 }).ok).toBe(true);
  });
  it.each(['empty', 'two-off', 'other-release'])('accepts the valid %s fixture', name => {
    const result = parseCreateOptions(fixture(name));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document).toEqual(JSON.parse(fixture(name)));
  });
  it('accepts the installed data file', () => {
    expect(parseCreateOptions(readFileSync(new URL(`./data/${empty.chainId}/${empty.factory}.json`, import.meta.url), 'utf8')).ok).toBe(true);
  });
  it('accepts fields in another order, including entry fields', () => {
    const doc = { ...empty, off: [{ issueId: 'issue-1', key: 'kind.token' }] };
    expect(parseCreateOptions(JSON.stringify(Object.fromEntries(Object.entries(doc).reverse())))).toEqual({ ok: true, document: doc });
  });
  it('accepts spaces, tabs and both line endings around JSON tokens', () => {
    const text = ` \t\r\n${JSON.stringify(empty).replaceAll(':', ' \t:\r\n').replaceAll(',', '\n,\t ')}\r\n`;
    expect(parseCreateOptions(text)).toEqual({ ok: true, document: empty });
  });
  const plain = JSON.stringify({ ...empty, off: [{ key: 'kind.token', issueId: 'issue-1' }] });
  it.each([
    ['repeated off hiding a disabled option', plain.replace(/}$/, ',"off":[]}')],
    ['repeated revision', plain.replace('"revision":1', '"revision":2,"revision":1')],
    ['repeated key in an entry', plain.replace('"key":"kind.token"', '"key":"kind.shop","key":"kind.token"')],
    ['repeated issueId in an entry', plain.replace('"issueId":"issue-1"', '"issueId":"other","issueId":"issue-1"')],
    ['decimal integer 1.0', plain.replace('"revision":1', '"revision":1.0')],
    ['uppercase exponent 1E2', plain.replace('"revision":1', '"revision":1E2')],
    ['lowercase exponent 1e2', plain.replace('"revision":1', '"revision":1e2')],
    ['signed exponent 1e+2', plain.replace('"revision":1', '"revision":1e+2')],
    ['escaped root member name', plain.replace('"off"', '"o\\u0066f"')],
    ['escaped entry member name', plain.replace('"key"', '"k\\u0065y"')],
    ['escaped option key', plain.replace('kind.token', 'kind.\\u0074oken')],
    ['escaped issueId', plain.replace('issue-1', 'issue\\u002d1')],
    ['escaped address', plain.replace('"0x', '"\\u0030x')],
  ])('refuses non-plain JSON: %s', (_name, text) => {
    expect(parseCreateOptions(text)).toEqual({ ok: false, reason: 'document must be plain JSON, no repeated or escaped members' });
  });
  it('accepts all three dynamic families and native coin', () => {
    expect(parse({ off: [{ key: `price.${address}` }, { key: `pile.coin.${address}` }, { key: `module.${address}.4294967295` },
      { key: 'price.0x0000000000000000000000000000000000000000' }, { key: `module.${address}.0` }] }).ok).toBe(true);
  });
  it('accepts exactly 128 entries and a 96-character issueId', () => {
    const off = Array.from({ length: 128 }, (_, id) => ({ key: `module.${address}.${id}`, issueId: 'a'.repeat(96) }));
    expect(parse({ off }).ok).toBe(true);
  });
  it('accepts exactly 32 KiB, refuses the next byte', () => {
    expect(parseCreateOptions(fixture('empty').padEnd(CREATE_OPTIONS_MAX_BYTES, ' ')).ok).toBe(true);
    expect(parseCreateOptions(fixture('oversized'))).toEqual({ ok: false, reason: 'document exceeds 32 KiB' });
  });
  it('measures UTF-8 bytes, including multibyte text', () => {
    expect(parseCreateOptions('é'.repeat(16385))).toEqual({ ok: false, reason: 'document exceeds 32 KiB' });
  });
  it.each(['{', '', 'null', '[]', 'true', '3', '"text"'])('refuses malformed JSON or root: %s', text => {
    expect(parseCreateOptions(text).ok).toBe(false);
  });
  it('refuses deeply nested JSON without throwing', () => {
    expect(parseCreateOptions('['.repeat(16000) + '0' + ']'.repeat(16000)).ok).toBe(false);
  });
  it('refuses extra root fields', () => expect(parse({ extra: true }).ok).toBe(false));
  it.each(Object.keys(empty))('refuses missing root field %s', field => {
    const doc = Object.fromEntries(Object.entries(empty).filter(([key]) => key !== field));
    expect(parseCreateOptions(JSON.stringify(doc)).ok).toBe(false);
  });
  it.each([0, 2, '1', null])('refuses unsupported schema %s', schema => expect(parse({ schema }).ok).toBe(false));
  for (const field of ['chainId', 'revision']) {
    it.each([0, -1, 1.5, '1', null, 9007199254740992])(`refuses invalid ${field} %s`, value => expect(parse({ [field]: value }).ok).toBe(false));
  }
  for (const field of ['factory', 'registry']) {
    it.each([address.toUpperCase(), `0x${'AB'.repeat(20)}`, address.slice(0, -1), `${address}0`, `${address}\n`, 'nope', null, 2])(`refuses noncanonical ${field} %s`, value => expect(parse({ [field]: value }).ok).toBe(false));
  }
  it.each([`0x${'AB'.repeat(32)}`, `0X${'ab'.repeat(32)}`, `0x${'ab'.repeat(32)}\n`, address, 'nope', null, 2])('refuses noncanonical hash %s', versionCodeHash => expect(parse({ versionCodeHash }).ok).toBe(false));
  it.each([null, {}, '', 5])('refuses non-list off %s', off => expect(parse({ off }).ok).toBe(false));
  it('refuses more than 128 entries', () => {
    expect(parse({ off: Array.from({ length: 129 }, (_, id) => ({ key: `module.${address}.${id}` })) }).ok).toBe(false);
  });
  it.each([null, [], 'kind.token', {}, { key: 'kind.token', extra: 1 }, { issueId: 'issue' }])('refuses malformed entry %j', entry => expect(parse({ off: [entry] }).ok).toBe(false));
  it.each(['', 'kind.nope', 'fee.buyers.shop', 'royalty-bps.500', 'art.hidden', 'opening.now', 'storage.all-art',
    'a'.repeat(97), 'kind.tokén', `price.${address.toUpperCase()}`, `pile.coin.${address}0`, `module.${address}.01`,
    `module.${address}.-1`, `module.${address}.4294967296`, `module.${address}.1.2`, `price.${address}\n`, 3, null])('refuses invalid key %s', key => expect(parse({ off: [{ key }] }).ok).toBe(false));
  it.each(['', 'Upper', 'has_underscore', 'has.dot', 'has space', 'é', 'a'.repeat(97), null, 2, 'issue\n'])('refuses invalid issueId %s', issueId => expect(parse({ off: [{ key: 'kind.token', issueId }] }).ok).toBe(false));
  it('refuses duplicate keys even with different issue IDs', () => {
    expect(parse({ off: [{ key: 'kind.token' }, { key: 'kind.token', issueId: 'another' }] })).toEqual({ ok: false, reason: 'duplicate option key' });
  });
  it('refuses the whole document when one entry is bad', () => {
    const result = parseCreateOptions(fixture('malformed'));
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty('document');
  });
  it('checks optional expected release pins', () => {
    const result = parseCreateOptions(fixture('empty'));
    if (!result.ok) throw new Error(result.reason);
    expect(parseCreateOptions(fixture('empty'), result.document).ok).toBe(true);
    expect(parseCreateOptions(fixture('other-release'), result.document).ok).toBe(false);
    for (const field of ['chainId', 'factory', 'registry', 'versionCodeHash']) {
      expect(parseCreateOptions(JSON.stringify({ ...empty, [field]: field === 'chainId' ? 1 : `0x${'11'.repeat(field === 'versionCodeHash' ? 32 : 20)}` }), result.document).ok).toBe(false);
    }
  });
});
