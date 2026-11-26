/**
 * The Sepolia runbook's Z1 = after (docs/runbooks/sepolia-core-v1.md; docs/evidence/SH-glamsterdam-after.md): core v1
 * deployed after Sepolia's Glamsterdam upgrade (2026-10-06 13:53:36 UTC) is one line (Z1, `true`), and the rest follows
 * from it:
 * - the unchanged block turns Z1 into forge's flags (`AFTER`), in zsh and bash alike: Foundry 1.8.3's runtime
 *   `--hardfork amsterdam` (forge charges EIP-8037's state gas when it sets the limits), the deploy script's own
 *   multiplier (`GAS_ESTIMATE_MULTIPLIER_AFTER`, which its block check assumes), a fee cap and a tip (each transaction
 *   first in its block: EIP-8037 includes one only while its whole limit fits the block's remaining state gas), and a
 *   10-minute wait per transaction; for `false` nothing;
 * - Steps 2 and 3 pass them to forge (Step 0 takes the chain's rules itself: scripts/sepolia-open-at.sh);
 * - Step 1 checks the upgrade on the latest and the finalized block against the script's GLAMSTERDAM_SEPOLIA;
 * - the deployer is funded from wallet 1 first (a transfer to it leaves its nonce, so every address stays);
 * - graduate() (F5) gets a limit well above its post-upgrade need (3,884,713 estimated on geth v1.17.7: 3,000,000 is
 *   refused, GasTooLow).
 * The review of d091e6bd (docs/evidence/SH-glamsterdam-after.md § Review) added: Z1 `true` by default (the founder
 * deploys after the upgrade); `RPC` is the settings block's fifth line and no later block puts it back (a node not
 * updated for the upgrade stops at the block before it, and the switch to another must hold); the unchanged block and
 * the life's setup print the chain's time beside the clock, so a stopped RPC shows before Step 0; 3.5 SepETH in the
 * deployer; the resume after the upgrade; F5 reads the receiver's settlement instead of a receipt placeholder.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const RUNBOOK = process.env.SH_RUNBOOK_FILE ?? repo('docs/runbooks/sepolia-core-v1.md');
const SCRIPT = repo('packages/contracts/script/DeployCoreV1.s.sol');

const text = readFileSync(RUNBOOK, 'utf8');
const script = readFileSync(SCRIPT, 'utf8');

/** A `uint256 public constant NAME = 1_234;` of the deploy script, as a number. */
function constantOf(name: string): number {
  const m = script.match(new RegExp(String.raw`uint256 public constant ${name} = ([0-9_]+);`));
  if (!m?.[1]) throw new Error(`DeployCoreV1.s.sol has no ${name}`);
  return Number(m[1].replaceAll('_', ''));
}

interface Block {
  readonly heading: string;
  readonly body: string;
}

/** The sh blocks with the heading (## or ###) above each. */
function blocks(): Block[] {
  const out: Block[] = [];
  let heading = '';
  for (const m of text.matchAll(/^(#{2,3}) ([^\n]+)$|^```sh\n([\s\S]*?)^```/gm)) {
    if (m[2] !== undefined) heading = m[2];
    else out.push({ heading, body: m[3] ?? '' });
  }
  return out;
}

const only = (found: Block[], what: string): Block => {
  expect(found, what).toHaveLength(1);
  return found[0] as Block;
};
const settings = () => only(blocks().filter((b) => /^export SPEC=/m.test(b.body)), 'the settings block');
const unchanged = () => only(blocks().filter((b) => /^export PLATFORM=/m.test(b.body) && b.body.includes('AFTER=')), 'the unchanged block');
const life = () => only(blocks().filter((b) => b.heading.startsWith('Once per terminal')), "the life's setup block");
/** The text from `from` to `to`, its line breaks and indents read as single spaces (the runbook wraps at 120). */
const section = (from: string, to: string) =>
  text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from))).replace(/\s+/g, ' ');
/** The public node the settings name (Step 1's alternative: the Tenderly gateway). */
const PUBLICNODE = 'https://ethereum-sepolia-rpc.publicnode.com';
const step = (n: number) => only(blocks().filter((b) => b.heading.startsWith(`Step ${n}:`)), `Step ${n}'s block`);
/** rc8 part 2c (open item 82): this code's deploy on its local rehearsal A, the sixteen transactions as the chain had them. */
interface DeployRow { readonly plannedLimit: bigint; readonly gasLimit: bigint; readonly gasUsed: bigint; readonly value: bigint }
function deployRows(): DeployRow[] {
  const [head, ...lines] = readFileSync(repo('docs/evidence/SH-V21-RC8-INT/part-2c-deploy.tsv'), 'utf8').trimEnd().split('\n');
  const cols = (head ?? '').split('\t');
  return lines.map((line) => {
    const cells = line.split('\t');
    const at = (name: string) => BigInt(cells[cols.indexOf(name)] ?? '');
    return { plannedLimit: at('planned_limit'), gasLimit: at('gas_limit'), gasUsed: at('gas_used'), value: at('value') };
  });
}

/** The unchanged block run in `shell` with Z1 = `ack` (from packages/contracts: it reads the spec file), AFTER printed. */
function afterOf(shell: 'zsh' | 'bash', ack: string): string[] {
  const body = `${unchanged().body}printf 'ARG|%s\\n' "\${AFTER[@]}"\n`;
  const r = spawnSync(shell, shell === 'zsh' ? ['-f', '-c', body] : ['--norc', '--noprofile', '-c', body], {
    cwd: repo('packages/contracts'),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      FOUNDRY_PROFILE: 'rehearsal',
      WALLET: '0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE',
      SPEC: 'script/config/box0-spec.11155111.rehearsal.json',
      SH_CORE_V1_GLAMSTERDAM_ACK: ack,
    },
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('ARG|'))
    .map((l) => l.slice(4))
    .filter((l) => l !== '');
}

describe("the runbook's Z1 = after: one line, and everything else follows from it (SH-glamsterdam-after)", () => {
  it("Z1 is the settings block's second line, `true` (after the upgrade, the founder's choice) by default", () => {
    const lines = settings().body.split('\n');
    expect(lines[1]).toBe('export SH_CORE_V1_GLAMSTERDAM_ACK=true');
    expect(lines.filter((l) => l.startsWith('export SH_CORE_V1_GLAMSTERDAM_ACK='))).toHaveLength(1);
    expect(text).toContain('`true` = after Sepolia');
    expect(text).toContain('`false` = before it');
  });

  it("RPC is the settings block's fifth line, and no later block puts it back (review of d091e6bd, findings 6 and 7)", () => {
    const lines = settings().body.split('\n');
    expect(lines[4]).toBe(`export RPC=${PUBLICNODE}`);
    const sets = blocks().flatMap((b) => b.body.split('\n').filter((l) => /^export RPC=/.test(l)).map((l) => ({ b, l })));
    expect(sets.map(({ l }) => l)).toEqual([`export RPC=${PUBLICNODE}`, `export RPC=\${RPC:-${PUBLICNODE}}`]);
    expect(sets[1]?.b.body).toBe(life().body);
    expect(unchanged().body).not.toMatch(/^export RPC=/m);
    // Step 1's switch is the settings line itself, so a new terminal's paste keeps it.
    expect(section('## Step 1', '## Step 2')).toContain("set the Z0-Z4 block's fifth line to `export RPC=https://sepolia.gateway.tenderly.co`");
  });

  it("the unchanged block and the life's setup print the chain's time beside the clock, so a stopped RPC shows before Step 0 (findings 6 and 7)", () => {
    const last = unchanged().body.trimEnd().split('\n').at(-1) ?? '';
    expect(last).toContain('$(cast block latest --field timestamp --rpc-url $RPC)');
    expect(last).toContain('$(date -u +%s)');
    const setupEcho = life().body.trimEnd().split('\n').at(-1) ?? '';
    expect(setupEcho).toMatch(/now \$\(cast block latest --field timestamp --rpc-url \$RPC\), clock \$\(date -u \+%s\)"$/);
    // Step 2's GlamsterdamTooClose: the hour before the upgrade by the founder's clock, a stopped RPC after it.
    const step2 = section('## Step 2', '## Step 3');
    expect(step2).toContain('With `GlamsterdamTooClose`: before 13:53:36 UTC by your clock');
    expect(step2).toContain('After it, `RPC` has stopped');
    expect(step2).toContain('`the measuring CREATE failed`');
  });

  it("the unchanged block turns Z1 = true into forge's Glamsterdam flags, with the script's own multiplier, in zsh and bash; Z1 = false into none", () => {
    const multiplier = constantOf('GAS_ESTIMATE_MULTIPLIER_AFTER');
    expect(multiplier).toBe(110);
    const want = [
      '--hardfork',
      'amsterdam',
      '--gas-estimate-multiplier',
      String(multiplier),
      '--with-gas-price',
      '10gwei',
      '--priority-gas-price',
      '2gwei',
      '--timeout',
      '600',
    ];
    for (const shell of ['zsh', 'bash'] as const) {
      expect(afterOf(shell, 'true'), shell).toEqual(want);
      expect(afterOf(shell, 'false'), shell).toEqual([]);
    }
  });

  it('Steps 2 and 3 pass the flags to forge script; Step 0 does not (it takes the chain\'s rules: --hardfork amsterdam from the upgrade on)', () => {
    for (const n of [2, 3]) {
      const body = step(n).body;
      expect(body, `Step ${n}`).toMatch(/forge script script\/DeployCoreV1\.s\.sol [^\n]*/);
      expect(body.trimEnd().endsWith('"${AFTER[@]}"'), `Step ${n} ends with the flags`).toBe(true);
    }
    expect(step(3).body).toContain('--slow --broadcast "${AFTER[@]}"');
    const step0 = only(blocks().filter((b) => b.body.startsWith('scripts/sepolia-open-at.sh ')), "Step 0's block");
    expect(step0.body).not.toContain('AFTER');
    const openAt = readFileSync(repo('packages/contracts/scripts/sepolia-open-at.sh'), 'utf8');
    expect(openAt).toContain(`GLAMSTERDAM_SEPOLIA=${constantOf('GLAMSTERDAM_SEPOLIA')}`);
    expect(openAt).toContain('HARDFORK=(--hardfork amsterdam)');
  });

  it("Step 1 checks the upgrade on the latest and the finalized block against the script's time, and the clock", () => {
    const g = String(constantOf('GLAMSTERDAM_SEPOLIA'));
    expect(g).toBe('1791294816');
    const body = step(1).body;
    expect(body).toContain('cast block latest --field timestamp --rpc-url $RPC\n');
    expect(body).toContain('date -u +%s\n');
    expect(body).toContain('cast block finalized --field timestamp --rpc-url $RPC\n');
    const section = text.slice(text.indexOf('## Step 1'), text.indexOf('## Step 2'));
    expect(section).toContain(`| finalized | | \`${g}\` or more`);
    // One comparison, said once: the chain's time from the fork on, the clock at most 60 above it (finding 9).
    expect(section).toContain(`| time (latest block) | below \`${Number(g) - 3_600}\` (one hour before the upgrade) | \`${g}\` or more |`);
    expect(section).toContain('| your clock | | at most 60 above the line above');
    expect(section).not.toContain('above the next line');
    // Z1 = before: below an hour before it (the script's GLAMSTERDAM_MARGIN, `1 hours`).
    expect(script).toContain('uint256 public constant GLAMSTERDAM_MARGIN = 1 hours;');
    expect(section).toContain(`below \`${constantOf('GLAMSTERDAM_SEPOLIA') - 3_600}\``);
  });

  it("the deployer is funded from wallet 1 before Z1 = after with room for a base fee up to about 6.7 gwei on this code's measured deploy, and the runbook says the transfer leaves its nonce (finding 3; rc8 part 2c)", () => {
    const fund = section('### Z1 = after: fund the deployer', 'Build it once');
    expect(fund).toContain('Send **3.35 SepETH from wallet 1**');
    expect(fund).toContain('does not change its nonce (13)');
    expect(section('## Step 1', '## Step 2')).toContain('`3.5` or more');
    // While it sends createBox (the last of sixteen), the deployer holds what the first fifteen paid (their gas at the
    // base fee plus the 2-gwei tip) and createBox's limit at the 10-gwei cap with its value: this code's deploy on its
    // local rehearsal A (rc8 part 2c), with createBox's limit as Step 2 plans it (its STEP line: the script plans a call
    // at or above a node's estimate; anvil set 46,615,990 there, geth 49,357,827 in R1, whose fifteen left 7 gwei).
    const rows = deployRows();
    expect(rows).toHaveLength(16);
    const last = rows[15] as DeployRow;
    expect(last.value).toBe(150_000_000_000_000n);
    const gwei = 10n ** 9n;
    expect(last.plannedLimit).toBeGreaterThanOrEqual(49_357_827n);
    expect(last.plannedLimit).toBeGreaterThanOrEqual(last.gasLimit);
    const reserve = last.plannedLimit * 10n * gwei + last.value;
    const funded = 3_500_000_000_000_000_000n;
    const firstFifteen = rows.slice(0, 15).reduce((a, r) => a + r.gasUsed, 0n);
    const coveredBaseFee = (funded - reserve) / firstFifteen - 2n * gwei;
    expect(coveredBaseFee).toBeGreaterThanOrEqual(6_700_000_000n);
    expect(coveredBaseFee).toBeLessThan(6_800_000_000n);
    expect(fund).toContain('while the base fee averages up to about 6.7 gwei over the deploy');
    expect(fund).not.toContain('about 7 gwei');
    // A refusal for funds stops the run, nothing sent: topped up from wallet 1, then resumed.
    expect(section('**If it stops part-way:**', '## Step 4')).toContain('`insufficient funds`');
  });

  it('a resume after the upgrade: the settings with Z1 `true` first, and the RPC is the first run\'s (finding 8)', () => {
    const stops = section('**If it stops part-way:**', '## Step 4');
    expect(stops).toContain('the Z0-Z4 block with Z1 `true` and the unchanged block; its first line must end `--timeout 600`');
    expect(stops).toContain('A resume sends through the RPC the first run used');
    expect(afterOf('zsh', 'true').slice(-2)).toEqual(['--timeout', '600']);
  });

  it('the checkout, Step 2\'s STEP lines and F5\'s check say what they show (findings 10, 11, 12)', () => {
    // Since F111 the checkout is main from the merge of sh-box0-r1-exact-draws on (later than sh-box0-stream-gas's of
    // F97 and sh-glamsterdam-after's), shown by BoxTickets' ticketInFlight() line (sepolia-runbook-box0-candidate.test.ts).
    expect(text).toContain('the merge of `sh-box0-r1-exact-draws`');
    const step2 = section('## Step 2', '## Step 3');
    expect(step2).not.toContain('line ends with its planned limit');
    expect(step2).toContain('just before its address, is the limit forge will set');
    const f5 = only(blocks().filter((b) => b.heading.startsWith('F5')), "F5's block");
    expect(f5.body).toContain("c $RECEIVER 'graduationSettled()(bool)'");
    expect(text).not.toContain('<graduate tx>');
  });

  it("graduate() (F5) gets at least 1.5 times its post-upgrade need (3,884,713 on geth v1.17.7 with POKE_GAS 1,000,000; since F95 the floor is box 0's candidate's, sepolia-runbook-box0-candidate.test.ts)", () => {
    const f5 = only(blocks().filter((b) => b.heading.startsWith('F5')), "F5's block");
    const limit = Number(f5.body.match(/'graduate\(\)' --gas-limit ([0-9]+) /)?.[1]);
    expect(limit).toBeGreaterThanOrEqual(Math.ceil(3_884_713 * 1.5));
    expect(limit).toBeLessThanOrEqual(16_777_216);
  });
});

// rc8 part 2b: the post-fork rehearsal (scripts/post-fork-rehearsal.sh) writes its zsh runners from this runbook with
// scripts/glamsterdam-after-rehearsal.py, which swaps the runbook's example registry for the rehearsal's own. Since
// F143's sixteen-transaction deployment that example is nonce 13's new registry (Step 2's table, Step 5, the
// once-per-terminal block), so the generator must expect it, or the life runner is never written.
describe('the rehearsal runners are written from this runbook (rc8 part 2b, the sixteen-transaction deployment)', () => {
  const generator = repo('packages/contracts/scripts/glamsterdam-after-rehearsal.py');
  const run = (args: string[]) => spawnSync('python3', ['-B', generator, ...args], { encoding: 'utf8', cwd: repo('packages/contracts') });

  it("the generator's example registry is the one Step 2's table, Step 5 and the once-per-terminal block name", () => {
    const example = /^EXAMPLE_REGISTRY = "(0x[0-9a-fA-F]{40})"$/m.exec(readFileSync(generator, 'utf8'))?.[1];
    expect(example).toBeDefined();
    const step2 = section('## Step 2', '## Step 3');
    expect(step2).toContain(`\` / \`${example}\``);
    expect([...text.matchAll(/^export REGISTRY=(0x[0-9a-fA-F]{40})$/gm)].map((m) => m[1])).toEqual([example, example]);
  });

  it('writes both runners for a rehearsal registry, the life runner with that registry everywhere', () => {
    const out = mkdtempSync(join(tmpdir(), 'sh-rehearsal-runners-'));
    const registry = '0x1234567890AbcdEF1234567890aBcdef12345678';
    const deploy = run(['deploy', '--rpc', 'http://127.0.0.1:8572', '--unlocked', '--script', 'real', '--open-at',
      '2026-10-21T06:00Z', '--min-lead', '900', '--fund', '3.35', '--platform-safe', `0x${'11'.repeat(20)}`, '--out', out]);
    expect(deploy.status, deploy.stderr).toBe(0);
    const life = run(['life', '--rpc', 'http://127.0.0.1:8572', '--unlocked', '--registry', registry, '--clock', 'fast',
      '--skip', 'G2,G3,G4,G6', '--probes', '--ledger-from', '2', '--out', out]);
    expect(life.status, life.stderr).toBe(0);
    const runner = readFileSync(join(out, 'life-runner.zsh'), 'utf8');
    // The once-per-terminal block, then Step 5's block at each of the verifier's four points.
    expect([...runner.matchAll(/^export REGISTRY=(0x[0-9a-fA-F]{40})$/gm)].map((m) => m[1])).toEqual(Array(5).fill(registry));
    expect(runner.match(/BoxCoreConformanceDeployedTest/g)).toHaveLength(4);
    expect(runner).not.toMatch(/0xe66f490d091742bEfF7a97646f04A916AD124F03|0xa94936CD8994FA94FA31bc1fC992586f2468bfcb/i);
  });

  it("the driver's last gate counts the deployed verifier's own tests (57 since F143's three backed-source checks), not a fixed 54", () => {
    const driver = readFileSync(repo('packages/contracts/scripts/post-fork-rehearsal.sh'), 'utf8');
    expect(driver).not.toMatch(/Suite result: ok\\\. [0-9]+ passed/);
    expect(driver).toContain('forge test --list --match-contract BoxCoreConformanceDeployedTest --json');
    expect(driver).toContain('Suite result: ok\\. $VERIFIER_TESTS passed; 0 failed');
    const backed = readFileSync(repo('packages/contracts/test/box/conformance/core/BackedSourceConformance.sol'), 'utf8');
    for (const name of ['test_BC053_backedSourceFixedAtCreation_noOwnerNoRestart', 'test_BC053_backedSourceDrandFirstThenBackupByRule',
      'test_BC053_backedSourceOneTargetPerRound']) expect(backed).toContain(`function ${name}(`);
  });
});

// rc8 part 2c (open item 80): the older fork rehearsal (scripts/core-v1-life-run.sh; it refuses to run since Sepolia's
// fork) reads box 0 as F143 has it, like the runbook's once-per-terminal block: the request on box 0's source (the
// BoxBackedSource), rounds posted and the bounty withdrawn on the DrandSource that source's DRAND() names.
describe("the older fork rehearsal reads box 0 through its backed source (rc8 open item 80, F143)", () => {
  const path = repo('packages/contracts/scripts/core-v1-life-run.sh');
  const life = readFileSync(path, 'utf8');

  it("takes the DrandSource from the source's DRAND() and stops on any other answer", () => {
    expect(life).toContain(`SOURCE="$(val "$BOX" 'randomness()(address)')"`);
    expect(life).toContain(`DRAND="$(val "$SOURCE" 'DRAND()(address)')"`);
    expect(life).toContain('[[ "$DRAND" =~ ^0x[0-9a-fA-F]{40}$ ]] || die');
    expect(life).not.toContain(`DRAND="$(val "$BOX" 'randomness()(address)')"`);
    expect(text).toContain("SOURCE=$(c $BOX 'randomness()(address)'); DRAND=$(c $SOURCE 'DRAND()(address)')");
  });

  it('reads the graduation request on the source, posts and withdraws on the DrandSource, and still parses', () => {
    expect(life).toContain(`cast call "$SOURCE" 'requestOf(address,uint256)(uint64,uint64)' "$TICKETS" 0`);
    expect(life).not.toContain(`cast call "$DRAND" 'requestOf(`);
    expect(life).toContain(`send "postRound-$round" "$DEPLOYER" - "$DRAND" 'postRound(uint256,bytes)'`);
    expect(life).toContain(`send withdrawBounty "$DEPLOYER" - "$DRAND" 'withdrawBounty(address)'`);
    const parsed = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    expect(parsed.status, parsed.stderr).toBe(0);
  });
});
