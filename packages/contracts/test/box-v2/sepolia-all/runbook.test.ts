import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync(new URL('../../../../../docs/runbooks/sepolia-core-v2.md', import.meta.url), 'utf8');
const section = (heading: string) => runbook.split(heading)[1]?.split('\n## ')[0] ?? '';

describe('combined Sepolia acceptance instructions', () => {
  it('permits deployment before box 0 graduates and holds FIT proceeds in its Safe', () => {
    const inputs = section('## 0.');
    expect(inputs).not.toContain('`CORE_V2_BOX0`; graduated;');
    expect(inputs).toContain('graduated=false is accepted');
    expect(inputs).toContain('Deploy and run every v2 specimen in either state');
    const safes = section('## 8.');
    expect(safes).toContain('remain in the FIT Safe');
    expect(safes).toContain('executor budget unchanged');
    expect(safes).toContain('only after box 0 graduated');
  });

  it('orders the platform Safe before box 0 and box 0 before this run (SH-SEP-BOX0-SAFE)', () => {
    const inputs = section('## 0.');
    const order = inputs.indexOf('**Order (SH-SEP-BOX0-SAFE).**');
    expect(order).toBeGreaterThan(-1);
    const steps = inputs.slice(order).split('\n\n')[0] ?? '';
    // The platform Safe first, then box 0 on core v1 with that Safe as platform, then this runbook.
    const safe = steps.indexOf('1-of-1 platform Safe');
    const box0 = steps.indexOf('box0-spec.11155111.rehearsal.sepolia-safe.json');
    const here = steps.indexOf('this runbook');
    expect(safe).toBeGreaterThan(-1);
    expect(box0).toBeGreaterThan(safe);
    expect(here).toBeGreaterThan(box0);
    expect(steps).toContain('WrongPlatformSafe');
    expect(inputs).toContain('| Box 0\'s platform | `receiver.platformSafe()` of box 0 = `CORE_V2_PLATFORM_SAFE` |');
  });

  it('SH-V21-RC7-INT open item 62 (SH-V21-RC8-INT open item 86: the tag core-v21-rc8): runs from the release folder at the tag, the Safe file naming the Safe', () => {
    const inputs = section('## 0.');
    const first = inputs.match(/^```sh\n([\s\S]*?)^```/m)?.[1] ?? '';
    const lines = first.split('\n');
    expect(lines[0]).toBe('export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"');
    expect(lines[1]).toBe('cd ~/Claude/Projects/squarehole-sepolia/packages/contracts');
    expect(lines[2]).toBe('git describe --tags --exact-match');
    expect(lines[3]).toBe(`grep -c '"platform": "0x9432380a67745b453886698F9539aC035DF80B34"' script/config/box0-spec.11155111.rehearsal.sepolia-safe.json`);
    expect(lines[4]).toBe('unset FOUNDRY_PROFILE');
    expect(runbook).not.toMatch(/^cd packages\/contracts$/m);
    const flat = inputs.replace(/\s+/g, ' ');
    expect(flat).toContain('`~/Claude/Projects/squarehole-sepolia`');
    expect(flat).toContain('prints `core-v21-rc8`');
    expect(flat).toContain('never switched');
  });

  it('requires the retained M1 and M2 specimens in both the matrix and final report', () => {
    const matrix = section('## 2.');
    for (const row of ['G box-coin price', 'L0 native holders', 'LS stock holders', 'L8 holders', 'FS failed shop']) {
      expect(matrix).toContain(`| ${row} |`);
    }
    expect(section('## 4.')).toContain('At least 5 founder-controlled wallets on each of L0, LS and L8');
    expect(section('## 5.')).not.toContain('On a separate failing shop if used');
    expect(section('## 9.')).toContain('FS');
    const report = section('## 11.');
    for (const row of ['G', 'L0', 'LS', 'L8', 'FS']) expect(report).toMatch(new RegExp(`\\b${row}\\b`));
  });

  it('RC7 part 2 review: sends every coordinator claim, the no-buyer claim(0) included, in the 8M row, never at 5M', () => {
    // Since SH-RC7-CLAIM-RESERVE a coordinator claim needs about 7.42M submitted gas (inbox admission 7,270,793).
    const rows = runbook.split('\n').filter((line) => line.startsWith('| '));
    const five = rows.find((line) => line.includes('| 5000000 |')) ?? '';
    const eight = rows.find((line) => line.includes('| 8000000 |')) ?? '';
    expect(five).not.toMatch(/\| `collect` \/ creator claim/);
    expect(five).toContain("the receiver's `claimCreator`");
    expect(eight).toContain('failure claim');
    expect(eight).toContain('`claim(0, TO)`');
  });

  it('RC7 part 3 review: 5M carries only the untipped collect(ZERO); a tipped collect takes the 8M row', () => {
    // rc7/ReceiverQuotaGas.t.sol: a tipped collect needs up to 5,864,206 on Amsterdam; collect(ZERO) up to 4,802,910.
    const rows = runbook.split('\n').filter((line) => line.startsWith('| '));
    const five = rows.find((line) => line.includes('| 5000000 |')) ?? '';
    const eight = rows.find((line) => line.includes('| 8000000 |')) ?? '';
    expect(five).toContain('`collect(ZERO)`');
    expect(five).not.toMatch(/\| `collect` \//);
    expect(eight).toContain('a tipped `collect(TO)`');
  });

  it('SH-SEP-DEPLOY-GUARD: the deploy and verify commands pin the default build; every founder transaction sets its fees', () => {
    const inputs = section('## 0.');
    expect(inputs).toContain('unset FOUNDRY_PROFILE');
    expect(inputs).toContain('export SEND_MAX_FEE=10gwei SEND_PRIORITY_FEE=2gwei');
    expect(inputs).toContain('NotReleaseBuild("rehearsal", 420698008500000000, 4206980085000000000)');
    expect(inputs).toContain('**Mainnet:** never these defaults');
    const lines = runbook.split('\n');
    const fees = '--with-gas-price "$SEND_MAX_FEE" --priority-gas-price "$SEND_PRIORITY_FEE"';
    const deploys = lines.filter((line) => line.includes('forge script script/DeployCoreV2.s.sol'));
    expect(deploys).toHaveLength(2);
    for (const line of deploys) {
      expect(line.startsWith('FOUNDRY_PROFILE=default ')).toBe(true);
      expect(line).toContain(fees);
    }
    expect(lines.filter((line) => line.includes('VerifyCoreV2.s.sol:VerifyCoreV2 --rpc-url'))
      .every((line) => line.startsWith('FOUNDRY_PROFILE=default '))).toBe(true);
    // Every forge command that can sign for the founder's wallet carries explicit fees.
    const founder = lines.filter((line) => /^(\S+=\S+ )*forge (script|create) /.test(line) && /--(sender|from) "\$WALLET"/.test(line));
    expect(founder.length).toBeGreaterThanOrEqual(5);
    for (const line of founder) expect(line).toMatch(/--(with-)?gas-price "\$SEND_MAX_FEE" --priority-gas-price "\$SEND_PRIORITY_FEE"/);
    // SH-V21-RC7-INT part 4: the prepare and test-set commands pin the default build too; the --slow broadcast waits
    // ten minutes per receipt, as core v1's does.
    for (const script of ['PrepareCoreV2Box.s.sol:PrepareCoreV2Box', 'DeploySepoliaV2TestSet.s.sol:DeploySepoliaV2TestSet', 'SepoliaV2TestSet.sol:SepoliaTestToken']) {
      const uses = lines.filter((line) => line.includes(script) && /\bforge (script|create) /.test(line));
      expect(uses.length, script).toBeGreaterThan(0);
      for (const line of uses) expect(line.startsWith('FOUNDRY_PROFILE=default '), script).toBe(true);
    }
    const broadcast = deploys.find((line) => line.includes('--broadcast')) ?? '';
    expect(broadcast).toContain('--slow --broadcast --timeout 600');
    expect(runbook).toContain('`--ledger --slow --broadcast --timeout 600`');
  });

  it('SH-V21-RC7-INT part 4: the 2^24 deploy boundary points at the recorded decision, not an open request', () => {
    const deploy = section('## 1.');
    expect(deploy).not.toContain('resolve that boundary before');
    expect(deploy).toContain('F140');
    expect(deploy).toContain('no CREATE is split');
  });

  it('checks a zero-floor pro-rata pile redemption, including the full-supply quote', () => {
    const pile = section('## 7.');
    expect(pile).not.toContain('fixed leave-behind');
    expect(pile).not.toContain('never assume the last unit is redeemable');
    expect(pile).toContain('Supply floor = 0. Leave-behind = 0.');
    expect(pile).toContain('floor(live asset balance * T_IN / pre-burn supply)');
    expect(pile).toContain('entire pre-burn supply');
    expect(pile).toContain('entire live asset balance');
  });
});
