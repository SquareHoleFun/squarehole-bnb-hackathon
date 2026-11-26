import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const helper = fileURLToPath(new URL('../../../script/sepolia-v2/send-core-v2.sh', import.meta.url));
interface Options { previewFails?: boolean; chain?: string; env?: Record<string, string>; shell?: string; args?: string }
function run(gas: string, options: Options = {}) {
  const { previewFails = false, chain = '11155111', env = {}, shell = 'bash', args = "target 'graduate()'" } = options;
  // A stand-in cast: chain-id answers the given chain; every other call prints its arguments, one per line.
  return spawnSync(shell, ['-c', `
    source "$1" || exit
    RPC=offline WALLET=founder
    cast() { if [ "$1" = chain-id ]; then printf '%s\\n' "$CHAIN"; return 0; fi; printf '%s\\n' "$@"; [ "$1" = call ] && ${previewFails ? 'return 1' : 'return 0'}; return 0; }
    send "$2" ${args}
  `, 'gas-test', helper, gas], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', CHAIN: chain, ...env },
  });
}
const calls = (stdout: string) => stdout.split(/\n(?=call\n|send\n)/);
const sendCall = (stdout: string) => calls(stdout).find((part) => part.startsWith('send\n')) ?? '';

describe('Sepolia explicit transaction envelope', () => {
  it.each(['16500000', '13500000', '15000000', '2000000'])('previews and sends the same %s gas limit', (gas) => {
    const result = run(gas);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/--gas-limit/g)).toHaveLength(2);
    expect(result.stdout.split('\n').filter((line) => line === gas)).toHaveLength(2);
    expect(result.stdout).toContain('--ledger');
  });
  it.each(['16777217', '0', '-1', '1e7', '13000000 --gas-limit 99999999'])('refuses unsafe gas %s before RPC or signing', (gas) => {
    const result = run(gas);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
  it('does not send after a failed preview', () => {
    const result = run('13500000', { previewFails: true });
    expect(result.status).not.toBe(0);
    expect(result.stdout.split('\n')).not.toContain('send');
  });
});

describe('SH-SEP-DEPLOY-GUARD: explicit Sepolia fees', () => {
  it.each(['bash', 'zsh'])('signs with v1\'s 10 gwei maximum and 2 gwei tip by default (%s)', (shell) => {
    const result = run('8000000', { shell });
    expect(result.status, result.stderr).toBe(0);
    const send = sendCall(result.stdout).split('\n');
    expect(send[send.indexOf('--gas-price') + 1]).toBe('10000000000');
    expect(send[send.indexOf('--priority-gas-price') + 1]).toBe('2000000000');
    // The preview is an eth_call: no fee, no balance reservation.
    const preview = calls(result.stdout).find((part) => part.startsWith('call\n')) ?? '';
    expect(preview).not.toContain('--gas-price');
    expect(preview).not.toContain('--priority-gas-price');
  });

  it.each([
    [{ SEND_MAX_FEE: '3gwei', SEND_PRIORITY_FEE: '1gwei' }, '3000000000', '1000000000'],
    [{ SEND_MAX_FEE: '5000000000', SEND_PRIORITY_FEE: '1500000000wei' }, '5000000000', '1500000000'],
  ])('takes the founder\'s exported fees %o', (env, max, tip) => {
    const result = run('8000000', { env });
    expect(result.status, result.stderr).toBe(0);
    const send = sendCall(result.stdout).split('\n');
    expect(send[send.indexOf('--gas-price') + 1]).toBe(max);
    expect(send[send.indexOf('--priority-gas-price') + 1]).toBe(tip);
  });

  it.each([
    { SEND_MAX_FEE: '10 gwei' },
    { SEND_MAX_FEE: '1.5gwei' },
    { SEND_MAX_FEE: '1000000gwei' },
    { SEND_MAX_FEE: '-1' },
    { SEND_PRIORITY_FEE: '1' },
    { SEND_PRIORITY_FEE: '0gwei' },
    { SEND_MAX_FEE: '1gwei', SEND_PRIORITY_FEE: '2gwei' },
  ])('refuses fee settings %o before RPC or signing', (env) => {
    const result = run('8000000', { env });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each(['--gas-price 1', '--priority-gas-price=1', '--legacy'])('refuses a fee flag %s in the call arguments', (flag) => {
    const result = run('8000000', { args: `target 'graduate()' ${flag}` });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('SEND_MAX_FEE');
  });

  it.each(['1', '31337', ''])('never previews or signs on chain %s', (chain) => {
    const result = run('8000000', { chain });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exports the fees for the runbook\'s forge commands', () => {
    const result = spawnSync('bash', ['-c', 'source "$1" && printf "%s %s\\n" "$SEND_MAX_FEE" "$SEND_PRIORITY_FEE" && bash -c \'printf "%s\\n" "$SEND_MAX_FEE"\'', 'fees', helper], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('10gwei 2gwei\n10gwei\n');
  });
});

// SH-V21-RC8-2-INT: on Sepolia without a hardware wallet (2026-10-23) the runbook's § 0 replaces `send` with the same
// helper signed by the testnet deployer's key file. The variant edits the helper's one `--ledger --from` text, so a
// changed helper line must fail here, not leave a Ledger send (or no signer) in the founder's shell.
describe('Sepolia without a hardware wallet: the runbook key-file variant of send', () => {
  const runbook = readFileSync(new URL('../../../../../docs/runbooks/sepolia-core-v2.md', import.meta.url), 'utf8');
  const block = runbook.split('**Sepolia without a hardware wallet')[1]?.match(/^```sh\n([\s\S]*?)^```/m)?.[1] ?? '';
  const contracts = fileURLToPath(new URL('../../../', import.meta.url));
  function variant(shell: string, gas: string, chain = '11155111') {
    const dir = mkdtempSync(join(tmpdir(), 'sh-send-variant-'));
    try {
      // A throwaway key file (the private key 1), written here; the variant reads it inside each send.
      writeFileSync(join(dir, 'throwaway.env'), `export SEPOLIA_DEPLOYER_PRIVATE_KEY=0x${'1'.padStart(64, '0')}\n`);
      const script = block.replace(/^export KEYFILE=\S+/m, `export KEYFILE=${join(dir, 'throwaway.env')}`);
      return spawnSync(shell, ['-c', `
        source script/sepolia-v2/send-core-v2.sh || exit
        RPC=offline
        cast() { if [ "$1" = chain-id ]; then printf '%s\\n' "$CHAIN"; return 0; fi; printf '%s\\n' "$@"; return 0; }
        ${script}
        send "$1" target 'graduate()'
      `, 'variant-test', gas], { cwd: contracts, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', CHAIN: chain } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is in § 0 and edits exactly the helper line that signs', () => {
    expect(block).toContain('eval "$(sed \'s/ --ledger --from / --private-key "$(key "$KEYFILE")" --from /\' script/sepolia-v2/send-core-v2.sh)"');
    const signing = readFileSync(helper, 'utf8').split('\n').filter((line) => line.includes('--ledger'));
    expect(signing).toHaveLength(1);
    expect(signing[0]).toContain(' --ledger --from "$WALLET" ');
  });

  it.each(['bash', 'zsh'])('signs with the key file, never --ledger, after the same preview (%s)', (shell) => {
    const result = variant(shell, '8000000');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.startsWith('1\n0\n'), result.stdout).toBe(true);
    const send = sendCall(result.stdout).split('\n');
    expect(send[send.indexOf('--private-key') + 1]).toBe(`0x${'1'.padStart(64, '0')}`);
    expect(send[send.indexOf('--from') + 1]).toBe('0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE');
    expect(result.stdout).not.toContain('--ledger');
    const preview = calls(result.stdout).find((part) => part.startsWith('call\n')) ?? '';
    expect(preview).not.toContain('--private-key');
  });

  it.each([['16777217', '11155111'], ['8000000', '1']])('keeps the helper\'s refusals (gas %s, chain %s)', (gas, chain) => {
    const result = variant('bash', gas, chain);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('1\n0\n');
  });
});
