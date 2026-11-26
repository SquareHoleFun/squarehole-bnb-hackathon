/** Offline service-image import closure; does not run an install or a build.
 * It does not see computed imports or files read at run time, apart from the bounded cases below.
 * It is not a substitute for building and starting the images.
 * Never resolves through the checkout's node_modules symlinks. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { inventory } from './reach.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const source = file => /\.[cm]?[jt]sx?$/.test(file);
const literal = node => node && ts.isStringLiteralLike(node);
// All four image preload files have these exact bytes. A changed loader needs a resolution-model review.
const TS_HOOK_SHA256 = '9d384cbce13ad4a31132dcf2afacbf2094e55654f7acec028a77a3b2507dd12d';
const need = (ok, message) => { if (!ok) throw new Error(`image-import-closure: ${message}`); };
const words = text => {
  need(!/[`$]/.test(text), `unresolved command or COPY expression: ${text}`);
  return [...text.matchAll(/"([^"\\]*)"|'([^']*)'|([^\s"']+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
};
const command = text => text.trim().startsWith('[') ? JSON.parse(text) : words(text);

// Compose's relevant subset is deliberately strict. New syntax must be taught here, never silently skipped.
export function composeServices(text) {
  const section = text.split(/^services:\s*$/m)[1]?.split(/^(?:networks|volumes|configs|secrets):/m)[0];
  need(section, 'Compose has no services');
  const blocks = [...section.matchAll(/^ {2}([\w-]+):\s*\n([\s\S]*?)(?=^ {2}[\w-]+:|$(?![\s\S]))/gm)];
  need(blocks.length === [...section.matchAll(/^ {2}\S[^\n]*:/gm)].length, 'unsupported inline or quoted service declaration');
  return blocks.map(([, name, block]) => {
    const field = key => block.match(new RegExp(`^ {4}${key}: (.+)$`, 'm'))?.[1];
    const build = block.match(/^ {4}build:\s*\n((?:^ {6}.*\n|^\s*#.*\n)*)/m)?.[1];
    need(!/^ {4}build: \S/m.test(block), `${name}: unsupported build syntax`);
    const context = build?.match(/^ {6}context: (.+)$/m)?.[1];
    const dockerfile = build?.match(/^ {6}dockerfile: (.+)$/m)?.[1];
    if (/^ {4}build:/m.test(block)) need(context && dockerfile, `${name}: build needs context and dockerfile`);
    const result = { name, image: field('image'), context, dockerfile, workdir: field('working_dir') };
    for (const key of ['command', 'entrypoint']) {
      if (new RegExp(`^ {4}${key}:`, 'm').test(block)) {
        need(field(key) && !/^[|>]/.test(field(key)), `${name}: unsupported ${key} syntax`);
        result[key] = field(key) === 'null' ? undefined : command(field(key));
      }
    }
    const health = block.match(/^ {6}test: (.+)$/m)?.[1];
    need(!/^ {6}test:\s*$/m.test(block), `${name}: unsupported multiline health command`);
    if (health) result.health = command(health);
    return result;
  });
}

export function dockerImage(text, context, files) {
  let image;
  const stages = new Map();
  for (const line of text.replace(/\\\n\s*/g, ' ').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
    const [, op, rest] = /^(\w+)\s+(.*)$/.exec(line) ?? [];
    if (op === 'FROM') {
      const [base, , name] = words(rest);
      const inherited = stages.get(base);
      image = inherited ? { ...inherited, copies: new Map(inherited.copies), directories: new Set(inherited.directories), installs: [...inherited.installs] }
        : { workdir: '/', copies: new Map(), directories: new Set(['/']), installs: [], cmd: [], entrypoint: [], health: [] };
      if (name) stages.set(name, image);
    } else if (op === 'WORKDIR') {
      image.workdir = posix.resolve(image.workdir, rest);
      directoryAt(image.workdir);
    }
    else if (op === 'COPY') {
      const flags = [...rest.matchAll(/(?:^|\s)(--[\w-]+=[^\s]+)/g)].map(m => m[1]);
      need(flags.every(f => /^--(?:from|chown|chmod)=/.test(f)), `unsupported COPY flags: ${line}`);
      const parts = command(rest.replace(/(?:^|\s)--[\w-]+=[^\s]+/g, '').trim());
      const destination = parts.pop();
      const target = posix.resolve(image.workdir, destination);
      need(parts.length === 1 || destination.endsWith('/'), `multiple COPY sources need a directory destination: ${line}`);
      const from = flags.find(f => f.startsWith('--from='))?.slice(7);
      // Generated native binaries (Caddy) are outside the JS graph. Stage source copies remain modelled.
      const inputs = from ? [...(stages.get(from)?.copies.keys() ?? [])] : files;
      for (const input of parts) {
        need(!/[*?[$]/.test(input), `unsupported COPY source: ${input}`);
        const path = from ? posix.resolve('/', input) : posix.normalize(posix.join(context, input)).replace(/\/$/, '');
        const directory = path === '.' || inputs.some(file => file.startsWith(`${path}/`));
        const matches = inputs.filter(file => path === '.' || file === path || file.startsWith(`${path}/`));
        need(from || matches.length, `COPY source absent: ${path}`);
        const intoDirectory = directory || destination.endsWith('/') || image.directories.has(target);
        if (intoDirectory) directoryAt(target);
        for (const file of matches) {
          const suffix = directory ? posix.relative(path, file) : (intoDirectory ? posix.basename(file) : '');
          const output = posix.resolve(target, suffix);
          need(!image.directories.has(output), `file/directory conflict at ${output}`);
          directoryAt(posix.dirname(output));
          image.copies.set(output, from ? stages.get(from).copies.get(file) : file);
        }
      }
    } else if (op === 'RUN' && /\bpnpm\b.*\binstall\b/.test(rest)) {
      need(/^pnpm install /.test(rest), `unsupported install command: ${line}`);
      const [install, ...tail] = rest.split(/\s*&&\s*/);
      need(tail.length === 0 || (tail.length === 1 && tail[0] === 'pnpm store prune'), `unsupported install command: ${line}`);
      image.installs.push({ args: words(install).slice(2), workdir: image.workdir, copies: new Map(image.copies) });
    } else if (op === 'CMD') image.cmd = command(rest);
    else if (op === 'ENTRYPOINT') image.entrypoint = command(rest);
    else if (op === 'HEALTHCHECK' && rest !== 'NONE') {
      const check = rest.match(/\bCMD\s+(.*)$/)?.[1];
      need(check, `unsupported HEALTHCHECK: ${line}`);
      image.health = command(check);
    }
  }
  need(image, 'Dockerfile has no FROM');
  return image;

  function directoryAt(path) {
    need(!image.copies.has(path), `file/directory conflict at ${path}`);
    if (image.directories.has(path)) return;
    directoryAt(posix.dirname(path));
    image.directories.add(path);
  }
}

// Only the committed pnpm importer form is supported. Reject new forms instead of guessing YAML semantics.
function lockImporters(text) {
  const body = text.split(/^importers:\s*$/m)[1]?.split(/^\S/m)[0];
  need(body, 'lockfile has no importers');
  const scalar = value => {
    if (value.startsWith('"')) return JSON.parse(value);
    if (/^'[^']*(?:''[^']*)*'$/.test(value)) return value.slice(1, -1).replaceAll("''", "'");
    need(value && !/[\s{}[\]&#|>]/.test(value), `unsupported lockfile scalar: ${value}`);
    return value;
  };
  const importers = new Map();
  let importer, group, dependency;
  for (const line of body.split('\n').filter(line => line.trim())) {
    let match;
    if ((match = /^ {2}(\S.*):(?: \{\})?$/.exec(line))) {
      const key = scalar(match[1]);
      need(!importers.has(key), `duplicate lockfile importer: ${key}`);
      importer = {}; group = undefined; dependency = undefined;
      importers.set(key, importer);
    } else if ((match = /^ {4}(dependencies|devDependencies|optionalDependencies):(?: \{\})?$/.exec(line)) && importer) {
      need(!importer[match[1]], `duplicate lockfile group: ${line}`);
      group = importer[match[1]] = {}; dependency = undefined;
    } else if ((match = /^ {6}(\S.*):$/.exec(line)) && group) {
      const key = scalar(match[1]);
      need(!group[key], `duplicate lockfile dependency: ${key}`);
      dependency = group[key] = {};
    } else if ((match = /^ {8}(specifier|version): (.+)$/.exec(line)) && dependency) {
      need(!dependency[match[1]], `duplicate lockfile value: ${line}`);
      dependency[match[1]] = scalar(match[2]);
    } else need(false, `unsupported lockfile importer syntax: ${line}`);
  }
  return importers;
}

function installedManifests(image, read) {
  const installed = new Map();
  for (const install of image.installs) {
    const lockPath = install.copies.get(posix.join(install.workdir, 'pnpm-lock.yaml'));
    need(lockPath, 'lockfile must be copied before pnpm install');
    const importers = lockImporters(read(lockPath));
    const manifests = new Map([...install.copies].filter(([path]) => path.endsWith('/package.json'))
      .map(([path, file]) => [path, JSON.parse(read(file))]));
    need(manifests.has(posix.join(install.workdir, 'package.json')), 'root manifest must be copied before pnpm install');
    for (const [path, pkg] of manifests) {
      const key = posix.relative(install.workdir, dirname(path)) || '.';
      const locked = importers.get(key);
      need(locked, `lockfile importer missing for ${key}`);
      for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const declared = pkg[group] ?? {}, pinned = locked[group] ?? {};
        for (const name of new Set([...Object.keys(declared), ...Object.keys(pinned)])) {
          need(declared[name] !== undefined && declared[name] === pinned[name]?.specifier,
            `lockfile specifier mismatch for ${key} ${group} ${name}`);
        }
      }
    }
    const byName = new Map([...manifests].map(([path, pkg]) => [pkg.name, path]));
    const filters = [];
    const args = install.args;
    need(args.includes('--frozen-lockfile') && args.includes('--prod'), 'install requires --frozen-lockfile --prod');
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--filter') {
        const match = /^(@?[\w/-]+)(\.\.\.)?$/.exec(args[++i] ?? '');
        need(match, 'unsupported pnpm install filter');
        filters.push({ name: match[1], closure: Boolean(match[2]) });
      } else need(['--frozen-lockfile', '--prod'].includes(args[i]), `unsupported pnpm install argument: ${args[i]}`);
    }
    need(filters.length, 'pnpm install needs explicit filters');
    const selected = new Set();
    function select(name, closure) {
      const path = byName.get(name);
      need(path, `${name}: manifest must be copied before pnpm install`);
      installed.set(path, manifests.get(path));
      if (!closure || selected.has(path)) return;
      selected.add(path);
      for (const [dependency, specifier] of Object.entries(manifests.get(path).dependencies ?? {})) {
        if (specifier.startsWith('workspace:')) select(dependency, true);
      }
    }
    for (const filter of filters) select(filter.name, filter.closure);
  }
  return installed;
}

/** Execute only the shell's command selection. The docker function records argv and returns success.
 * No Docker executable, Compose, environment files, settings, service code or network is used. */
export function smokeCommands(root = ROOT) {
  const script = `docker() { printf '%s\\0' "$@" '' >&3; printf 'offline health record\\n'; }; export -f docker; source "$1" all`;
  // Selection uses shell builtins only. An added external command must fail, never reach a real Docker binary.
  const run = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', script, 'image-import-closure', resolve(root, 'infra/server/smoke-services.sh')],
    { cwd: root, env: { PATH: '/nonexistent-image-import-closure' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 5000 });
  need(run.status === 0, `cannot enumerate smoke commands: ${run.stderr ?? run.error}`);
  return run.output[3].split('\0\0').filter(Boolean).map(row => {
    const args = row.split('\0');
    need(args.slice(0, 3).join(' ') === 'compose exec -T', `unknown smoke invocation: ${args.join(' ')}`);
    return { service: args[3], args: args.slice(4) };
  });
}

export function importsOf(file, text) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [], blind = [];
  const fsAliases = new Set();
  for (const node of ast.statements) {
    if (ts.isImportDeclaration(node) && literal(node.moduleSpecifier) && /^(?:node:)?fs(?:\/promises)?$/.test(node.moduleSpecifier.text)) {
      for (const binding of node.importClause?.namedBindings?.elements ?? []) {
        if (/^(?:read|open|access|exists|stat|lstat|realpath|createReadStream)/.test((binding.propertyName ?? binding.name).text)) fsAliases.add(binding.name.text);
      }
    }
  }
  const add = (node, name, kind) => imports.push({ name, kind, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
  const note = (node, kind) => blind.push({ file, kind, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, expression: node.getText(ast).replace(/\s+/g, ' ') });
  function visit(node) {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && literal(node.argument.literal)) add(node, node.argument.literal.text, 'type');
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings ?? node.exportClause;
      const typeOnly = clause?.isTypeOnly || node.isTypeOnly || (!clause?.name && bindings?.elements?.length && bindings.elements.every(e => e.isTypeOnly));
      if (literal(node.moduleSpecifier)) add(node, node.moduleSpecifier.text, typeOnly ? 'type' : 'static');
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === 'require') {
        if (literal(node.arguments[0])) add(node, node.arguments[0].text, name === 'require' ? 'static' : 'dynamic');
        else note(node, 'computed import');
      }
      if (fsAliases.has(name) || /(?:^|\.)(?:readFileSync|readFile|read|readdirSync|readdir|createReadStream|openSync|open|accessSync|access|existsSync|statSync|stat|lstatSync|lstat|realpathSync|realpath)$/.test(name)) note(node, 'runtime file access');
      if (name === 'createRequire') note(node, 'createRequire anchor');
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { imports, blind };
}

function commandEntries(args, workdir) {
  if (['CMD', 'CMD-SHELL'].includes(args[0])) args = args.slice(1);
  if (args[0] !== 'node') {
    need(!args.some(arg => /\.[cm]?[jt]s\b/.test(arg)), `unsupported source command: ${args.join(' ')}`);
    return [];
  }
  const entries = [];
  let hook = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-e' || arg === '--eval') {
      entries.push({ path: posix.join(workdir, '__command__.mjs'), inline: args[i + 1], hook });
      break;
    }
    if (arg === '--import') { entries.push({ path: posix.resolve(workdir, args[++i]), hook: false, preload: true }); hook = true; continue; }
    need(!arg.startsWith('--import=') && !['-r', '--require', '--loader'].includes(arg), `unsupported preload: ${arg}`);
    if (arg.startsWith('-')) continue;
    entries.push({ path: posix.resolve(workdir, arg), hook, args: args.slice(i + 1) });
    break;
  }
  return entries;
}

export function auditImages({ root = ROOT, files = inventory(root), texts = new Map(), smoke = smokeCommands(root) } = {}) {
  const read = file => texts.get(file) ?? readFileSync(resolve(root, file), 'utf8');
  const services = composeServices(read('infra/server/compose.yaml'));
  const workspace = new Map(files.filter(f => /^(?:packages|apps)\/[^/]+\/package.json$/.test(f)).map(file => {
    const pkg = JSON.parse(read(file)); return [pkg.name, { ...pkg, dir: dirname(file) }];
  }));
  const cache = new Map();
  const syntax = file => { if (!cache.has(file)) cache.set(file, importsOf(file, read(file))); return cache.get(file); };
  const results = [];
  for (const service of services.filter(s => s.dockerfile)) {
    const context = posix.normalize(posix.join('infra/server', service.context));
    const dockerfile = posix.join(context, service.dockerfile);
    for (const ignore of [posix.join(context, '.dockerignore'), `${dockerfile}.dockerignore`]) {
      need(!files.includes(ignore), `teach the gate Docker ignore rules before using ${ignore}`);
    }
    const image = dockerImage(read(dockerfile), context, files);
    const installed = installedManifests(image, read);
    const users = services.filter(s => s.image === service.image);
    const imageRoot = [...image.copies].find(([, file]) => file === 'package.json')?.[0];
    const sourceAt = path => image.copies.get(path) ?? (imageRoot && files.includes(posix.relative(dirname(imageRoot), path)) ? posix.relative(dirname(imageRoot), path) : undefined);
    const result = { dockerfile, services: users.map(s => s.name), entries: [], missing: [], blind: [], reached: new Set() };
    const commands = [ { label: 'image CMD', args: [...image.entrypoint, ...image.cmd], workdir: image.workdir },
      { label: 'image health', args: image.health, workdir: image.workdir } ];
    if (service.name === 'cards') {
      // spawn() uses a URL-derived entry; include both that child and the offline image pixel check explicitly.
      for (const entry of ['src/webp-child.ts', 'scripts/check-webp.ts', 'src/webp-fixtures/memory-check.mjs']) commands.push({ label: 'cards WebP',
        args: ['node', '--import', './scripts/register-ts.mjs', entry], workdir: image.workdir });
    }
    for (const user of users) {
      commands.push({ label: `${user.name} command`, args: [...(user.entrypoint ?? image.entrypoint), ...(user.command ?? (user.entrypoint ? [] : image.cmd))], workdir: user.workdir ?? image.workdir });
      if (user.health) commands.push({ label: `${user.name} health`, args: user.health, workdir: user.workdir ?? image.workdir });
      for (const check of smoke.filter(s => s.service === user.name)) commands.push({ label: `${user.name} smoke`, args: check.args, workdir: user.workdir ?? image.workdir });
    }
    // Offline operator commands are image entry points too; they are absent from Compose's service commands.
    if (users.some(user => user.name === 'alpha-sender')) for (const file of ['release-float.mjs', 'forget-tester.mjs', 'forget-image-check.mjs']) {
      commands.push({ label: 'alpha operator', args: ['node', `infra/server/services/alpha/${file}`, '--help'], workdir: image.workdir });
    }
    if (users.some(user => user.name === 'alpha-api')) for (const file of ['purge.mjs', 'backup.mjs']) {
      commands.push({ label: 'alpha operator', args: ['node', `infra/server/services/alpha/${file}`], workdir: image.workdir });
    }
    // Package links exist only for production workspace dependencies of copied manifests. Never use host resolution.
    function locate(from, name, hook) {
      if (name.startsWith('.') || name.startsWith('/')) {
        const path = posix.resolve(dirname(from), name);
        const candidates = [path, ...(hook && !/\.[cm]?[jt]sx?$|\.json$/.test(name) ? [`${path}.ts`, `${path}/index.ts`] : [])];
        return candidates.find(p => image.copies.has(p)) ?? candidates.find(p => sourceAt(p)) ?? candidates.at(hook ? 1 : 0) ?? path;
      }
      const key = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
      const pkg = workspace.get(key);
      need(pkg || !key.startsWith('@squarehole/'), `${from}: unknown workspace package ${key}`);
      if (!pkg) return null; // Node builtins and locked registry dependencies are outside repository closure.
      let directory = dirname(from), owner;
      while (directory !== '/') {
        const manifest = image.copies.get(`${directory}/package.json`);
        if (manifest) { owner = JSON.parse(read(manifest)); break; }
        directory = dirname(directory);
      }
      need(owner?.name === key || owner?.dependencies?.[key]?.startsWith('workspace:'), `${from}: undeclared production workspace import ${name}`);
      const installedOwner = installed.get(`${directory}/package.json`);
      need(installedOwner, `${from}: importing package not selected by pnpm install`);
      need(installedOwner.name === key || installedOwner.dependencies?.[key]?.startsWith('workspace:'), `${from}: undeclared production workspace import at install: ${name}`);
      const manifests = [...installed].filter(([, manifest]) => manifest.name === key);
      need(manifests.length, `${key}: manifest must be copied before and selected by pnpm install`);
      const subpath = name === key ? '.' : `.${name.slice(key.length)}`;
      let target = typeof pkg.exports === 'string' ? (subpath === '.' ? pkg.exports : undefined) : pkg.exports?.[subpath];
      if (target && typeof target === 'object') target = target.node ?? target.import ?? target.default;
      need(typeof target === 'string', `${name}: unsupported or absent runtime export`);
      return posix.resolve(dirname(manifests[0][0]), target);
    }
    for (const cmd of commands) for (const entry of commandEntries(cmd.args, cmd.workdir)) {
      const label = `${cmd.label}: ${cmd.args.join(' ')}`;
      if (entry.preload && sourceAt(entry.path)) need(createHash('sha256').update(read(sourceAt(entry.path))).digest('hex') === TS_HOOK_SHA256,
        `${label}: unrecognised preload; review its resolution semantics`);
      result.entries.push(label);
      const seen = new Set();
      function walk(path, from, line, later, hook, inline) {
        const file = sourceAt(path);
        if (!image.copies.has(path) && inline === undefined) {
          result.missing.push({ entry: label, importer: from, line, path, when: later ? `deferred via ${later}` : 'startup' });
          if (!file) return;
        }
        if (seen.has(path)) return;
        seen.add(path);
        if (file) result.reached.add(file);
        if (file && !source(file)) return;
        const parsed = inline === undefined ? syntax(file) : importsOf(path, inline);
        result.blind.push(...parsed.blind);
        // run.mjs has a bounded dispatch selected by argv, after the enabled/health checks.
        const dispatch = parsed.blind.find(b => b.kind === 'computed import' && b.expression === 'import(`./${service}.mjs`)');
        if (dispatch && file === 'infra/server/services/run.mjs') {
          need(entry.args?.[0] && /^[a-z-]+$/.test(entry.args[0]), `${label}: runner service argument required`);
          if (!entry.args.includes('--healthcheck') && !entry.args.includes('--dry-run')) walk(posix.resolve(dirname(path), `${entry.args[0]}.mjs`), file, dispatch.line, `${file}:${dispatch.line} (enabled ${entry.args[0]} driver)`, hook);
        }
        // Literal calls to the repository's artwork loader have finite, source-visible targets.
        const body = inline ?? read(file);
        if (parsed.imports.some(i => i.name.endsWith('/load-ts.mjs'))) {
          for (const match of body.matchAll(/\bimportArtwork\(['"]([^'"]+)['"]\)/g)) {
            walk(`/app/packages/artwork/src/${match[1]}`, file, body.slice(0, match.index).split('\n').length, later, true);
          }
        }
        for (const edge of parsed.imports.filter(i => i.kind !== 'type')) {
          const target = locate(path, edge.name, hook);
          if (target) walk(target, file ?? path, edge.line, later || (edge.kind === 'dynamic' ? `${file}:${edge.line}` : ''), hook);
        }
      }
      walk(entry.path, '<command>', 0, '', entry.hook, entry.inline);
    }
    result.missing = [...new Map(result.missing.map(m => [JSON.stringify(m), m])).values()];
    result.blind = [...new Map(result.blind.map(b => [JSON.stringify(b), b])).values()].sort((a,b) => a.file.localeCompare(b.file) || a.line-b.line);
    results.push(result);
  }
  const escapes = [];
  for (const file of files.filter(f => /^packages\/[^/]+\/src\//.test(f) && source(f))) {
    const owner = file.split('/').slice(0, 2).join('/');
    for (const edge of syntax(file).imports) if (edge.name.startsWith('.') && !posix.resolve('/', dirname(file), edge.name).startsWith(`/${owner}/`)) {
      escapes.push({ file, ...edge, images: results.filter(r => r.reached.has(file) && edge.kind !== 'type').map(r => r.dockerfile) });
    }
  }
  return { results, escapes };
}

export function reportAudit({ results, escapes }) {
  const out = ['Image import closure (repository modules; no Docker or host node_modules resolution).'];
  for (const r of results) {
    out.push(`\n${r.dockerfile} [${r.services.join(', ')}]: ${r.missing.length ? 'FAIL' : 'PASS'}; ${new Set(r.entries).size} entry commands; ${r.reached.size} files`);
    for (const m of r.missing) out.push(`  entry ${m.entry}\n    ${m.importer}:${m.line} -> ${m.path} [${m.when}]`);
    out.push('  Blind sites (computed imports and runtime file access are not proven; bounded runner/artwork calls above are expanded):');
    for (const b of r.blind) out.push(`    ${b.file}:${b.line} ${b.kind}: ${b.expression}`);
  }
  out.push('\nRelative imports leaving packages/*/src (type-only/test edges included; images reflect runtime reach):');
  for (const e of escapes) out.push(`  ${e.file}:${e.line} ${e.kind} ${e.name} => ${e.images.join(', ') || 'no service image'}`);
  out.push('\nLimits: no general evaluation of computed imports, runtime reads, subprocesses or arbitrary loader hooks. Registry dependencies/native binaries and RUN-generated files are not traversed. Unknown Docker/Compose forms fail where parsed; shell command wrappers need explicit support. File-access sites are a syntax inventory, not a proof of every I/O wrapper.');
  return `${out.join('\n')}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const audit = auditImages();
  process.stdout.write(reportAudit(audit));
  process.exitCode = audit.results.some(r => r.missing.length) ? 1 : 0;
}
