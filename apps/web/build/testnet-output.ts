/**
 * SH-258: what a build for another test network than Sepolia (BNB Chain testnet, `SH_TESTNET=bnb`) changes in its
 * output, after Vite has copied `public/`:
 * - `_headers`: the `/*` block's Content-Security-Policy is the profile's (its read RPCs, the index origin and picture
 *   gateway the build names, Arweave's where the profile keeps pictures there; src/share/share-headers.ts
 *   `testnetCspOrigins`), not Sepolia's;
 * - `nft/the-misfits/`: box 0's collection files are left out (no box 0 on that network);
 * - `nft/orchard/` (the Sepolia rehearsal collection's metadata, "Testnet only (Ethereum Sepolia)") is left out;
 * - `examples/` (the explainer, whose art and words show ETH coins): SH-324, kept, with the BNB version's files laid
 *   over it (`layExamplesOverlay`: every file of build/examples-bnb replaces the file at its path, the others stay).
 *   Without that overlay, or one without its index.html, the build fails: it never ships the ETH page, and Create links
 *   to it on both networks. The search below runs over the result like over every emitted file.
 * A Sepolia build is not touched.
 */
import { createHash } from 'node:crypto';
import REVIEWED from './bnb-reviewed-sentences.json' with { type: 'json' };
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { securityHeadersFor, testnetCspOrigins } from '../src/share/share-headers';
import type { TestnetProfile } from '../../../packages/chain/src/config/testnet-profile';

type Env = Readonly<Record<string, string | undefined>>;

/** The CSP line of the `/*` block for this profile and the origins the build names. */
export function testnetHeadersPolicy(profile: TestnetProfile, env: Env): string {
  const api = env.SH_CORE_SEPOLIA_INDEXER_ORIGIN?.trim();
  const art = env.SH_CORE_SEPOLIA_ART_GATEWAY?.trim();
  return securityHeadersFor(testnetCspOrigins(profile, { api: api ? [new URL(api).origin] : [], art: art ? [new URL(art).origin] : [] }))['Content-Security-Policy'] as string;
}

/** `_headers` with its `/*` Content-Security-Policy replaced (every other line kept). */
export function rewriteHeaders(text: string, policy: string): string {
  return text.replace(/^(\s+Content-Security-Policy: ).*$/m, (_line, lead: string) => `${lead}${policy}`);
}

/**
 * SH-258 round 3 (re-read finding 6), made strict in round 3b: what a BNB Chain testnet build must not emit: the
 * unrevealed edition's name, box 0, its coin's three letters as a word, the first-generation box page, the edition's
 * mock art and the Demo's snapshot words, in a file's name or in the text of ANY emitted file (a file is text unless it
 * holds a NUL byte); the edition's pictures by their bytes (any name, also inlined as a data URL); and the visible
 * sentences of the modules the build swaps out (build/bnb-variants.ts).
 */
export const BNB_OUTPUT_FORBIDDEN = /[Mm]isfit|MISFIT|\b[Bb][Oo][Xx] ?0\b|\bFIT\b|RowBoxPage|HiddenDrawsV2|mock-v0|demo-art|Demo snapshot/;

/** A remaining hit allowed by name: the emitted file (its name without the content hash) and the exact string in it. */
export interface OutputException {
  readonly file: string;
  readonly text: string;
  readonly why: string;
}

const VAULT = 'packages/domain vault-math: an invariant message of the shared vault arithmetic (thrown, never a page line)';
const FEE_KIND = 'fee-kinds: the label of a fee whose token is FIT; no box on chain 97 burns FIT';
const MARKET = 'fit-target: parsing a box 0 market record; a BNB build takes none (SH_FIT_MARKET refused, deployments-plugin.ts)';
const GUARD = 'packages/chain executor: the box 0 send guard; nothing on chain 97 reaches it (no core v1)';
const SPEC = 'BoxSpec: the coin class named FIT (an enum value of the v1 and v2 spec) and the v1 fee words; no BNB box is priced in FIT';
const LAUNCH = 'useLaunchBox and fit-links: the box 0 market\'s reads and links, loaded only for a market record (none in a BNB build)';

/** Each remaining string, bound to its file and its exact text (round 3b). Every other hit stops the build. */
export const BNB_OUTPUT_EXCEPTIONS: readonly OutputException[] = Object.freeze([
  { file: 'assets/BoxPage.js', text: '`need 1 ≤ n ≤ N (F23: the last Misfit stays)`', why: VAULT },
  { file: 'assets/BoxPage.js', text: '`need at least one raw FIT per inside Misfit (A ≥ n)`', why: VAULT },
  { file: 'assets/BoxPage.js', text: '`return quote below one raw unit per Misfit`', why: VAULT },
  { file: 'assets/BoxPage.js', text: '`the last Misfit cannot leave the vault (F23)`', why: VAULT },
  { file: 'assets/BoxPage.js', text: '`last_misfit`', why: VAULT },
  { file: 'assets/BoxPage.js', text: '`Fees burn FIT`', why: FEE_KIND },
  { file: 'assets/BoxPage.js', text: '===`FIT`', why: FEE_KIND },
  { file: 'assets/BoxPage.js', text: '`misfits`', why: MARKET },
  { file: 'assets/FitParts.js', text: '"misfits"', why: MARKET },
  { file: 'assets/FitParts.js', text: '`misfits`', why: MARKET },
  { file: 'assets/FitParts.js', text: '`Misfits`', why: MARKET },
  { file: 'assets/FitParts.js', text: '`FIT market record`', why: MARKET },
  { file: 'assets/FitParts.js', text: '`The FIT market record`', why: MARKET },
  { file: 'assets/FitParts.js', text: '`The live service follows another curve than this FIT market.`', why: MARKET },
  { file: 'assets/FitParts.js', text: '`poolId is not the id of the pool key of this FIT and hook (native ETH, 1%, spacing 60)`', why: MARKET },
  { file: 'assets/executor.js', text: '`FIT approval must name the tickets and a positive amount`', why: GUARD },
  { file: 'assets/executor.js', text: '`a draw needs a FIT limit and a deadline`', why: GUARD },
  { file: 'assets/executor.js', text: '`a take names one item, a FIT limit and a deadline, without a record`', why: GUARD },
  { file: 'assets/executor.js', text: '`box 0 action must target the token, the tickets or the stream`', why: GUARD },
  { file: 'assets/executor.js', text: '`calldata is not a canonical box 0 action`', why: GUARD },
  { file: 'assets/executor.js', text: '`core-v1-box0`', why: GUARD },
  { file: 'assets/executor.js', text: '`function is not a box 0 action`', why: GUARD },
  { file: 'assets/executor.js', text: '`invalid box 0 role or caller address`', why: GUARD },
  { file: 'assets/indexer-listings.js', text: '.FIT||', why: SPEC },
  { file: 'assets/indexer-listings.js', text: '`FIT`', why: SPEC },
  { file: 'assets/indexer-listings.js', text: 'burns FIT · ', why: SPEC },
  { file: 'assets/indexer-v2.js', text: 'FIT:3', why: SPEC },
  { file: 'assets/indexer-v2.js', text: '.FIT&&', why: SPEC },
  { file: 'assets/indexer-v2.js', text: 'box0:!0', why: 'the Sepolia profile\'s switch (`switches.box0`), carried as data; this build runs the BNB profile' },
  { file: 'assets/indexer-v2.js', text: 'box0:!1', why: 'the BNB profile\'s switch (`switches.box0`), false' },
  // SH-275: the profiles' data in their own shared chunk (the alpha's switch reads them from the app's first paint) and in
  // the join page, which the BNB build now makes (its own build: the notice and the alpha's words read the profile).
  { file: 'assets/testnet-profile.js', text: 'box0:!0', why: 'the Sepolia profile\'s switch (`switches.box0`), carried as data; this build runs the BNB profile' },
  { file: 'assets/testnet-profile.js', text: 'box0:!1', why: 'the BNB profile\'s switch (`switches.box0`), false' },
  { file: 'join/assets/join.js', text: 'box0:!0', why: 'the Sepolia profile\'s switch (`switches.box0`), carried as data in the join page; it runs the BNB profile' },
  { file: 'join/assets/join.js', text: 'box0:!1', why: 'the BNB profile\'s switch (`switches.box0`), false, in the join page' },
  { file: 'assets/indexer-v2.js', text: '`chain 97 has no core v1 version (no box 0 on BNB Chain testnet)`', why: 'core-manifest: a developer diagnostic of the manifest check' },
  { file: 'assets/indexer-v2.js', text: '`version 1 (box 0\'s factory) is missing`', why: 'core-manifest: a developer diagnostic of the manifest check' },
  { file: 'assets/indexer-v2.js', text: 'platform differs from box 0`', why: 'manifest-v2: a developer diagnostic of the manifest check' },
  { file: 'assets/reveal-finalized.js', text: '`The Sorter: launch guidance, empty states, sidebar card; MISFIT STUDIO demo avatar`', why: 'packages/design art manifest: the description of a cast picture (the Sorter), not an edition item; never shown' },
  { file: 'assets/useCore.js', text: '.FIT]:`FIT`', why: SPEC },
  { file: 'assets/useLaunchBox.js', text: '`Demo: FIT is not deployed anywhere, so no link is built. Nothing on this page is a real contract.`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`FIT totalSupply()`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`FIT-DS-POOL`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`FIT-ES-TOKEN`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`FIT-SEP-DS`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`FIT-SEP-ES-TOKEN`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`FIT-SEP-UNI-ETH`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`FIT-UNI-ETH`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`Misfit`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`Misfits`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`The FIT identity is malformed, so no destination is offered.`', why: LAUNCH },
  { file: 'assets/useLaunchBox.js', text: '`The vault holds more Misfits than the edition has`', why: LAUNCH },
  { file: 'assets/web.css', text: 'sh-box0-actions', why: 'a CSS class name of the box 0 panel (no text; the panel is not in the build)' },
  // SH-273: the same strings as the entries above, moved by the bundler: the box page's picture is a chunk of its own
  // that shares fee-kinds.ts, spec-record.ts and the design art manifest with the box page, so they land in a common
  // chunk (useV2) and the entry chunk (web). The entries above stay for a build without that split.
  { file: 'assets/useV2.js', text: '`FIT`', why: SPEC }, // as indexer-listings.js `FIT` (fee-kinds.ts paidIn and tokenWord)
  { file: 'assets/useV2.js', text: '.FIT||', why: SPEC }, // as indexer-listings.js .FIT|| (fee-kinds.ts qBurns)
  { file: 'assets/useV2.js', text: 'burns FIT · ', why: SPEC }, // as indexer-listings.js burns FIT · (spec-record.ts)
  { file: 'assets/web.js', text: '`The Sorter: launch guidance, empty states, sidebar card; MISFIT STUDIO demo avatar`', why: 'packages/design art manifest: the description of a cast picture (the Sorter), not an edition item; never shown' }, // as reveal-finalized.js
]);

/** The reviewed visible sentences of the swapped-out modules, each with its module (round 4: pinned, never derived). */
export const BNB_REVIEWED_SENTENCES: readonly { readonly module: string; readonly sentence: string }[] = Object.freeze(REVIEWED);

/** What else identifies box 0 in an output: the edition's pictures by digest and data-URL head, and swapped-out sentences. */
export interface OutputIdentity {
  /** sha256 hex of each edition picture -> its source path. */
  readonly pictures: ReadonlyMap<string, string>;
  /** The first 64 base64 characters of each edition picture (a data URL inlines it so) -> its source path. */
  readonly heads: ReadonlyMap<string, string>;
  /** The pinned visible sentences of the swapped-out modules (bnb-reviewed-sentences.json). */
  readonly sentences: readonly string[];
}
const NO_IDENTITY: OutputIdentity = { pictures: new Map(), heads: new Map(), sentences: [] };

/** The emitted file's name without its content hash ("assets/BoxPage-AbC12345.js" -> "assets/BoxPage.js"). */
export const outputBase = (file: string): string => file.replace(/-[A-Za-z0-9_-]{8}(\.\w+)$/, '$1');

/** Every hit in `outDir`, as "file: what"; the named exceptions (file and exact text) left out. */
export function bnbOutputHits(outDir: string, identity: OutputIdentity = NO_IDENTITY): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      const file = relative(outDir, path);
      if (BNB_OUTPUT_FORBIDDEN.test(file)) hits.push(`${file}: (its name)`);
      const bytes = readFileSync(path);
      const picture = identity.pictures.get(createHash('sha256').update(bytes).digest('hex'));
      if (picture) hits.push(`${file}: the edition picture ${picture}`);
      if (bytes.includes(0)) continue;
      const text = bytes.toString('utf8');
      for (const [head, source] of identity.heads) if (text.includes(head)) hits.push(`${file}: the edition picture ${source}, inlined`);
      for (const sentence of identity.sentences) if (text.includes(sentence)) hits.push(`${file}: a swapped-out sentence "${sentence}"`);
      const base = outputBase(file);
      const covered: [number, number][] = [];
      for (const exception of BNB_OUTPUT_EXCEPTIONS) {
        if (exception.file !== base) continue;
        for (let at = text.indexOf(exception.text); at >= 0; at = text.indexOf(exception.text, at + 1)) covered.push([at, at + exception.text.length]);
      }
      for (const match of text.matchAll(new RegExp(BNB_OUTPUT_FORBIDDEN.source, 'g'))) {
        const end = match.index + match[0].length;
        if (covered.some(([from, to]) => from <= match.index && end <= to)) continue;
        hits.push(`${file}: …${text.slice(Math.max(0, match.index - 40), end + 40).replace(/\s+/g, ' ')}…`);
      }
    }
  };
  walk(outDir);
  return hits;
}

/** The repository's edition pictures and the pinned sentences of the swapped-out modules (`root`: the repository). */
export function bnbOutputIdentity(root: string): OutputIdentity {
  const pictures = new Map<string, string>();
  const heads = new Map<string, string>();
  const collect = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { collect(path); continue; }
      if (!/\.(webp|png|jpe?g|gif|avif|svg)$/i.test(name)) continue;
      const bytes = readFileSync(path);
      const source = relative(root, path);
      pictures.set(createHash('sha256').update(bytes).digest('hex'), source);
      heads.set(bytes.toString('base64').slice(0, 64), source);
    }
  };
  collect(join(root, 'packages/design/art/misfits'));
  collect(join(root, 'docs/design/misfits-v2'));
  // Round 4: the reviewed sentences are a pinned list of their own (bnb-reviewed-sentences.json: each exact sentence
  // and the swapped module it came from), never derived from what kept sources lack.
  const sentences = BNB_REVIEWED_SENTENCES.map((row) => row.sentence);
  return { pictures, heads, sentences };
}

/** SH-324: the BNB version's files of the explainer, relative to the app's folder (apps/web). */
export const EXAMPLES_OVERLAY = 'build/examples-bnb';

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path, base) : [relative(base, path)];
  });
}

/**
 * SH-324: lays every file of `overlayDir` over `examplesDir` (the output's copy of public/examples), at the same relative
 * path; the files it does not hold stay as they are. Fails, before anything is copied, when the output has no explainer
 * or the overlay is missing or has no index.html. Returns the overlaid paths.
 */
export function layExamplesOverlay(examplesDir: string, overlayDir: string): string[] {
  if (!existsSync(join(examplesDir, 'index.html'))) throw new Error(`SH-324: the BNB output has no ${join(examplesDir, 'index.html')} (public/examples not copied)`);
  if (!existsSync(overlayDir) || !statSync(overlayDir).isDirectory()) throw new Error(`SH-324: the BNB build needs the explainer's BNB files in ${overlayDir}; it is missing, and the ETH page must not ship`);
  if (!existsSync(join(overlayDir, 'index.html')) || !statSync(join(overlayDir, 'index.html')).isFile()) throw new Error(`SH-324: the BNB build needs ${join(overlayDir, 'index.html')}; the ETH page must not ship`);
  const files = filesUnder(overlayDir).sort();
  // The app's own address of the demo boxes (src/features/examples/examples-page.ts DEMO_BOXES_PATH) stays the app's.
  const shadow = files.find((file) => file.split(/[\\/]/)[0] === 'boxes');
  if (shadow || existsSync(join(examplesDir, 'boxes'))) throw new Error(`SH-324: examples/boxes is the app's address of the demo boxes; no file may sit there (${shadow ?? 'boxes'})`);
  for (const file of files) {
    const target = join(examplesDir, file);
    if (existsSync(target) && statSync(target).isDirectory()) throw new Error(`SH-324: the overlay's file ${file} would replace a folder of the explainer`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(overlayDir, file), target);
  }
  return files;
}

export function testnetOutput(profile: TestnetProfile, env: Env, options: { readonly examplesOverlay?: string } = {}): Plugin {
  let outDir = '';
  let repoRoot = '';
  let overlayDir = '';
  return {
    name: 'squarehole-testnet-output',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      repoRoot = resolve(config.root, '../..');
      overlayDir = options.examplesOverlay ?? resolve(config.root, EXAMPLES_OVERLAY);
    },
    closeBundle() {
      if (profile.name === 'sepolia' || outDir === '') return;
      const headers = join(outDir, '_headers');
      if (existsSync(headers)) writeFileSync(headers, rewriteHeaders(readFileSync(headers, 'utf8'), testnetHeadersPolicy(profile, env)));
      if (!profile.switches.box0) rmSync(join(outDir, 'nft', 'the-misfits'), { recursive: true, force: true });
      rmSync(join(outDir, 'nft', 'orchard'), { recursive: true, force: true });
      // SH-324: the explainer stays, in its BNB version (the overlay); the search below reads the result.
      layExamplesOverlay(join(outDir, 'examples'), overlayDir);
      // SH-258 round 3: the output is searched, names and contents; a hit outside the named exceptions stops the build.
      const hits = bnbOutputHits(outDir, bnbOutputIdentity(repoRoot));
      if (hits.length) throw new Error(`SH-258: the BNB output holds box 0's words or files (${hits.length}):\n${hits.join('\n')}`);
    },
  };
}
