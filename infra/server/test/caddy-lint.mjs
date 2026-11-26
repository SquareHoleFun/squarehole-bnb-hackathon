// A lint for one Caddyfile trap (SH-ALPHA-LOCK-REDIRECT). Caddy reads a directive's first argument as its request
// matcher when that argument is `*`, starts with `/` (a path matcher) or starts with `@` (a named matcher). So the page
// lock's `redir /join 303` meant "for the path /join only, redirect to the location `303`", and every other app path
// fell through to the file server; `redir * /join 303` is what was meant. `caddy validate` accepts both lines.
//
// For the directives whose argument after the optional matcher is a location (redir, rewrite, root), this lint finds
// that location and refuses one that is missing, a bare status code, or otherwise not a path or a URL. The argument
// order follows Caddy 2.11's parsers (pinned against `caddy adapt` in docs/evidence/SH-ALPHA-LOCK-REDIRECT.md):
// redir always tries a matcher first; rewrite and root with a single argument read it as the location.
//
// Only directive positions count: site blocks, snippets, and the blocks of route, handle, handle_path, handle_errors
// and a handle_response inside a directive's block. Matcher definitions, global options and other directives' blocks
// hold subdirectives (reverse_proxy's own `rewrite`, a `file` matcher's `root` and `try_files`), which are skipped.
// Imports are not followed: each file is linted on its own (the app's generated site files by their own test).

const LOCATION_DIRECTIVES = new Set(['redir', 'rewrite', 'root']);
const DIRECTIVE_BLOCKS = new Set(['route', 'handle', 'handle_path', 'handle_errors']);

export const isMatcherToken = (text) => text === '*' || text.startsWith('/') || text.startsWith('@');
export const isLocation = (text) => /^(\/|\?|\{|\.{1,2}\/)/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text);

/** Caddyfile tokens split as Caddy's lexer splits them: { text, quoted, line (physical, 1-based), newline (an unescaped
 * line break since the previous token, outside any token) }. Quotes and backticks may span lines; a heredoc (<<MARKER)
 * runs to its closing marker (its text kept as written, not dedented); `#` at the start of a token comments out the rest
 * of the line; a backslash before a line break continues the line. */
export function caddyTokens(text) {
  const out = [];
  let i = 0;
  let line = 1;
  let newline = true;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line += 1; newline = true; i += 1; continue; }
    if (c === '\\' && text[i + 1] === '\n') { line += 1; i += 2; continue; }
    if (c === '\\' && text[i + 1] === '\r' && text[i + 2] === '\n') { line += 1; i += 3; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '#') { while (i < n && text[i] !== '\n') i += 1; continue; }
    const start = line;
    let value = '';
    let quoted = false;
    const heredoc = /^<<([A-Za-z0-9_-]+)\r?\n/.exec(text.slice(i, i + 256));
    if (c === '"') {
      quoted = true;
      i += 1;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && text[i + 1] === '"') { value += '"'; i += 2; continue; }
        if (text[i] === '\n') line += 1;
        value += text[i];
        i += 1;
      }
      i += 1;
    } else if (c === '`') {
      quoted = true;
      i += 1;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\n') line += 1;
        value += text[i];
        i += 1;
      }
      i += 1;
    } else if (heredoc) {
      // The content runs until it ends with the marker (Caddy's lexer); the marker's line may carry more arguments.
      quoted = true;
      const marker = heredoc[1];
      i += heredoc[0].length;
      line += 1;
      while (i < n && !value.endsWith(marker)) {
        if (text[i] === '\n') line += 1;
        value += text[i];
        i += 1;
      }
      value = value.slice(0, -marker.length);
    } else {
      const continuation = (k) => text[k] === '\\' && (text[k + 1] === '\n' || (text[k + 1] === '\r' && text[k + 2] === '\n'));
      while (i < n && !/\s/.test(text[i]) && !continuation(i)) { value += text[i]; i += 1; }
    }
    out.push({ text: value, quoted, line: start, newline });
    newline = false;
  }
  return out;
}

/** Statements: the tokens of one directive, matcher or address line (a new statement starts after a line break). */
export function caddyStatements(text) {
  const statements = [];
  for (const token of caddyTokens(text)) {
    if (token.newline || statements.length === 0) statements.push({ line: token.line, tokens: [token] });
    else statements.at(-1).tokens.push(token);
  }
  return statements;
}

const open = (t) => t && !t.quoted && t.text === '{';
const close = (t) => t && !t.quoted && t.text === '}';

/** Where the location argument of a redir, rewrite or root directive is, as Caddy 2.11 parses the arguments. */
export function locationOf(directive, args) {
  if (directive !== 'redir' && args.length === 1) return { matcher: null, location: args[0] };
  if (args.length > 0 && isMatcherToken(args[0])) return { matcher: args[0], location: args[1] };
  return { matcher: null, location: args[0] };
}

function check(directive, args, line, file) {
  const { matcher, location } = locationOf(directive, args);
  const shown = [directive, ...args].join(' ');
  const read = matcher ? `Caddy reads ${matcher} as the request matcher` : 'there is no matcher';
  let why = null;
  if (location === undefined) why = `${read}, so no location is left`;
  else if (/^[0-9]{3}$/.test(location)) why = `${read}, so the location is the bare status code ${location}`;
  else if (!isLocation(location)) why = `${read}, so the location is ${location}, which is not a path or a URL`;
  if (!why) return null;
  return { file, line, directive, text: shown, matcher, location: location ?? null, message: `${file}:${line}: \`${shown}\`: ${why}; give the matcher first (\`${directive} * <path or URL>${directive === 'redir' ? ' <code>' : ''}\` or \`${directive} @name ...\`)` };
}

/** Findings for one Caddyfile's text: [] when every redir, rewrite and root in a directive position has a location. */
export function lintCaddyfile(text, file = 'Caddyfile') {
  const findings = [];
  const stack = [];
  for (const statement of caddyStatements(text)) {
    const tokens = statement.tokens;
    if (close(tokens[0])) { stack.pop(); continue; }
    const opens = open(tokens.at(-1));
    const words = tokens.slice(0, opens ? -1 : undefined).map((t) => t.text);
    const context = stack.at(-1) ?? 'top';
    let inner = context === 'directives' ? 'subdirectives' : context;
    if (context === 'top') {
      // `{` alone is the global options block; `(name) {` a snippet; anything else a site block.
      inner = words.length === 0 ? 'options' : 'directives';
    } else if (context === 'directives') {
      const [name, ...args] = words;
      if (name.startsWith('@')) inner = 'matcher';
      else {
        if (DIRECTIVE_BLOCKS.has(name)) inner = 'directives';
        if (LOCATION_DIRECTIVES.has(name)) {
          const finding = check(name, args, statement.line, file);
          if (finding) findings.push(finding);
        }
      }
    } else if (context === 'subdirectives' && words[0] === 'handle_response') {
      inner = 'directives';
    } else if (context === 'subdirectives') {
      inner = 'other';
    }
    if (opens) stack.push(inner);
  }
  return findings;
}
