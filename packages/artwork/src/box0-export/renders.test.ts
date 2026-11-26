/**
 * The render-hash file (squarehole.misfits-render-hashes/1, written by the batch render tool): JSON Lines, a header
 * naming the generator tree, the platform and the encoding, then one record per id with its attributes and the sha256
 * and size of its image, avatar and model. The expected encoding is a parameter whose default is the founder's MF-9 and
 * MF-10 defaults (512 px WebP q90 picture, 256 px WebP avatar in every leaf).
 */
import { describe, expect, it } from 'vitest';
import { TEST_ENCODING, messageOf, readR7, renderHeader, renderText, testRender, testSet } from '../test-support/box0-export';
import { MF_DEFAULT_ENCODING, parseRenderHashes } from './renders';

const r7 = readR7();
const { records } = testSet(5, r7.types);
const withEncoding = (patch: Record<string, unknown>) => renderHeader({ encoding: { ...TEST_ENCODING, ...patch } });

describe('render-hash file', () => {
  it('the default expectation is MF-9 and MF-10: 512 px WebP q90, a 256 px WebP avatar, a GLB model', () => {
    expect(MF_DEFAULT_ENCODING).toEqual({
      image: { format: 'webp', size: 512, quality: 90 },
      avatar: { format: 'webp', size: 256 },
      model: { format: 'glb' },
    });
  });

  it('reads the header and one record per id, hashes as 0x lower-case hex', () => {
    const upper = records.map((r) => (r.id === 2 ? { ...r, image: { ...r.image, sha256: r.image.sha256.slice(2).toUpperCase() } } : r));
    const parsed = parseRenderHashes(renderText(renderHeader(), [...upper].reverse()), 5);
    expect(parsed.header.platform).toBe('darwin-arm64');
    expect(parsed.header.encoding.image).toEqual({ format: 'webp', size: 512, quality: 90 });
    expect(parsed.records.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.records[1]?.image.sha256).toBe(records[1]?.image.sha256.toLowerCase());
    expect(parsed.records[0]?.avatar?.bytes).toBe(records[0]?.avatar?.bytes);
  });

  it('refuses an encoding other than the expected one, naming the founder question', () => {
    const big = withEncoding({ image: { format: 'webp', size: 1024, quality: 90 } });
    expect(messageOf(() => parseRenderHashes(renderText(big, records), 5))).toMatch(/image size is 1024; expected 512 \(MF-9\)/);
    const q80 = withEncoding({ image: { format: 'webp', size: 512, quality: 80 } });
    expect(messageOf(() => parseRenderHashes(renderText(q80, records), 5))).toMatch(/image quality is 80; expected 90 \(MF-10\)/);
    const png = withEncoding({ avatar: { format: 'png', size: 256 } });
    expect(messageOf(() => parseRenderHashes(renderText(png, records), 5))).toMatch(/avatar format is png; expected webp \(MF-10\)/);
    const none = withEncoding({ avatar: null });
    expect(messageOf(() => parseRenderHashes(renderText(none, records), 5))).toMatch(/the renders have no avatar; expected one in every leaf \(MF-10\)/);
  });

  it('takes another encoding when the parameter says so (1,024 px; no avatar)', () => {
    const big = renderHeader({ encoding: { image: { format: 'webp', size: 1024, quality: 90 }, avatar: null, model: { format: 'glb' } } });
    const noAvatar = records.map((r) => testRender(r.id, r.attributes, false));
    const expected = { image: { format: 'webp', size: 1024, quality: 90 }, avatar: null, model: { format: 'glb' } } as const;
    const parsed = parseRenderHashes(renderText(big, noAvatar), 5, expected);
    expect(parsed.records.every((r) => r.avatar === null)).toBe(true);
    expect(messageOf(() => parseRenderHashes(renderText(big, records), 5, expected))).toMatch(/id 1: an avatar where the encoding has none/);
  });

  it('refuses another format, a missing or repeated id, a file over one raw block, an empty file and a malformed hash', () => {
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader({ format: 'x/1' }), records), 5))).toMatch(
      /not a squarehole.misfits-render-hashes\/1 file/,
    );
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader(), records.slice(0, 4)), 5))).toMatch(/no render record for id 5/);
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader(), [...records, records[4]]), 5))).toMatch(/id 5 has two render records/);
    const huge = records.map((r) => (r.id === 2 ? { ...r, model: { ...r.model, bytes: 1_048_577 } } : r));
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader(), huge), 5))).toMatch(
      /id 2: the model is 1048577 bytes; one raw IPFS block holds at most 1048576/,
    );
    const empty = records.map((r) => (r.id === 2 ? { ...r, image: { ...r.image, bytes: 0 } } : r));
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader(), empty), 5))).toMatch(/id 2: the image size must be a whole number of bytes from 1/);
    const short = records.map((r) => (r.id === 2 ? { ...r, avatar: { sha256: '0x1234', bytes: 9 } } : r));
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader(), short), 5))).toMatch(/id 2: the avatar sha256 must be 64 hex digits/);
    const noModel = records.map((r) => (r.id === 3 ? { ...r, model: undefined } : r));
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader(), noModel), 5))).toMatch(/id 3: the model sha256 must be 64 hex digits/);
    expect(messageOf(() => parseRenderHashes('{"format":', 5))).toMatch(/line 1 is not JSON/);
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader(), [...records, { ...records[0], id: 6 }]), 5))).toMatch(/line 7: id 6 is outside 1\.\.5/);
  });

  it('never quotes an id that is not a whole number, nor a format that is not a plain name', () => {
    const named = records.map((r) => (r.id === 2 ? { ...r, id: 'Unreleased Name' } : r));
    const idMessage = messageOf(() => parseRenderHashes(renderText(renderHeader(), named), 5));
    expect(idMessage).toMatch(/line 3: the id is not a whole number in 1\.\.5/);
    expect(idMessage).not.toContain('Unreleased');
    const odd = withEncoding({ image: { format: 'Unreleased Violet', size: 512, quality: 90 } });
    const formatMessage = messageOf(() => parseRenderHashes(renderText(odd, records), 5));
    expect(formatMessage).toMatch(/the image format is not webp \(MF-10\)/);
    expect(formatMessage).not.toContain('Unreleased');
    expect(messageOf(() => parseRenderHashes(renderText(withEncoding({ image: { format: 'png', size: 512, quality: 90 } }), records), 5))).toMatch(
      /the image format is png; expected webp \(MF-10\)/,
    );
  });

  it('a picture whose header has no quality (a lossless format) passes only an expectation without one', () => {
    const lossless = withEncoding({ image: { format: 'png', size: 512 } });
    const want = { ...MF_DEFAULT_ENCODING, image: { format: 'png', size: 512, quality: 90 } };
    expect(messageOf(() => parseRenderHashes(renderText(lossless, records), 5, want))).toMatch(
      /the image header has no quality; expected 90 \(MF-10; --image-quality any leaves it unchecked\)/,
    );
    const any = { ...MF_DEFAULT_ENCODING, image: { format: 'png', size: 512 } };
    expect(parseRenderHashes(renderText(lossless, records), 5, any).header.encoding.image).toEqual({ format: 'png', size: 512 });
  });

  it('refuses a header without a generator tree id or platform', () => {
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader({ generatorTree: 'abc' }), records), 5))).toMatch(
      /generatorTree must be a git tree id/,
    );
    expect(messageOf(() => parseRenderHashes(renderText(renderHeader({ platform: '' }), records), 5))).toMatch(/platform must name/);
  });
});
