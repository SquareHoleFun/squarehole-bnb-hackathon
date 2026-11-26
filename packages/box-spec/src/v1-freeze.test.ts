/**
 * Core v2 M1-02 (core-v2-m1-tickets.md § 2; ADR-0017 § 10): box 0's pin, case BC-222 (plan N16). The manifest
 * packages/contracts/test/vectors/box0-pin/box0-pin.v1.json pins box 0 at the F126 integration reference 85675164
 * (SH-V2-INT-FIX4); packages/contracts/scripts/box0-pin.mjs checks the tree against it without a build (this file, `pnpm
 * test`), and test/box-v2/freeze/Box0CodePin.t.sol checks the build (`forge test`). The tree passes; a copy with one
 * changed source, build profile, compiler setting or runtime code hash fails.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Box0Pin, CodePin } from '../../contracts/scripts/box0-pin.mjs';
import {
  FOUNDRY_TOML,
  MANIFEST,
  SPEC_SOURCES,
  boxArtifacts,
  checkCode,
  checkTree,
  compilerSettings,
  pinDigest,
  repoDir,
  sha256,
} from '../../contracts/scripts/box0-pin.mjs';

const SCRIPT = join(repoDir, 'packages/contracts/scripts/box0-pin.mjs');
const manifest = JSON.parse(readFileSync(join(repoDir, MANIFEST), 'utf8')) as Box0Pin;
const scratch = mkdtempSync(join(tmpdir(), 'box0-pin-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let copies = 0;
/** A copy of every file the pin reads (its sources, foundry.toml and the manifest) in a fresh folder. */
function copyTree(): string {
  const root = join(scratch, `tree-${++copies}`);
  for (const path of [...manifest.sources.map((s) => s.file), FOUNDRY_TOML, MANIFEST]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repoDir, path), join(root, path));
  }
  return root;
}

/** `path` in `root` rewritten by `change`, which must change it. */
function edit(root: string, path: string, change: (text: string) => string): void {
  const before = readFileSync(join(root, path), 'utf8');
  const after = change(before);
  expect(after, `${path} changed`).not.toBe(before);
  writeFileSync(join(root, path), after);
}

/** A build folder with one src/box/ artifact (as forge writes it) and the pin of its code. */
function syntheticBuild(runtime: string): { out: string; pin: CodePin[] } {
  const out = join(scratch, `out-${++copies}`);
  mkdirSync(join(out, 'BoxPinProbe.sol'), { recursive: true });
  const artifact = {
    bytecode: { object: '0x6080604052' },
    deployedBytecode: { object: runtime },
    metadata: { settings: { compilationTarget: { 'src/box/BoxPinProbe.sol': 'BoxPinProbe' } }, sources: {} },
  };
  writeFileSync(join(out, 'BoxPinProbe.sol/BoxPinProbe.json'), JSON.stringify(artifact));
  const pin = boxArtifacts(out).map(({ artifact: a, creation, runtime: r, runtimeBytes }) => ({ artifact: a, creation, runtime: r, runtimeBytes }));
  return { out, pin };
}

const COORDINATOR = 'packages/contracts/src/box/BoxCoordinator.sol';
const MAINNET_PROFILE = 'packages/contracts/src/box/build/mainnet/BoxBuildV1.sol';

describe('box 0 pin (M1-02)', () => {
  it("BC-222 v1's hashes, build profiles and compiler settings pinned", () => {
    expect(checkTree(manifest), 'the tree').toEqual([]);
    const changes: [string, (root: string) => void, RegExp][] = [
      ['source', (r) => edit(r, COORDINATOR, (t) => t.replace('POKE_GAS = 2_600_000', 'POKE_GAS = 2_600_001')), /^source: .*BoxCoordinator\.sol changed$/],
      ['build_profile', (r) => edit(r, MAINNET_PROFILE, (t) => t.replace(/RAISE = (\d)/, 'RAISE = 1$1')), /^source: .*build\/mainnet\/BoxBuildV1\.sol changed$/],
      ['compiler_setting', (r) => edit(r, FOUNDRY_TOML, (t) => t.replace('optimizer_runs = 1_000', 'optimizer_runs = 1_001')), /^compiler: \[profile\.default\] optimizer_runs = 1001, pinned 1000$/],
    ];
    for (const [change, apply, problem] of changes) {
      const root = copyTree();
      expect(checkTree(manifest, root), `${change}: the unchanged copy`).toEqual([]);
      apply(root);
      const problems = checkTree(manifest, root);
      expect(problems, `${change}: one problem`).toHaveLength(1);
      expect(problems[0], change).toMatch(problem);
    }
    // runtime_code_hash: the build under test differs from the pin by one byte of runtime code.
    const { out, pin } = syntheticBuild('0x60016002');
    expect(checkCode(pin, out, 'default'), 'the pinned build').toEqual([]);
    writeFileSync(join(out, 'BoxPinProbe.sol/BoxPinProbe.json'), readFileSync(join(out, 'BoxPinProbe.sol/BoxPinProbe.json'), 'utf8').replace('0x60016002', '0x60016003'));
    expect(checkCode(pin, out, 'default')).toEqual([expect.stringMatching(/^code: default: src\/box\/BoxPinProbe\.sol:BoxPinProbe runtime [0-9a-f]{64}, pinned [0-9a-f]{64}$/)]);
  });

  it('pins the settings ADR-0017 § 10 names, in both build profiles', () => {
    const d = manifest.compiler.profiles['profile.default'];
    expect(d).toMatchObject({ solc: '"0.8.26"', evm_version: '"cancun"', optimizer: 'true', optimizer_runs: '1000', via_ir: 'false', bytecode_hash: '"none"', auto_detect_solc: 'false' });
    expect(d?.remappings).toContain('"sh-box-build/=src/box/build/mainnet/"');
    expect(manifest.compiler.profiles['profile.rehearsal']?.remappings).toContain('"sh-box-build/=src/box/build/rehearsal/"');
    const files = manifest.sources.map((s) => s.file);
    expect(files).toEqual(expect.arrayContaining([...SPEC_SOURCES, COORDINATOR, MAINNET_PROFILE, 'packages/contracts/src/box/BoxSpecV1.sol', 'packages/contracts/src/box/build/rehearsal/BoxBuildV1.sol']));
    expect(files.filter((p) => !p.startsWith('packages/contracts/src/box/') && !SPEC_SOURCES.includes(p)).length, 'the files outside src/box/ that solc reads for box 0').toBeGreaterThan(20);
  });

  it('a profile change, a new setting, a new file or a remappings.txt fails; a spelling or an inert key does not', () => {
    const fails: [string, (root: string) => void, RegExp][] = [
      ['the rehearsal remapping', (r) => edit(r, FOUNDRY_TOML, (t) => t.replace('"sh-box-build/=src/box/build/rehearsal/"', '"sh-box-build/=src/box/build/mainnet/"')), /^compiler: \[profile\.rehearsal\] remappings = /],
      ['build-profiles.v1.json', (r) => edit(r, 'packages/box-spec/build-profiles.v1.json', (t) => t.replace('"rehearsal"', '"rehearsal2"')), /^source: packages\/box-spec\/build-profiles\.v1\.json changed$/],
      ['via_ir', (r) => edit(r, FOUNDRY_TOML, (t) => t.replace('via_ir = false', 'via_ir = true')), /^compiler: \[profile\.default\] via_ir = true, pinned false$/],
      ['a new key', (r) => edit(r, FOUNDRY_TOML, (t) => t.replace('via_ir = false', 'via_ir = false\ncbor_metadata = true')), /^compiler: \[profile\.default\] cbor_metadata is not a setting/],
      ['a sub-table', (r) => edit(r, FOUNDRY_TOML, (t) => `${t}\n[profile.rehearsal.optimizer_details]\nyul = false\n`), /^compiler: \[profile\.rehearsal\.optimizer_details\] may change/],
      ['a new file', (r) => writeFileSync(join(r, 'packages/contracts/src/box/build/mainnet/Extra.sol'), '// x\n'), /^source: .*Extra\.sol is new under/],
      ['remappings.txt', (r) => writeFileSync(join(r, 'packages/contracts/remappings.txt'), 'sh-box-build/=src/box/build/rehearsal/\n'), /^absent: packages\/contracts\/remappings\.txt exists$/],
      // Forge 1.8.3 still applies a legacy `[<name>]` as `[profile.<name>]` (a warning only), `[default]` to every profile.
      ['a legacy [rehearsal]', (r) => edit(r, FOUNDRY_TOML, (t) => `${t}\n[rehearsal]\noptimizer_runs = 200\n`), /^compiler: \[rehearsal\] is neither a \[profile\.<name>\] table nor/],
      ['a legacy [default]', (r) => edit(r, FOUNDRY_TOML, (t) => `${t}\n[default]\ncbor_metadata = false\n`), /^compiler: \[default\] is neither/],
      ['a legacy sub-table', (r) => edit(r, FOUNDRY_TOML, (t) => `${t}\n[rehearsal.optimizer_details]\nyul = false\n`), /^compiler: \[rehearsal\.optimizer_details\] is neither/],
      ['soldeer dependencies', (r) => edit(r, FOUNDRY_TOML, (t) => `${t}\n[dependencies]\nforge-std = "1.9.0"\n`), /^compiler: \[dependencies\] is neither/],
      ['a [profile] key', (r) => edit(r, FOUNDRY_TOML, (t) => `${t}\n[profile]\nrehearsal2 = { via_ir = true }\n`), /^compiler: \[profile\] is neither/],
      ['a key outside any table', (r) => edit(r, FOUNDRY_TOML, (t) => `optimizer_runs = 200\n${t}`), /^compiler: optimizer_runs is set outside any table$/],
    ];
    for (const [what, apply, problem] of fails) {
      const root = copyTree();
      apply(root);
      expect(checkTree(manifest, root), what).toEqual([expect.stringMatching(problem)]);
    }
    const passes: [string, (t: string) => string][] = [
      ['1_000 spelled 1000', (t) => t.replace('optimizer_runs = 1_000', 'optimizer_runs = 1000 # same')],
      ['a test setting', (t) => t.replace('ignored_error_codes = [2394]', 'ignored_error_codes = [2394, 5667]')],
      ['a new profile for v2', (t) => `${t}\n[profile.v2]\nvia_ir = true\n`],
      ['a tool section', (t) => `${t}\n[rpc_endpoints]\nsepolia = "https://ethereum-sepolia-rpc.publicnode.com"\n`],
    ];
    for (const [what, change] of passes) {
      const root = copyTree();
      edit(root, FOUNDRY_TOML, change);
      expect(checkTree(manifest, root), what).toEqual([]);
    }
    expect(() => compilerSettings('[profile.default]\nsolc = """0.8.26"""\n')).toThrow(/multi-line/);
  });

  it('the pin matches the clean F143 builds and the Sepolia runbook versionCodeHash', () => {
    // F143 on F126: box 0's BoxBackedSource (two new files, BoxFactoryV1's constructor pin; every other src/box/ code
    // as F126's integration pin had it, fe6a7e83… / c1c2054b… for 34 contracts). SHA-256 of each complete code table
    // from clean default and rehearsal builds of sh-box0-backup-source after its security review fix round (the
    // latest start, a recent header; 6357222a… / 533b1497… before it); see SH-BOX0-BACKUP-SOURCE.
    // Keep an independent pin here so rewriting the manifest cannot silently accept different bytecode.
    const codeDigests = {
      default: '92dd094c86247d50e6eae412a7692ec51924c03ba547a8dd052b2b447e5547f3',
      rehearsal: '2bcc0e5cf88bf525427244d783c1fff22af22776ce08fc06dbbfcb01c6a717e6',
    };
    for (const build of ['default', 'rehearsal'] as const) {
      expect(manifest.code[build], build).toHaveLength(36);
      expect(sha256(JSON.stringify(manifest.code[build])), build).toBe(codeDigests[build]);
    }
    const runbook = readFileSync(join(repoDir, 'docs/runbooks/sepolia-core-v1.md'), 'utf8');
    const row = /^\| `versionCodeHash:` \| `(0x[0-9a-f]{64})` \(full-size: `(0x[0-9a-f]{64})`\) \|$/m.exec(runbook);
    expect(row, "the runbook's Step 2 row").not.toBeNull();
    expect([manifest.versionCodeHash.rehearsal, manifest.versionCodeHash.default]).toEqual([row?.[1], row?.[2]]);
    expect(runbook).toContain(`| \`factory:\` / \`registry:\` | \`${manifest.versionCodeHash.factory}\``);
  });

  it('a --write after an unreviewed edit fails: sources, absent files and compiler settings match the reviewed digest', () => {
    expect(manifest.candidate.pinDigest, 'candidate.pinDigest').toBe(pinDigest(manifest));
    const root = copyTree();
    edit(root, COORDINATOR, (t) => `${t}// a stray comment\n`);
    const rewritten = { ...manifest, sources: manifest.sources.map((s) => (s.file === COORDINATOR ? { ...s, sha256: sha256(readFileSync(join(root, s.file))) } : s)) };
    expect(checkTree(rewritten, root)).toEqual([expect.stringMatching(/^manifest: sources, absent or compiler differ from candidate\.pinDigest /)]);
  });

  it('the command exits 0 on the tree and 1 on a changed copy', () => {
    const ok = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^box0-pin: box 0 is as pinned \(\d+ sources/);
    const root = copyTree();
    edit(root, FOUNDRY_TOML, (t) => t.replace('evm_version = "cancun"', 'evm_version = "prague"'));
    const bad = spawnSync(process.execPath, [SCRIPT, '--check', '--root', root], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('compiler: [profile.default] evm_version = "prague", pinned "cancun"');
    expect(existsSync(join(root, MANIFEST))).toBe(true);
  });
});
