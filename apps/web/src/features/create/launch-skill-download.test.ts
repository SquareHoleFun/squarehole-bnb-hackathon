/**
 * The launch skill's checker (`pnpm box-spec:check`, F73) reads this page's "Download BoxSpec" file. Besides the spec,
 * the file carries fingerprints of its own: the rights record's spec hash (written by every Download press), the
 * logo's, the collection cover's (F74 U3), banner's and teasers' sha256 and open art's reveal list, and the network it
 * was checked for (F74 U1). This builds the file exactly as the Download press does (`boxSpecFile` with `rightsRecord`)
 * and checks that the checker reads it as a valid download (for the network the file names), never as "looks
 * like a private key" (exit 4).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '@squarehole/box-spec';
import { BoxType, QStream, TStream } from '@squarehole/box-spec';
import { describe, expect, it } from 'vitest';
import { EXIT, SECRET_MESSAGE, checkSpec, modelFor, renderText } from '../../../../../packages/box-spec/scripts/lib/check-spec.mjs';
import type { Network } from '@squarehole/box-spec';
import {
  DEFAULT_FORM,
  EMPTY_PAGE,
  boxSpecFile,
  buildSpec,
  commitArt,
  revealList,
  rightsRecord,
  type ArtState,
  type CoverState,
  type CreateForm,
  type Hex,
  type PageState,
} from './create-model';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const model = modelFor(lib as unknown as Record<string, unknown>);
const OWNER = '0xdce82e76456434d0f550b492ff212a862221e6c5' as const;
const NOW = Date.UTC(2026, 9, 3, 12);

/** sha256 of a text as 0x hex: as random-looking as a real picture's or salt's fingerprint. */
const sha = (text: string) => `0x${createHash('sha256').update(text).digest('hex')}` as Hex;
/** A processed picture as the page keeps it: the sha256 of the stored bytes and the bytes (base64). */
const picture = (name: string): CoverState => ({ sha256: sha(name), url: null, bytes: 4, data: Buffer.from(name).toString('base64') });
const art = (n: number): ArtState => ({
  items: Array.from({ length: n }, (_, i) => ({ id: i + 1, imageSha256: sha(`${i + 1}.png`), traits: [{ trait: 'Colour', value: i % 2 ? 'Red' : 'Blue' }], bytes: 10 })),
  salts: Array.from({ length: n }, (_, i) => sha(`salt ${i}`)),
  thumbs: [],
  totalBytes: 10 * n,
  problems: [],
});
const BANNER_AND_TEASERS: PageState = { banner: picture('banner.png'), teasers: [picture('teaser-1.png'), picture('teaser-2.png')] };

/** The file the Download press saves (use-create-flow `downloadSpec`) for a form patch, the page's pictures and art. */
function download(patch: Partial<CreateForm>, page: PageState = EMPTY_PAGE, items = 0, network: Network = 'mainnet') {
  const form: CreateForm = { ...DEFAULT_FORM, name: 'Gas Guzzlers', ticker: 'GUZZ', description: 'Demo: 100 toy fuel cans from the 2021 gas wars.', ...patch };
  const cover = picture('logo.png');
  const collection = form.contents === 'collection';
  const collectionCover = collection ? picture('collection-cover.png') : null;
  const artState = items > 0 ? art(items) : null;
  const commitment = commitArt(artState, form.artMode);
  const spec = buildSpec({ form, art: artState, commitment, cover, collectionCover, page, owner: OWNER, nowMs: NOW });
  const openList = collection && form.artMode === 'open' && artState && commitment ? revealList(artState, commitment.packed) : null;
  const file = boxSpecFile(spec, {
    builtAtMs: NOW,
    cover,
    collectionCover,
    network,
    page,
    revealList: openList,
    links: { website: 'https://guzz.example', x: '@guzz', telegram: '' },
    rights: rightsRecord(lib.specHash(spec), OWNER, NOW),
    storeAll: collection,
  });
  return { spec, text: file.text, doc: JSON.parse(file.text) as Record<string, unknown> };
}

describe("the checker reads the page's own Download BoxSpec file", () => {
  it('a token-only box with the rights record', () => {
    const { spec, doc } = download({ contents: 'token', qStream: QStream.TO_CREATOR, tStream: TStream.BURN_T });
    expect(spec.boxType).toBe(BoxType.TOKEN_ONLY);
    expect((doc.site as { rights: { specHash: string } }).rights.specHash).toBe(doc.specHash);
    const result = checkSpec(model, doc);
    expect(result, renderText(result)).toMatchObject({ ok: true, kind: 'download', specHash: lib.specHash(spec) });
  });

  it('a collection with open art, a banner, two teasers and the rights record', () => {
    const { doc } = download({ contents: 'collection', artMode: 'open' }, BANNER_AND_TEASERS, 12);
    expect(doc.collectionCover).toMatchObject({ sha256: sha('collection-cover.png') });
    expect(doc.banner).toMatchObject({ sha256: sha('banner.png') });
    expect(doc.teasers).toHaveLength(2);
    expect((doc.revealList as { items: unknown[] }).items).toHaveLength(12);
    const result = checkSpec(model, doc);
    expect(result, renderText(result)).toMatchObject({ ok: true, kind: 'download', enterable: true });
  });

  it('F74 U1: a Demo file with holder payouts names its network; the checker checks it for that network unless told another', () => {
    const { doc } = download({ contents: 'token', qStream: QStream.HOLDERS_IN_T, tStream: TStream.PAY_HOLDERS_T }, EMPTY_PAGE, 0, 'demo');
    expect(doc.network).toBe('demo');
    const demo = checkSpec(model, doc, { network: doc.network as Network });
    expect(demo, renderText(demo)).toMatchObject({ ok: true, kind: 'download', network: 'demo' });
    // No --network: the file's own network, said in the first line (review of sh-f74-spec).
    const asFiled = checkSpec(model, doc);
    expect(asFiled, renderText(asFiled)).toMatchObject({ ok: true, network: 'demo', networkFrom: 'file' });
    expect(renderText(asFiled)).toContain('(context v2, Demo, as the file says)');
    expect(checkSpec(model, doc, { network: 'mainnet' }).ok).toBe(false);
    expect(checkSpec(model, doc, { network: 'sepolia' }).ok).toBe(false);
  });

  it('a collection with hidden art (no reveal list in the file) and the rights record', () => {
    const result = checkSpec(model, download({ contents: 'collection', artMode: 'hidden' }, { banner: picture('banner.png'), teasers: [picture('teaser.png')] }, 10).doc);
    expect(result, renderText(result)).toMatchObject({ ok: true, kind: 'download' });
  });

  it('from the command line too: exit 0, and still exit 4 for a key added beside them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-download-'));
    const { doc, text } = download({ contents: 'collection', artMode: 'open' }, BANNER_AND_TEASERS, 12);
    const run = (body: string) => {
      const path = join(dir, 'guzz-boxspec-v1.json');
      writeFileSync(path, body);
      return spawnSync(process.execPath, [join(ROOT, 'packages/box-spec/scripts/check-spec.mjs'), path], { encoding: 'utf8', cwd: ROOT });
    };
    const ok = run(text);
    expect(ok.stdout, ok.stderr).toContain('Valid: the factory');
    expect(ok.status).toBe(EXIT.VALID);
    const key = sha('a private key, for this test');
    const site = doc.site as Record<string, unknown>;
    const added = run(JSON.stringify({ ...doc, site: { ...site, note: key } }));
    expect(added.status).toBe(EXIT.SECRET);
    expect(added.stdout).toContain(SECRET_MESSAGE);
    expect(added.stdout).toContain('Where: site.note');
    expect(added.stdout).not.toContain(key.slice(2, 20));
  });
});
