// The server builds its images from the stack archive that infra/server/ship.sh packs, not from a checkout. This gate
// compares the lists that must agree: the archive's path list in ship.sh on one side; on the other, every file or
// folder the Compose images copy from the build context, every repository path Compose mounts or names as an env
// file, and every path of the release that install.sh and ship.sh's own outside check read. On 15 November 2026 stack
// ship 20 stopped in the server's image build because the card image copied three paths the archive did not carry;
// the local image check builds from the checkout and could not see it.
// The Dockerfile reader refuses with an error whatever it cannot judge. The Compose and script readers collect the
// path forms their functions name; a form they do not know is not seen, so the tests pin what they find in the
// real files.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { composeServices } from './image-import-closure.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVER = 'infra/server';
// The installer writes this file into the unpacked release itself (the release's commit for Compose).
const CREATED_BY_INSTALLER = new Set(['infra/server/.env']);
const INSTRUCTIONS = new Set(['FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME',
  'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL']);
const COPY_FLAGS = /^--(?:from|chown|chmod|exclude)=|^--(?:link|parents)(?:=(?:true|false))?$/;
const MOUNTS_WITHOUT_CONTEXT = new Set(['cache', 'tmpfs', 'secret', 'ssh']);

/** The paths of ship.sh's `paths=( ... )` list, in order. A comment, a quote or any shell syntax inside it is refused. */
export function archivePaths(shipText) {
  const blocks = [...shipText.matchAll(/^paths=\(\n([\s\S]*?)^\)$/gm)];
  const assignments = shipText.match(/^[ \t]*paths\s*\+?=/gm) ?? [];
  if (blocks.length !== 1 || assignments.length !== 1) {
    throw new Error(`ship.sh must hold exactly one paths=( ... ) list and no other assignment to paths, found ${blocks.length} and ${assignments.length}`);
  }
  const paths = blocks[0][1].split(/\s+/).filter(Boolean);
  for (const path of paths) {
    if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/') || path.endsWith('/') || path.split('/').some(part => part === '..' || part === '.' || part === '')) {
      throw new Error(`unsupported archive path: ${path}`);
    }
  }
  if (new Set(paths).size !== paths.length) throw new Error('ship.sh lists an archive path twice');
  return paths;
}

/** A Dockerfile's instructions as Docker reads them: comment lines dropped first, then continued lines joined. */
export function logicalLines(dockerText) {
  if (/^\s*#\s*escape\s*=/mi.test(dockerText)) throw new Error('a Dockerfile with its own escape character is not supported by this gate');
  const lines = [];
  let open = '';
  for (const physical of dockerText.split(/\r?\n/)) {
    if (/^\s*#/.test(physical)) continue;
    if (!physical.trim()) continue;
    if (/\\\\[ \t]*$/.test(physical)) throw new Error(`a line ending in two backslashes is not supported by this gate: ${physical.trim()}`);
    const continued = physical.match(/^(.*)\\[ \t]*$/);
    if (continued) { open += `${continued[1]} `; continue; }
    lines.push(`${open}${physical}`.trim());
    open = '';
  }
  if (open.trim()) throw new Error(`a continued line ends the Dockerfile: ${open.trim()}`);
  return lines;
}

/** Every COPY source a Dockerfile takes from its build context (a copy from an earlier stage has no source here). */
export function contextSources(dockerText) {
  const sources = [];
  const stages = [];
  for (const line of logicalLines(dockerText)) {
    const [word, ...rest] = line.split(/\s+/);
    const op = word.toUpperCase();
    if (!INSTRUCTIONS.has(op)) throw new Error(`not a Dockerfile instruction this gate knows (a heredoc body?): ${line}`);
    if (op === 'ONBUILD') throw new Error(`ONBUILD is not supported by this gate: ${line}`);
    if (op === 'ADD') throw new Error(`ADD is not supported by this gate: ${line}`);
    if (op === 'FROM') {
      const as = rest.findIndex(w => w.toUpperCase() === 'AS');
      stages.push(as >= 0 && rest[as + 1] ? rest[as + 1].toLowerCase() : '');
      continue;
    }
    if (op === 'RUN') {
      for (const flag of rest.filter(w => w.startsWith('--mount'))) {
        const type = flag.match(/(?:^--mount=|,)type=([a-z]+)/)?.[1] ?? 'bind';
        if (!MOUNTS_WITHOUT_CONTEXT.has(type)) throw new Error(`a RUN mount that can read the build context is not supported by this gate: ${line}`);
      }
      continue;
    }
    if (op !== 'COPY') continue;
    if (rest[0]?.startsWith('[') || rest.some(w => w.startsWith('<<'))) throw new Error(`the JSON form and the heredoc form of COPY are not supported by this gate: ${line}`);
    const firstPath = rest.findIndex(w => !w.startsWith('--'));
    const flags = firstPath < 0 ? rest : rest.slice(0, firstPath);
    const parts = firstPath < 0 ? [] : rest.slice(firstPath);
    const late = parts.find(w => w.startsWith('--'));
    if (late) throw new Error(`a COPY word that looks like a flag after the first path is not supported by this gate: ${late}`);
    const unknown = flags.find(flag => !COPY_FLAGS.test(flag));
    if (unknown) throw new Error(`a COPY flag this gate does not know: ${unknown}`);
    const from = flags.find(flag => flag.startsWith('--from='))?.slice('--from='.length);
    if (from !== undefined) {
      const earlier = stages.slice(0, -1);
      const isStage = (/^\d+$/.test(from) && Number(from) < earlier.length) || (from !== '' && earlier.includes(from.toLowerCase()));
      if (!isStage) throw new Error(`COPY --from=${from} names no earlier stage; an image or another build context is not supported by this gate`);
      continue;
    }
    if (parts.length < 2) throw new Error(`COPY needs a source and a destination: ${line}`);
    for (const source of parts.slice(0, -1)) {
      if (!/^[A-Za-z0-9._/-]+$/.test(source)) throw new Error(`a COPY source with a pattern, a variable or a quote is not supported by this gate: ${source}`);
      if (source.split('/').includes('..')) throw new Error(`a COPY source that leaves its folder is not supported by this gate: ${source}`);
      sources.push(source);
    }
  }
  return sources;
}

/** Repository paths Compose reads on the server beside the images: relative env files and relative bind sources. */
export function composeRepositoryPaths(composeText) {
  const found = [];
  const unquote = value => value.replace(/^(["'])(.*)\1$/, '$2');
  let envFile = -1;
  for (const raw of composeText.split(/\r?\n/)) {
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // A YAML list may sit at the same indent as its key: the block ends at a shallower line, or at a key of the same indent.
    if (envFile >= 0 && (indent < envFile || (indent === envFile && !line.startsWith('- ')))) envFile = -1;
    const single = line.match(/^env_file:\s*(\S.*)$/);
    if (single) { found.push({ path: unquote(single[1].trim()), why: 'an env file Compose reads' }); continue; }
    if (line === 'env_file:') { envFile = indent; continue; }
    if (envFile >= 0) {
      const entry = line.match(/^- (?:path:\s*)?(\S+)\s*$/);
      if (entry) found.push({ path: unquote(entry[1]), why: 'an env file Compose reads' });
      continue;
    }
    const item = line.startsWith('- ') ? unquote(line.slice(2).trim()) : '';
    const short = item.match(/^(\.{1,2}(?:\/[^:\s]*)?):/);
    if (short) found.push({ path: short[1], why: 'a folder or file Compose mounts' });
    const long = line.match(/^source:\s*(\S+)\s*$/);
    if (long && /^\.{1,2}(?:\/|$)/.test(unquote(long[1]))) found.push({ path: unquote(long[1]), why: 'a folder or file Compose mounts' });
    const file = line.match(/^(?:- )?file:\s*(\S+)\s*$/);
    if (file) found.push({ path: unquote(file[1]), why: 'a file Compose reads' });
  }
  return found
    .filter(entry => !entry.path.startsWith('/'))
    .map(entry => {
      if (!/^[A-Za-z0-9._/-]+$/.test(entry.path)) throw new Error(`a Compose path with a variable or a quote is not supported by this gate: ${entry.path}`);
      return { ...entry, path: posix.normalize(posix.join(SERVER, entry.path)).replace(/\/$/, '') };
    });
}

/** Paths of the unpacked release that install.sh names (`$release/...`), and that ship.sh takes out of its own archive. */
export function scriptReleasePaths(installText, shipText) {
  const found = [];
  for (const match of installText.matchAll(/\$\{?release\}?"?\/([A-Za-z0-9._/-]*)/g)) {
    // A brace list, a variable or a pattern right after the match names several files: the whole folder is needed.
    const open = '{$*[?'.includes(installText[match.index + match[0].length] ?? ' ');
    const path = (open ? match[1].slice(0, match[1].lastIndexOf('/') + 1) : match[1]).replace(/\/$/, '');
    if (!path) throw new Error(`install.sh names the root of the release with a pattern; this gate cannot judge it near: ${installText.slice(match.index, match.index + 50).split('\n')[0]}`);
    if (!CREATED_BY_INSTALLER.has(path)) found.push({ path, why: 'install.sh reads it from the release' });
  }
  for (const match of shipText.matchAll(/tar -xzf "\$tarball" -C "\$work" ([^\n]+)/g)) {
    for (const path of match[1].trim().split(/\s+/)) found.push({ path, why: "ship.sh's own outside check takes it from the archive" });
  }
  return found;
}

/** True when the archive carries `path` whole: it is a listed path or lies under a listed folder. */
export function carried(paths, path) {
  return paths.some(listed => path === listed || path.startsWith(`${listed}/`));
}

/**
 * Every repository path the server needs that the archive does not carry whole, plus every such path that git does
 * not track (the archive is made with `git archive`, so an untracked file never reaches the server).
 */
export function archiveGaps({ root = ROOT, read = file => readFileSync(resolve(root, file), 'utf8'), repo = repository(root) } = {}) {
  const ignoring = repo.attributeFiles().filter(file => /\bexport-(?:ignore|subst)\b/.test(read(file)));
  if (ignoring.length) throw new Error(`teach this gate the export attributes before using them: ${ignoring.join(', ')}`);
  const shipText = read(`${SERVER}/ship.sh`);
  const composeText = read(`${SERVER}/compose.yaml`);
  const paths = archivePaths(shipText);
  if (/^\s+additional_contexts:/m.test(composeText)) throw new Error('Compose additional_contexts are not supported by this gate');
  const needs = [];
  const seen = new Set();
  for (const service of composeServices(composeText).filter(s => s.dockerfile)) {
    const context = posix.normalize(posix.join(SERVER, service.context));
    const dockerfile = posix.normalize(posix.join(context, service.dockerfile));
    if (seen.has(`${context}\n${dockerfile}`)) continue;
    seen.add(`${context}\n${dockerfile}`);
    needs.push({ path: dockerfile, who: dockerfile, why: 'a Dockerfile Compose builds' });
    for (const source of contextSources(read(dockerfile))) {
      needs.push({ path: posix.normalize(posix.join(context, source)).replace(/\/$/, ''), who: dockerfile, why: 'copied into the image' });
    }
  }
  // install.sh and the smoke scripts work inside the unpacked infra/server with relative names: the folder goes whole
  // (listed itself, or under a listed parent).
  needs.push({ path: SERVER, who: `${SERVER}/install.sh`, why: 'the installer works inside this folder' });
  for (const entry of composeRepositoryPaths(composeText)) needs.push({ ...entry, who: `${SERVER}/compose.yaml` });
  for (const entry of scriptReleasePaths(read(`${SERVER}/install.sh`), shipText)) needs.push({ ...entry, who: entry.why.startsWith('ship.sh') ? `${SERVER}/ship.sh` : `${SERVER}/install.sh` });
  const gaps = [];
  const judged = new Set();
  for (const { path, who, why } of needs) {
    if (path === '.' || path === '' || path.startsWith('..')) throw new Error(`${who}: a path outside the repository, or the whole repository, is not supported by this gate: ${path}`);
    if (judged.has(`${who}\n${path}`)) continue;
    judged.add(`${who}\n${path}`);
    if (!carried(paths, path)) gaps.push({ who, path, why: `${why}; not in the archive list of ${SERVER}/ship.sh` });
    else if (!repo.tracked(path)) gaps.push({ who, path, why: `${why}; not tracked in git, so git archive leaves it out` });
  }
  return gaps;
}

/** What git tracks in a checkout: a path is tracked when it is a tracked file or holds one. */
export function repository(root = ROOT) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
  const set = new Set(files);
  return {
    tracked: path => set.has(path) || files.some(file => file.startsWith(`${path}/`)),
    attributeFiles: () => files.filter(file => file === '.gitattributes' || file.endsWith('/.gitattributes')),
  };
}

export function reportGaps(gaps) {
  if (!gaps.length) return 'Every path the server needs from the repository is in the stack archive.';
  return ['The server works from the stack archive. These paths would be missing there:',
    ...gaps.map(gap => `  ${gap.path}  (${gap.who}: ${gap.why})`)].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const gaps = archiveGaps();
  process.stdout.write(`${reportGaps(gaps)}\n`);
  process.exit(gaps.length ? 1 : 0);
}
