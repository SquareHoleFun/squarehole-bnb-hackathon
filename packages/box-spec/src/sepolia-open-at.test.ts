/**
 * Step 0 of the Sepolia runbook (docs/runbooks/sepolia-core-v1.md; DECISION-LOG F80 (4)): the founder picks box 0's
 * opening time with one command, packages/contracts/scripts/sepolia-open-at.sh <UTC time>. It writes the Sepolia spec
 * files for that time (the rehearsal build's is the one the runbook deploys), prints the spec hash and the hook the dry
 * run predicts, and refuses a time less than 45 minutes after Sepolia's latest block (the dry run, the 15 transactions
 * and the verifier come before the open; the deploy script's own floor is 15 minutes, OpenAtTooSoon) or more than 14
 * days after it (the factory refuses that, OpenAtTooFar).
 *
 * These tests run only the script's time check (SH_OPEN_AT_CHECK_ONLY=1 with a fixed clock, SH_OPEN_AT_NOW): no RPC,
 * nothing written, no dry run. The write and the dry run are rehearsed on a Sepolia fork by
 * `scripts/core-v1-life-run.sh --rehearsal --runbook` (docs/evidence/SH-open-at-final.md).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';

const SCRIPT = fileURLToPath(new URL('../../contracts/scripts/sepolia-open-at.sh', import.meta.url));
/** 2026-10-06 08:00:00 UTC: a Sepolia block time (whole minutes are slot times there). */
const NOW = 1_791_273_600;
const MIN_LEAD = 45 * 60;
const FOURTEEN_DAYS = 14 * 86_400;

/** `t` (Unix seconds) as the founder types it: 2026-10-06T11:00Z, or with seconds when they are not 0. */
const typed = (t: number): string => {
  const iso = new Date(t * 1000).toISOString();
  return t % 60 === 0 ? `${iso.slice(0, 16)}Z` : `${iso.slice(0, 19)}Z`;
};

function check(time: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, time], {
    encoding: 'utf8',
    env: { ...process.env, SH_OPEN_AT_CHECK_ONLY: '1', SH_OPEN_AT_NOW: String(NOW), RPC: '', ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('Step 0: the opening time the founder types (scripts/sepolia-open-at.sh)', () => {
  it('takes a UTC time 45 minutes or more ahead, and says when the window runs and when Step 3 must be sent', () => {
    const r = check(typed(NOW + MIN_LEAD));
    expect(r.out).toContain('opening time: 2026-10-06 08:45:00 UTC (openAt 1791276300)');
    expect(r.out).toContain('window: 08:45:00 to 08:51:24 UTC');
    expect(r.out).toContain('send Step 3 before 08:30:00 UTC');
    expect(r.status).toBe(0);
    // Seconds are read too, and an hour ahead is fine.
    expect(check('2026-10-06T09:00:30Z').status).toBe(0);
  });

  it('refuses a time less than 45 minutes ahead, to the second, and a passed one', () => {
    for (const t of [NOW + MIN_LEAD - 1, NOW + 20 * 60, NOW, NOW - 3_600]) {
      const r = check(typed(t));
      expect(r.status, typed(t)).toBe(1);
      expect(r.out).toContain('REFUSED');
      expect(r.out).toContain('at least 45 minutes');
    }
  });

  it('refuses a time more than 14 days ahead, to the second (the factory would refuse box 0: OpenAtTooFar)', () => {
    expect(check(typed(NOW + FOURTEEN_DAYS)).status).toBe(0);
    const r = check(typed(NOW + FOURTEEN_DAYS + 1));
    expect(r.status).toBe(1);
    expect(r.out).toContain('REFUSED');
    expect(r.out).toContain('at most 14 days');
  });

  it('reads only a UTC time with the Z: never a local time, an offset, a date alone or a day that does not exist', () => {
    for (const bad of [
      '2026-10-06T11:00',
      '2026-10-06 11:00',
      '2026-10-06T11:00+02:00',
      '2026-10-06T11:00:00.000Z',
      '2026-10-06',
      '2026-09-31T11:00Z',
      '2026-10-06T24:00Z',
      '1791284400',
      'tomorrow',
      '',
    ]) {
      const r = check(bad);
      expect(r.status, bad).toBe(1);
      expect(r.out, bad).toContain('like 2026-10-06T11:00Z');
    }
  });

  it('takes a shorter lead only for rehearsals, never under the deploy script\'s 15 minutes', () => {
    const twenty = typed(NOW + 20 * 60);
    expect(check(twenty, { SH_OPEN_AT_MIN_LEAD: '1200' }).status).toBe(0);
    expect(check(twenty, { SH_OPEN_AT_MIN_LEAD: '1201' }).status).toBe(1);
    const r = check(twenty, { SH_OPEN_AT_MIN_LEAD: '899' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('SH_OPEN_AT_MIN_LEAD');
  });

  it('uses a made-up clock only to check, never to write a spec file', () => {
    const r = spawnSync('bash', [SCRIPT, typed(NOW + 3_600)], {
      encoding: 'utf8',
      env: { ...process.env, SH_OPEN_AT_NOW: String(NOW), SH_OPEN_AT_CHECK_ONLY: '', RPC: '' },
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain('SH_OPEN_AT_NOW');
  });
});

/** The install command Step 0 and the runbook give: the founder's default Node (23.11.1) is outside the engines. */
const INSTALL = '(cd ../.. && PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH" pnpm install --frozen-lockfile)';

describe("Step 0's Node and packages, checked before anything is read or written (review of sh-open-at-final, finding 4)", () => {
  // The script copied into an empty checkout (no node_modules), with a made-up HOME and a `node` that only says its
  // version: the founder's default terminal (Node 23.11.1 first on PATH), with or without nvm's 24.22.1.
  const root = mkdtempSync(join(tmpdir(), 'sepolia-open-at-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'checkout/packages/contracts/scripts/sepolia-open-at.sh');
  mkdirSync(join(root, 'checkout/packages/contracts/scripts'), { recursive: true });
  copyFileSync(SCRIPT, script);
  const fakeNode = (dir: string, version: string): string => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'node'), `#!/bin/sh\necho ${version}\n`);
    chmodSync(join(dir, 'node'), 0o755);
    return dir;
  };
  function step0(defaultNode: string, nvm24: boolean) {
    const home = join(root, `home-${defaultNode}-${nvm24 ? 'nvm' : 'plain'}`);
    if (nvm24) fakeNode(join(home, '.nvm/versions/node/v24.22.1/bin'), 'v24.22.1');
    const bin = fakeNode(join(home, 'default-bin'), defaultNode);
    const r = spawnSync('bash', [script, '2026-10-06T11:00Z'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FOUNDRY_PROFILE: 'rehearsal',
        WALLET: '0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE',
        SPEC: 'script/config/box0-spec.11155111.rehearsal.json',
        // Never reached: the checks come first.
        RPC: 'http://127.0.0.1:9',
        SH_OPEN_AT_CHECK_ONLY: '',
        SH_OPEN_AT_NOW: '',
      },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it("the founder's terminal (default Node 23.11.1, nvm's 24.22.1 installed): Node 24.22.1 is used, and the refusal gives the exact install command", () => {
    const r = step0('v23.11.1', true);
    expect(r.status).toBe(1);
    expect(r.out).toContain("the repository's packages are not installed");
    expect(r.out).toContain(INSTALL);
    expect(r.out).not.toContain('no answer from');
  });

  it('without nvm: Node 23, 25 and every release below the 2026-10-21 security floors are refused with the engines\' range; ^22.23.4, ^24.22.1 and >=26.12.1 pass on to the packages (SH-NODE-24-22-1)', () => {
    for (const v of ['v23.11.1', 'v22.21.1', 'v20.19.0', 'v22.22.0', 'v22.23.3', 'v24.0.0', 'v24.19.0', 'v24.22.0', 'v25.9.0', 'v26.4.0', 'v26.12.0']) {
      const r = step0(v, false);
      expect(r.status, v).toBe(1);
      expect(r.out, v).toContain(`Node ${v} is outside the repository's engines (Node ^22.23.4, ^24.22.1 or >=26.12.1)`);
    }
    for (const v of ['v22.23.4', 'v22.24.0', 'v24.22.1', 'v24.23.0', 'v26.12.1', 'v27.0.0']) {
      const r = step0(v, false);
      expect(r.status, v).toBe(1);
      expect(r.out, v).toContain("the repository's packages are not installed");
      expect(r.out, v).toContain('pnpm install --frozen-lockfile');
    }
  }, shLimit(60_000)); // 17 runs of the script: well over vitest's 5 s default under pnpm verify's parallel load

  it('the runbook gives the same command, as a block of its own (review of the merge of main)', () => {
    const runbook = readFileSync(fileURLToPath(new URL('../../../docs/runbooks/sepolia-core-v1.md', import.meta.url)), 'utf8');
    expect(runbook).toContain(`\n\`\`\`sh\n${INSTALL}\n\`\`\`\n`);
  });
});

/** Sepolia's Glamsterdam fork: 2026-10-06 13:53:36 UTC (EIP-7773; script/DeployCoreV1.s.sol GLAMSTERDAM_SEPOLIA). */
const GLAMSTERDAM_SEPOLIA = 1_791_294_816;

describe("Step 0's dry run takes the chain's rules: from Sepolia's Glamsterdam fork on, forge's --hardfork amsterdam (Z1 = after; SH-glamsterdam-after)", () => {
  // The script in a made-up checkout whose HOME holds a `forge` and a `cast` that only answer (no chain, no Foundry):
  // the script puts $HOME/.foundry/bin first on PATH. `cast` gives Sepolia's chain id and a chosen latest block time;
  // the made-up `vitest` writes the spec file for SH_SEPOLIA_OPEN_AT; `forge` records its arguments and prints what
  // the real dry run prints for that file. Nothing reaches a network.
  const root = mkdtempSync(join(tmpdir(), 'sepolia-open-at-fork-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const contracts = join(root, 'checkout/packages/contracts');
  const script = join(contracts, 'scripts/sepolia-open-at.sh');
  mkdirSync(join(contracts, 'scripts'), { recursive: true });
  mkdirSync(join(contracts, 'script/config'), { recursive: true });
  copyFileSync(SCRIPT, script);
  const exe = (path: string, body: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };
  const home = join(root, 'home');
  exe(join(home, '.nvm/versions/node/v24.22.1/bin/node'), '#!/bin/sh\necho v24.22.1\n');
  exe(
    join(home, '.foundry/bin/cast'),
    '#!/bin/sh\ncase "$1 $2" in\n"chain-id "*) echo 11155111 ;;\n"block latest") echo "$FAKE_LATEST" ;;\n*) echo "cast: unexpected $*" >&2; exit 1 ;;\nesac\n',
  );
  exe(
    join(home, '.foundry/bin/forge'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" > "$FORGE_ARGS"',
      'python3 - "$SH_CORE_V1_SPEC_FILE" <<\'PY\'',
      'import json, sys',
      'f = json.load(open(sys.argv[1]))',
      'print("== DeployCoreV1 plan (chain id, deployer, nonce) ==")',
      'print("  11155111 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE 13")',
      'print("  spec hash: " + f["specHash"])',
      'print("  openAt (Unix seconds, UTC): " + str(f["openAt"]))',
      'print("  hook: 0x3F7bECDAe89fA94e39FDe9f509dedfB6576baAe0 salt: 0x" + "0" * 60 + "594e")',
      'print("SIMULATION COMPLETE.")',
      'PY',
      '',
    ].join('\n'),
  );
  exe(
    join(root, 'checkout/node_modules/.bin/vitest'),
    [
      '#!/bin/sh',
      'python3 - <<\'PY\'',
      'import json, os',
      'd = os.path.join("packages/contracts", os.environ.get("SH_SEPOLIA_SPEC_DIR") or "script/config")',
      'for n in ("box0-spec.11155111.rehearsal.json", "box0-spec.11155111.json", "box0-spec.11155111.safe.json"):',
      '    json.dump({"openAt": int(os.environ["SH_SEPOLIA_OPEN_AT"]), "specHash": "0x" + "ab" * 32,',
      '               "platform": "0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE"}, open(os.path.join(d, n), "w"))',
      'PY',
      '',
    ].join('\n'),
  );
  function step0(latest: number) {
    const argsFile = join(root, `forge-args-${latest}.txt`);
    const r = spawnSync('bash', [script, typed(latest + 3_600)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        FAKE_LATEST: String(latest),
        FORGE_ARGS: argsFile,
        FOUNDRY_PROFILE: 'rehearsal',
        WALLET: '0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE',
        SPEC: 'script/config/box0-spec.11155111.rehearsal.json',
        RPC: 'http://127.0.0.1:9',
        SH_OPEN_AT_CHECK_ONLY: '',
        SH_OPEN_AT_NOW: '',
        SH_OPEN_AT_MIN_LEAD: '',
        SH_SEPOLIA_SPEC_DIR: '',
      },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, forgeArgs: readFileSync(argsFile, 'utf8') };
  }

  it("before the fork (Z1 = before): today's rules, no --hardfork", () => {
    for (const latest of [NOW, GLAMSTERDAM_SEPOLIA - 2 * 3_600, GLAMSTERDAM_SEPOLIA - 60]) {
      const r = step0(latest);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('spec hash: 0x' + 'ab'.repeat(32));
      expect(r.forgeArgs).toContain('script/DeployCoreV1.s.sol --rpc-url http://127.0.0.1:9 --sender 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE --no-storage-caching');
      expect(r.forgeArgs).not.toContain('--hardfork');
    }
  });

  it('from the fork on (Z1 = after): --hardfork amsterdam, to the second', () => {
    for (const latest of [GLAMSTERDAM_SEPOLIA, GLAMSTERDAM_SEPOLIA + 3 * 3_600]) {
      const r = step0(latest);
      expect(r.status, r.out).toBe(0);
      expect(r.forgeArgs.trim().endsWith('--no-storage-caching --hardfork amsterdam')).toBe(true);
      expect(r.out).toContain('--hardfork amsterdam');
    }
  });
});

describe("recording the deployed time: scripts/sepolia-open-at.sh --deployed <registry> (review of sh-open-at-final, finding 1)", () => {
  const deployed = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [SCRIPT, '--deployed', ...args], { encoding: 'utf8', env: { ...process.env, RPC: '', ...env } });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('takes one registry address, and Sepolia as RPC', () => {
    expect(deployed([]).status).toBe(1);
    expect(deployed([]).out).toContain('usage');
    const bad = deployed(['0x1234']);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('REFUSED');
    expect(bad.out).toContain('not an address');
    const noRpc = deployed(['0xe66f490d091742bEfF7a97646f04A916AD124F03']);
    expect(noRpc.status).toBe(1);
    expect(noRpc.out).toContain('RPC is not set');
  });

  it('never with a made-up clock or the check-only knob (it records what the chain holds)', () => {
    const r = deployed(['0xe66f490d091742bEfF7a97646f04A916AD124F03'], { SH_OPEN_AT_CHECK_ONLY: '1', SH_OPEN_AT_NOW: String(NOW) });
    expect(r.status).toBe(1);
    expect(r.out).toContain('REFUSED');
  });
});

describe('Step 0 with the Sepolia platform Safe file (SH-SEP-BOX0-SAFE): only a 1-of-1 Safe on Sepolia becomes box 0\'s platform', () => {
  // The script in a made-up checkout: a `cast` that answers Sepolia's chain id, a latest block time and the Safe's reads
  // (code, threshold, owners, version, modules, guard slot) from FAKE_* variables; a `vitest` that writes the four files
  // (the Safe file's platform SH_SEPOLIA_PLATFORM_SAFE, else FAKE_WRITTEN_PLATFORM, else the file's own); a `forge`
  // that records its arguments and the platform it was given. Nothing reaches a network.
  const SAFE_SPEC = 'script/config/box0-spec.11155111.rehearsal.sepolia-safe.json';
  const EXAMPLE = '0x00000000000000000000000000000000005aFE01';
  const SAFE = '0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE';
  const OWNER = '0x5583f846B0dDC80f49ea0E89C51520bA341c6658';
  const root = mkdtempSync(join(tmpdir(), 'sepolia-open-at-safe-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const contracts = join(root, 'checkout/packages/contracts');
  const script = join(contracts, 'scripts/sepolia-open-at.sh');
  mkdirSync(join(contracts, 'scripts'), { recursive: true });
  mkdirSync(join(contracts, 'script/config'), { recursive: true });
  copyFileSync(SCRIPT, script);
  const exe = (path: string, body: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  };
  const home = join(root, 'home');
  exe(join(home, '.nvm/versions/node/v24.22.1/bin/node'), '#!/bin/sh\necho v24.22.1\n');
  exe(
    join(home, '.foundry/bin/cast'),
    [
      '#!/bin/sh',
      'echo "$*" >> "$CAST_LOG"',
      'case "$1" in',
      'chain-id) echo 11155111 ;;',
      'block) echo "$FAKE_LATEST" ;;',
      'code) echo "${FAKE_CODE:-0x}" ;;',
      'storage) echo "${FAKE_GUARD:-0x0000000000000000000000000000000000000000000000000000000000000000}" ;;',
      'call)',
      '  case "$3" in',
      "  'getThreshold()(uint256)') echo \"$FAKE_THRESHOLD\" ;;",
      "  'getOwners()(address[])') echo \"$FAKE_OWNERS\" ;;",
      "  'VERSION()(string)') echo \"\\\"$FAKE_VERSION\\\"\" ;;",
      "  'getModulesPaginated(address,uint256)(address[],address)') printf '%s\\n%s\\n' \"${FAKE_MODULES:-[]}\" 0x0000000000000000000000000000000000000001 ;;",
      '  *) echo "cast: unexpected call $*" >&2; exit 1 ;;',
      '  esac ;;',
      '*) echo "cast: unexpected $*" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  exe(
    join(home, '.foundry/bin/forge'),
    [
      '#!/bin/sh',
      'printf "%s\\n%s\\n" "$*" "platform $SH_CORE_V1_PLATFORM_SAFE" > "$FORGE_ARGS"',
      'python3 - "$SH_CORE_V1_SPEC_FILE" <<\'PY\'',
      'import json, sys',
      'f = json.load(open(sys.argv[1]))',
      'print("== DeployCoreV1 plan (chain id, deployer, nonce) ==")',
      'print("  11155111 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE 13")',
      'print("  spec hash: " + f["specHash"])',
      'print("  openAt (Unix seconds, UTC): " + str(f["openAt"]))',
      'print("  hook: 0x3F7bECDAe89fA94e39FDe9f509dedfB6576baAe0 salt: 0x" + "0" * 60 + "594e")',
      'print("SIMULATION COMPLETE.")',
      'PY',
      '',
    ].join('\n'),
  );
  exe(
    join(root, 'checkout/node_modules/.bin/vitest'),
    [
      '#!/bin/sh',
      'python3 - <<\'PY\'',
      'import json, os',
      'd = os.path.join("packages/contracts", os.environ.get("SH_SEPOLIA_SPEC_DIR") or "script/config")',
      'safe_file = os.path.join(d, "box0-spec.11155111.rehearsal.sepolia-safe.json")',
      'own = json.load(open(safe_file))["platform"] if os.path.exists(safe_file) else None',
      'safe = os.environ.get("SH_SEPOLIA_PLATFORM_SAFE") or os.environ.get("FAKE_WRITTEN_PLATFORM") or own',
      'for n, p in (("box0-spec.11155111.rehearsal.json", "0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE"),',
      '             ("box0-spec.11155111.json", "0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE"),',
      '             ("box0-spec.11155111.safe.json", "0xdCE82e76456434d0f550b492Ff212A862221e6c5"),',
      '             ("box0-spec.11155111.rehearsal.sepolia-safe.json", safe)):',
      '    json.dump({"openAt": int(os.environ["SH_SEPOLIA_OPEN_AT"]), "specHash": "0x" + "cd" * 32, "platform": p},',
      '              open(os.path.join(d, n), "w"))',
      'PY',
      '',
    ].join('\n'),
  );
  let run = 0;
  function step0(committed: string | null, env: Record<string, string> = {}) {
    run += 1;
    const file = join(contracts, SAFE_SPEC);
    rmSync(file, { force: true });
    if (committed !== null) writeFileSync(file, JSON.stringify({ openAt: 1_791_284_400, specHash: `0x${'ee'.repeat(32)}`, platform: committed }));
    const argsFile = join(root, `forge-args-${run}.txt`);
    const castLog = join(root, `cast-${run}.log`);
    writeFileSync(argsFile, '');
    writeFileSync(castLog, '');
    const r = spawnSync('bash', [script, typed(NOW + 3_600)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        FAKE_LATEST: String(NOW),
        FORGE_ARGS: argsFile,
        CAST_LOG: castLog,
        FOUNDRY_PROFILE: 'rehearsal',
        WALLET: '0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE',
        SPEC: SAFE_SPEC,
        RPC: 'http://127.0.0.1:9',
        SH_OPEN_AT_CHECK_ONLY: '',
        SH_OPEN_AT_NOW: '',
        SH_OPEN_AT_MIN_LEAD: '',
        SH_SEPOLIA_SPEC_DIR: '',
        SH_SEPOLIA_PLATFORM_SAFE: '',
        FAKE_CODE: '0x608060',
        FAKE_THRESHOLD: '1',
        FAKE_OWNERS: `[${OWNER}]`,
        FAKE_VERSION: '1.4.1',
        ...env,
      },
    });
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      forge: readFileSync(argsFile, 'utf8'),
      written: committed === null && !existsSync(file) ? null : (JSON.parse(readFileSync(file, 'utf8')) as { platform: string; openAt: number }),
    };
  }

  it('is the rehearsal build\'s file: taken with FOUNDRY_PROFILE=rehearsal, refused under the full-size build', () => {
    const r = step0(SAFE, { FOUNDRY_PROFILE: '' });
    expect(r.status).toBe(1);
    expect(r.out).toContain("is the rehearsal build's file");
    expect(r.out).not.toContain('is not one of');
  });

  it('a 1-of-1 Safe 1.4.1 or 1.5.0 without modules or guard: the files are written with it and the dry run is given it', () => {
    for (const version of ['1.4.1', '1.5.0']) {
      const r = step0(SAFE, { FAKE_VERSION: version });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain(`platform Safe: ${SAFE} (1-of-1, owner ${OWNER}, Safe ${version}, no modules, no guard)`);
      expect(r.forge).toContain(`platform ${SAFE}`);
      expect(r.written?.platform).toBe(SAFE);
      expect(r.written?.openAt).toBe(NOW + 3_600);
    }
  });

  it("refuses the generator's example (the committed file until the founder's Safe is written): nothing written, no dry run", () => {
    const r = step0(EXAMPLE, { FAKE_CODE: '0x' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('REFUSED');
    expect(r.out).toContain("the generator's example");
    expect(r.out).toContain('SH_SEPOLIA_PLATFORM_SAFE');
    expect(r.forge).toBe('');
    expect(r.written?.openAt).toBe(1_791_284_400);
  });

  it('refuses a platform that is no 1-of-1 Safe on Sepolia (no code, threshold, owners, version, a module, a guard)', () => {
    const cases: [Record<string, string>, string][] = [
      [{ FAKE_CODE: '0x' }, 'no code'],
      [{ FAKE_THRESHOLD: '2' }, 'threshold 2'],
      [{ FAKE_OWNERS: `[${OWNER}, ${SAFE}]` }, '2 owners'],
      [{ FAKE_OWNERS: '[]' }, '0 owners'],
      [{ FAKE_VERSION: '1.3.0' }, 'version 1.3.0'],
      [{ FAKE_MODULES: `[${OWNER}]` }, 'a module'],
      [{ FAKE_GUARD: `0x000000000000000000000000${OWNER.slice(2).toLowerCase()}` }, 'a guard'],
    ];
    for (const [env, says] of cases) {
      const r = step0(SAFE, env);
      expect(r.status, says).toBe(1);
      expect(r.out, says).toContain('REFUSED');
      expect(r.out, says).toContain(says);
      expect(r.forge, says).toBe('');
      expect(r.written?.openAt, says).toBe(1_791_284_400);
    }
  });

  it('SH_SEPOLIA_PLATFORM_SAFE (a rehearsal\'s, or ours before the commit) is the Safe checked and written', () => {
    const r = step0(EXAMPLE, { SH_SEPOLIA_PLATFORM_SAFE: SAFE });
    expect(r.status, r.out).toBe(0);
    expect(r.written?.platform).toBe(SAFE);
    expect(r.forge).toContain(`platform ${SAFE}`);
    const bad = step0(SAFE, { SH_SEPOLIA_PLATFORM_SAFE: '0x1234' });
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('not an address');
  });

  it('SH_SEPOLIA_PLATFORM_SAFE with another SPEC: refused before anything is written (the Safe file never takes an unchecked Safe)', () => {
    for (const spec of ['script/config/box0-spec.11155111.rehearsal.json', 'script/config/box0-spec.11155111.json']) {
      const r = step0(EXAMPLE, {
        SPEC: spec,
        FOUNDRY_PROFILE: spec.includes('rehearsal') ? 'rehearsal' : '',
        SH_SEPOLIA_PLATFORM_SAFE: SAFE,
      });
      expect(r.status, spec).toBe(1);
      expect(r.out, spec).toContain('REFUSED');
      expect(r.out, spec).toContain('SH_SEPOLIA_PLATFORM_SAFE is set');
      expect(r.forge, spec).toBe('');
      expect(r.written?.platform, spec).toBe(EXAMPLE);
      expect(r.written?.openAt, spec).toBe(1_791_284_400);
    }
  });

  it('refuses when the file it wrote names another platform than the one it checked', () => {
    const r = step0(SAFE, { FAKE_WRITTEN_PLATFORM: OWNER });
    expect(r.status).toBe(1);
    expect(r.out).toContain('REFUSED');
    expect(r.out).toContain(`names platform ${OWNER}`);
    expect(r.forge).toBe('');
  });

  it('without the file and without SH_SEPOLIA_PLATFORM_SAFE: refused, nothing to check', () => {
    const r = step0(null);
    expect(r.status).toBe(1);
    expect(r.out).toContain('REFUSED');
    expect(r.out).toContain('no platform Safe');
  });
});
