/**
 * The Sepolia runbook (docs/runbooks/sepolia-core-v1.md) follows the build its settings choose (F78; review of the
 * rehearsal build, finding 1). Z0's line picks the build (`export FOUNDRY_PROFILE=rehearsal`, or none for the full-size
 * mainnet build), and every figure the runbook's commands carry must be that build's:
 * - the spec file Z3 names is made for it (its `.build`, absent = mainnet), and Step 2's expected spec hash, build
 *   profile, raise and bootstrap are that file's and that build's;
 * - a `P1=` price limit is the build's curve end (√P at the curve's lower tick, as BoxLayoutV1 / layout.ts compute it
 *   from the build's raise: tick 177,180 in the mainnet build, 200,220 in the rehearsal build);
 * - no amount a command sends (`--value …ether`, a buy's exact input `(true,-amount,…)`) exceeds what fills the build's
 *   curve (R plus its 1% pool fee).
 * So a section written for one build (the full-size fill: 2.4 + 2 SepETH up to P1 at tick 177,180) cannot be merged
 * under the other build's settings unscaled: `pnpm test` (in `pnpm verify`) fails. Every sh block must also paste into
 * zsh as it reads in bash (the founder's terminal; zsh's `interactivecomments` is off by default): no `#` outside
 * quotes, no quote left open (sh-life-run's review finding 1, the same rule as its `core-v1-life-run.sh
 * --check-runbook`), no `<word>` placeholder outside quotes (a redirection; review of the merge of main). And every `postRound` waits first for the chain to reach its round's time (`postRoundProblems`;
 * review of sh-sepolia-base; the same rule in `--check-runbook`): a fork rehearsal cannot show that refusal, since anvil
 * estimates on its pending block.
 *
 * Step 2's spec-hash row is the runbook's example time's (F80): Step 0 rewrites the spec files for the founder's time, so
 * a file at another time is compared at the example time (its spec with the example's openAt), never against its own
 * hash alone (review of sh-open-at-final, finding 1: the founder's files, kept or committed, turned `pnpm verify` red).
 *
 * SH_RUNBOOK_FILE=<path> checks another text, e.g. a merge result before it is committed:
 *   SH_RUNBOOK_FILE=/tmp/merged.md npx vitest run packages/box-spec/src/sepolia-runbook.test.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  BUILD_PROFILE_MAINNET,
  BUILD_PROFILE_REHEARSAL,
  BUILD_PROFILES,
  boxCurve,
  decodeBoxSpecV1,
  encodeBoxSpecV1,
  specHash,
  type BoxSpecV1,
  type BuildProfile,
} from './index';
import { getSqrtPriceAtTick } from './v4-math';

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const contracts = (path: string) => repo(`packages/contracts/${path}`);
const RUNBOOK = process.env.SH_RUNBOOK_FILE ?? repo('docs/runbooks/sepolia-core-v1.md');

interface SpecFile {
  readonly build?: string;
  readonly specHash: string;
  readonly openAt?: number;
  readonly encoded?: string;
}

interface ShBlock {
  readonly line: number;
  readonly body: string;
}

const readSpec = (path: string): SpecFile => JSON.parse(readFileSync(contracts(path), 'utf8')) as SpecFile;

/** The fenced sh blocks (```sh, bash, zsh, shell) with the runbook line their body starts on. */
function shBlocks(text: string): ShBlock[] {
  return [...text.matchAll(/^```(?:sh|bash|zsh|shell)\n([\s\S]*?)^```/gm)].map((m) => ({
    line: text.slice(0, m.index).split('\n').length + 1,
    body: m[1] ?? '',
  }));
}

/** The build the settings block chooses (the block that exports SPEC): its FOUNDRY_PROFILE line, none = mainnet. */
function settingsOf(text: string): { build: BuildProfile; spec: string } {
  const settings = shBlocks(text).filter((b) => /^export SPEC=/m.test(b.body));
  if (settings.length !== 1) throw new Error(`one settings block exports SPEC (found ${settings.length})`);
  const body = settings[0]?.body ?? '';
  const profile = body.match(/^export FOUNDRY_PROFILE=(\S+)$/m)?.[1];
  const build = profile ? Object.values(BUILD_PROFILES).find((p) => p.foundryProfile === profile) : BUILD_PROFILE_MAINNET;
  if (!build) throw new Error(`FOUNDRY_PROFILE=${profile} is no build profile of core v1`);
  const spec = body.match(/^export SPEC=(\S+)$/m)?.[1] ?? '';
  return { build, spec };
}

/** What fills `build`'s curve, with room for the pool fee: R plus 2%. */
const fillOf = (build: BuildProfile): bigint => build.values.RAISE + build.values.RAISE / 50n;

/** `x` ether (a decimal string) in wei. */
function weiOf(ether: string): bigint {
  const [whole = '0', frac = ''] = ether.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

/**
 * The `#`, open quotes and `<word>` placeholders a paste into zsh would trip on, read as bash reads the block. A
 * placeholder outside quotes is a redirection from the file `word` (Step 5's `<registry>`, review of the merge: zsh
 * stops at `no such file or directory: registry`), which `zsh -n` parses without a word.
 */
function pasteProblems(block: ShBlock): string[] {
  const problems: string[] = [];
  const body = block.body;
  let line = block.line;
  let quote: string | null = null;
  let opened = line;
  let escaped = false;
  let comment = false;
  let prev = '\n';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? '';
    if (comment) comment = ch !== '\n';
    else if (escaped) escaped = false;
    else if (quote === "'") quote = ch === "'" ? null : quote;
    else if (ch === '\\') escaped = true;
    else if (quote === '"') quote = ch === '"' ? null : quote;
    else if (ch === "'" || ch === '"') {
      quote = ch;
      opened = line;
    } else if (ch === '#') {
      comment = ' \t\n;&|()'.includes(prev);
      problems.push(`line ${line}: ${comment ? "a note after '#' (zsh passes it on as arguments)" : "a '#' outside quotes"}`);
    } else if (ch === '<') {
      const placeholder = body.slice(i).match(/^<[A-Za-z][A-Za-z0-9_.-]*>/)?.[0];
      if (placeholder) problems.push(`line ${line}: a placeholder '${placeholder}' outside quotes (zsh reads it as a redirection)`);
    }
    if (ch === '\n') line += 1;
    prev = ch;
  }
  if (quote) problems.push(`line ${opened}: a ${quote} quote is never closed in its block`);
  return problems;
}

/**
 * The chain-time wait every `postRound` needs (review of sh-sepolia-base). A request asks for `roundAt(now + 12 s)`
 * (DrandSource.sol, MARGIN), and Sepolia's block times and quicknet's round times are both multiples of 3 s, so a
 * draw's round has exactly the next slot's time. A gas estimate at the latest block (no block tag or `latest` on
 * Sepolia's RPCs; cast 1.8.3's `cast send` asks for `pending`, which they run at the next slot's time, but other
 * versions and tools may not) refuses a post sent as soon as drand has the round (`RoundNotYet`, nothing sent) until
 * that next block is out, and the founder's zsh (no `set -e`) runs the rest of the block on. The wait: after the
 * round's last `NAME=` and before the post, the line `until [ "$(cast block latest --field timestamp --rpc-url $RPC)"
 * -ge "$(python3 scripts/drand-round.py --time $NAME)" ]; do sleep N; done` (core-v1-life-run.sh's --runbook mode
 * mines a block in its loop: a fork makes none of its own).
 */
const CHAIN_WAIT = (name: string): RegExp =>
  new RegExp(
    String.raw`^until \[ "\$\(cast block latest --field timestamp --rpc-url \$RPC\)" -ge ` +
      String.raw`"\$\(python3 scripts/drand-round\.py --time \$${name}\)" \]; do sleep [1-9][0-9]?; done$`,
  );

function postRoundProblems(block: ShBlock): string[] {
  const problems: string[] = [];
  const lines = block.body.split('\n');
  lines.forEach((text, i) => {
    if (!text.includes('postRound(')) return;
    const name = text.match(/'postRound\(uint256,bytes\)' \$([A-Za-z_][A-Za-z0-9_]*) /)?.[1];
    if (name === undefined) {
      problems.push(`line ${block.line + i}: postRound's round is not a $NAME the block sets and waits for`);
      return;
    }
    const lastBefore = (match: (l: string) => boolean): number => {
      for (let j = i - 1; j >= 0; j -= 1) if (match(lines[j] ?? '')) return j;
      return -1;
    };
    const set = lastBefore((l) => l.startsWith(`${name}=`));
    const wait = lastBefore((l) => CHAIN_WAIT(name).test(l));
    if (wait < 0 || wait < set) {
      problems.push(
        `line ${block.line + i}: postRound without a wait for the chain to reach round $${name}'s time after ${name}= ` +
          '(an estimate at the latest block refuses it: RoundNotYet)',
      );
    }
  });
  return problems;
}

/**
 * The spec hash of `file`'s spec at the runbook's example time (F80): the file's own while it holds that time (or none is
 * named), else its spec with the example's openAt. Step 0 rewrites the file for the founder's time; Step 2's row stays
 * the example's, and still guards every other field of the spec.
 */
function specHashAt(file: SpecFile, example: number | undefined): string {
  if (example === undefined || file.openAt === example || file.encoded === undefined) return file.specHash;
  return specHash({ ...decodeBoxSpecV1(file.encoded as Hex), openAt: example });
}

/** Every way the runbook's commands disagree with the build its settings choose (empty: none). */
function runbookBuildProblems(text: string, spec: (path: string) => SpecFile = readSpec): string[] {
  const problems: string[] = [];
  const { build, spec: specPath } = settingsOf(text);
  const file = spec(specPath);
  if ((file.build ?? 'mainnet') !== build.name) {
    problems.push(`Z3's ${specPath} is the ${file.build ?? 'mainnet'} build's file, Z0 chooses the ${build.name} build`);
  }
  // The row opens with the founder's value (Step 0's), then the example time's hash (review of the merge of main).
  const hash = text.match(/^\| `spec hash:` \| The one Step 0 printed \(example time: `(0x[0-9a-f]{64})`/m)?.[1];
  const example = text.match(/^\| `openAt \(Unix seconds, UTC\):` \|[^\n]*\(the example: `(\d+)`/m)?.[1];
  const expected = specHashAt(file, example === undefined ? undefined : Number(example));
  if (hash !== expected) {
    const at = expected === file.specHash ? '' : ` at the example's openAt ${example} (the file holds ${file.openAt})`;
    problems.push(`Step 2 expects spec hash ${hash}, ${specPath} has ${expected}${at}`);
  }
  const printed = text.match(/`build profile: ([a-z]+)/)?.[1];
  if (printed !== undefined && printed !== build.name) problems.push(`Step 2 expects build profile ${printed}`);
  const raise = text.match(/`raise, bootstrap \(wei\): (\d+)\s+(\d+)`/);
  if (raise && (BigInt(raise[1] ?? '') !== build.values.RAISE || BigInt(raise[2] ?? '') !== build.values.BOOTSTRAP_ETH)) {
    problems.push(`Step 2 expects raise and bootstrap ${raise[1]} ${raise[2]}, not the ${build.name} build's`);
  }
  const p1 = boxCurve(build.values.RAISE, false).sqrtPriceEndX96;
  const fill = fillOf(build);
  for (const block of shBlocks(text)) {
    for (const m of block.body.matchAll(/\bP1=(\d+)\b/g)) {
      if (BigInt(m[1] ?? '') !== p1) problems.push(`block at line ${block.line}: P1=${m[1]}, the ${build.name} build's is ${p1}`);
    }
    for (const m of block.body.matchAll(/--value[ =]([0-9.]+)ether\b/g)) {
      if (weiOf(m[1] ?? '') > fill) {
        problems.push(`block at line ${block.line}: --value ${m[1]}ether, more than fills the ${build.name} build's curve`);
      }
    }
    for (const m of block.body.matchAll(/\(true,-(\d+),/g)) {
      if (BigInt(m[1] ?? '') > fill) {
        problems.push(`block at line ${block.line}: a buy of ${m[1]} wei, more than fills the ${build.name} build's curve`);
      }
    }
    problems.push(...pasteProblems(block), ...postRoundProblems(block));
  }
  return problems;
}

/** A runbook's settings and Step 2 for `build`, with `extra` as one more sh block. */
function snippet(build: BuildProfile, extra: string): string {
  const rehearsal = build.name === 'rehearsal';
  const file = rehearsal ? 'script/config/box0-spec.11155111.rehearsal.json' : 'script/config/box0-spec.11155111.json';
  return [
    '```sh',
    ...(rehearsal ? ['export FOUNDRY_PROFILE=rehearsal'] : []),
    `export SPEC=${file}`,
    '```',
    '',
    `| \`spec hash:\` | The one Step 0 printed (example time: \`${readSpec(file).specHash}\`) |`,
    '',
    '```sh',
    extra,
    '```',
    '',
  ].join('\n');
}

/** The settings' spec file (SH-SEP-BOX0-SAFE): the rehearsal build's file with the Sepolia platform Safe as platform. */
const SETTINGS_FILE = 'script/config/box0-spec.11155111.rehearsal.sepolia-safe.json';

/** `file` as Step 0 writes it for the time `t` (F80), with `change` too: the spec at openAt `t`, its own hash. */
function atTime(file: SpecFile, t: number, change: Partial<BoxSpecV1> = {}): SpecFile {
  const spec = { ...decodeBoxSpecV1(file.encoded as Hex), ...change, openAt: t };
  return { ...file, openAt: t, specHash: specHash(spec), encoded: encodeBoxSpecV1(spec) };
}

/** A spec reader that returns `file` for the settings' file and the committed file otherwise. */
const reading = (file: SpecFile) => (path: string): SpecFile => (path === SETTINGS_FILE ? file : readSpec(path));

type Git = (...args: string[]) => { readonly status: number | null; readonly stdout: string };
const realGit: Git = (...args) => spawnSync('git', args, { cwd: repo(''), encoding: 'utf8' });

/** The branch the work merges into; the runbook names it "from the merge of sh-open-at-final on". */
const MERGE_TARGET = 'main';

/**
 * The release T14 runs from (SH-V21-RC7-INT open item 62; since SH-V21-RC8-INT open item 86 the rc8 tag, which holds
 * F143's sixteen-transaction deployment that Step 2 describes): the tag core-v21-rc8, checked out detached in a separate
 * release folder, so the founder's primary checkout is never switched. The tag goes on the head that carries this
 * runbook (the record's tag draft), so until it exists HEAD is read.
 */
const RELEASE_TAG = 'core-v21-rc8';
const RELEASE_FOLDER = '~/Claude/Projects/squarehole-sepolia';

/**
 * Where to read the checkout the settings name ("in a checkout of `<ref>`"; review of sh-open-at-final, finding 3).
 * Any ref as it is (a branch merged long ago, such as sh-sepolia-base, stays in this commit's history and still has no
 * Step 0), except `main`, which the runbook names from the merge that brings Step 0 on: while `main` is in this commit's
 * history, a --no-ff merge of this commit leaves `main` with this commit's tree, so HEAD is read; once `main` holds
 * commits this one lacks, `main` as it is. The release tag as it is once made, HEAD before. undefined: the ref is not in
 * this clone.
 */
function checkoutTree(ref: string, git: Git = realGit): string | undefined {
  const known = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).status === 0;
  if (ref === RELEASE_TAG) return known ? ref : 'HEAD';
  if (!known) return undefined;
  if (ref !== MERGE_TARGET) return ref;
  return git('merge-base', '--is-ancestor', ref, 'HEAD').status === 0 ? 'HEAD' : ref;
}

/** What a checkout at `tree` lacks for the runbook: Step 0's script and the clock-time hook (F80). */
function step0Problems(tree: string, git: Git = realGit): string[] {
  const problems: string[] = [];
  if (git('cat-file', '-e', `${tree}:packages/contracts/scripts/sepolia-open-at.sh`).status !== 0) {
    problems.push("no packages/contracts/scripts/sepolia-open-at.sh (Step 0's script)");
  }
  const hook = git('show', `${tree}:packages/contracts/src/box/BoxHook.sol`).stdout;
  if (!hook.includes('function openAt()')) problems.push('BoxHook has no openAt()');
  if (hook.includes('function openBlock()')) problems.push('BoxHook still has openBlock()');
  return problems;
}

describe('the Sepolia runbook follows the build its settings choose (F78)', () => {
  it(`${RUNBOOK.replace(repo(''), '')}: no command disagrees with its build`, () => {
    expect(existsSync(RUNBOOK)).toBe(true);
    const text = readFileSync(RUNBOOK, 'utf8');
    expect(runbookBuildProblems(text)).toEqual([]);
  });

  it('the default is the rehearsal build, with its spec file naming the Sepolia platform Safe (F78; SH-SEP-BOX0-SAFE)', () => {
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const { build, spec } = settingsOf(text);
    expect(build.name).toBe('rehearsal');
    expect(spec).toBe(SETTINGS_FILE);
    // Core v2 is deployed only on a box 0 whose platform is its platform Safe: the file's z3 says so.
    expect((JSON.parse(readFileSync(contracts(spec), 'utf8')) as { z3: string }).z3).toBe('sepolia-safe');
  });

  it("each build's curve end: tick 177,180 (mainnet) and 200,220 (rehearsal)", () => {
    expect(boxCurve(BUILD_PROFILE_MAINNET.values.RAISE, false).tickLower).toBe(177_180);
    expect(boxCurve(BUILD_PROFILE_REHEARSAL.values.RAISE, false).tickLower).toBe(200_220);
    // sh-life-run's fill sections (written for the mainnet build) name this P1.
    expect(boxCurve(BUILD_PROFILE_MAINNET.values.RAISE, false).sqrtPriceEndX96).toBe(557316679617586024814736431134799n);
    // The runbook's fill sections at the rehearsal build's sizes (F80) name this P1.
    expect(boxCurve(BUILD_PROFILE_REHEARSAL.values.RAISE, false).sqrtPriceEndX96).toBe(1763535759953844042750390480595831n);
  });

  it("the runbook's P1 is the rehearsal curve's end, tick 200,220 (a buy lowers the tick; 227,100 is its start)", () => {
    // ETH is currency0, so box 0's T is currency1 (tIsC0 false): the curve starts at its upper tick (P0) and a buy
    // (zeroForOne) lowers the price to its lower tick (P1), where the curve closes. P1 is the buys' price limit.
    const curve = boxCurve(BUILD_PROFILE_REHEARSAL.values.RAISE, false);
    expect([curve.tickStart, curve.tickEnd]).toEqual([227_100, 200_220]);
    expect(curve.sqrtPriceStartX96).toBe(getSqrtPriceAtTick(227_100));
    expect(curve.sqrtPriceEndX96).toBe(getSqrtPriceAtTick(200_220));
    expect(curve.sqrtPriceEndX96).toBeLessThan(curve.sqrtPriceStartX96);
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const named = [...text.matchAll(/^P1=(\d+)$/gm)].map((m) => BigInt(m[1] ?? ''));
    expect(named).toEqual([1763535759953844042750390480595831n]);
    // The setup line's check names the same tick: "it must be `200220`".
    expect(text).toContain('it must be\n`200220`');
  });

  it('refuses a full-size fill under the rehearsal settings, and accepts it scaled', () => {
    const fullSize = [
      'P1=557316679617586024814736431134799',
      'cast send $ROUTER "buy(uint256)" 30000000000000000 --value 0.03ether',
      'cast send $SWAPTEST "$SWAP" "$KEY" "(true,-2400000000000000000,$P1)" "(false,false)" 0x --value 2.4ether',
      'cast send $SWAPTEST "$SWAP" "$KEY" "(true,-2000000000000000000,$P1)" "(false,false)" 0x --value 2ether',
    ].join('\n');
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_MAINNET, fullSize))).toEqual([]);
    const refused = runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, fullSize));
    expect(refused).toHaveLength(5);
    expect(refused[0]).toContain('P1=557316679617586024814736431134799');
    const p1 = boxCurve(BUILD_PROFILE_REHEARSAL.values.RAISE, false).sqrtPriceEndX96;
    const scaled = [
      `P1=${p1}`,
      'cast send $ROUTER "buy(uint256)" 3000000000000000 --value 0.003ether',
      'cast send $SWAPTEST "$SWAP" "$KEY" "(true,-240000000000000000,$P1)" "(false,false)" 0x --value 0.24ether',
      'cast send $SWAPTEST "$SWAP" "$KEY" "(true,-200000000000000000,$P1)" "(false,false)" 0x --value 0.2ether',
    ].join('\n');
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, scaled))).toEqual([]);
  });

  it("refuses settings whose spec file is the other build's, and Step 2's figures of the other build", () => {
    const mixed = snippet(BUILD_PROFILE_REHEARSAL, 'echo').replace(
      'box0-spec.11155111.rehearsal.json',
      'box0-spec.11155111.json',
    );
    const problems = runbookBuildProblems(mixed);
    expect(problems.some((p) => p.includes("mainnet build's file"))).toBe(true);
    const raise = `${snippet(BUILD_PROFILE_REHEARSAL, 'echo')}\`raise, bootstrap (wei): 4206980085000000000\n1500000000000000\`\n`;
    expect(runbookBuildProblems(raise)).toHaveLength(1);
  });

  it('refuses a note after # and an open quote in an sh block (they do not paste into zsh)', () => {
    const noted = snippet(BUILD_PROFILE_REHEARSAL, "export WALLET=0x1F14  # the deployer's wallet\nexport X=1");
    const problems = runbookBuildProblems(noted);
    expect(problems.some((p) => p.includes("a note after '#'"))).toBe(true);
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, "echo 'open"))).toHaveLength(1);
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, "echo '#ok' \"#ok\""))).toEqual([]);
  });

  it('refuses a placeholder <word> outside quotes in an sh block: zsh reads it as a redirection (review of the merge, Step 5)', () => {
    // Step 5 as it was: zsh stops at `no such file or directory: registry` and runs nothing; `zsh -n` parses it.
    const placeholder = snippet(BUILD_PROFILE_REHEARSAL, 'SH_CORE_V1_REGISTRY=<registry> forge test --fork-url $RPC');
    const problems = runbookBuildProblems(placeholder);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("a placeholder '<registry>' outside quotes");
    // Quoted, a variable set in the block, a here-string or a comparison: accepted.
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, "echo '<registry>' \"<registry>\""))).toEqual([]);
    const set = 'export REGISTRY=0xe66f490d091742bEfF7a97646f04A916AD124F03\nSH_CORE_V1_REGISTRY=$REGISTRY forge test';
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, set))).toEqual([]);
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, 'cast call $X <<< 1\n[ 1 -lt 2 ] && echo $((1<2))'))).toEqual([]);
  });

  it('the deploy part picks the opening time in one command, after the settings and the build, before Step 1 (F80)', () => {
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const picks = shBlocks(text).filter((b) => b.body.includes('sepolia-open-at.sh'));
    expect(picks).toHaveLength(1);
    const pick = picks[0] as ShBlock;
    // One line: the command and the UTC time the founder types (Z: UTC, never a local time).
    expect(pick.body).toMatch(/^scripts\/sepolia-open-at\.sh \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z\n$/);
    const lineOf = (needle: string): number => text.slice(0, text.indexOf(needle)).split('\n').length;
    const settings = shBlocks(text).find((b) => /^export SPEC=/m.test(b.body)) as ShBlock;
    const build = shBlocks(text).find((b) => b.body === 'forge build\n') as ShBlock;
    expect(settings.line).toBeLessThan(pick.line);
    expect(build.line).toBeLessThan(pick.line);
    expect(pick.line).toBeLessThan(lineOf('## Step 1'));
    expect(text).toContain('## Step 0: pick the opening time');
  });

  it('F1 waits for the open and the fill (F3) for the window end, openAt + 384 s, before sending (F80)', () => {
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const section = (heading: string): ShBlock => {
      const at = text.indexOf(`\n### ${heading}`);
      expect(at, heading).toBeGreaterThan(0);
      const first = shBlocks(text).find((b) => text.split('\n').slice(0, b.line - 1).join('\n').length > at);
      if (first === undefined) throw new Error(`no block after ${heading}`);
      return first;
    };
    const wait = (name: string): string =>
      `until [ "$(cast block latest --field timestamp --rpc-url $RPC)" -ge "$${name}" ]; do sleep 3; done`;
    const f1 = section('F1 ');
    const f3 = section('F3 ');
    expect(f1.body.split('\n')[0]).toBe(wait('OPEN'));
    expect(f3.body.split('\n')[0]).toBe(wait('END'));
    // $END is the hook's windowEndsAt (openAt + WINDOW_SECONDS, 32 steps of 12 s), set once per terminal.
    expect(text).toContain("END=$(c $HOOK 'windowEndsAt()(uint256)')");
  });

  it("Step 2's spec hash is the example time's: the committed file passes, and so does the founder's after Step 0 (review of sh-open-at-final, finding 1)", () => {
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    // The checkout's own file passes, whichever time it holds (the example, or the founder's once recorded).
    expect(runbookBuildProblems(text)).toEqual([]);
    // Both files made from it: the example's (2026-10-06 11:00 UTC, the time the row is for) and Step 0's for 2026-10-05
    // 09:00 UTC (the sample dry run's time): another openAt and hash, nothing else changed.
    const checkout = readSpec(SETTINGS_FILE);
    const exampleAt = Number(text.match(/\(the example: `(\d+)`/)?.[1]);
    expect(exampleAt).toBe(1_791_284_400);
    const example = atTime(checkout, exampleAt);
    const founder = atTime(checkout, 1_791_190_800);
    expect(founder.specHash).not.toBe(example.specHash);
    expect(runbookBuildProblems(text, reading(example))).toEqual([]);
    expect(runbookBuildProblems(text, reading(founder))).toEqual([]);
    // A file that differs in anything but the time is still refused: the row guards the spec.
    const renamed = atTime(checkout, 1_791_190_800, { tokenName: 'Rehearsal Token 4' });
    expect(runbookBuildProblems(text, reading(renamed))).toEqual([expect.stringContaining('Step 2 expects spec hash')]);
    // The row is the example time's: the founder's hash there is refused, with either file.
    const pinned = text.replace(example.specHash, founder.specHash);
    expect(pinned).not.toBe(text);
    expect(runbookBuildProblems(pinned, reading(example))).toEqual([expect.stringContaining('Step 2 expects spec hash')]);
    expect(runbookBuildProblems(pinned, reading(founder))).toEqual([expect.stringContaining('Step 2 expects spec hash')]);
  });

  it('the checkout the settings name has Step 0 and the clock-time hook (review of sh-open-at-final, finding 3)', ({ skip }) => {
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const ref = text.match(/in a checkout of `([^`]+)`/)?.[1];
    expect(ref, 'the settings name the checkout ("in a checkout of `<branch>`")').toBeDefined();
    // T14 runs from the release tag in its own folder (SH-V21-RC7-INT open item 62).
    expect(ref).toBe(RELEASE_TAG);
    const tree = checkoutTree(ref ?? '');
    // A clone without that branch (or after it was deleted) cannot check it here.
    if (tree === undefined) skip(`${ref} is not in this clone`);
    expect(step0Problems(tree ?? ''), `a checkout of ${ref} (read at ${tree})`).toEqual([]);
  });

  it('the release tag holds the code Step 2 describes, and every runbook that runs from it names that tag (F143; rc8 part 2c review, open item 86)', () => {
    // Step 2's table is F143's sixteen-transaction deployment (row 14, box 0 on its BoxBackedSource): a release tag
    // without that source would deploy other addresses than the table, and T14 would stop at Step 2.
    const v1 = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    expect(v1).toContain('| 14 | BoxBackedSource (through the CREATE2 deployer; F143) |');
    const tree = checkoutTree(RELEASE_TAG) ?? '';
    expect(realGit('cat-file', '-e', `${tree}:packages/contracts/src/box/randomness/BoxBackedSource.sol`).status,
      `${RELEASE_TAG} (read at ${tree}) has no BoxBackedSource`).toBe(0);
    // Both Sepolia runbooks run from that one tag and name no other release candidate; the mainnet runbook's candidate
    // (which reads box 0 through its backed source, steps 7 and 9) is the same release.
    const v2 = readFileSync(repo('docs/runbooks/sepolia-core-v2.md'), 'utf8');
    for (const text of [v1, v2]) expect([...new Set(text.match(/core-v21-rc\d+/g))]).toEqual([RELEASE_TAG]);
    const mainnet = readFileSync(repo('docs/runbooks/mainnet-launch.md'), 'utf8');
    expect(mainnet.match(/\*\*Candidate:\*\* the tagged release `([^`]+)`/)?.[1]).toBe(RELEASE_TAG);
  });

  it("the runbook's `main` is read as merging this commit leaves it; any other ref as it is (merge of sh-open-at-final into main)", () => {
    const stub = (refs: readonly string[], ancestors: ReadonlyArray<readonly [string, string]>): Git => (...args) => {
      if (args[0] === 'rev-parse') return { status: refs.some((r) => args.includes(`${r}^{commit}`)) ? 0 : 1, stdout: '' };
      if (args[0] === 'merge-base') return { status: ancestors.some(([a, d]) => args[2] === a && args[3] === d) ? 0 : 1, stdout: '' };
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    // Before the merge: main is in this commit's history, so a --no-ff merge gives main this commit's tree.
    expect(checkoutTree('main', stub(['main'], [['main', 'HEAD']]))).toBe('HEAD');
    // On main itself (HEAD is main): the same tree.
    expect(checkoutTree('main', stub(['main'], [['main', 'HEAD'], ['HEAD', 'main']]))).toBe('HEAD');
    // main moved on without this commit, or this commit is behind main: main as it is.
    expect(checkoutTree('main', stub(['main'], []))).toBe('main');
    expect(checkoutTree('main', stub(['main'], [['HEAD', 'main']]))).toBe('main');
    // Any other ref as it is, even one in this commit's history (sh-sepolia-base, merged into main long ago).
    expect(checkoutTree('sh-sepolia-base', stub(['sh-sepolia-base'], [['sh-sepolia-base', 'HEAD']]))).toBe('sh-sepolia-base');
    expect(checkoutTree('sh-open-at-final', stub(['sh-open-at-final'], [['sh-open-at-final', 'HEAD']]))).toBe('sh-open-at-final');
    // Not in this clone.
    expect(checkoutTree('main', stub([], []))).toBeUndefined();
    // The release tag: as it is once made; before, HEAD (the tag goes on the head carrying this runbook).
    expect(checkoutTree(RELEASE_TAG, stub([RELEASE_TAG], []))).toBe(RELEASE_TAG);
    expect(checkoutTree(RELEASE_TAG, stub([], []))).toBe('HEAD');
  });

  it('a checkout of sh-sepolia-base is refused although this commit descends from it: no Step 0, opens by block (finding 3)', ({ skip }) => {
    if (realGit('rev-parse', '--verify', '--quiet', 'sh-sepolia-base^{commit}').status !== 0) skip('sh-sepolia-base is not in this clone');
    expect(realGit('merge-base', '--is-ancestor', 'sh-sepolia-base', 'HEAD').status).toBe(0);
    expect(checkoutTree('sh-sepolia-base')).toBe('sh-sepolia-base');
    expect(step0Problems('sh-sepolia-base')).toEqual([
      "no packages/contracts/scripts/sepolia-open-at.sh (Step 0's script)",
      'BoxHook has no openAt()',
      'BoxHook still has openBlock()',
    ]);
  });

  it("Step 0's install is its own block before Step 0's line, for when Step 0 says the packages are not installed (the founder's default Node 23 is refused: engine-strict), with the engines' range (review of sh-open-at-final, finding 4; review of the merge)", () => {
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const lineOf = (needle: string): number => text.slice(0, text.indexOf(needle)).split('\n').length;
    const step0 = text.slice(text.indexOf('## Step 0'), text.indexOf('## Step 1'));
    const installs = shBlocks(text).filter((b) => b.body.includes('pnpm install'));
    expect(installs.map((b) => b.body)).toEqual([
      '(cd ../.. && PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH" pnpm install --frozen-lockfile)\n',
    ]);
    const install = installs[0] as ShBlock;
    const pick = shBlocks(text).find((b) => b.body.includes('sepolia-open-at.sh')) as ShBlock;
    expect(install.line).toBeGreaterThan(lineOf('## Step 0'));
    expect(install.line).toBeLessThan(pick.line);
    // Headed with the words Step 0 refuses with (scripts/sepolia-open-at.sh).
    expect(step0).toContain('Only if Step 0 says the packages are not installed (once)');
    expect(readFileSync(contracts('scripts/sepolia-open-at.sh'), 'utf8')).toContain("the repository's packages are not installed");
    expect(step0).toContain('Node ^22.23.4, ^24.22.1 or >=26.12.1');
    expect(step0).not.toMatch(/Node 22 or later/);
    // The range is the repository's engines (with .npmrc's engine-strict).
    const engines = (JSON.parse(readFileSync(repo('package.json'), 'utf8')) as { engines: { node: string } }).engines.node;
    expect(engines).toBe('^22.23.4 || ^24.22.1 || >=26.12.1');
    expect(readFileSync(repo('.npmrc'), 'utf8')).toMatch(/^engine-strict=true$/m);
  });

  it('the first block goes to the release folder at the tag, before the settings (review of the merge; SH-V21-RC7-INT open item 62)', () => {
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const blocks = shBlocks(text);
    const settings = blocks.find((b) => /^export SPEC=/m.test(b.body)) as ShBlock;
    const lines = blocks[0]?.body.split('\n') ?? [];
    expect(lines[0]).toBe(`cd ${RELEASE_FOLDER}/packages/contracts`);
    // HEAD is the tag, and the Safe file names the founder's Safe (the file's own platform).
    expect(lines).toContain('git describe --tags --exact-match');
    const platform = (JSON.parse(readFileSync(contracts(SETTINGS_FILE), 'utf8')) as { platform: string }).platform;
    expect(platform).toBe('0x9432380a67745b453886698F9539aC035DF80B34');
    expect(lines).toContain(`grep -c '"platform": "${platform}"' ${SETTINGS_FILE}`);
    const after = text.slice(text.indexOf('## Open a terminal'), text.indexOf('## The settings')).replace(/\s+/g, ' ');
    expect(after).toContain(`prints \`${RELEASE_TAG}\``);
    expect(after).toContain(`\`${RELEASE_FOLDER}\``);
    // The primary checkout is never switched: no block or line tells the founder to switch or detach it.
    expect(text).not.toContain('git switch');
    expect(text).not.toContain('cd ~/Claude/Projects/squarehole/');
    expect(blocks[0]?.line).toBeLessThan(text.slice(0, text.indexOf('## The settings')).split('\n').length);
    expect(blocks[0]?.line).toBeLessThan(settings.line);
  });

  it("Step 5's block sets the registry it reads: Step 2's `registry:`, the once-per-terminal block's (review of the merge)", () => {
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const step5 = text.slice(text.indexOf('## Step 5'), text.indexOf('## Costs'));
    const verifier = shBlocks(text).filter((b) => b.body.includes('BoxCoreConformanceDeployedTest'));
    expect(verifier).toHaveLength(1);
    const lines = (verifier[0] as ShBlock).body.split('\n');
    const registry = text.match(/^\| `factory:` \/ `registry:` \| `0x[0-9a-fA-F]{40}` \/ `(0x[0-9a-fA-F]{40})` \|$/m)?.[1];
    expect(registry).toBeDefined();
    expect(lines[0]).toBe(`export REGISTRY=${registry}`);
    expect(lines[1]).toMatch(/^SH_CORE_V1_REGISTRY=\$REGISTRY forge test --match-contract BoxCoreConformanceDeployedTest /);
    expect(text).toContain(`\nexport REGISTRY=${registry}\nexport KEEPER=`);
    expect(step5).toContain("REGISTRY is the `registry:` line Step 3 printed; change it only if yours differs.");
  });

  it('refuses a postRound without a wait for the chain to reach its round (review of sh-sepolia-base)', () => {
    const round = "ROUND=$(cast call $DRAND 'requestOf(address,uint256)(uint64,uint64)' $TICKETS 1 --rpc-url $RPC)";
    const wait =
      'until [ "$(cast block latest --field timestamp --rpc-url $RPC)" -ge ' +
      '"$(python3 scripts/drand-round.py --time $ROUND)" ]; do sleep 3; done';
    const post =
      'cast send $DRAND \'postRound(uint256,bytes)\' $ROUND "$(python3 scripts/drand-round.py $ROUND --wait)" \\\n' +
      '  --rpc-url $RPC --private-key "$(key $KEEPER_KEYFILE)"';
    // The block as it was (G4 before this review): refused.
    const bare = runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, [round, post].join('\n')));
    expect(bare).toHaveLength(1);
    expect(bare[0]).toContain('postRound without a wait');
    // The wait before the round is known, or for another round: refused.
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, [wait, round, post].join('\n')))).toHaveLength(1);
    const other = wait.replace('--time $ROUND', '--time $ROUND0');
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, [round, other, post].join('\n')))).toHaveLength(1);
    // A literal round: refused.
    expect(
      runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, post.replace("' $ROUND \"", "' 32764772 \""))),
    ).toHaveLength(1);
    // The round, the wait, the post: accepted (and it pastes into zsh: no '#', quotes balanced).
    expect(runbookBuildProblems(snippet(BUILD_PROFILE_REHEARSAL, [round, wait, post].join('\n')))).toEqual([]);
    // Each of the runbook's posts (G2, G4) has its wait.
    const text = readFileSync(repo('docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const posts = shBlocks(text).filter((b) => b.body.includes('postRound('));
    expect(posts).toHaveLength(2);
    for (const b of posts) expect(postRoundProblems(b)).toEqual([]);
  });
});
