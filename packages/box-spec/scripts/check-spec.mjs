#!/usr/bin/env node
/**
 * Checks a BoxSpec JSON the way the box factory will (F73: the launch skill's checker).
 *
 * Usage (from the repository root):
 *   pnpm box-spec:check <file.json>            validate, print the spec hash, the overview and what to tell the creator
 *   pnpm box-spec:check <file.json> --json     the same as JSON (for assistants and tests)
 *   pnpm box-spec:check <file.json> --network demo|sepolia|mainnet
 *                                              where the box is meant to run (F74 U1; default: the network a Download
 *                                              BoxSpec file names, else mainnet, the strictest: the factory's own
 *                                              check). Demo offers holder payouts early, marked pending legal review;
 *                                              Sepolia once they are built; mainnet never before the legal review
 *   pnpm box-spec:check --menu [--context v2]  what a box can be today, read from the spec at run time
 *   pnpm box-spec:check --field <name> <text>  one name, ticker or text checked on its own, every problem at once
 *   pnpm box-spec:check --numbers [--raise 4.206980085] [--items 250] [--buy 0.02] [--share 5] [--eth-usd 2500] [--usd 2000]
 *                                              what the presets come to: all tokens and one item at the first buy and
 *                                              at graduation, a creator buy's share, the buy for a share, dollars
 *
 * It reads drafts (`squarehole.boxspec-draft/1`), the launch flow's "Download BoxSpec" file (`squarehole.boxspec/1`) and
 * bare specs; it validates with the generated library (`boxSpecV1Schema`, `validateBoxSpecV1`, `specHash`) against
 * the version context, and turns a refusal into a plain sentence with the fix.
 *
 * Format 2 (M1-11, core v2; lib/check-spec-v2.mjs): a `squarehole.boxspec-draft/2` draft is checked against its network's
 * menu (--network demo|sepolia, else the draft's own "network", else sepolia): the listings of the offline copy
 * (listings.<network>.json) with the indexer's answer over them (--listings <file> or --indexer <url>, read only), and
 * the reviewed plug-ins. `--format 2` also refuses a format 1 draft for version 2 with a pointer to the translation
 * table (box 0's version 1 stays format 1), and gives `--menu` for format 2; `--numbers --pricing <symbol>` (a token
 * Square Hole listed) or `--numbers --box-token <symbol>` (a box token listed by rule) works in that token's units.
 * Until M1-10's twin (src/generated/box-spec.v2.ts) is in the checkout no format 2 draft is valid.
 * It never asks for keys and never sends anything: the only request it makes is the read-only GET of --indexer (https,
 * or http on this computer; no redirect followed, at most 1 MB read), when asked; a value shaped like a private key or
 * recovery phrase is never repeated.
 * Exit codes: 0 valid · 1 refused by the factory's check · 2 usage error · 3 not a readable BoxSpec (input problems,
 * invalid JSON, an edited download) · 4 stopped: something looks like a private key or recovery phrase.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_NETWORK, EXIT, NETWORK_NAMES, SECRET_MESSAGE, checkField, checkSpec, exitCodeOf, modelFor, numbersOf, renderField, renderMenu, renderNumbers, renderText, secretKind, textFieldNames } from './lib/check-spec.mjs';
import { loadBoxSpecLibrary, loadBoxSpecV2Library } from './lib/load-generated.mjs';

const USAGE = [
  'Usage: pnpm box-spec:check <file.json> [--json] [--network demo|sepolia|mainnet] [--format 2]',
  '       format 2 drafts: [--network demo|sepolia] [--listings <indexer-answer.json> | --indexer <url>]',
  '       pnpm box-spec:check --menu [--context v2] | --menu --format 2 [--network demo|sepolia]',
  '       pnpm box-spec:check --numbers --pricing <symbol> | --box-token <symbol> [--items 250] [--buy 0.02] [--share 5] [--network demo|sepolia]',
  '       pnpm box-spec:check --field <name> <text> [--json]',
  '       pnpm box-spec:check --numbers [--raise 4.206980085] [--items 250] [--buy 0.02] [--share 5] [--eth-usd 2500] [--usd 2000] [--json]',
  'Exit codes: 0 valid, 1 refused, 2 usage error, 3 not a readable BoxSpec, 4 looks like a private key or recovery phrase.',
  '',
].join('\n');
const VALUE_OPTIONS = ['--context', '--network', '--raise', '--items', '--buy', '--share', '--eth-usd', '--usd', '--format', '--pricing', '--box-token', '--listings', '--indexer'];
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
/** An option that takes a value, given with nothing after it or with another option there ("--buy --share 5"). */
const missingValue = VALUE_OPTIONS.find((name) => flag(name) && (option(name) === undefined || option(name).startsWith('--')));
// Values of options never count as the file (a ticker such as "$GM" or a text starting with "-" included).
const taken = new Set();
args.forEach((a, i) => {
  if (VALUE_OPTIONS.includes(a)) taken.add(i + 1);
  if (a === '--field') [i + 1, i + 2].forEach((j) => taken.add(j));
});
const positional = args.filter((a, i) => !taken.has(i) && !a.startsWith('--'));
const replacer = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);
const print = (result, text) => process.stdout.write(flag('--json') ? `${JSON.stringify(result, replacer, 2)}\n` : text);

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write(USAGE);
  process.exit(EXIT.USAGE);
}

if (flag('--help') || flag('-h')) {
  process.stdout.write(USAGE);
  process.exit(EXIT.VALID);
}

// A pasted key or phrase on the command line is never echoed back (not in a usage error either): each argument, and
// the arguments read together (a phrase typed without quotes arrives one word per argument).
if (args.some((a) => secretKind(a) !== null) || secretKind(args.filter((a) => !a.startsWith('--')).join(' ')) !== null) {
  const result = { ok: false, stage: 'secret', secret: true, paths: ['a command-line argument'], problems: [], message: SECRET_MESSAGE };
  print(result, renderText(result));
  process.exit(EXIT.SECRET);
}

if (missingValue) usage(`${missingValue} needs a value, e.g. ${missingValue} ${{ '--context': 'v2', '--network': 'demo', '--raise': '4.206980085', '--items': '250', '--buy': '0.02', '--share': '5', '--eth-usd': '2500', '--usd': '2000', '--format': '2', '--pricing': 'USDC', '--box-token': 'MUG', '--listings': 'listings-answer.json', '--indexer': 'https://indexer.example/v2/listings' }[missingValue]}.`);
const format = option('--format');
if (format !== undefined && format !== '1' && format !== '2') usage('--format must be 1 (box 0) or 2 (core v2).');
// F74 U1: the network decides only what is offered early (holder payouts in Demo). Without --network a Download
// BoxSpec file is checked for the network it names, anything else for the strictest (checkSpec).
const network = option('--network');
if (network !== undefined && !NETWORK_NAMES.includes(network)) usage(`--network must be one of ${NETWORK_NAMES.join(', ')} (default ${DEFAULT_NETWORK}; a Download BoxSpec file: the network it names).`);

const lib = await loadBoxSpecLibrary();
const model = modelFor(lib);

/** The indexer's answer when asked for (a saved file or a read-only GET), else none: the offline copy alone. */
async function indexerAnswer({ fetchIndexerAnswer, indexerUrlOk }) {
  const file = option('--listings');
  if (file !== undefined) {
    try {
      // Read from where the command was typed, as the file argument is (INIT_CWD under `pnpm box-spec:check`).
      const from = process.env.npm_lifecycle_event && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
      return JSON.parse(readFileSync(isAbsolute(file) ? file : resolve(from, file), 'utf8'));
    } catch {
      usage(`--listings ${file}: not a readable JSON file of the indexer's listings.`);
    }
  }
  const url = option('--indexer');
  if (url === undefined) return undefined;
  // https only, except on this computer (an indexer run locally): a menu read in the clear could be changed on the way.
  if (!indexerUrlOk(url)) usage("--indexer takes an https URL of the indexer's listings (http only on this computer).");
  try {
    return await fetchIndexerAnswer(url);
  } catch (error) {
    process.stderr.write(`Could not read the indexer (${error.message}); the offline copy is used.\n`);
    return undefined;
  }
}

/** Format 2's checker, loaded only when asked for, so format 1's command line starts as fast as before. */
const v2 = () => import('./lib/check-spec-v2.mjs');
/** lib/check-spec-v2.mjs `DRAFT_FORMAT_V2` (the command-line tests route a draft with it). */
const DRAFT_FORMAT_V2 = 'squarehole.boxspec-draft/2';

async function modelV2(fromDoc) {
  const net = network ?? fromDoc ?? 'sepolia';
  try {
    const formatTwo = await v2();
    return formatTwo.modelForV2({ network: net, twin: await formatTwo.loadTwinV2(), curve: await loadBoxSpecV2Library(), indexer: await indexerAnswer(formatTwo) });
  } catch (error) {
    return usage(error.message);
  }
}

if (flag('--menu') && format === '2') {
  process.stdout.write((await v2()).renderMenuV2(await modelV2()));
  process.exit(EXIT.VALID);
}

if (flag('--numbers') && (option('--pricing') !== undefined || option('--box-token') !== undefined || format === '2')) {
  const { numbersOfV2, renderNumbersV2 } = await v2();
  const result = numbersOfV2(await modelV2(), { pricing: option('--pricing'), boxToken: option('--box-token'), items: option('--items'), buy: option('--buy'), share: option('--share') });
  if (!result.ok) usage(renderNumbersV2(result).trimEnd());
  print(result, renderNumbersV2(result));
  process.exit(EXIT.VALID);
}

if (flag('--menu')) {
  try {
    process.stdout.write(renderMenu(model, option('--context') ?? 'v2'));
  } catch (error) {
    usage(error.message);
  }
  process.exit(EXIT.VALID);
}

if (flag('--field')) {
  const i = args.indexOf('--field');
  if (args[i + 1] === undefined || args[i + 2] === undefined) usage(`Name the field and the text, e.g. --field ticker "GM". Text fields: ${textFieldNames(model).join(', ')}.`);
  const result = checkField(model, args[i + 1], args[i + 2]);
  if (result.unknown) usage(result.problems[0]);
  print(result, renderField(result));
  process.exit(result.secret ? EXIT.SECRET : result.ok ? EXIT.VALID : EXIT.REFUSED);
}

if (flag('--numbers')) {
  const result = numbersOf(model, { raise: option('--raise'), items: option('--items'), buy: option('--buy'), share: option('--share'), ethUsd: option('--eth-usd'), usd: option('--usd') });
  if (!result.ok) usage(renderNumbers(result).trimEnd());
  print(result, renderNumbers(result));
  process.exit(EXIT.VALID);
}

if (positional.length !== 1) usage(positional.length === 0 ? 'Name the BoxSpec JSON file to check.' : 'Check one file at a time.');

// `pnpm box-spec:check` runs from the repository root and INIT_CWD is where the command was typed; anywhere else
// (node directly, the skill's scripts/check.mjs) a leftover INIT_CWD from an outer pnpm run must not move the file.
const base = process.env.npm_lifecycle_event && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
const file = isAbsolute(positional[0]) ? positional[0] : resolve(base, positional[0]);

/** Where `offset` is in `text`, as "line 3, column 7". */
function lineColumn(text, offset) {
  const before = text.slice(0, offset).split('\n');
  return `line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`;
}

/** The character at `offset`: a plain one in quotes, an invisible or non-ASCII one by name and code. */
function charAt(text, offset) {
  const ch = [...text.slice(offset)][0];
  if (ch === undefined) return 'the end';
  const hex = `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
  if (ch === '\n' || ch === '\r') return 'a line break';
  if (ch === '\ufeff') return `a byte-order mark (${hex}, invisible)`;
  if (/^[\x21-\x7e]$/.test(ch)) return `"${ch}"`;
  return `an invisible or non-ASCII character (${hex})`;
}

const near = (text, offset) => `near ${lineColumn(text, offset)}, at ${charAt(text, offset)}`;

/**
 * "not valid JSON (near line 3, column 7, at "x")". The parser's own message may quote the text, which can be a
 * secret, so only a position and the one character there are kept. When the parser gives no position ("tru" for
 * "true"), the shortest start of the text that already fails is found by halving.
 */
function jsonProblem(text, error) {
  const message = String(error.message);
  const at = /position (\d+)/.exec(message);
  if (/end of JSON input/.test(message) || (at && Number(at[1]) >= text.length)) return 'not valid JSON (it ends before the JSON is complete)';
  if (at) return `not valid JSON (${near(text, Number(at[1]))})`;
  // A start that ends early fails at its own end ("end of JSON input", or a position at the end): still fine.
  const fails = (end) => {
    try {
      JSON.parse(text.slice(0, end));
      return false;
    } catch (e) {
      const position = /position (\d+)/.exec(String(e.message));
      return !/end of JSON input/.test(String(e.message)) && !(position && Number(position[1]) >= end);
    }
  };
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fails(mid)) hi = mid;
    else lo = mid + 1;
  }
  return `not valid JSON (${near(text, lo - 1)})`;
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch (error) {
  process.stderr.write(`Cannot read ${positional[0]}: ${error.code === 'ENOENT' ? 'no such file' : error.code === 'EISDIR' ? 'it is a folder' : 'the file cannot be opened'}.\n`);
  process.exit(EXIT.USAGE);
}
// A byte-order mark (Windows editors save one) is not part of the JSON.
if (text.startsWith('\ufeff')) text = text.slice(1);
let doc;
try {
  doc = JSON.parse(text);
} catch (error) {
  if (secretKind(text) !== null) {
    const result = { ok: false, stage: 'secret', secret: true, paths: ['(the whole file)'], problems: [], message: SECRET_MESSAGE };
    print(result, renderText(result));
    process.exit(EXIT.SECRET);
  }
  process.stderr.write(`Cannot read ${positional[0]}: ${jsonProblem(text, error)}.\n`);
  process.exit(EXIT.NOT_READABLE);
}

// Format 2 (M1-11): a format 2 draft, or any draft with --format 2 except box 0's version 1, which stays format 1.
const box0 = typeof doc === 'object' && doc !== null && Number((doc.spec ?? doc).version) === 1;
if (doc?.format === DRAFT_FORMAT_V2 || (format === '2' && !box0)) {
  const { MENU_NETWORKS_V2, checkSpecV2, exitCodeOfV2, renderTextV2 } = await v2();
  // The draft's own network picks the menu only when it is one that has a menu; any other value is the draft's input
  // problem (checkSpecV2), never a path.
  const model2 = await modelV2(MENU_NETWORKS_V2.includes(doc?.network) ? doc.network : undefined);
  let checked;
  try {
    checked = checkSpecV2(model2, doc);
  } catch {
    process.stderr.write(`Cannot check ${positional[0]}: a value has a shape the checker does not read. Compare the file with references/v2/spec-json.md, or start again from a worked example.\n`);
    process.exit(EXIT.NOT_READABLE);
  }
  print(checked, renderTextV2(checked, positional[0]));
  process.exit(exitCodeOfV2(checked));
}

let result;
try {
  // The clock: an opening time already passed, or more than 14 days ahead, is warned about (field 15 openAt).
  result = checkSpec(model, doc, { network, nowMs: Date.now() });
} catch {
  // Defensive: an input the readers did not foresee. Report it without the value or a stack.
  process.stderr.write(`Cannot check ${positional[0]}: a value has a shape the checker does not read. Compare the file with references/spec-json.md, or start again from a worked example.\n`);
  process.exit(EXIT.NOT_READABLE);
}
print(result, renderText(result, positional[0]));
process.exit(exitCodeOf(result));
