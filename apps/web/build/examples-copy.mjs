/**
 * SH-252: the examples inside the app. The explainer (Basics, How it works and the ten examples, every part of a
 * picture selectable with its explanation) is a static page that its generator writes into apps/landing/public on the
 * landing's branch (docs/marketing/explainers/build.mjs there). The app serves that output at /examples/ from its own
 * public files (apps/web/public/examples), so every tester opens it inside the app, behind the app's own page lock and
 * headers. This file is the one way those files are made and checked:
 *
 * - Copied from one commit's apps/landing/public, read from Git (no checkout, no filter: the blobs).
 * - Three changes, and only these, each recorded per file in the manifest:
 *   1. `comments`: the comments of the page, its scripts and its style sheets go (`stripComments`), so no working note
 *      ships; a licence or copyright comment would stay (`KEPT_COMMENT`; the source has none). Nothing else changes:
 *      a script parses to the same tree of the same tokens (`sameScript`), a style sheet to the same tokens
 *      (`sameStyle`), and the page loses exactly its `<!-- … -->` bytes, so its text and attributes stay byte for byte
 *      (the unit test compares both documents).
 *   2. `addresses`: every address of the site's own files gets the /examples prefix (the generator writes root-absolute
 *      addresses, `/art/...`, and has no base option).
 *   3. index.html gets one link back to the app, `WAY_BACK`, right after its `<main>` line.
 *   `restore` undoes 2 and 3: the result is the source without its comments, byte for byte.
 * - Six files of the landing stay out (`LEFT`): its Pages settings, its 404 page and robots file, the share card (only
 *   an absolute og:image address names it) and the mark the 404 page alone shows.
 * - apps/web/build/examples-manifest.json records the source (ref, commit, folder, the generator's place), every copied
 *   file's SHA-256, and for each changed file its source's SHA-256 and what changed.
 *
 * Run from the repository root (Node 24); both read the source commit from Git, so the clone needs the ref the
 * manifest names (origin/backup/2026-11-10/sh-landing-founder): run `--check` by hand before a ship that touches the
 * examples (the unit test runs it too).
 *   node apps/web/build/examples-copy.mjs --check
 *       rebuilds every file and the manifest in memory from the manifest's commit and compares them with the folder
 *       and the committed manifest; exit 1 on any difference.
 *   node apps/web/build/examples-copy.mjs --write <commit> [<ref name>]
 *       a new copy (after the generator ran again on its branch): the folder must not exist yet. It names every
 *       picture whose bytes changed under the same name: a browser may keep the old one for up to a day (the
 *       release's cache rule, infra/server/app/config.mjs EXAMPLES_ART_CACHE).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../../..');
export const TARGET = 'apps/web/public/examples';
export const MANIFEST = 'apps/web/build/examples-manifest.json';
export const SOURCE_FOLDER = 'apps/landing/public';
export const PREFIX = '/examples';

/** The files whose addresses change (index.html also gets the way back). */
export const PREFIXED = Object.freeze(['follow.js', 'index.html', 'pager.js', 'site.webmanifest', 'styles.css']);
/** The text files whose comments go: the page and any SVG (`<!-- -->`), the scripts and the style sheets. */
export const COMMENTED = /\.(?:html|svg|js|css)$/;
/** A comment that stays: a licence, a copyright or a preserved notice of someone's code. */
export const KEPT_COMMENT = /\blicen[cs]e\b|\bcopyright\b|@preserve|^\/\*!/i;
/** What stays out, by its path in the source folder. */
export const LEFT = Object.freeze(['404.html', '_headers', '_routes.json', 'art/card-1200x630.jpg', 'brand/mark.svg', 'robots.txt']);

/**
 * An address of the site's own files: one of its folders or root files, right after a quote, a backtick, a bracket,
 * a comma or a space (an attribute, a srcset list, a CSS url(), a script's string). `https://squarehole.fun/art/...`
 * never matches (a letter stands before its `/art/`).
 */
export const ADDRESS = /(["'`(, ])\/(art\/|brand\/|fonts\/|follow\/|follow\.css|follow\.js|pager\.js|styles\.css|favicon\.ico|favicon\.svg|apple-touch-icon\.png|site\.webmanifest|icon-192\.png|icon-512\.png|icon-maskable-512\.png)/g;

/** The line of index.html the way back follows. */
export const WAY_BACK_ANCHOR = '    <main class="page">\n';
/**
 * The way back to the app's Create: the page's own pill link style (`elsewhere`, the "Follow @squarehole_" link's), the
 * arrow of its own "Back to" buttons turned left, and the words the site already uses for the way to Create
 * ("Launch a box": the feed's link, the existing-NFTs flow's way back). `/create` opens the first step of Create.
 */
export const WAY_BACK = '      <a class="elsewhere" href="/create"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 12H5M11.5 5.5 5 12l6.5 6.5"/></svg><span>Launch a box</span></a>\n';

export const WHAT = "The explainer (Basics, How it works and the ten examples) as the app serves it at /examples/: the generator's output without its comments, its addresses with the /examples prefix, and one link back to the app in index.html (apps/web/build/examples-copy.mjs).";
export const GENERATOR = 'docs/marketing/explainers/build.mjs at that commit (docs/marketing/explainers/README.md there): it writes the folder; regenerate there, then copy again with examples-copy.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const count = (text, part) => text.split(part).length - 1;
const scriptOf = (text) => ts.createSourceFile('copy.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
/** The parser's own nodes for a JSDoc comment: comment, not code (they go with the comment). */
const isDoc = (node) => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

// --- 1. comments ------------------------------------------------------------------------------------------------------

/** A script's comments, read by the TypeScript parser (strings, templates and regular expressions are no comment). */
function scriptComments(text) {
  const source = scriptOf(text);
  const found = new Map();
  const take = (ranges) => { for (const range of ranges ?? []) found.set(range.pos, range.end); };
  const visit = (node) => {
    // A token's leading comments (on the lines before it) and its trailing ones (after it, on its own line).
    if (node.kind < ts.SyntaxKind.FirstNode || node.kind === ts.SyntaxKind.EndOfFileToken) {
      take(ts.getLeadingCommentRanges(text, node.pos));
      take(ts.getTrailingCommentRanges(text, node.end));
    }
    for (const child of node.getChildren(source)) if (!isDoc(child)) visit(child);
  };
  visit(source);
  take(ts.getLeadingCommentRanges(text, source.endOfFileToken.pos));
  return [...found].map(([start, end]) => ({ start, end }));
}

/** A style sheet's tokens: strings, comments, runs of white space and single characters. */
function styleTokens(text) {
  const tokens = [];
  for (let at = 0; at < text.length;) {
    const char = text[at];
    let end = at + 1;
    let kind = 'char';
    if (char === '"' || char === "'") {
      while (end < text.length && text[end] !== char && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      end = Math.min(text.length, end + 1);
      kind = 'string';
    } else if (text.startsWith('/*', at)) {
      const close = text.indexOf('*/', at + 2);
      if (close < 0) throw new Error('an unclosed comment in a style sheet');
      end = close + 2;
      kind = 'comment';
    } else if (/\s/.test(char)) {
      while (end < text.length && /\s/.test(text[end])) end += 1;
      kind = 'space';
    }
    tokens.push({ kind, start: at, end, text: text.slice(at, end) });
    at = end;
  }
  return tokens;
}

/** The comments of a page, a script or a style sheet, as [start, end) ranges in order. */
export function commentRanges(name, text) {
  if (/\.js$/.test(name)) return scriptComments(text).sort((a, b) => a.start - b.start);
  if (/\.css$/.test(name)) return styleTokens(text).filter((token) => token.kind === 'comment').map(({ start, end }) => ({ start, end }));
  if (/\.(?:html|svg)$/.test(name)) return [...text.matchAll(/<!--[\s\S]*?-->/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  return [];
}

/**
 * Removes a file's comments (all but `KEPT_COMMENT`). A page or an SVG loses exactly the comment's bytes (its text and
 * white space stay as they are). In a script or a style sheet a comment on lines of its own goes with its lines, one
 * at a line's end with the spaces before it, and one between code on the same line becomes what a comment is there:
 * nothing in a style sheet, in a script a line break when it held one (for automatic semicolons), else a space unless
 * one stands beside it already.
 */
export function stripComments(name, source) {
  const ranges = commentRanges(name, source).filter(({ start, end }) => !KEPT_COMMENT.test(source.slice(start, end)));
  const kept = commentRanges(name, source).length - ranges.length;
  let text = source;
  const page = /\.(?:html|svg)$/.test(name);
  for (const { start, end } of [...ranges].reverse()) {
    if (page) {
      text = text.slice(0, start) + text.slice(end);
      continue;
    }
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const newline = text.indexOf('\n', end);
    const lineEnd = newline < 0 ? text.length : newline;
    const before = text.slice(lineStart, start);
    const after = text.slice(end, lineEnd);
    if (!before.trim() && !after.trim()) text = text.slice(0, lineStart) + text.slice(newline < 0 ? text.length : newline + 1);
    else if (!after.trim()) text = text.slice(0, start - (before.length - before.trimEnd().length)) + text.slice(lineEnd);
    else {
      const comment = text.slice(start, end);
      const spaced = /\s$/.test(before) || /^\s/.test(after);
      const instead = /\.css$/.test(name) ? '' : comment.includes('\n') ? '\n' : spaced ? '' : ' ';
      text = text.slice(0, start) + instead + text.slice(end);
    }
  }
  return { text, comments: ranges.length, kept };
}

/** A script's shape: every node's kind, every token's text, in order (the same shape runs the same way). */
export function scriptShape(text) {
  const source = scriptOf(text);
  if (source.parseDiagnostics?.length) throw new Error('a script the parser cannot read');
  const shape = [];
  const visit = (node) => {
    shape.push(node.kind < ts.SyntaxKind.FirstNode ? `${node.kind}:${node.getText(source)}` : String(node.kind));
    for (const child of node.getChildren(source)) if (!isDoc(child)) visit(child);
  };
  visit(source);
  return shape;
}
export const sameScript = (a, b) => isDeepStrictEqual(scriptShape(a), scriptShape(b));

/** A style sheet's tokens without comments, each run of white space as one space (what a browser reads). */
export function styleShape(text) {
  const shape = [];
  for (const token of styleTokens(text)) {
    if (token.kind === 'comment') continue;
    if (token.kind === 'space') { if (shape.at(-1) !== ' ') shape.push(' '); } else shape.push(token.text);
  }
  return shape;
}
export const sameStyle = (a, b) => isDeepStrictEqual(styleShape(a), styleShape(b));

// --- 2. addresses and 3. the way back ------------------------------------------------------------------------------

/** A file (its comments gone) as the app serves it, and how many addresses gained the prefix. */
export function rewrite(name, text) {
  if (text.includes(PREFIX)) throw new Error(`${name}: the source already holds ${PREFIX}; the copy could not be undone`);
  let addresses = 0;
  let out = text.replace(ADDRESS, (_, before, rest) => {
    addresses += 1;
    return `${before}${PREFIX}/${rest}`;
  });
  if (name === 'index.html') {
    if (count(out, WAY_BACK_ANCHOR) !== 1) throw new Error('index.html: the <main> line is not there exactly once');
    out = out.replace(WAY_BACK_ANCHOR, `${WAY_BACK_ANCHOR}${WAY_BACK}`);
  }
  return { text: out, addresses };
}

/** Undoes `rewrite`: the file without its comments again, byte for byte. */
export function restore(name, text) {
  let out = text;
  if (name === 'index.html') {
    if (count(out, WAY_BACK) !== 1) throw new Error('index.html: the way back is not there exactly once');
    out = out.replace(WAY_BACK, '');
  }
  return out.split(`${PREFIX}/`).join('/');
}

/** One source file as the app serves it, and its manifest entry. */
export function transform(name, bytes) {
  if (!COMMENTED.test(name) && !PREFIXED.includes(name)) return { bytes, entry: { sha256: sha256(bytes) } };
  const original = bytes.toString('utf8');
  const entry = {};
  let text = original;
  if (COMMENTED.test(name)) {
    const stripped = stripComments(name, original);
    if (/\.js$/.test(name) && !sameScript(original, stripped.text)) throw new Error(`${name}: without its comments the script would read differently`);
    if (/\.css$/.test(name) && !sameStyle(original, stripped.text)) throw new Error(`${name}: without its comments the style sheet would read differently`);
    text = stripped.text;
    if (stripped.comments) entry.comments = stripped.comments;
    if (stripped.kept) entry.keptComments = stripped.kept;
  }
  const uncommented = text;
  if (PREFIXED.includes(name)) {
    const rewritten = rewrite(name, text);
    text = rewritten.text;
    entry.addresses = rewritten.addresses;
    if (restore(name, text) !== uncommented) throw new Error(`${name}: the addresses do not undo`);
  }
  if (text === original) return { bytes, entry: { sha256: sha256(bytes) } };
  const served = Buffer.from(text, 'utf8');
  return { bytes: served, entry: { sha256: sha256(served), source: sha256(bytes), ...entry } };
}

// --- the copy -------------------------------------------------------------------------------------------------------

/** Every file of a folder, by its path inside it with forward slashes, in code-unit order. */
export function filesUnder(folder, prefix = '') {
  return readdirSync(join(folder, prefix)).flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    return statSync(join(folder, path)).isDirectory() ? filesUnder(folder, path) : [path];
  }).sort();
}

const git = (args, encoding = 'utf8') => execFileSync('git', args, { cwd: ROOT, encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** The source folder at a commit, read from Git's blobs: path -> bytes. */
export function sourceAt(commit) {
  try { git(['cat-file', '-e', `${commit}^{commit}`]); } catch {
    throw new Error(`commit ${commit} is not in this clone: fetch origin/backup/2026-11-10/sh-landing-founder`);
  }
  const listing = git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', SOURCE_FOLDER]);
  const files = new Map();
  for (const entry of listing.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
    if (!match) throw new Error(`unexpected tree entry: ${entry}`);
    if (match[1] !== '100644') throw new Error(`${match[3]}: mode ${match[1]}, a plain file expected`);
    files.set(match[3].slice(SOURCE_FOLDER.length + 1), git(['cat-file', 'blob', match[2]], 'buffer'));
  }
  return files;
}

/** The copy of a source folder: the served files (path -> bytes) and the manifest. */
export function copyOf(source, { ref, commit }) {
  const missing = LEFT.filter((name) => !source.has(name));
  if (missing.length) throw new Error(`the source lacks files this copy leaves out: ${missing.join(', ')}`);
  const files = new Map();
  const entries = {};
  for (const name of [...source.keys()].sort()) {
    if (LEFT.includes(name)) continue;
    if (!/^[A-Za-z0-9_./-]+$/.test(name)) throw new Error(`${name}: a name the app's release refuses`);
    const { bytes, entry } = transform(name, source.get(name));
    files.set(name, bytes);
    entries[name] = entry;
  }
  const absent = PREFIXED.filter((name) => !files.has(name));
  if (absent.length) throw new Error(`the source lacks ${absent.join(', ')}`);
  const manifest = {
    format: 'squarehole.examples/2',
    what: WHAT,
    source: { ref, commit, folder: SOURCE_FOLDER, generator: GENERATOR },
    target: TARGET,
    prefix: PREFIX,
    left: [...LEFT],
    files: entries,
  };
  return { files, manifest };
}

export const manifestText = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

/** The pictures whose bytes changed under the same name from one manifest to the next. */
export const changedPictures = (before, after) => Object.entries(after.files)
  .filter(([name, entry]) => name.startsWith('art/') && before?.files?.[name] && before.files[name].sha256 !== entry.sha256)
  .map(([name]) => name);

/** Differences between the folder (and the committed manifest) and a fresh copy from the manifest's commit. */
export function check(root = ROOT) {
  const committed = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  const { files, manifest } = copyOf(sourceAt(committed.source.commit), committed.source);
  const problems = [];
  const folder = join(root, TARGET);
  const present = filesUnder(folder);
  for (const name of present) if (!files.has(name)) problems.push(`${name}: in the folder, not in the copy`);
  for (const [name, bytes] of files) {
    if (!present.includes(name)) problems.push(`${name}: missing from the folder`);
    else if (sha256(readFileSync(join(folder, name))) !== sha256(bytes)) problems.push(`${name}: differs from the copy`);
  }
  if (!isDeepStrictEqual(committed, manifest)) problems.push(`${MANIFEST}: differs from the copy's manifest`);
  return problems;
}

/** A new copy into an absent folder, with its manifest; the pictures changed under the same name, for a warning. */
export function write(commit, ref, root = ROOT) {
  const folder = join(root, TARGET);
  if (existsSync(folder)) throw new Error(`${TARGET} exists: move it aside first (a copy never mixes two commits)`);
  const previous = existsSync(join(root, MANIFEST)) ? JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')) : null;
  const full = git(['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const { files, manifest } = copyOf(sourceAt(full), { ref, commit: full });
  for (const [name, bytes] of files) {
    const path = join(folder, name);
    if (relative(folder, path).startsWith(`..${sep}`)) throw new Error(`${name}: outside the folder`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { flag: 'wx' });
  }
  writeFileSync(join(root, MANIFEST), manifestText(manifest));
  return { manifest, changed: changedPictures(previous, manifest) };
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const [mode, commit, ref] = process.argv.slice(2);
  try {
    if (mode === '--check' && !commit) {
      const problems = check();
      for (const problem of problems) process.stderr.write(`examples-copy: ${problem}\n`);
      if (problems.length) process.exitCode = 1;
      else process.stdout.write(`examples-copy: ${TARGET} and ${MANIFEST} equal a fresh copy\n`);
    } else if (mode === '--write' && commit) {
      const { manifest, changed } = write(commit, ref ?? commit);
      for (const name of changed) process.stderr.write(`examples-copy: warning: ${name} changed under the same name; a browser may show the old picture for up to a day\n`);
      process.stdout.write(`examples-copy: ${Object.keys(manifest.files).length} files from ${manifest.source.commit} into ${TARGET}\n`);
    } else {
      throw new Error('usage: examples-copy.mjs --check | --write <commit> [<ref name>]');
    }
  } catch (error) {
    process.stderr.write(`examples-copy: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
