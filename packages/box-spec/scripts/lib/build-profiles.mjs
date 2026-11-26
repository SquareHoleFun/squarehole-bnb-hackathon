/**
 * Build profiles (F78): packages/box-spec/build-profiles.v1.json, its checks and its emitters. Part of generate.mjs.
 *
 * - packages/contracts/src/box/build/<profile>/BoxBuildV1.sol: the profile's library (the scaled values, its name,
 *   scale and refused chain) and BoxBuildGuard (empty for mainnet; for a profile that refuses chains, a constructor that
 *   reverts on them). foundry.toml's `sh-box-build/` remapping picks the profile (default: mainnet; FOUNDRY_PROFILE=
 *   rehearsal: rehearsal).
 * - packages/box-spec/src/generated/build-profiles.v1.ts: the same values for TypeScript.
 * - `buildRef(name)` / `raiseRef(q, preset)`: what BoxSpecV1.sol writes for a scaled constant or the raise preset (the
 *   library's name instead of the literal), so one source compiles to either profile.
 *
 * The mainnet profile's values ARE box-spec.v1.json's (each scaled constant and the native-ETH raise preset of every
 * product context); every other profile's value must equal mainnet's times its scale exactly, and is checked here.
 */
import { join } from 'node:path';
import { addOnByKey, assert, constants, contexts, contractsDir, groupDigits, pkgDir, readJson, solInt, spec, tsBig } from './model.mjs';

const SOURCE = 'packages/box-spec/build-profiles.v1.json';
const file = readJson(join(pkgDir, 'build-profiles.v1.json'));
const NATIVE = '0x0000000000000000000000000000000000000000';
const NAME = /^[a-z][a-z0-9-]*$/;

assert(file.name === 'BoxBuildV1', `${SOURCE}: name BoxBuildV1`);
const scaledNames = file.scaled.map((s) => s.name);
assert(new Set(scaledNames).size === scaledNames.length, `${SOURCE}: a scaled value twice`);
assert(scaledNames[0] === 'RAISE', `${SOURCE}: RAISE first`);

/** The raise every product context lists for native ETH (one value: F74 U5). */
const mainnetRaise = (() => {
  const raises = new Set();
  for (const ctx of spec.contexts) {
    const c = contexts.find((x) => x.name === ctx.name);
    for (const q of c.qList) {
      if (q.token.toLowerCase() === NATIVE) for (const p of q.presets) raises.add(p);
    }
  }
  assert(raises.size === 1, `${SOURCE}: the product contexts list exactly one native-ETH raise (F74 U5)`);
  return [...raises][0];
})();

/** Mainnet's value of each scaled name: the raise preset, an add-on parameter's allowed value, else the
 * box-spec.v1.json constant (a uint256). */
const mainnetValues = new Map(
  file.scaled.map((s) => {
    const n = s.name;
    if (n === 'RAISE') return [n, mainnetRaise];
    if (s.addOnParam) {
      const { addOn, param, index } = s.addOnParam;
      const p = addOnByKey.get(addOn)?.params.find((x) => x.name === param);
      assert(p && p.type === 'uint256' && Array.isArray(p.allowed), `${SOURCE}: ${n}: ${addOn}.${param} must be a uint256 with allowed values`);
      assert(index >= 0 && index < p.allowed.length, `${SOURCE}: ${n}: ${addOn}.${param} has no allowed[${index}]`);
      return [n, BigInt(p.allowed[index])];
    }
    const c = constants.get(n);
    assert(c && c.type === 'uint256', `${SOURCE}: ${n} must be a uint256 constant of box-spec.v1.json`);
    return [n, c.value];
  }),
);
/** Every allowed value of a scaled add-on parameter must be scaled (none half done). */
for (const s of file.scaled.filter((x) => x.addOnParam)) {
  const { addOn, param } = s.addOnParam;
  const p = addOnByKey.get(addOn).params.find((x) => x.name === param);
  p.allowed.forEach((_, j) => {
    const named = file.scaled.some((x) => x.addOnParam && x.addOnParam.addOn === addOn && x.addOnParam.param === param && x.addOnParam.index === j);
    assert(named, `${SOURCE}: ${addOn}.${param} allowed[${j}] is not scaled`);
  });
}

const profiles = file.profiles.map((p) => {
  assert(NAME.test(p.name), `${SOURCE}: profile name ${p.name}`);
  const num = BigInt(p.scale.numerator);
  const den = BigInt(p.scale.denominator);
  assert(num > 0n && den > 0n && num <= den, `${SOURCE}: ${p.name}: a scale in (0, 1]`);
  assert(Array.isArray(p.refusesChainIds) && p.refusesChainIds.length <= 1, `${SOURCE}: ${p.name}: at most one refused chain`);
  const values = new Map();
  for (const n of scaledNames) {
    const m = mainnetValues.get(n);
    assert((m * num) % den === 0n, `${SOURCE}: ${p.name}: ${n} × ${num}/${den} is not a whole number of wei`);
    const v = (m * num) / den;
    if (p.values !== undefined) {
      assert(p.values[n] !== undefined, `${SOURCE}: ${p.name}: values.${n} missing`);
      assert(BigInt(p.values[n]) === v, `${SOURCE}: ${p.name}: values.${n} is ${p.values[n]}, the scale gives ${v}`);
    }
    assert(v > 0n, `${SOURCE}: ${p.name}: ${n} is zero`);
    values.set(n, v);
  }
  if (p.values !== undefined) {
    for (const k of Object.keys(p.values)) assert(scaledNames.includes(k), `${SOURCE}: ${p.name}: values.${k} is not scaled`);
  }
  return { ...p, num, den, values, refused: p.refusesChainIds.length ? BigInt(p.refusesChainIds[0]) : 0n };
});
const defaults = profiles.filter((p) => p.default);
assert(defaults.length === 1 && defaults[0].name === 'mainnet', `${SOURCE}: mainnet is the one default profile`);
assert(defaults[0].num === 1n && defaults[0].den === 1n && defaults[0].refused === 0n, `${SOURCE}: mainnet is unscaled and refuses no chain`);

/** BoxSpecV1.sol's expression for constant `name`: the library's name for a scaled one, else null (the literal). */
const buildRef = (name) => (scaledNames.includes(name) && name !== 'RAISE' ? `BoxBuildV1.${name}` : null);
/** BoxSpecV1.sol's expression for add-on `addOn`'s parameter `param`, allowed value `index`: the library's name for a
 * scaled one, else null (the literal). */
const addOnParamRef = (addOn, param, index) => {
  const s = file.scaled.find((x) => x.addOnParam && x.addOnParam.addOn === addOn && x.addOnParam.param === param && x.addOnParam.index === index);
  return s ? `BoxBuildV1.${s.name}` : null;
};
/** BoxSpecV1.sol's expression for a native-ETH raise preset: the library's RAISE for the raise, else null. */
const raiseRef = (token, preset) =>
  token.toLowerCase() === NATIVE && BigInt(preset) === mainnetRaise ? 'BoxBuildV1.RAISE' : null;

const ether = (wei) => {
  const s = wei.toString().padStart(19, '0');
  const whole = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, '');
  return frac ? `${groupDigits(whole)}.${frac}` : groupDigits(whole);
};

function emitBuildSolidity(p) {
  const L = [];
  L.push('// SPDX-License-Identifier: MIT');
  L.push('pragma solidity 0.8.26;');
  L.push('');
  L.push(`// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from ${SOURCE}`);
  L.push('// (`pnpm box-spec:write`); `pnpm check:box-spec` (in `pnpm verify`) fails when stale.');
  L.push('');
  L.push(`/// @title BoxBuildV1 (build profile \`${p.name}\`)`);
  L.push('/// @notice The values core v1 takes from its build profile (F78): the raise and the fixed ETH amounts, read through');
  L.push('/// BoxSpecV1 (BoxSpecV1.BOOTSTRAP_ETH is BoxBuildV1.BOOTSTRAP_ETH, the raise preset is BoxBuildV1.RAISE). foundry.toml');
  L.push(`/// maps \`sh-box-build/\` to src/box/build/mainnet/ by default and to src/box/build/rehearsal/ under`);
  L.push('/// FOUNDRY_PROFILE=rehearsal; nothing else differs between the two builds.');
  L.push(`/// ${p.about}`);
  L.push('library BoxBuildV1 {');
  L.push('    /// @notice The profile this file belongs to.');
  L.push(`    string internal constant PROFILE = "${p.name}";`);
  L.push('    /// @notice True for a profile whose values are not mainnet\'s (a rehearsal for testnets).');
  L.push(`    bool internal constant REHEARSAL = ${p.name === 'mainnet' ? 'false' : 'true'};`);
  L.push('    /// @notice The chain id whose deployments this build refuses (0: none); BoxBuildGuard enforces it.');
  L.push(`    uint256 internal constant REFUSED_CHAIN_ID = ${solInt(p.refused)};`);
  L.push('    /// @notice Every scaled value is mainnet\'s × SCALE_NUMERATOR / SCALE_DENOMINATOR, exactly.');
  L.push(`    uint256 internal constant SCALE_NUMERATOR = ${solInt(p.num)};`);
  L.push(`    uint256 internal constant SCALE_DENOMINATOR = ${solInt(p.den)};`);
  for (const s of file.scaled) {
    const v = p.values.get(s.name);
    const what = s.name === 'RAISE'
      ? 'The raise R (Q raw units, native ETH)'
      : s.addOnParam
        ? `Add-on ${s.addOnParam.addOn}, ${s.addOnParam.param} allowed[${s.addOnParam.index}]`
        : `BoxSpecV1.${s.name}`;
    L.push(`    /// @dev ${what}: ${ether(v)} ETH (mainnet ${ether(mainnetValues.get(s.name))}). ${s.why[0].toUpperCase()}${s.why.slice(1)}.`.replace(/\.\.$/, '.'));
    L.push(`    uint256 internal constant ${s.name} = ${solInt(v)};`);
  }
  L.push('}');
  L.push('');
  if (p.refused === 0n) {
    L.push(`/// @title BoxBuildGuard (build profile \`${p.name}\`)`);
    L.push('/// @notice Empty in this profile: it refuses no chain, adds no code and changes no bytecode. The factory, the planner');
    L.push('/// and every implementation inherit it so that a profile which refuses a chain (the rehearsal) can do so in their');
    L.push('/// constructors.');
    L.push('abstract contract BoxBuildGuard {}');
  } else {
    L.push(`/// @title BoxBuildGuard (build profile \`${p.name}\`)`);
    L.push(`/// @notice This build can never be deployed on chain id ${p.refused}: the constructor of the factory, the planner and every`);
    L.push('/// implementation (each inherits this contract) reverts there, so no box of this build can exist on it (F78).');
    L.push('abstract contract BoxBuildGuard {');
    L.push('    /// @notice A contract of a rehearsal build was deployed on a chain the build refuses.');
    L.push('    error RehearsalBuildRefusesChain(uint256 chainId);');
    L.push('');
    L.push('    constructor() {');
    L.push('        if (block.chainid == BoxBuildV1.REFUSED_CHAIN_ID) revert RehearsalBuildRefusesChain(block.chainid);');
    L.push('    }');
    L.push('}');
  }
  return `${L.join('\n')}\n`;
}

function emitBuildTs() {
  const L = [];
  L.push(`// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from ${SOURCE}`);
  L.push('// (`pnpm box-spec:write`); `pnpm check:box-spec` (in `pnpm verify`) fails when stale. Twin of');
  L.push('// packages/contracts/src/box/build/<profile>/BoxBuildV1.sol.');
  L.push('');
  L.push(`/** The build profiles of core v1 (F78). ${file.status} */`);
  L.push(`export type BuildProfileName = ${profiles.map((p) => `'${p.name}'`).join(' | ')};`);
  L.push('');
  L.push('/** The values a build takes from its profile (BoxBuildV1.sol). */');
  L.push(`export type BuildScaledName = ${scaledNames.map((n) => `'${n}'`).join(' | ')};`);
  L.push('');
  L.push('export interface BuildProfile {');
  L.push('  readonly name: BuildProfileName;');
  L.push('  /** FOUNDRY_PROFILE that builds it (`default`: none set). */');
  L.push('  readonly foundryProfile: string;');
  L.push('  readonly rehearsal: boolean;');
  L.push('  /** Chain ids its contracts refuse in their constructors. */');
  L.push('  readonly refusedChainIds: readonly number[];');
  L.push('  readonly scaleNumerator: bigint;');
  L.push('  readonly scaleDenominator: bigint;');
  L.push('  readonly values: Readonly<Record<BuildScaledName, bigint>>;');
  L.push('}');
  L.push('');
  L.push(`export const BUILD_SCALED_NAMES: readonly BuildScaledName[] = [${scaledNames.map((n) => `'${n}'`).join(', ')}];`);
  L.push('');
  for (const p of profiles) {
    L.push(`/** ${p.about} */`);
    L.push(`export const BUILD_PROFILE_${p.name.toUpperCase().replace(/-/g, '_')}: BuildProfile = {`);
    L.push(`  name: '${p.name}',`);
    L.push(`  foundryProfile: '${p.foundryProfile}',`);
    L.push(`  rehearsal: ${p.name === 'mainnet' ? 'false' : 'true'},`);
    L.push(`  refusedChainIds: [${p.refusesChainIds.join(', ')}],`);
    L.push(`  scaleNumerator: ${tsBig(p.num)},`);
    L.push(`  scaleDenominator: ${tsBig(p.den)},`);
    L.push('  values: {');
    for (const n of scaledNames) L.push(`    ${n}: ${tsBig(p.values.get(n))},`);
    L.push('  },');
    L.push('};');
    L.push('');
  }
  L.push('export const BUILD_PROFILES: Readonly<Record<BuildProfileName, BuildProfile>> = {');
  for (const p of profiles) L.push(`  ${p.name.includes('-') ? `'${p.name}'` : p.name}: BUILD_PROFILE_${p.name.toUpperCase().replace(/-/g, '_')},`);
  L.push('};');
  return `${L.join('\n')}\n`;
}

const buildOutputs = () => [
  ...profiles.map((p) => [join(contractsDir, `src/box/build/${p.name}/BoxBuildV1.sol`), emitBuildSolidity(p)]),
  [join(pkgDir, 'src/generated/build-profiles.v1.ts'), emitBuildTs()],
];

export { addOnParamRef, buildOutputs, buildRef, raiseRef, mainnetRaise, profiles as buildProfiles, scaledNames };
