/**
 * Whole-app wording scan (F23 "use safe wording everywhere"; core v2 C21; SEC staff FAQ Q2.5): every user-facing string
 * of the app, and of the packages whose text the app shows (claim and launch messages, revert explanations, testnet
 * disclosures, demo fixture descriptions), passes `appCopyFraming` in features/legal/wording.ts. Holding is never
 * framed as earning, rewards, yield, returns, APY, growth or gains.
 *
 * What counts as copy: every string literal, template literal and JSX text outside comments. A JSX element's text is
 * read whole ("does not mean {name} is backed by …" keeps its negation), with each expression shown as "…". Not copy,
 * and skipped: module paths, single lower-case tokens (ids, routes, URL parameters, field names: `/rewards`,
 * `launch-reward`, `accruedRaw`), class lists, and the values of JSX attributes that hold ids, classes, routes or form
 * values. The rendered pages are checked too (App.wording.test.tsx, e2e/wording-audit.spec.ts).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { withoutTemplateNames } from './features/create/v2/test-support/template-wording';
import { appCopyFraming } from './features/legal/wording';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// S10a: the indexer's sources too (the site shows its answers), BC-091.
const SCANNED_DIRS = ['apps/web/src', 'packages/artwork/src', 'packages/chain/src', 'packages/design/src', 'packages/domain/src', 'packages/indexer/src', 'packages/links/src', 'packages/providers/src'];
/** Demo data whose descriptions the pair pages show. */
const FIXTURE_DIRS = ['packages/providers/src/fixtures'];
/** Test code, test support and developer tools are not shipped copy. */
const NOT_SHIPPED = /\.test\.tsx?$|\/(test-support|integration|tools|e2e)\//;
/** The rule itself: it lists the banned words. */
const RULE = 'apps/web/src/features/legal/wording.ts';

/** JSX attributes whose values are ids, classes, routes, form names or values, never copy. */
const NON_COPY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'className',
  'id',
  'htmlFor',
  'key',
  'name',
  'value',
  'defaultValue',
  'to',
  'href',
  'path',
  'src',
  'type',
  'role',
  'rel',
  'target',
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
]);

/** A token that names code, not people: `rewards`, `/rewards?pair=…`, `sh-reward`, `accruedScaled`, `input[name="…"]`. */
const IDENTIFIER = /^[^\sA-Z][^\s]*$/;
/** A class list: every token lower-case kebab or snake case with at least one separator ("sh-page sh-rewards-page"). */
const CLASS_LIST = /^(?:[a-z0-9]+(?:[-_]{1,2}[a-z0-9]+)+)(?:\s+[a-z0-9]+(?:[-_]{1,2}[a-z0-9]+)*)*$/;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Whether a string is prose someone reads (a word with a capital, or more than one word). */
export function isCopy(text: string): boolean {
  const trimmed = tidy(text);
  if (!/[A-Za-z]/.test(trimmed)) return false;
  if (IDENTIFIER.test(trimmed)) return false;
  return !CLASS_LIST.test(trimmed);
}

function jsxAttributeName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && (ts.isJsxExpression(current) || ts.isParenthesizedExpression(current) || ts.isConditionalExpression(current))) {
    current = current.parent;
  }
  return current !== undefined && ts.isJsxAttribute(current) ? current.name.getText() : null;
}

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true;
  return ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword || parent.expression.getText() === 'require');
}

/** The text a JSX element shows, expressions as "…", inline children included (roughly its textContent). */
function jsxText(node: ts.JsxElement | ts.JsxFragment, source: ts.SourceFile): string {
  return node.children
    .map((child) => {
      if (ts.isJsxText(child)) return child.text;
      if (ts.isJsxExpression(child)) {
        const inner = child.expression;
        if (inner === undefined) return '';
        if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
        return '…';
      }
      if (ts.isJsxElement(child) || ts.isJsxFragment(child)) return ` ${jsxText(child, source)} `;
      return child.getText(source).startsWith('<br') ? ' ' : '…';
    })
    .join('');
}

/** Every piece of copy in a source file: literals, templates (expressions as "…") and whole JSX texts. */
export function copyStrings(fileName: string, text: string): string[] {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const add = (node: ts.Node, value: string) => {
    if (isModuleSpecifier(node)) return;
    const attribute = jsxAttributeName(node);
    if (attribute !== null && (NON_COPY_ATTRIBUTES.has(attribute) || attribute.startsWith('data-'))) return;
    if (isCopy(value)) found.push(tidy(value));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) add(node, [node.head.text, ...node.templateSpans.map((span) => `…${span.literal.text}`)].join(''));
    else if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && node.children.some((child) => ts.isJsxText(child) && !child.containsOnlyTriviaWhiteSpaces)) {
      const shown = jsxText(node, source);
      if (isCopy(shown)) found.push(tidy(shown));
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

/** Every string value in a JSON document that is copy (keys are field names, not copy). */
export function jsonCopy(value: unknown): string[] {
  if (typeof value === 'string') return isCopy(value) ? [tidy(value)] : [];
  if (Array.isArray(value)) return value.flatMap(jsonCopy);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(jsonCopy);
  return [];
}

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path, pattern);
    return pattern.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

// F119 / CQ11: the exact fee choice describes adding liquidity, not holder returns.
const findings = (label: string, copy: readonly string[]) => appCopyFraming(copy.map((text) => /^apps\/web\/src\/features\/(core|create)\/v2\//.test(label) ? text.replace(/\bGrow the pool\b/g, 'Add to the pool') : text)).map((clause) => `${label}: ${clause}`);

describe('whole-app wording scan (F23 safe wording)', () => {
  it('reads literals, templates and whole JSX texts, and skips ids, classes, routes and comments', () => {
    const tsx = [
      '// Holders earn rewards (a comment is not copy).',
      "import { x } from './rewards';",
      "const nav = { id: 'rewards', to: '/rewards', label: 'Claims' };",
      'const rule = `Holders earn ${asset}`;',
      'const card = <section className="sh-detail-card sh-rewards" aria-labelledby="rewards-title" data-reward-side="Q">',
      '  <h2 id="rewards-title">Holder fee share</h2>',
      '  <p>Being paired with it does not mean {name} is backed by its issuer.</p>',
      '  <p>You still have rewards <strong>to claim</strong>.</p>',
      '</section>;',
    ].join('\n');
    const copy = copyStrings('card.tsx', tsx);
    expect(copy).toEqual([
      'Claims',
      'Holders earn …',
      'Holder fee share',
      'Being paired with it does not mean … is backed by its issuer.',
      'You still have rewards to claim .',
      'to claim',
    ]);
    expect(appCopyFraming(copy)).toEqual(['Holders earn …', 'You still have rewards to claim .']);
  });

  it('treats capitalised single words and short phrases as copy, and code tokens as not copy', () => {
    for (const text of ['Rewards', 'Pair & payout', 'Holders earn', 'this pair pays rewards in T']) expect(isCopy(text), text).toBe(true);
    for (const text of ['rewards', '/rewards?pair=…', 'launch-reward-q-title', 'sh-page sh-rewards-page', 'accruedScaled', 'input[value="…"]', '  ', '12.5']) {
      expect(isCopy(text), text).toBe(false);
    }
    expect(jsonCopy({ rewards: [{ accruedRaw: '1', description: 'Holders earn USDC-DEMO.' }], rewardSide: 'Q' })).toEqual(['Holders earn USDC-DEMO.', 'Q']);
  });

  it('finds no earning, reward, yield, return, APY, growth or gain framing in the app and the package copy it shows', () => {
    const sources = SCANNED_DIRS.flatMap((dir) => files(join(ROOT, dir), /\.(ts|tsx)$/)).filter((file) => !NOT_SHIPPED.test(relative(ROOT, file)) && relative(ROOT, file) !== RULE);
    expect(sources.length).toBeGreaterThan(100);
    // No template name is an exception since founder R47J (create/v2/test-support/template-wording.ts lists none).
    const fromSources = sources.flatMap((file) => findings(relative(ROOT, file), copyStrings(file, readFileSync(file, 'utf8')).map(withoutTemplateNames)));
    const fixtures = FIXTURE_DIRS.flatMap((dir) => files(join(ROOT, dir), /\.json$/));
    expect(fixtures.map((file) => relative(ROOT, file))).toContain('packages/providers/src/fixtures/pair-details.json');
    const fromFixtures = fixtures.flatMap((file) => findings(relative(ROOT, file), jsonCopy(JSON.parse(readFileSync(file, 'utf8')))));
    const html = readFileSync(join(ROOT, 'apps/web/index.html'), 'utf8');
    const head = [...html.matchAll(/<title>([^<]*)<\/title>|content="([^"]*)"/g)].map((match) => match[1] ?? match[2] ?? '');
    expect([...fromSources, ...fromFixtures, ...findings('apps/web/index.html', head)]).toEqual([]);
  });

  it('BC-091: the scan reads the core v1 surfaces S10a adds (box 0 page cards, links, notices, the indexer), and finds no framing there', () => {
    const read = (path: string) => copyStrings(path, readFileSync(join(ROOT, path), 'utf8'));
    expect(read('apps/web/src/features/core/CoreCards.tsx')).toContain('Starts at graduation');
    expect(read('apps/web/src/features/core/RowBoxPage.tsx').some((line) => line.startsWith('Read from the chain at block'))).toBe(true);
    const core = ['apps/web/src/features/core', 'packages/indexer/src/core', 'packages/indexer/src/history'].flatMap((dir) => files(join(ROOT, dir), /\.(ts|tsx)$/)).filter((file) => !NOT_SHIPPED.test(relative(ROOT, file)));
    expect(core.length).toBeGreaterThan(20);
    expect(core.flatMap((file) => findings(relative(ROOT, file), copyStrings(file, readFileSync(file, 'utf8'))))).toEqual([]);
  });

  it('the scan reaches the copy it guards (a scan that reads nothing would pass)', () => {
    const read = (path: string) => copyStrings(path, readFileSync(join(ROOT, path), 'utf8'));
    expect(read('apps/web/src/shell/nav-items.ts')).toContain('My Box');
    expect(read('apps/web/src/features/boxes/counters.ts')).toContain('Not built yet');
    expect(read('apps/web/src/features/feed/format.ts')).toContain('Fee share in …');
    expect(read('apps/web/src/features/pair/PairCards.tsx')).toContain('Holder fee share');
    expect(read('packages/chain/src/write/revert.ts')).toContain('Only the holder can claim what is credited to it.');
    expect(read('apps/web/src/features/legal/terms.ts').length).toBeGreaterThan(100);
  });
});

/**
 * F130 (founder desk round 44, 2026-10-11, R44B): "Remove all Demo badges, mentions, no need for that." No copy the app
 * writes says demo or mock, in either build: badges, tapes, chips, labels, explanations, titles, accessible names and
 * messages (it supersedes "mock data stays labelled Demo" for labels). The sample data is named "Sample data" in
 * Settings only. Code names (`isDemo`, `DEMO_BUILD`, `demo-boxes.ts`, the `demo` source id, CSS classes) stay: they are
 * not copy. The one value kept is data: the M1 fixture's placeholder symbol `UNSET-DEMO`, which `displaySymbol` turns
 * into "Ticker not set" before anyone sees it. The rendered pages are checked in the browser (e2e/no-demo-text.spec.ts).
 */
describe('F130: no Demo or mock word in the copy apps/web writes', () => {
  /** The words, alone or as a part of a name ("Demo", "USDC-DEMO", "Mock"), never inside another word ("demonstrate"). */
  const DEMO_WORD = /(?<![a-z])(?:demo|mock)s?(?![a-z])/i;
  /** Data, not copy: the fixture's unset-ticker placeholder (format.ts), never shown as it is. */
  const DATA_VALUES: ReadonlySet<string> = new Set(['UNSET-DEMO']);

  it('the rule: the words alone or inside a name, never inside another word', () => {
    for (const text of ['Demo', 'Box created · Demo', 'Demo snapshot', 'USDC-DEMO', 'a mock wrapper', 'No links in Demo']) expect(DEMO_WORD.test(text), text).toBe(true);
    for (const text of ['Sample data', 'demonstrate', 'Democracy', 'mockup', 'Local chain 31337']) expect(DEMO_WORD.test(text), text).toBe(false);
  });

  it('finds none in apps/web/src (every build: the development build carries no Demo label either)', () => {
    const sources = files(join(ROOT, 'apps/web/src'), /\.(ts|tsx)$/).filter((file) => !NOT_SHIPPED.test(relative(ROOT, file)));
    expect(sources.length).toBeGreaterThan(100);
    const found = sources.flatMap((file) =>
      copyStrings(file, readFileSync(file, 'utf8'))
        .filter((text) => DEMO_WORD.test(text) && !DATA_VALUES.has(text))
        .map((text) => `${relative(ROOT, file)}: ${text}`),
    );
    expect(found).toEqual([]);
    const html = ['apps/web/index.html', 'apps/web/src/features/scene/lab.html', 'apps/web/src/features/scene/poster.html'].map((path) => readFileSync(join(ROOT, path), 'utf8'));
    for (const page of html) expect(page.match(/<title>[^<]*<\/title>|content="[^"]*"/g)?.filter((tag) => DEMO_WORD.test(tag)) ?? []).toEqual([]);
  });

  it('the scan reaches the copy it guards: the sample data\'s one name, in Settings', () => {
    expect(copyStrings('data-source.ts', readFileSync(join(ROOT, 'apps/web/src/features/data-source/data-source.ts'), 'utf8'))).toContain('Sample data');
  });
});

/**
 * Founder wording rule (2026-10-11): "Just the token" belittles the creator. A box with no NFTs is a "Token" box: the
 * contents tile, the template lines, the feed cards and the box pages say "Token", never "just the token" and never
 * "token only". The rendered pages are checked in the browser too (e2e/no-demo-text.spec.ts).
 */
describe('founder wording: "Token", never "just the token" or "token only"', () => {
  const BELITTLING = /\bjust (?:the|a) token\b|\btoken[- ]only\b|\bonly (?:the|a) token\b/i;

  it('the rule', () => {
    for (const text of ['Just the token', 'Paper Moons: just the token, paired with ETH.', 'Token only', 'a token-only box', 'Only the token']) expect(BELITTLING.test(text), text).toBe(true);
    for (const text of ['Token', 'Token No NFTs', 'None: a token box', 'Tokens', 'the token’s holders']) expect(BELITTLING.test(text), text).toBe(false);
  });

  it('finds none in the copy apps/web writes', () => {
    const sources = files(join(ROOT, 'apps/web/src'), /\.(ts|tsx)$/).filter((file) => !NOT_SHIPPED.test(relative(ROOT, file)));
    const found = sources.flatMap((file) => copyStrings(file, readFileSync(file, 'utf8')).filter((text) => BELITTLING.test(text)).map((text) => `${relative(ROOT, file)}: ${text}`));
    expect(found).toEqual([]);
  });

  it('the scan reaches the copy it guards: the contents tile and the box kind say "Token"', () => {
    expect(copyStrings('ContentsStep.tsx', readFileSync(join(ROOT, 'apps/web/src/features/create/ContentsStep.tsx'), 'utf8'))).toContain('Token');
    expect(copyStrings('box-model.ts', readFileSync(join(ROOT, 'apps/web/src/features/boxes/box-model.ts'), 'utf8'))).toContain('Token');
  });
});
