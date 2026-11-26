/**
 * The Sepolia runbook (docs/runbooks/sepolia-core-v1.md) against the code it deploys (F97; docs/evidence/
 * SH-box0-stream-gas.md § The review of 0bfeed8b, finding 1). F97 postponed the deploy: the one Sepolia deploy runs box
 * 0's mainnet candidate (OBSERVER_GAS 460,000 with the floor margin 10,000, POKE_GAS 2,600,000: F87, F90 R16H, F95
 * R19M; merged from sh-box0-stream-gas), after the runbook's revision for that code is rehearsed green end to end on a
 * local post-fork chain (docs/evidence/SH-box0-final-candidate.md, 2026-10-06: green). F111 (2026-10-07) changed that
 * code for R1 of the Codex review (each draw earns from its own request; docs/evidence/SH-box0-r1.md, merged from
 * sh-box0-r1-exact-draws) and holds T14 until the runbook is rehearsed again for it (SH-box0-r1 review round 1,
 * finding 2). Rehearsals A, B and C passed for R1 (SH-box0-r1 § The rehearsal of this candidate). So:
 * - the runbook says ready for the founder's Sepolia deploy T14, cites R1's rehearsal for its measured figures, and
 *   keeps the earlier candidate's rehearsal (F97) as history;
 * - its checkout holds `main` from the merge of sh-box0-r1-exact-draws on, and the checkout block shows it (BoxTickets'
 *   `ticketInFlight()` line, which only R1's code has; BoxCoordinator's POKE_GAS line, the check before R1, is also on a
 *   `main` without R1, whose Step 2 prints the earlier ids: SH-box0-r1 review round 1, finding 1); since SH-V21-RC7-INT
 *   open item 62 that checkout is the release folder at the release tag (core-v21-rc8 since SH-V21-RC8-INT open
 *   item 86), not the founder's primary checkout;
 * - F5 sends graduate() with at least the least gas it needs when all four follow-ups burn their whole budget after
 *   Glamsterdam (12,913,551 as a transaction, Foundry from cold; F5's 6,000,000 is refused, GasTooLow, when the
 *   settlement is the box's first batch with T pending: 6,168,507), under EIP-7825's 16,777,216; the waits-and-costs
 *   table names the same limit;
 * - F5's text gives each follow-up POKE_GAS as BoxCoordinator.sol and box-spec.v1.json have it, and no older value;
 * - G7 is the keeper of F95 R19U and F96 R19G, one block the founder leaves running, on box-spec's constants; G6 holds a
 *   Misfit transfer (the observer cap of F87 and F90 R16H).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const RUNBOOK = process.env.SH_RUNBOOK_FILE ?? repo('docs/runbooks/sepolia-core-v1.md');
const text = readFileSync(RUNBOOK, 'utf8');
const coordinator = readFileSync(repo('packages/contracts/src/box/BoxCoordinator.sol'), 'utf8');
const tickets = readFileSync(repo('packages/contracts/src/box/BoxTickets.sol'), 'utf8');
const spec = JSON.parse(readFileSync(repo('packages/box-spec/box-spec.v1.json'), 'utf8')) as {
  readonly constants: ReadonlyArray<{ readonly name: string; readonly value: string }>;
};

/** graduate()'s least transaction after Glamsterdam with all four follow-ups burning their budget (SH-box0-stream-gas § F95). */
const LEAST_ALL_BURNING_AFTER_GLAMSTERDAM = 12_913_551;
/** EIP-7825's per-transaction cap. */
const TX_GAS_CAP = 16_777_216;

const grouped = (n: number) => n.toLocaleString('en-US');
/** rc8 part 2c (open item 82): this code's deploy on its local rehearsal A, the sixteen transactions as the chain had them. */
const DEPLOY_TSV = repo('docs/evidence/SH-V21-RC8-INT/part-2c-deploy.tsv');
/** The same rehearsal's Step 2, the runbook's dry run, as forge printed it. */
const DRY_RUN = repo('docs/evidence/SH-V21-RC8-INT/part-2c-dry-run.txt');
const GWEI = 10n ** 9n;
const BOOTSTRAP = 150_000_000_000_000n;
/** Step 3's row names, in the deploy's order (the runbook's own words for the dry run's STEP lines). */
const ROW_LABELS = ['BoxCoordinator (implementation)', 'BoxHookExtension', 'BoxHook (implementation)', 'BoxLaunchRouter (implementation)',
  'BoxReceiverExtension', 'BoxReceiver (implementation)', 'BoxCollection (implementation)', 'BoxVault (implementation)',
  'BoxTickets (implementation)', 'BoxRoyaltyRouter (implementation)', 'BoxItemStream (implementation)', 'BoxFactoryV1Planner',
  'the DrandSource', 'the BoxBackedSource', 'the factory and its registry', '`createBox`'];
interface DeployRow { readonly row: number; readonly label: string; readonly plannedLimit: bigint; readonly gasLimit: bigint; readonly gasUsed: bigint; readonly status: string }
function deployRows(): DeployRow[] {
  const [head, ...lines] = readFileSync(DEPLOY_TSV, 'utf8').trimEnd().split('\n');
  const cols = (head ?? '').split('\t');
  const at = (cells: string[], name: string) => cells[cols.indexOf(name)] ?? '';
  return lines.map((line) => {
    const cells = line.split('\t');
    const row = Number(at(cells, 'row'));
    return { row, label: ROW_LABELS[row - 1] ?? '', plannedLimit: BigInt(at(cells, 'planned_limit')), gasLimit: BigInt(at(cells, 'gas_limit')), gasUsed: BigInt(at(cells, 'gas_used')), status: at(cells, 'status') };
  });
}
/** `wei` with `decimals` decimals, as a decimal string; `places` rounds half up (no trailing zeros dropped then). */
function decimal(wei: bigint, decimals: number, places?: number): string {
  const unit = 10n ** BigInt(decimals);
  if (places === undefined) {
    const frac = (wei % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${wei / unit}${frac ? `.${frac}` : ''}`;
  }
  const step = 10n ** BigInt(decimals - places);
  const rounded = (wei + step / 2n) / step;
  const p = 10n ** BigInt(places);
  return `${rounded / p}.${(rounded % p).toString().padStart(places, '0')}`;
}
/** Gas in millions, rounded half up to `places` decimals ("48.3"; "382"). */
const millions = (gas: bigint, places: number): string => (places === 0 ? String((gas + 500_000n) / 1_000_000n) : decimal(gas, 6, places));
/** The text from `from` to `to`, its line breaks and indents read as single spaces (the runbook wraps at 120). */
const section = (from: string, to: string) => {
  const at = text.indexOf(from);
  expect(at, `the runbook has ${from}`).toBeGreaterThanOrEqual(0);
  return text.slice(at, text.indexOf(to, at)).replace(/\s+/g, ' ');
};
/** The sh blocks, in order. */
const shBlocks = () => [...text.matchAll(/^```sh\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? '');

/** BoxCoordinator's POKE_GAS source line and value. */
function pokeGas(): { readonly line: string; readonly value: number } {
  const m = coordinator.match(/^ *(uint256 public constant POKE_GAS = ([0-9_]+);)$/m);
  if (!m?.[1] || !m[2]) throw new Error('BoxCoordinator.sol has no POKE_GAS');
  return { line: m[1], value: Number(m[2].replaceAll('_', '')) };
}

/** The text the checkout block counts in BoxTickets.sol: the in-flight view R1 added (SH-box0-r1), on exactly one line. */
function inFlightView(): string {
  const needle = 'function ticketInFlight()';
  const lines = tickets.split('\n').filter((l) => l.includes(needle));
  if (lines.length !== 1) throw new Error(`BoxTickets.sol has ${lines.length} lines with ${needle}, not 1`);
  return needle;
}

describe("the runbook against box 0's mainnet candidate (F97, F111)", () => {
  it('POKE_GAS is 2,600,000 in BoxCoordinator.sol and box-spec.v1.json (F95 R19M)', () => {
    expect(pokeGas().value).toBe(2_600_000);
    expect(spec.constants.find((c) => c.name === 'POKE_GAS')?.value).toBe(String(pokeGas().value));
  });

  it("says ready for the founder's Sepolia deploy T14 after R1's rehearsal (F111), and keeps F97 as history", () => {
    const status = section('**Status:**', '## In plain words');
    expect(status).toMatch(/^\*\*Status:\*\* \*\*ready for the founder's Sepolia deploy T14\*\*, \*\*not broadcast\*\*/);
    expect(text).not.toContain('not ready: R1 rehearsal pending');
    expect(text).not.toContain("until R1's rehearsal");
    for (const d of [
      'F111',
      'T14',
      '`sh-box0-r1-exact-draws`',
      'A (fork-warped), B (devnet) and C (fork-live)',
      '54 of 54 four times on each',
      'The rehearsal of this candidate (F111)',
    ]) {
      expect(status).toContain(d);
    }
    expect(status).toContain('[SH-box0-r1](../evidence/SH-box0-r1.md)');
    expect(existsSync(repo('docs/evidence/SH-box0-r1.md'))).toBe(true);
    for (const d of ['F97', '`sh-box0-stream-gas`', 'local post-fork chains', 'Z1 = after', 'F95 R19U', 'F96 R19G']) {
      expect(status).toContain(d);
    }
    expect(status).toContain('[SH-box0-final-candidate](../evidence/SH-box0-final-candidate.md)');
    expect(existsSync(repo('docs/evidence/SH-box0-final-candidate.md'))).toBe(true);
  });

  it("cites R1's measured draw and wallet figures where they stand (SH-box0-r1); the deploy's are this code's (rc8 part 2c, below)", () => {
    const lines = text.split('\n');
    for (const [start, figures] of [
      ["| Box 0's life after the deploy", ['5,052,644', '5,145,858', '11,314,461', '11,214,010']],
      ['| G4 draw', ['720,762', '727,440', '825,394', '380,958', '180,123', '179,324', '31,342']],
    ] as const) {
      const rows = lines.filter((l) => l.startsWith(start));
      expect(rows, start).toHaveLength(1);
      for (const figure of figures) expect(rows[0], start).toContain(figure);
      expect(rows[0], start).toMatch(/\]\(\.\.\/evidence\/SH-box0-r1(?:\.md|\/)/);
    }
    const g4 = section('### G4', '### G5');
    for (const figure of ['720,762', '+110,116', '727,440 (B)', '825,394 (C)']) expect(g4).toContain(figure);
    expect(g4).toContain('../evidence/SH-box0-r1.md');
    const perWallet = section('Per wallet (', '**wallet 1');
    for (const figure of ['5,052,644 (B)', '5,145,858 (C)', '11,314,461 (B)', '11,214,010 (C)']) {
      expect(perWallet).toContain(figure);
    }
    expect(perWallet).toContain('../evidence/SH-box0-r1.md');
  });

  it("Step 2's dry-run lines, Step 3's Z1 = after gas and limits, the costs and the plain-words figures are this code's measured deploy (rc8 part 2c, open item 82)", () => {
    const rows = deployRows();
    expect(rows.map((r) => r.row)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(rows.every((r) => r.status === '1')).toBe(true);
    const used = rows.reduce((a, r) => a + r.gasUsed, 0n);
    const limits = rows.reduce((a, r) => a + r.gasLimit, 0n);
    // forge's own total is the sum of the sixteen limits, at its 10-gwei price; the dry run printed both.
    const dry = readFileSync(DRY_RUN, 'utf8');
    expect(dry).toContain('Estimated gas price: 10 gwei');
    expect(dry).toContain(`Estimated total gas used for script: ${limits}\n`);
    expect(dry).toContain(`Estimated amount required: ${decimal(limits * 10n * GWEI, 18)} ETH\n`);
    // Step 2: the founder compares the leading digits, and the figure itself is there.
    const step2 = section('## Step 2', '## Step 3');
    expect(step2).toContain(`\`Estimated total gas used for script: ${String(limits).slice(0, 2)}…\``);
    expect(step2).toContain(`\`Estimated amount required: ${decimal(limits * 10n * GWEI, 18).slice(0, 3)}… ETH\``);
    expect(step2).toContain(grouped(Number(limits)));
    expect(step2).not.toMatch(/41…|4\.1…|410-413/);
    // Step 3's table: every row's Z1 = after figure is that transaction's gas, and the total their sum.
    const table = text.slice(text.indexOf('| # | Transaction | Address |'), text.indexOf('\n\nBox 0: coordinator')).split('\n');
    for (const r of rows) {
      const line = table.filter((l) => l.startsWith(`| ${r.row} | `));
      expect(line, `row ${r.row}`).toHaveLength(1);
      expect(line[0]?.split('|').map((c) => c.trim())[5], `row ${r.row}`).toBe(grouped(Number(r.gasUsed)));
    }
    const total = table.filter((l) => l.startsWith('| | **Total**'));
    expect(total).toHaveLength(1);
    expect(total[0]).toContain(`[${grouped(Number(used))}](../evidence/SH-V21-RC8-INT.md#part-2c)`);
    expect(step2).not.toMatch(/369,323,832|until rehearsals A, B and C run again/);
    // Step 3's limits: forge's largest on the local chain, createBox's there and as its STEP line plans it (the dry run's
    // planned limits are the table's planned_limit column), and the largest execution gas the dry run printed.
    const largest = rows.reduce((m, r) => (r.gasLimit > m.gasLimit ? r : m));
    const step3 = section('## Step 3', '## Step 4');
    expect(step3).toContain(`the largest was ${millions(largest.gasLimit, 1)}M on the local rehearsal (${largest.label})`);
    const createBox = rows[15] as DeployRow;
    expect(dry).toContain(`|${createBox.plannedLimit} 0x`);
    expect(step3).toContain(`\`createBox\`'s was ${millions(createBox.gasLimit, 1)}M there`);
    expect(step3).toContain(`at most the ${millions(createBox.plannedLimit, 1)}M its \`STEP|\` line plans`);
    const execution = [...dry.matchAll(/STEP\|[^|]+\|\d+\|\d+\|(\d+)\|/g)].map((m) => BigInt(m[1] ?? '0'));
    expect(execution).toHaveLength(16);
    expect(step3).toContain(`at most ${millions(execution.reduce((m, x) => (x > m ? x : m)), 1)}M here`);
    expect(step3).not.toMatch(/largest is 49\.4M|2\.5M here/);
    // § Costs: paid at a 1, 2 and 3 gwei base fee with the 2-gwei tip, and forge's limits.
    const costs = text.split('\n');
    const paid = costs.filter((l) => l.startsWith('| Z1 = after: paid'));
    expect(paid).toHaveLength(1);
    for (const figure of [grouped(Number(used)), ...[1n, 2n, 3n].map((b) => decimal(used * (b + 2n) * GWEI, 18, 3))]) expect(paid[0]).toContain(figure);
    const forge = costs.filter((l) => l.startsWith("| Z1 = after: forge's limits"));
    expect(forge).toHaveLength(1);
    expect(forge[0]).toContain(grouped(Number(limits)));
    for (const row of [...paid, ...forge]) expect(row).toContain('../evidence/SH-V21-RC8-INT.md#part-2c');
    // In plain words: the gas in millions and what the founder pays.
    const plain = section('## In plain words', '### What differs from mainnet');
    expect(plain).toContain(`| Gas | 53.8 million | ${millions(used, 0)} million`);
    expect(plain).toContain(`about ${decimal(used * 3n * GWEI, 18, 2)} SepETH at a 1-gwei base fee (${decimal(used * 4n * GWEI, 18, 2)} at 2, ${decimal(used * 5n * GWEI, 18, 2)} at 3)`);
    // The funding text: what the deploy pays, and what is left for the keeper at a 3-gwei base fee.
    const fund = section('### Z1 = after: fund the deployer', 'Build it once');
    expect(fund).toContain(`about ${decimal(used * 3n * GWEI, 18, 2)}-${decimal(used * 5n * GWEI, 18, 2)} SepETH (${millions(used, 0)} million gas`);
    const left = 3_500_000_000_000_000_000n - used * 5n * GWEI - BOOTSTRAP;
    expect(fund).toContain(`(${decimal(left - (left % 10n ** 16n), 18, 2)} or more)`);
    expect(fund).toContain(`used ${grouped(Number(used))} gas`);
  });

  it("names main from the merge of sh-box0-r1-exact-draws on, and the checkout block shows R1's code (finding 1)", () => {
    const checkout = shBlocks()[0] ?? '';
    expect(checkout.split('\n')[0]).toBe('cd ~/Claude/Projects/squarehole-sepolia/packages/contracts');
    const grep = checkout.split('\n').find((l) => l.startsWith('grep -c '));
    expect(grep, "the checkout block counts BoxTickets' in-flight view (R1)").toBe(
      `grep -c '${inFlightView()}' src/box/BoxTickets.sol`,
    );
    // The check before R1: a `main` with sh-box0-stream-gas and without R1 has it too.
    expect(checkout).not.toContain(pokeGas().line);
    const after = section('## Open a terminal and go to the release folder', '## The settings');
    expect(after).toContain('the merge of `sh-box0-r1-exact-draws`');
    expect(after).toContain('the last `1`');
    expect(after).not.toContain('the merge of `sh-box0-stream-gas`');
    expect(text).not.toContain('the merge of `sh-glamsterdam-after` or later for Z1 = after');
    expect(text).not.toContain('from the merge of `sh-box0-stream-gas` on');
    expect(section('## The settings', '- **Z0')).toContain('from the merge of `sh-box0-r1-exact-draws` on');
  });

  it("F5's limit covers all four follow-ups burning their budget after Glamsterdam, under the cap; the costs table says the same", () => {
    const f5 = text.slice(text.indexOf('### F5'), text.indexOf('## After graduation'));
    const limits = [...f5.matchAll(/'graduate\(\)' --gas-limit ([0-9]+) /g)].map((m) => Number(m[1]));
    expect(limits).toHaveLength(1);
    const limit = limits[0] ?? 0;
    expect(limit).toBeGreaterThanOrEqual(LEAST_ALL_BURNING_AFTER_GLAMSTERDAM);
    expect(limit).toBeLessThanOrEqual(TX_GAS_CAP);
    expect(f5).toContain(`Keep \`${limit}\``);
    const row = text.split('\n').find((l) => l.startsWith('| F5 graduate, reward |'));
    expect(row).toContain(`(limit ${grouped(limit)})`);
  });

  it("F5's text gives each follow-up exactly POKE_GAS, and no older budget", () => {
    const f5 = section('### F5', '## After graduation');
    const poke = grouped(pokeGas().value);
    // Report both missing phrases when a runbook edit drops them together.
    expect.soft(f5).toContain(`hands each of its four follow-ups (below) exactly ${poke} gas`);
    expect.soft(f5).toContain(`four follow-ups, each with exactly ${poke} gas`);
    for (const old of ['exactly 1,000,000', 'exactly 1,600,000', 'about 1.88M', 'about 3.9M']) expect(f5).not.toContain(old);
  });
});

/** A box-spec constant, as a number. */
const constant = (name: string): number => {
  const c = spec.constants.find((k) => k.name === name);
  if (!c) throw new Error(`box-spec.v1.json has no ${name}`);
  return Number(c.value);
};

/** The sh blocks with the ### heading above each. */
function headed(): Array<{ readonly heading: string; readonly body: string }> {
  const out: Array<{ heading: string; body: string }> = [];
  let heading = '';
  for (const m of text.matchAll(/^#{2,3} ([^\n]+)$|^```sh\n([\s\S]*?)^```/gm)) {
    if (m[1] !== undefined) heading = m[1];
    else out.push({ heading, body: m[2] ?? '' });
  }
  return out;
}

describe("the keeper (G7): F95 R19U's order and F96 R19G's poke, one block the founder leaves running (F97)", () => {
  const keeper = () => {
    const all = headed();
    const last = all.at(-1);
    expect(last?.heading, "the keeper's block is the runbook's last").toMatch(/^G7 · the keeper/);
    return last?.body ?? '';
  };

  it("pokes FIT's executor while a poke would move its sample a whole step: the price 1% or more away (R19G)", () => {
    const step = constant('EXECUTOR_MAX_OBSERVATION_STEP');
    expect(step).toBe(100);
    // A sample moves at most `step` ticks, so a poke's call result is `step` from the latest sample exactly when the
    // price is `step` ticks or more away; 1.0001^100 is above 1.01 and 1.0001^99 below it.
    expect(1.0001 ** step).toBeGreaterThan(1.01);
    expect(1.0001 ** (step - 1)).toBeLessThan(1.01);
    const body = keeper();
    expect(body).toContain("S=$(c $EXECUTOR 'latestSampleTick()(int24)'); P=$(c $EXECUTOR 'poke()(int24)')");
    // Both reads must have answered: shell arithmetic reads an empty S or P (a failed read) as 0, so without the two
    // -n tests a failed read passed the 100-tick test and sent an unneeded poke (twice on 2026-10-22,
    // SH-SEPOLIA-CORE-V1-LIFE).
    expect(body).toContain(`if [ -n "$S" ] && [ -n "$P" ] && [ $(( (P - S) * (P - S) )) -ge ${step * step} ]; then`);
    expect(body).toContain("cast send $EXECUTOR 'poke()' --rpc-url $RPC --private-key \"$(key $KEEPER_KEYFILE)\"");
  });

  it('deepens every hour: the cooldown from graduation or the last add, sent on a conversion or a paired add (R19U)', () => {
    const cooldown = constant('DEPTH_COOLDOWN_BLOCKS');
    expect(cooldown * 12).toBe(3_600);
    const body = keeper();
    expect(body).toContain(
      `D=$(c $HOOK 'lastDeepenBlock()(uint256)'); [ "$D" != 0 ] || D=$(c $HOOK 'migratedAtBlock()(uint256)'); D=$((D + ${cooldown}))`,
    );
    expect(body).toContain('"1 0 "* | "2 0 "*)\n      if cast send $HOOK \'deepen(address)\' $KEEPER');
    // A mark moves on only once its step went through or was rightly declined, so an RPC error retries the next block.
    expect(body).toContain(`>/dev/null; then\n        echo "$N deepen $V"; D=$((N + ${cooldown})); W=0\n      fi ;;`);
    expect(body).toContain(`echo "$N collect"; CL=$((N + ${2 * cooldown}))`);
    // Every way an hour ends (sent, nothing to add, waited out) sets the next mark an hour on.
    expect(body.split(`D=$((N + ${cooldown}))`)).toHaveLength(4);
  });

  it('collects every 2 hours and never right before a deepen: held while one is due within 25 blocks (R19U)', () => {
    const cooldown = constant('DEPTH_COOLDOWN_BLOCKS');
    const body = keeper();
    expect(body).toContain(`CL=$((N + ${2 * cooldown}))`);
    expect(body).toContain('if [ "$N" -ge "$CL" ] && [ $((D - N)) -gt 25 ]; then');
    // The collect comes after the deepen in the block, so a deepen sent in this block frees it at once.
    expect(body.indexOf('cast send $RECEIVER \'collect(address)\'')).toBeGreaterThan(body.indexOf("cast send $HOOK 'deepen(address)'"));
  });

  it('buys and burns only after the first deepen, runs 900 blocks, waits for each next block, and sends only as the keeper', () => {
    const body = keeper();
    expect(body).toContain('if [ "$E" = 0 ] && [ "$D" -gt "$N" ]; then E=$((N + 25)); fi');
    // The buy-and-burn's preview must have answered too: an empty answer is not "something to buy".
    expect(body).toContain(
      "X=$(c $EXECUTOR 'execute(uint256)(uint256,uint256,uint256)' 1)\n    if [ -n \"$X\" ] && [ \"$X\" != 0 ]; then",
    );
    expect(body).toMatch(/^N=\$\(cast block-number --rpc-url \$RPC\); STOP=\$\(\(N \+ 900\)\);/);
    // The next block, read only from an answer: an RPC error leaves N as it is instead of ending the loop.
    expect(body).toContain('  until NB=$(cast block-number --rpc-url $RPC) && [ "$NB" -gt "$N" ]; do sleep 3; done\n  N=$NB\n');
    const keys = [...body.matchAll(/--private-key "\$\(key \$([A-Z0-9]+)_KEYFILE\)"/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    expect(new Set(keys)).toEqual(new Set(['KEEPER']));
    const text7 = section('### G7', '### Waits and costs');
    for (const d of ['F96 R19G', 'F95 R19U', '900 blocks (3 hours)']) expect(text7).toContain(d);
    for (const d of ['trades just before G7', 'about an hour', '100-tick rule', '270-294 blocks', '300-block wait']) {
      expect(text7).toContain(d);
    }
    expect(text7).toContain('../evidence/SH-box0-r1.md');
  });
});

describe('G6: a Misfit transfer after the claim (F87, F90 R16H: the observer cap 460,000)', () => {
  it("wallet 1 gives its second item to the keeper; the block prints the new owner and the stream's record of it", () => {
    const g6 = headed().filter((b) => b.heading.startsWith('G6'));
    expect(g6).toHaveLength(1);
    const lines = (g6[0]?.body ?? '').trimEnd().split('\n');
    expect(lines[0]).toMatch(/^cast send \$STREAM 'claim\(uint256\[\],address\)' "\[\$ITEM,\$ITEM2\]" \$W1 /);
    expect(lines[1]).toBe(
      'cast send $COLLECTION \'transferFrom(address,address,uint256)\' $W1 $KEEPER $ITEM2 --rpc-url $RPC --private-key "$(key $W1_KEYFILE)"',
    );
    expect(lines.slice(2)).toEqual([
      "c $COLLECTION 'ownerOf(uint256)(address)' $ITEM2",
      "c $STREAM 'pendingOf(uint256)(address,uint256)' $ITEM2",
    ]);
    const observer = readFileSync(repo('packages/contracts/src/box/BoxCollection.sol'), 'utf8').match(
      /uint256 public constant OBSERVER_GAS = ([0-9_]+);/,
    )?.[1];
    expect(observer?.replaceAll('_', '')).toBe('460000');
    expect(section('### G6', '### G7')).toContain('up to 460,000 (F90 R16H)');
  });
});
