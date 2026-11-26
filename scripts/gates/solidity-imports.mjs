import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// Tokenize before looking for imports: comments and strings containing fake imports are not edges.
export function solidityImports(source) {
  const imports = [];
  let statement;
  for (const [token] of source.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\bimport\b|;/g)) {
    if (token.startsWith('//') || token.startsWith('/*')) continue;
    if (token === 'import') statement = [];
    else if (statement && /^['"]/.test(token)) statement.push(token.slice(1, -1));
    else if (statement && token === ';') {
      if (statement.length !== 1) throw new Error('Malformed Solidity import');
      imports.push(statement[0]);
      statement = undefined;
    }
  }
  if (statement) throw new Error('Malformed Solidity import');
  return imports;
}

// Only the remappings arrays are needed, not a general TOML parser. Read default and profile overrides.
export function foundryRemappings(toml) {
  const clean = toml.replace(/"(?:\\.|[^"\\])*"|'[^']*'|#[^\n]*/g, token => token.startsWith('#') ? '' : token);
  const profiles = new Map();
  for (const section of clean.matchAll(/^\s*\[profile\.([\w-]+)\]([^]*?)(?=^\s*\[|$(?![^]))/gm)) {
    const array = /^\s*remappings\s*=\s*\[([^]*?)\]/m.exec(section[2]);
    if (!array) continue;
    profiles.set(section[1], [...array[1].matchAll(/["']([^"']+)["']/g)].map(([, entry]) => {
      const at = entry.indexOf('=');
      if (at < 1) throw new Error(`Invalid remapping: ${entry}`);
      const key = entry.slice(0, at), colon = key.indexOf(':');
      return { context: colon < 0 ? '' : key.slice(0, colon), prefix: key.slice(colon + 1), target: entry.slice(at + 1) };
    }));
  }
  if (!profiles.has('default')) throw new Error('Missing profile.default remappings');
  return profiles;
}

export function resolveImport(from, name, remappings) {
  const path = name.startsWith('.') ? posix.join(posix.dirname(from), name) : name;
  const mapping = remappings.filter(({ context, prefix }) => from.startsWith(context) && path.startsWith(prefix))
    .sort((a, b) => b.context.length - a.context.length || b.prefix.length - a.prefix.length)[0];
  return posix.normalize(mapping ? mapping.target + path.slice(mapping.prefix.length) : path);
}

export function projectSources(root) {
  const sources = new Map();
  function visit(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.sol')) sources.set(path, readFileSync(join(root, path), 'utf8'));
    }
  }
  for (const dir of ['src', 'test', 'script']) visit(dir);
  return sources;
}

export function importGraph(sources, remappings) {
  return new Map([...sources].map(([file, source]) => [file, (Array.isArray(source) ? source : solidityImports(source)).map(name => {
    const path = resolveImport(file, name, remappings);
    // Libraries are terminal edges: this guard works even with uninitialised submodules.
    if (!sources.has(path) && !path.startsWith('lib/')) throw new Error(`${file}: unresolved import ${name} -> ${path}`);
    return path;
  })]));
}

export function importersOf(graph, target) {
  const reverse = new Map();
  for (const [file, imports] of graph) for (const path of imports) {
    if (!reverse.has(path)) reverse.set(path, new Set());
    reverse.get(path).add(file);
  }
  const seen = new Set([target]), pending = [target];
  for (let i = 0; i < pending.length; i++) for (const file of reverse.get(pending[i]) ?? []) {
    if (!seen.has(file)) { seen.add(file); pending.push(file); }
  }
  return [...seen].filter(file => graph.has(file)).sort();
}
