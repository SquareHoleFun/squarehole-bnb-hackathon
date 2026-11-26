import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMENTED, LEFT, MANIFEST, PREFIX, PREFIXED, ROOT, TARGET, WAY_BACK, changedPictures, check, commentRanges, filesUnder, restore, sameScript, sameStyle,
  sha256, sourceAt, stripComments, type ExamplesManifest,
} from '../../../build/examples-copy.mjs';
import { fails, loadGraph, scanDirectory } from '../../../production-check';
import { shLimit } from '../../../../../vitest.timeouts.mjs';

// SH-252: the explainer's files the app serves at /examples/ (apps/web/public/examples), against their manifest
// (apps/web/build/examples-manifest.json, written by apps/web/build/examples-copy.mjs) and against the source commit
// itself, read from Git. The explainer's words stay as the generator wrote them: the copy only drops comments, gives
// addresses the /examples prefix and adds one link back. Nothing the page loads comes from another origin, and the
// release's rules for shipped files hold.

const FOLDER = join(ROOT, TARGET);
const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8')) as ExamplesManifest;
const files = filesUnder(FOLDER);
const text = (name: string): string => readFileSync(join(FOLDER, name), 'utf8');
const TEXT_FILE = /\.(?:html|css|js|webmanifest|svg|txt)$/;
/** Reading and hashing 37 MB, reading the source commit, or scanning it as the production check does. */
const WHOLE_FOLDER_MS = shLimit(60_000);
let source: Map<string, Buffer> | null = null;
/** The source folder at the manifest's commit (Git's blobs), read once. */
const sourceText = (name: string): string => {
  source ??= sourceAt(manifest.source.commit);
  const bytes = source.get(name);
  if (!bytes) throw new Error(`${name}: not in the source`);
  return bytes.toString('utf8');
};
/** A document without its comment nodes, as HTML. */
function withoutComments(html: string): Document {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
  for (const node of comments) node.parentNode?.removeChild(node);
  return document;
}
const WORDS = ['alt', 'aria-label', 'title', 'content'] as const;
const attributeWords = (document: Document): string[] => [...document.querySelectorAll(WORDS.map((name) => `[${name}]`).join(', '))]
  .flatMap((element) => WORDS.map((name) => element.getAttribute(name)).filter((value): value is string => value !== null));

describe('the explainer’s files at /examples/ (SH-252)', () => {
  it('the manifest names exactly the files of the folder, each with its SHA-256', () => {
    expect(files).toEqual(Object.keys(manifest.files).sort());
    const differing = files.filter((name) => sha256(readFileSync(join(FOLDER, name))) !== manifest.files[name]?.sha256);
    expect(differing).toEqual([]);
    expect(files.length).toBe(513);
  }, WHOLE_FOLDER_MS);

  it('comes from one commit of the generator’s output, says where the generator lives, and is that commit’s copy exactly', () => {
    expect(manifest.format).toBe('squarehole.examples/2');
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.source.folder).toBe('apps/landing/public');
    expect(manifest.source.generator).toMatch(/^docs\/marketing\/explainers\/build\.mjs /);
    expect([manifest.target, manifest.prefix, manifest.left]).toEqual([TARGET, PREFIX, [...LEFT]]);
    // The copy script's own check: every file and the manifest made again from the commit's blobs.
    expect(check()).toEqual([]);
  }, WHOLE_FOLDER_MS);

  it('three changes only, each recorded: comments out, the prefix on addresses, one link back', () => {
    const changed = Object.entries(manifest.files).filter(([, entry]) => entry.source !== undefined);
    for (const [name, entry] of changed) {
      expect(COMMENTED.test(name) || PREFIXED.includes(name), name).toBe(true);
      expect((entry.comments ?? 0) > 0 || (entry.addresses ?? 0) > 0, name).toBe(true);
      expect(entry.keptComments, name).toBeUndefined();
      expect(sha256(Buffer.from(sourceText(name), 'utf8')), name).toBe(entry.source);
    }
    // Every file a comment was taken from, and every prefixed one; nothing else differs from its source.
    expect(changed.map(([name]) => name).sort()).toEqual(
      Object.keys(manifest.files).filter((name) => PREFIXED.includes(name) || (COMMENTED.test(name) && commentRanges(name, sourceText(name)).length > 0)).sort(),
    );
    let addresses = 0;
    for (const name of PREFIXED) {
      const entry = manifest.files[name];
      const served = text(name);
      // Undoing the prefix and the way back gives the source without its comments, byte for byte.
      expect(restore(name, served), name).toBe(stripComments(name, sourceText(name)).text);
      expect(served.split(`${PREFIX}/`).length - 1, name).toBe(entry?.addresses);
      addresses += entry?.addresses ?? 0;
    }
    expect(addresses).toBe(512);
    expect(text('index.html').split(WAY_BACK).length - 1).toBe(1);
    expect(WAY_BACK).toBe('      <a class="elsewhere" href="/create"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 12H5M11.5 5.5 5 12l6.5 6.5"/></svg><span>Launch a box</span></a>\n');
  }, WHOLE_FOLDER_MS);

  it('the page reads the same: its text, alt texts and every attribute equal the source’s, byte for byte', () => {
    const before = withoutComments(sourceText('index.html'));
    const after = new DOMParser().parseFromString(restore('index.html', text('index.html')), 'text/html');
    expect(after.createTreeWalker(after, NodeFilter.SHOW_COMMENT).nextNode()).toBeNull();
    expect(after.documentElement.outerHTML).toBe(before.documentElement.outerHTML);
    // What a visitor reads, as served (the way back taken out again): the same text and the same words in attributes.
    const served = new DOMParser().parseFromString(text('index.html'), 'text/html');
    expect(served.querySelector('a.elsewhere[href="/create"]')?.textContent).toBe('Launch a box');
    expect(served.body.textContent?.replace('      Launch a box\n', '')).toBe(before.body.textContent);
    expect(after.body.textContent).toBe(before.body.textContent);
    expect(served.title).toBe(before.title);
    expect(attributeWords(served)).toEqual(attributeWords(before));
    expect(attributeWords(before).length).toBe(167);
  }, WHOLE_FOLDER_MS);

  it('the scripts and style sheets run the same: the same tree of the same tokens, the same style tokens', () => {
    for (const name of files.filter((file) => /\.(?:js|css)$/.test(file))) {
      const served = PREFIXED.includes(name) ? restore(name, text(name)) : text(name);
      if (name.endsWith('.js')) expect(sameScript(sourceText(name), served), name).toBe(true);
      else expect(sameStyle(sourceText(name), served), name).toBe(true);
    }
  }, WHOLE_FOLDER_MS);

  it('the comment rule: comments go and code stays, line breaks kept where a semicolon could depend on them', () => {
    expect(stripComments('a.js', 'const a = 1; // a note\n/* a block\n   of notes */\nconst b = a /* inline */ + 1;\nreturn /*\n*/ b;\n').text)
      .toBe('const a = 1;\nconst b = a  + 1;\nreturn \n b;\n');
    expect(stripComments('a.js', "const s = '/* not a comment */'; const r = /\\/\\/ not either/; // but this\n").text)
      .toBe("const s = '/* not a comment */'; const r = /\\/\\/ not either/;\n");
    expect(stripComments('a.css', '/* note */\na { color: red; } /* end */\nb/**/c { content: "/* kept */"; }\n').text)
      .toBe('a { color: red; }\nbc { content: "/* kept */"; }\n');
    expect(stripComments('a.html', '<p>a<!-- x -->b</p>\n  <!-- y -->\n').text).toBe('<p>ab</p>\n  \n');
    expect(stripComments('a.js', '/*! Licence: MIT */\nx();\n')).toEqual({ text: '/*! Licence: MIT */\nx();\n', comments: 0, kept: 1 });
    expect(sameScript('a + b', 'a - b')).toBe(false);
    expect(sameScript('a\n(b)', 'a (b)')).toBe(true);
    expect(sameStyle('a b {}', 'ab {}')).toBe(false);
  });

  it('no working note ships: no comment left, no round, decision or task number, no founder, no quotation of a person', () => {
    for (const name of files.filter((file) => COMMENTED.test(file))) expect(commentRanges(name, text(name)), name).toEqual([]);
    for (const name of files.filter((file) => TEXT_FILE.test(file) && !file.startsWith('fonts/'))) {
      const body = text(name);
      expect(body, name).not.toMatch(/desk,? round|\bround \d+\b|\bF\d+\b|\bSH-\d+|founder/i);
      // A quotation given to a person: "X, 2026-10-14: “…”", "… said: “…”", "the founder: “…”".
      expect(body, name).not.toMatch(/\b\d{4}-\d{2}-\d{2}\s*:\s*["“]|\b(?:said|says|wrote|asked)\s*[:,]?\s*["“]/i);
    }
  });

  it('a new copy names every picture changed under the same name', () => {
    const one = { files: { 'art/a.avif': { sha256: '1' }, 'art/b.avif': { sha256: '2' }, 'index.html': { sha256: '3' } } };
    const two = { files: { 'art/a.avif': { sha256: '1' }, 'art/b.avif': { sha256: '9' }, 'art/c.avif': { sha256: '4' }, 'index.html': { sha256: '8' } } };
    expect(changedPictures(one as unknown as ExamplesManifest, two as unknown as ExamplesManifest)).toEqual(['art/b.avif']);
    expect(changedPictures(null, two as unknown as ExamplesManifest)).toEqual([]);
  });

  it('every address of the site’s own files names a file of the copy, and each example has its own slides file', () => {
    const named = new Set<string>();
    for (const name of PREFIXED) {
      for (const match of text(name).matchAll(/\/examples\/([A-Za-z0-9_./-]*)/g)) named.add(match[1] ?? '');
    }
    // follow.js names an example's slides file by its page: `/examples/follow/${id}.js`.
    expect(named.has('follow/')).toBe(true);
    named.delete('follow/');
    expect([...named].filter((name) => !files.includes(name))).toEqual([]);
    const pages = [...text('index.html').matchAll(/<section class="pager__page pager__page--[a-z-]+" id="([a-z-]+)"/g)].map((match) => match[1] ?? '');
    expect(pages.slice(0, 2)).toEqual(['basics', 'how-it-works']);
    expect(pages.length).toBe(12);
    expect(pages.slice(2).map((id) => `follow/${id}.js`).sort()).toEqual(files.filter((name) => name.startsWith('follow/')));
    // No address of the site's own files is left without the prefix (the way back to the app aside).
    const bare = PREFIXED.flatMap((name) => [...text(name).matchAll(/["'`(, ]\/(?!examples\/)[A-Za-z0-9_.-]+/g)].map((match) => `${name}: ${match[0]}`));
    expect(bare).toEqual(['index.html: "/create']);
  });

  it('nothing the page loads comes from another origin: other addresses are its canonical, share and X links only', () => {
    const absolute = [...text('index.html').matchAll(/<(\w+)\b[^>]*?\s([\w:-]+)="((?:https?:)?\/\/[^"]*)"/g)].map((match) => `${match[1]} ${match[2]} ${match[3]}`);
    expect(absolute).toEqual([
      'link href https://squarehole.fun/',
      'meta content https://squarehole.fun/',
      'meta content https://squarehole.fun/art/card-1200x630.jpg',
      'meta content https://squarehole.fun/art/card-1200x630.jpg',
      'a href https://x.com/squarehole_',
    ]);
    expect(text('index.html')).toContain('<link rel="canonical" href="https://squarehole.fun/" />');
    // The scripts, styles and the rest: no address of another origin at all (SVG's own namespace aside), and no
    // way to ask one: the scripts load only the site's own files, by script and link elements.
    for (const name of files.filter((file) => TEXT_FILE.test(file) && file !== 'index.html' && !file.endsWith('.txt'))) {
      expect(text(name).replaceAll('http://www.w3.org/2000/svg', ''), name).not.toMatch(/https?:|\/\/[a-z0-9-]+\.[a-z]/i);
    }
    for (const name of files.filter((file) => file.endsWith('.js'))) {
      expect(text(name), name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(|new\s+Worker|\.src\s*=\s*['"`]https?:/);
    }
  });

  it('passes the production check’s scan of shipped files (no Demo, mock, local chain, trade or alpha trace)', () => {
    const findings = scanDirectory(FOLDER);
    expect(findings.filter(fails)).toEqual([]);
    expect(findings).toEqual([]);
  }, WHOLE_FOLDER_MS);

  it('names the release accepts, and nothing its site block keeps private', () => {
    // infra/server/app/build.mjs `publicFiles` and config.mjs `renderSites` (@private), with this folder's prefix.
    expect(files.filter((name) => !/^[A-Za-z0-9_./-]+$/.test(`examples/${name}`))).toEqual([]);
    expect(files.filter((name) => /(^|\/)\.[^/]*|\.map$/.test(`/examples/${name}`))).toEqual([]);
    expect(files.filter((name) => /^_|\/_/.test(name))).toEqual([]);
  });

  it('no word the site keeps out: no Misfits or FIT, no checked or trusted label, no wallet; one key line that begins with its verb', () => {
    const words = files.filter((name) => TEXT_FILE.test(name) && !name.startsWith('fonts/')).map((name) => [name, text(name)] as const);
    for (const [name, body] of words) {
      expect(body, name).not.toMatch(/misfit|\bFIT\b|\bverified\b|\btrusted\b|\bwallets?\b/i);
    }
    // One sentence here begins with this verb: the box's line in the key (follow.js), in the explainer's approved
    // words, as the app's own "Starts with the curve" does.
    const starts = words.flatMap(([name, body]) => [...body.matchAll(/.{0,8}\bStarts\b.{0,40}/g)].map((match) => `${name}: ${match[0]}`));
    expect(starts).toEqual(['follow.js: "line":"Starts its token and gives it its own pool.","']);
  });

  it('weighs under 40 MB in the release, and its page names under 1 MB to load first', () => {
    const bytes = files.reduce((sum, name) => sum + statSync(join(FOLDER, name)).size, 0);
    expect(bytes).toBeLessThan(40_000_000);
    const first = [...loadGraph(join(ROOT, 'apps/web/public')).firstPaint].filter((name) => name.startsWith('examples/'));
    expect(first).toContain('examples/index.html');
    expect(first).toContain('examples/pager.js');
    expect(first).toContain('examples/styles.css');
    const firstBytes = first.reduce((sum, name) => sum + statSync(join(ROOT, 'apps/web/public', name)).size, 0);
    expect(firstBytes).toBeLessThan(1_000_000);
  }, WHOLE_FOLDER_MS);
});
