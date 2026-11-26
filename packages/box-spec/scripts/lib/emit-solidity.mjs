/** The Solidity emitter: packages/contracts/src/box/BoxSpecV1.sol. Part of generate.mjs. */
import { getAddress } from 'viem';
import {
  fail,
  assert,
  spec,
  UINT_BITS,
  paramKindName,
  constants,
  enums,
  rules,
  reasons,
  fields,
  addOns,
  fieldIds,
  contexts,
  contextIndex,
  snake,
  pascal,
  solConstName,
  solEnumConst,
  solAddOnConst,
  solInt,
  bound,
  predicate,
} from './model.mjs';
import { addOnParamRef, buildRef, raiseRef } from './build-profiles.mjs';
import { addOnCheckLines, branchCheckLines, dialect, fieldCheckLines, ruleParts, shopCheckLines, sideCheckLines } from './checks-v2.mjs';

// ---------------------------------------------------------------------------------------------------------------
// Solidity
// ---------------------------------------------------------------------------------------------------------------

function solType(type) {
  return type === 'AddOn[]' ? 'AddOn[]' : type;
}

/** The field's own check, or with `zeroWhen` (F70): zero (or empty) while the predicate holds, its own check otherwise. */
function solFieldCheck(f) {
  const own = solOwnFieldCheck(f);
  const when = f.check.zeroWhen;
  if (when === undefined) return own;
  const lines = [`if (${predicate(when, 'sol')}) {`, `    if (${solNonZero(f)}) return (REASON_MUST_BE_ZERO, ${solConstName(f.name)});`];
  if (own.length) lines.push('} else {', ...own.map((line) => `    ${line}`));
  lines.push('}');
  return lines;
}

function solNonZero(f) {
  const ref = `s.${f.name}`;
  if (f.type === 'string') return `bytes(${ref}).length != 0`;
  if (f.type === 'bytes') return `${ref}.length != 0`;
  if (f.type === 'bytes32') return `${ref} != bytes32(0)`;
  if (f.type === 'address') return `${ref} != address(0)`;
  if (f.type in UINT_BITS) return `${ref} != 0`;
  return fail(`field ${f.name}: no zero test for ${f.type}`);
}

function solOwnFieldCheck(f) {
  const c = f.check;
  const id = solConstName(f.name);
  const ref = `s.${f.name}`;
  switch (c.kind) {
    case 'uint': {
      const reason = `REASON_${c.reason ?? 'OUT_OF_RANGE'}`;
      if (c.allowed) return [`if (!(${c.allowed.map((v) => `${ref} == ${solInt(v)}`).join(' || ')})) return (${reason}, ${id});`];
      // `orZero` (open-at-clock-time.md): 0 is a value of its own (Now); `max` may be left out (the type's own bound).
      const range = c.max === undefined ? `${ref} < ${bound(c.min, 'sol', f.type)}` : `${ref} < ${bound(c.min, 'sol', f.type)} || ${ref} > ${bound(c.max, 'sol', f.type)}`;
      return [`if (${c.orZero ? `${ref} != 0 && (${range})` : range}) return (${reason}, ${id});`];
    }
    case 'enum': {
      const e = enums.get(f.enum);
      const members = e.members.map((m) => `${ref} == ${solEnumConst(f.enum, m.name)}`).join(' || ');
      const offered = c.offered.map((m) => `${ref} == ${solEnumConst(f.enum, m)}`).join(' || ');
      const lines = [`if (!(${members})) return (REASON_NOT_A_MEMBER, ${id});`];
      if (c.offered.length !== e.members.length) lines.push(`if (!(${offered})) return (REASON_NOT_OFFERED, ${id});`);
      if (c.inContext) lines.push(`if (!_inList(${ref}, ctx.${c.inContext})) return (REASON_NOT_OFFERED, ${id});`);
      return lines;
    }
    case 'string':
      return [
        `r = _checkString(bytes(${ref}), ${bound(c.minBytes, 'sol')}, ${bound(c.maxBytes, 'sol')}, RULE_${c.rule});`,
        `if (r != REASON_OK) return (r, ${id});`,
      ];
    case 'bytes': {
      const lines = [`if (${ref}.length < ${bound(c.minBytes, 'sol')} || ${ref}.length > ${bound(c.maxBytes, 'sol')}) return (REASON_LENGTH_OUT_OF_RANGE, ${id});`];
      // Core item 9: the metadata table's format v1, after its length (BoxMetadataTable.validate's rules).
      if (c.format === 'METADATA_TABLE_V1') lines.push(`if (!_tableV1(${ref})) return (REASON_METADATA_TABLE_MALFORMED, ${id});`);
      return lines;
    }
    case 'nonZero': {
      const zero = f.type === 'bytes32' ? 'bytes32(0)' : 'address(0)';
      return [`if (${ref} == ${zero}) return (REASON_ZERO_VALUE, ${id});`];
    }
    case 'listedQ':
      return [`if (!_isListed(${ref}, ctx.qList)) return (REASON_Q_NOT_LISTED, ${id});`];
    case 'raisePreset':
      return [`if (!_isPreset(s.q, ${ref}, ctx.qList)) return (REASON_RAISE_NOT_A_PRESET, ${id});`];
    case 'any':
    case 'addOns':
      return [];
    default:
      return fail(`field ${f.name}: unknown check ${c.kind}`);
  }
}

function solAddOnFunction(a) {
  const base = `FIELD_ADD_ON_${snake(a.key)}`;
  const lines = [];
  lines.push(`    /// @dev Add-on ${a.id} \`${a.key}\`: ${a.title}.`);
  lines.push(`    function _check${pascal(a.key)}(BoxSpec memory s, bytes memory p) private pure returns (uint16, uint16) {`);
  lines.push(`        if (!(${a.versions.map((v) => `s.version == ${v}`).join(' || ')})) return (REASON_ADD_ON_NOT_AVAILABLE, ${base});`);
  lines.push(`        if (!${predicate({ field: 'boxType', in: a.boxTypes }, 'sol')}) return (REASON_ADD_ON_CONFLICT, ${base});`);
  if (a.params.length === 0) {
    lines.push(`        if (p.length != 0) return (REASON_ADD_ON_PARAMS_MALFORMED, ${base});`);
  } else {
    lines.push(`        uint8[] memory kinds = new uint8[](${a.params.length});`);
    a.params.forEach((param, i) => lines.push(`        kinds[${i}] = _K_${paramKindName(param.type)};`));
    lines.push('        (bool ok, uint256[] memory w) = _canonical(p, kinds);');
    lines.push(`        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, ${base});`);
    if (a.params.some((x) => x.type === 'string')) lines.push('        uint16 r;');
    a.params.forEach((param, i) => {
      const id = solConstName(`addOns.${a.key}.${param.name}`);
      if (param.type === 'string') {
        lines.push(`        r = _checkStringAt(p, w[${i}], ${solInt(param.minBytes)}, ${solInt(param.maxBytes)}, RULE_${param.rule});`);
        lines.push(`        if (r != REASON_OK) return (r, ${id});`);
      } else if (param.type in UINT_BITS && ('min' in param || 'max' in param)) {
        const cond = [];
        if ('min' in param) cond.push(`w[${i}] < ${bound(param.min, 'sol', 'uint256')}`);
        if ('max' in param) cond.push(`w[${i}] > ${bound(param.max, 'sol', 'uint256')}`);
        lines.push(`        if (${cond.join(' || ')}) return (REASON_OUT_OF_RANGE, ${id});`);
      } else if (param.allowed) {
        // A build-profile value (F78) is written first: solc compiles `x == <literal>` literal first (its literal-order
        // optimisation for commutative operators), so `<constant> == x` keeps the mainnet build's bytecode unchanged
        // where `x == <constant>` would not (scripts/bytecode-hashes.py; docs/evidence/SH-rehearsal-build.md).
        const set = param.allowed
          .map((v, j) => {
            const ref = addOnParamRef(a.key, param.name, j);
            return ref ? `${ref} == w[${i}]` : `w[${i}] == ${solInt(v)}`;
          })
          .join(' || ');
        lines.push(`        if (!(${set})) return (REASON_NOT_A_MEMBER, ${id});`);
      } else if (param.enum) {
        const set = enums.get(param.enum).members.map((m) => `w[${i}] == ${solEnumConst(param.enum, m.name)}`).join(' || ');
        lines.push(`        if (!(${set})) return (REASON_NOT_A_MEMBER, ${id});`);
        if (param.offered && param.offered.length !== enums.get(param.enum).members.length) {
          const offered = param.offered.map((m) => `w[${i}] == ${solEnumConst(param.enum, m)}`).join(' || ');
          lines.push(`        if (!(${offered})) return (REASON_NOT_OFFERED, ${id});`);
        }
      } else if (param.type === 'bytes32[]') {
        lines.push(`        if (_word(p, w[${i}]) > ${solInt(param.maxItems)}) return (REASON_LENGTH_OUT_OF_RANGE, ${id});`);
        if (param.nonZeroItems) lines.push(`        if (!_nonZeroItems(p, w[${i}])) return (REASON_ZERO_VALUE, ${id});`);
      } else if (param.nonZeroIff) {
        const when = predicate({ param: param.nonZeroIff.param, eq: param.nonZeroIff.eq }, 'sol', a);
        lines.push(`        if (${when}) {`);
        lines.push(`            if (w[${i}] == 0) return (REASON_ZERO_VALUE, ${id});`);
        lines.push(`        } else if (w[${i}] != 0) {`);
        lines.push(`            return (REASON_MUST_BE_ZERO, ${id});`);
        lines.push('        }');
      } else if (param.nonZero) {
        lines.push(`        if (w[${i}] == 0) return (REASON_ZERO_VALUE, ${id});`);
      }
    });
  }
  for (const req of a.requires) {
    lines.push(`        if (!(${predicate(req.predicate, 'sol', a)})) return (REASON_${req.reason}, ${base});`);
  }
  lines.push('        return (REASON_OK, 0);');
  lines.push('    }');
  return lines.join('\n');
}

function solContext(ctx) {
  const P = pascal(ctx.name);
  const lines = [`    /// @notice Version context \`${ctx.name}\`: its Q list and graduated layout(s)${ctx.gradLayoutsOpen ? ` (${ctx.gradLayoutsOpen})` : ''}.`];
  lines.push(`    function context${P}() internal pure returns (VersionContext memory ctx) {`);
  lines.push(`        ctx.qList = qList${P}();`);
  lines.push(`        ctx.gradLayouts = new uint8[](${ctx.gradLayouts.length});`);
  ctx.gradLayouts.forEach((g, i) => lines.push(`        ctx.gradLayouts[${i}] = ${solEnumConst('GradLayout', g)};`));
  lines.push('    }');
  return lines.join('\n');
}

function solQList(ctx) {
  const lines = [`    /// @notice The curated Q list of context \`${ctx.name}\`: ${ctx.status}`];
  lines.push(`    function qList${pascal(ctx.name)}() internal pure returns (QAsset[] memory list) {`);
  lines.push(`        list = new QAsset[](${ctx.qList.length});`);
  ctx.qList.forEach((q, i) => {
    lines.push(`        uint256[] memory presets${i} = new uint256[](${q.presets.length});`);
    q.presets.forEach((p, j) => lines.push(`        presets${i}[${j}] = ${raiseRef(q.token, p) ?? solInt(p)};`));
    lines.push(
      `        list[${i}] = QAsset({token: ${q.token === getAddress('0x0000000000000000000000000000000000000000') ? 'address(0)' : q.token}, decimals: ${q.decimals}, qClass: ${solEnumConst('QClass', q.qClass)}, raisePresets: presets${i}});`,
    );
  });
  lines.push('    }');
  return lines.join('\n');
}

function emitSolidity() {
  const L = [];
  L.push('// SPDX-License-Identifier: MIT');
  L.push('pragma solidity 0.8.26;');
  L.push('');
  L.push('// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from packages/box-spec/box-spec.v1.json');
  L.push('// and packages/box-spec/add-ons.v1.json (`pnpm box-spec:write`); `pnpm check:box-spec` (in `pnpm verify`) fails when stale.');
  L.push('');
  L.push('// The build profile (F78; packages/box-spec/build-profiles.v1.json): the raise and the fixed ETH amounts. foundry.toml maps');
  L.push('// `sh-box-build/` to src/box/build/mainnet/ (default) or src/box/build/rehearsal/ (FOUNDRY_PROFILE=rehearsal).');
  L.push('import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";');
  L.push('');
  L.push('/// @title BoxSpecV1');
  L.push('/// @notice The BoxSpec wire format (launch pipeline v1 § 1, slice S1): the struct, its fixed values, `validate()` and');
  L.push('/// `specHash()`. The TypeScript twin is packages/box-spec/src/generated/box-spec.v1.ts; both run the shared vectors');
  L.push('/// test/vectors/box-spec/box-spec-v1.json (BC-001). Nothing on chain calls it yet: the factory is slice S7.');
  L.push('/// @dev Every enum is a uint8 on the wire (0 is never a member), so a bad value decodes and is refused with a reason.');
  L.push('/// `validate()` returns the first failing (reason, field) in the source order: fields, then each add-on, then rules.');
  L.push('library BoxSpecV1 {');
  L.push('    // ------------------------------------------------------------------------------------------- fixed values');
  for (const c of constants.values()) {
    L.push(`    /// @dev ${c.source}`);
    const ref = buildRef(c.name);
    if (ref) {
      L.push(`    /// Build profile (F78): ${solInt(c.value)} in the mainnet build, scaled in a rehearsal build (${ref}).`);
      L.push(`    ${c.type} internal constant ${c.name} = ${ref};`);
    } else if (c.type === 'address') L.push(`    address internal constant ${c.name} = ${c.value};`);
    else if (c.type === 'bytes32') L.push(`    bytes32 internal constant ${c.name} = ${c.value};`);
    else L.push(`    ${c.type} internal constant ${c.name} = ${solInt(c.value)};`);
  }
  L.push('');
  L.push('    // ------------------------------------------------------------------------------------------- enums (uint8)');
  for (const e of enums.values()) {
    for (const m of e.members) L.push(`    uint8 internal constant ${solEnumConst(e.name, m.name)} = ${m.value};`);
  }
  L.push('');
  L.push('    // ------------------------------------------------------------------------------------------- string rules');
  for (const r of rules.values()) L.push(`    uint8 internal constant RULE_${r.name} = ${r.id};`);
  L.push('');
  L.push('    // ------------------------------------------------------------------------------------------- reasons');
  for (const [name, code] of reasons) L.push(`    uint16 internal constant REASON_${name} = ${code};`);
  L.push('');
  L.push('    // ------------------------------------------------------------------------------------------- field ids');
  for (const [path, id] of fieldIds) L.push(`    uint16 internal constant ${solConstName(path)} = ${id};`);
  L.push('');
  L.push('    // ------------------------------------------------------------------------------------------- add-ons');
  for (const a of addOns) {
    L.push(`    uint16 internal constant ${solAddOnConst(a)} = ${a.id};`);
    for (const c of a.constants) L.push(`    uint256 internal constant ${solAddOnConst(a)}_${c.name} = ${solInt(c.value)};`);
  }
  L.push('');
  L.push('    // ------------------------------------------------------------------------------------------- types');
  L.push('    /// @notice One add-on: its catalog id and abi.encode(<its parameter tuple>), canonical (add-ons.v1.json).');
  L.push('    struct AddOn {');
  L.push('        uint16 id;');
  L.push('        bytes params;');
  L.push('    }');
  L.push('');
  L.push('    struct BoxSpec {');
  for (const f of fields) L.push(`        ${solType(f.type)} ${f.name};`);
  L.push('    }');
  L.push('');
  L.push('    /// @notice One curated Q: the version`s list is passed to `validate()` (q must be listed, raise one of its presets).');
  L.push('    struct QAsset {');
  L.push('        address token;');
  L.push('        uint8 decimals;');
  L.push('        uint8 qClass;');
  L.push('        uint256[] raisePresets;');
  L.push('    }');
  L.push('');
  L.push('    /// @notice What a version, not the creator, chooses, passed to `validate()` beside the spec: the curated Q list');
  L.push('    /// and the graduated layout(s) the version allows (a `gradLayout` it does not list is NOT_OFFERED).');
  L.push('    struct VersionContext {');
  L.push('        QAsset[] qList;');
  L.push('        uint8[] gradLayouts;');
  L.push('    }');
  L.push('');
  L.push('    // ------------------------------------------------------------------------------------------- API');
  L.push('    /// @notice keccak256 of the ABI encoding of the whole spec (the registry`s spec hash).');
  L.push('    function specHash(BoxSpec memory s) internal pure returns (bytes32) {');
  L.push('        return keccak256(abi.encode(s));');
  L.push('    }');
  L.push('');
  L.push('    /// @notice (REASON_OK, 0) for a valid spec, else the first failing check`s reason and field id. `ctx` is the');
  L.push('    /// version`s context (`contextV1()`, `contextV2()`).');
  L.push('    function validate(BoxSpec memory s, VersionContext memory ctx) internal pure returns (uint16 reason, uint16 field) {');
  L.push('        (reason, field) = _checkFields(s, ctx);');
  L.push('        if (reason != REASON_OK) return (reason, field);');
  L.push('        (reason, field) = _checkAddOns(s);');
  L.push('        if (reason != REASON_OK) return (reason, field);');
  L.push('        return _checkRules(s, ctx);');
  L.push('    }');
  L.push('');
  for (const ctx of spec.contexts) {
    L.push(solContext(contexts[contextIndex(ctx.name)]));
    L.push('');
  }
  for (const ctx of spec.contexts) {
    L.push(solQList(contexts[contextIndex(ctx.name)]));
    L.push('');
  }
  L.push('    // ------------------------------------------------------------------------------------------- fields');
  L.push('    function _checkFields(BoxSpec memory s, VersionContext memory ctx) private pure returns (uint16, uint16) {');
  L.push('        uint16 r;');
  for (const f of fields) {
    const lines = solFieldCheck(f);
    if (lines.length === 0) continue;
    L.push(`        // ${f.id} ${f.name}`);
    for (const line of lines) L.push(`        ${line}`);
  }
  L.push('        return (REASON_OK, 0);');
  L.push('    }');
  L.push('');
  L.push('    // ------------------------------------------------------------------------------------------- add-ons');
  L.push('    function _checkAddOns(BoxSpec memory s) private pure returns (uint16, uint16) {');
  L.push('        uint256 count = s.addOns.length;');
  L.push('        if (count > MAX_ADD_ONS) return (REASON_TOO_MANY_ADD_ONS, FIELD_ADD_ONS);');
  L.push('        for (uint256 i; i < count; ++i) {');
  L.push('            uint16 id = s.addOns[i].id;');
  L.push('            if (i != 0) {');
  L.push('                uint16 previous = s.addOns[i - 1].id;');
  L.push('                if (id < previous || (id == previous && !_repeatable(id))) return (REASON_ADD_ON_ORDER, FIELD_ADD_ONS);');
  L.push('            }');
  L.push('            (uint16 r, uint16 f) = _checkAddOn(s, id, s.addOns[i].params);');
  L.push('            if (r != REASON_OK) return (r, f);');
  L.push('        }');
  L.push('        return (REASON_OK, 0);');
  L.push('    }');
  L.push('');
  const repeatable = addOns.filter((a) => a.repeatable);
  L.push('    function _repeatable(uint16 id) private pure returns (bool) {');
  L.push(`        return ${repeatable.length ? repeatable.map((a) => `id == ${solAddOnConst(a)}`).join(' || ') : 'id != id'};`);
  L.push('    }');
  L.push('');
  L.push('    function _checkAddOn(BoxSpec memory s, uint16 id, bytes memory p) private pure returns (uint16, uint16) {');
  for (const a of addOns) L.push(`        if (id == ${solAddOnConst(a)}) return _check${pascal(a.key)}(s, p);`);
  L.push('        return (REASON_ADD_ON_UNKNOWN, FIELD_ADD_ONS);');
  L.push('    }');
  L.push('');
  for (const a of addOns) {
    L.push(solAddOnFunction(a));
    L.push('');
  }
  L.push('    // ------------------------------------------------------------------------------------------- rules');
  L.push('    function _checkRules(BoxSpec memory s, VersionContext memory ctx) private pure returns (uint16, uint16) {');
  for (const rule of spec.rules) {
    L.push(`        // ${rule.name} (${rule.source})`);
    L.push(`        if (${predicate(rule.when, 'sol')} && !(${predicate(rule.require, 'sol')})) {`);
    L.push(`            return (REASON_${rule.reason}, ${solConstName(rule.field)});`);
    L.push('        }');
  }
  L.push('        return (REASON_OK, 0);');
  L.push('    }');
  L.push('');
  L.push(SOL_HELPERS);
  L.push('}');
  L.push('');
  return L.join('\n');
}

/** The helpers both formats share (format 2 reads `bytes` params with the string kind's layout). */
const SOL_KINDS = `    // ------------------------------------------------------------------------------------------- helpers
    uint8 private constant _K_UINT8 = 1;
    uint8 private constant _K_UINT16 = 2;
    uint8 private constant _K_UINT32 = 3;
    uint8 private constant _K_UINT64 = 4;
    uint8 private constant _K_UINT128 = 5;
    uint8 private constant _K_UINT256 = 6;
    uint8 private constant _K_BOOL = 7;
    uint8 private constant _K_ADDRESS = 8;
    uint8 private constant _K_BYTES32 = 9;
    uint8 private constant _K_STRING = 10;
    uint8 private constant _K_BYTES32_ARRAY = 11;`;

const SOL_SHARED = `    function _checkString(bytes memory b, uint256 minBytes, uint256 maxBytes, uint8 rule) private pure returns (uint16) {
        uint256 len = b.length;
        if (len < minBytes || len > maxBytes) return REASON_LENGTH_OUT_OF_RANGE;
        if (!_allBytesAllowed(b, 0, len, _mask(rule))) return REASON_BAD_CHARACTER;
        return _hasPrefix(b, 0, len, rule) ? REASON_OK : REASON_BAD_CHARACTER;
    }

    /// @dev A string inside canonical params: its length word at \`offset\`, its bytes right after.
    function _checkStringAt(bytes memory p, uint256 offset, uint256 minBytes, uint256 maxBytes, uint8 rule)
        private
        pure
        returns (uint16)
    {
        uint256 len = _word(p, offset);
        if (len < minBytes || len > maxBytes) return REASON_LENGTH_OUT_OF_RANGE;
        if (!_allBytesAllowed(p, offset + 32, len, _mask(rule))) return REASON_BAD_CHARACTER;
        return _hasPrefix(p, offset + 32, len, rule) ? REASON_OK : REASON_BAD_CHARACTER;
    }

    /// @dev True when the rule needs no prefix, the string is empty, or b[start, start + len) starts with the rule's
    /// prefix (the caller checked that the range lies inside \`b\`).
    function _hasPrefix(bytes memory b, uint256 start, uint256 len, uint8 rule) private pure returns (bool) {
        if (len == 0 || !_needsPrefix(rule)) return true;
        bytes memory prefix = _prefix(rule);
        if (len < prefix.length) return false;
        for (uint256 j; j < prefix.length; ++j) {
            if (b[start + j] != prefix[j]) return false;
        }
        return true;
    }

    /// @dev A canonical bytes32[] in params: its length word at \`offset\` (checked by \`_canonical\`), its items after.
    function _nonZeroItems(bytes memory p, uint256 offset) private pure returns (bool) {
        uint256 count = _word(p, offset);
        for (uint256 j; j < count; ++j) {
            if (_word(p, offset + 32 + 32 * j) == 0) return false;
        }
        return true;
    }

    /// @dev True when every byte of b[start, start + len) has its bit set in \`mask\`. The callers checked that the
    /// range lies inside \`b\` (a string's own length, or canonical params). Each byte is read as the low byte of the
    /// word ending at it, so every read stays inside \`b\`'s allocation (its length word and data).
    function _allBytesAllowed(bytes memory b, uint256 start, uint256 len, uint256 mask) private pure returns (bool ok) {
        ok = true;
        assembly ("memory-safe") {
            let p := add(add(b, 0x20), start)
            let end := add(p, len)
            for {} lt(p, end) { p := add(p, 1) } {
                if iszero(and(shr(and(mload(sub(p, 31)), 0xff), mask), 1)) {
                    ok := 0
                    break
                }
            }
        }
    }

    /// @dev Format v1 of the metadata table, BoxMetadataTable.validate's rules (core item 9): version byte 1, a uint16
    /// big-endian description length and the description, at most MAX_TRAIT_TYPES types, then per type a name of at
    /// least one byte, a value count of at least one and each value of at least one byte, every text JSON_TEXT, and
    /// nothing after the last value. Never reverts: every offset is compared with the table's length before a read.
    function _tableV1(bytes memory t) private pure returns (bool) {
        uint256 len = t.length;
        if (len < 3 || uint8(t[0]) != 1) return false;
        uint256 mask = _mask(RULE_JSON_TEXT);
        uint256 c = 3 + ((uint256(uint8(t[1])) << 8) | uint256(uint8(t[2])));
        if (c >= len || !_allBytesAllowed(t, 3, c - 3, mask)) return false;
        uint256 types = uint8(t[c++]);
        if (types > MAX_TRAIT_TYPES) return false;
        bool ok;
        for (uint256 i; i < types; ++i) {
            (ok, c) = _tableText(t, c, mask);
            if (!ok || c >= len) return false;
            uint256 values = uint8(t[c++]);
            if (values == 0) return false;
            for (uint256 v; v < values; ++v) {
                (ok, c) = _tableText(t, c, mask);
                if (!ok) return false;
            }
        }
        return c == len;
    }

    /// @dev One text of the table at \`c\`: a length byte of at least 1, then that many JSON_TEXT bytes inside \`t\`.
    /// Returns whether it holds and the offset after it.
    function _tableText(bytes memory t, uint256 c, uint256 mask) private pure returns (bool, uint256) {
        if (c >= t.length) return (false, c);
        uint256 n = uint8(t[c]);
        uint256 end = c + 1 + n;
        if (n == 0 || end > t.length || !_allBytesAllowed(t, c + 1, n, mask)) return (false, c);
        return (true, end);
    }

    /// @dev \`ok\` when \`p\` is exactly the canonical abi.encode of a tuple of \`kinds\` (strings and bytes32[] the only
    /// dynamic types): head words in order, each dynamic part's offset the next free position, zero padding, no
    /// trailing bytes, every static value inside its type. \`w\` holds the static values and, for a dynamic part, the
    /// offset of its length word. Never reverts: every length is compared with \`p.length\` before any arithmetic on it.
    /// Each early return leaves \`ok\` false.
    function _canonical(bytes memory p, uint8[] memory kinds) private pure returns (bool ok, uint256[] memory w) {
        uint256 k = kinds.length;
        w = new uint256[](k);
        uint256 size = p.length;
        uint256 cursor = k * 32;
        if (size < cursor) return (ok, w);
        for (uint256 i; i < k; ++i) {
            uint256 v = _word(p, i * 32);
            if (kinds[i] == _K_STRING) {
                if (v != cursor || size - cursor < 32) return (ok, w);
                uint256 len = _word(p, cursor);
                if (len > size) return (ok, w);
                uint256 padded = (len + 31) & ~uint256(31);
                if (size - cursor - 32 < padded) return (ok, w);
                uint256 end = cursor + 32 + padded;
                for (uint256 j = cursor + 32 + len; j < end; ++j) {
                    if (p[j] != 0) return (ok, w);
                }
                w[i] = cursor;
                cursor = end;
            } else if (kinds[i] == _K_BYTES32_ARRAY) {
                if (v != cursor || size - cursor < 32) return (ok, w);
                uint256 count = _word(p, cursor);
                if (count > (size - cursor - 32) / 32) return (ok, w);
                w[i] = cursor;
                cursor = cursor + 32 + 32 * count;
            } else {
                if (!_fits(kinds[i], v)) return (ok, w);
                w[i] = v;
            }
        }
        ok = cursor == size;
    }

    function _fits(uint8 kind, uint256 v) private pure returns (bool) {
        if (kind == _K_UINT256 || kind == _K_BYTES32) return true;
        if (kind == _K_BOOL) return v <= 1;
        if (kind == _K_ADDRESS) return v >> 160 == 0;
        // _K_UINT8 ... _K_UINT128: 8, 16, 32, 64 or 128 bits.
        return v >> (uint256(8) << (kind - 1)) == 0;
    }

    function _word(bytes memory p, uint256 offset) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(add(p, 0x20), offset))
        }
    }

    function _hasAddOn(BoxSpec memory s, uint16 id) private pure returns (bool) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id) return true;
        }
        return false;
    }

    /// @dev True when an entry of add-on \`id\` holds \`value\` in head word \`index\` of its params. Only rules call it, and
    /// rules run after every add-on passed its own checks, so each entry's params hold at least its head words.
    function _addOnWordIs(BoxSpec memory s, uint16 id, uint256 index, uint256 value) private pure returns (bool) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id && _word(s.addOns[i].params, 32 * index) == value) return true;
        }
        return false;
    }

    function _inList(uint8 v, uint8[] memory list) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == v) return true;
        }
        return false;
    }`;

const SOL_V1_ONLY = `    function _isListed(address q, QAsset[] memory qList) private pure returns (bool) {
        for (uint256 i; i < qList.length; ++i) {
            if (qList[i].token == q) return true;
        }
        return false;
    }

    /// @dev The first listed entry for \`q\` decides (as in \`_qClassOf\`).
    function _isPreset(address q, uint256 raise, QAsset[] memory qList) private pure returns (bool) {
        for (uint256 i; i < qList.length; ++i) {
            if (qList[i].token != q) continue;
            uint256[] memory presets = qList[i].raisePresets;
            for (uint256 j; j < presets.length; ++j) {
                if (presets[j] == raise) return true;
            }
            return false;
        }
        return false;
    }

    function _qClassOf(address q, QAsset[] memory qList) private pure returns (uint8) {
        for (uint256 i; i < qList.length; ++i) {
            if (qList[i].token == q) return qList[i].qClass;
        }
        return 0;
    }`;

const SOL_HELPERS = `${SOL_KINDS}\n\n${solAllowed()}\n\n${SOL_SHARED}\n\n${SOL_V1_ONLY}`;

/** Each rule as a 256-bit mask of its allowed bytes (bit c set = byte c allowed), so a byte costs one shift. */
function solAllowed(ruleList = [...rules.values()]) {
  const lines = [];
  for (const r of ruleList) {
    let mask = 0n;
    for (const [lo, hi] of r.allowed) {
      assert(lo >= 0 && hi <= 255 && lo <= hi, `rule ${r.name}: bad range ${lo}-${hi}`);
      for (let c = lo; c <= hi; c++) mask |= 1n << BigInt(c);
    }
    lines.push(`    /// @dev Bytes rule ${r.name} allows: ${r.allowed.map(([lo, hi]) => (lo === hi ? `0x${lo.toString(16)}` : `0x${lo.toString(16)}-0x${hi.toString(16)}`)).join(', ')}.`);
    lines.push(`    uint256 private constant _MASK_${r.name} = 0x${mask.toString(16).padStart(64, '0')};`);
  }
  lines.push('');
  lines.push('    function _mask(uint8 rule) private pure returns (uint256) {');
  for (const r of ruleList) lines.push(`        if (rule == RULE_${r.name}) return _MASK_${r.name};`);
  lines.push('        return 0;');
  lines.push('    }');
  lines.push('');
  const prefixed = ruleList.filter((r) => r.prefix);
  lines.push('    function _needsPrefix(uint8 rule) private pure returns (bool) {');
  lines.push(`        return ${prefixed.length ? prefixed.map((r) => `rule == RULE_${r.name}`).join(' || ') : 'false'};`);
  lines.push('    }');
  lines.push('');
  lines.push('    /// @dev The prefix a non-empty string of the rule must start with (none: empty).');
  lines.push('    function _prefix(uint8 rule) private pure returns (bytes memory) {');
  for (const r of ruleList) if (r.prefix) lines.push(`        if (rule == RULE_${r.name}) return "${r.prefix}";`);
  lines.push('        return "";');
  lines.push('    }');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Solidity, format 2 (M1-10-b): src/box-v2/BoxSpecV2.sol over M1-00's frozen types (SpecTypes.sol, RecipeTypes.sol)
// ---------------------------------------------------------------------------------------------------------------

const SOL_V2_ONLY = `    function _pw(bytes memory p, uint256 i) private pure returns (uint256) {
        return _word(p, 32 * i);
    }

    /// @dev The length of a dynamic member of canonical params: its offset is head word \`i\`, its length word is there.
    function _dynLen(bytes memory p, uint256 i) private pure returns (uint256) {
        return _word(p, _word(p, 32 * i));
    }

    /// @dev An address member of canonical params: \`_canonical\` checked that its word fits 160 bits.
    function _addr(uint256 w) private pure returns (address) {
        // casting to 'uint160' is safe because canonical params hold an address member in its low 160 bits
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(w));
    }

    /// @dev A params list's kinds from one byte each (\`_K_*\`), so a check carries them as one literal.
    function _kinds(bytes memory k) private pure returns (uint8[] memory kinds) {
        kinds = new uint8[](k.length);
        for (uint256 i; i < k.length; ++i) {
            kinds[i] = uint8(k[i]);
        }
    }

    function _isCanonical(bytes memory p, uint8[] memory kinds) private pure returns (bool ok) {
        (ok,) = _canonical(p, kinds);
    }

    function _in16(uint16 v, uint16[] memory list) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == v) return true;
        }
        return false;
    }

    /// @dev An empty context is not native listing zero: admitted rows have a nonzero kind.
    function _listingKnown(ReleaseContext memory ctx, uint256 id) private pure returns (bool) {
        return ctx.listing.kind != 0 && ctx.listing.id == id;
    }

    function _listingTokenIs(ReleaseContext memory ctx, uint256 id, address token) private pure returns (bool) {
        return _listingKnown(ctx, id) && ctx.listing.token == token;
    }

    function _raiseMatches(ReleaseContext memory ctx, uint256 id, uint256 raise) private pure returns (bool) {
        return _listingKnown(ctx, id) && raise == ctx.listing.raise;
    }

    function _sameBranch(Branch memory x, Branch memory y) private pure returns (bool) {
        return x.leg == y.leg && x.dest == y.dest && keccak256(x.legParams) == keccak256(y.legParams)
            && keccak256(x.destParams) == keccak256(y.destParams);
    }

    function _one(bool b) private pure returns (uint256 n) {
        if (b) n = 1;
    }`;

const indent = (lines, n) => lines.map((l) => (l === '' ? '' : `${' '.repeat(n)}${l}`));

function solConstV2(c) {
  if (c.type.endsWith('[]')) {
    const type = c.type.slice(0, -2);
    return `function ${c.name}() internal pure returns (${c.type} memory values) {\n        values = new ${c.type}(${c.value.length});\n${c.value.map((v, i) => `        values[${i}] = ${type}(${solInt(v)});`).join('\n')}\n    }`;
  }
  if (c.type === 'address' || c.type === 'bytes32') return `${c.type} internal constant ${c.name} = ${c.value};`;
  return `${c.type} internal constant ${c.name} = ${solInt(c.value)};`;
}

function emitSolidityV2(model) {
  const D = dialect('sol', model);
  const specEnums = [...model.enums.values()].filter((e) => !e.frozen || /\/(SpecTypes|RecipeTypes)\.sol$/.test(e.file));
  const frozenFrom = (file) => specEnums.filter((e) => e.frozen && e.file.endsWith(file)).map((e) => e.name);
  const L = [];
  L.push('// SPDX-License-Identifier: MIT', 'pragma solidity 0.8.26;', '');
  L.push(`// GENERATED FILE, do not edit: packages/box-spec/scripts/generate-v2.mjs writes it from ${model.labels.spec}`);
  L.push(`// and ${model.labels.addOns}; \`node packages/box-spec/scripts/generate-v2.mjs --check\` fails when stale.`);
  L.push('');
  L.push(`import {BoxSpec, ReleaseContext, ${frozenFrom('SpecTypes.sol').join(', ')}} from "./interfaces/SpecTypes.sol";`);
  L.push(`import {Branch, Side, ${frozenFrom('RecipeTypes.sol').join(', ')}} from "./interfaces/RecipeTypes.sol";`);
  L.push('');
  L.push('/// @title BoxSpecV2');
  L.push('/// @notice BoxSpec format 2 (box-spec-v2-draft.md § 2-7): its fixed values, `validate()` and `specHash()` over the types');
  L.push('/// ticket M1-00 froze (SpecTypes.sol, RecipeTypes.sol), which this library imports and never redefines. The TypeScript');
  L.push('/// twin is packages/box-spec/src/generated/box-spec.v2.ts; both come from the same checks (scripts/lib/checks-v2.mjs).');
  L.push('/// @dev Every enum is a uint8 on the wire (0 is never a member). `validate()` returns the first failing (reason, field):');
  L.push('/// fields in id order (a recipe field checks its members, the release context`s offers and its canonical params),');
  L.push('/// including add-ons at field 29, then the rules and opaque shop contents. Recipe sub-fields are the field id x 1000 + the offset (buyers 17001-17022).');
  L.push('library BoxSpecV2 {');
  const sec = (title) => L.push(`    // ${'-'.repeat(91 - title.length)} ${title}`);
  sec('fixed values');
  L.push('    /// @dev False for the real M1-10 source. Kept as the release boundary marker; the');
  L.push('    /// validator (M1-32-a) and the release runs (M1-61, M1-64) must assert it is false before any deploy.');
  L.push('    bool internal constant SOURCE_IS_STUB = false;');
  for (const c of model.constants.values()) L.push(`    /// @dev ${c.source}`, `    ${solConstV2(c)}`);
  L.push('');
  sec('enums (uint8)');
  for (const e of specEnums) {
    for (const m of e.members) L.push(`    uint8 internal constant ${snake(e.name)}_${snake(m.name)} = ${e.frozen ? `uint8(${e.name}.${m.name})` : m.value};`);
  }
  L.push('');
  sec('string rules');
  for (const r of model.stringRules.values()) L.push(`    uint8 internal constant RULE_${r.name} = ${r.id};`);
  L.push('');
  sec('reasons');
  for (const [name, code] of model.reasons) L.push(`    uint16 internal constant REASON_${name} = ${code};`);
  L.push('');
  sec('field ids');
  for (const [path, id] of model.fieldIds) L.push(`    uint16 internal constant ${solConstName(path)} = ${solInt(id)};`);
  L.push('');
  sec('add-ons');
  for (const a of model.addOns) L.push(`    uint16 internal constant ADD_ON_${snake(a.key)} = ${a.id};`);
  L.push('');
  sec('API');
  L.push('    /// @notice keccak256 of the ABI encoding of the whole spec (the registry`s spec hash).');
  L.push('    function specHash(BoxSpec memory s) internal pure returns (bytes32) {', '        return keccak256(abi.encode(s));', '    }', '');
  L.push('    /// @notice (REASON_OK, 0) for a valid spec, else the first failing check`s reason and field id, under the release`s');
  L.push('    /// context (the factory supplies the current pricing listing; offers are fixed by this release).');
  L.push('    function validate(BoxSpec memory s, ReleaseContext memory ctx) internal pure returns (uint16 reason, uint16 field) {');
  L.push('        (reason, field) = _checkFields(s, ctx);', '        if (reason != REASON_OK) return (reason, field);');
  L.push('        (reason, field) = _checkRules(s, ctx);', '        if (reason != REASON_OK) return (reason, field);', '        return _checkShop(s);', '    }', '');
  sec('fields');
  L.push('    function _checkFields(BoxSpec memory s, ReleaseContext memory ctx) private pure returns (uint16, uint16) {');
  const fieldLines = [];
  for (const f of model.fields) {
    const lines = fieldCheckLines(D, model, f);
    if (lines.length) fieldLines.push(`// ${f.id} ${f.name}`, ...lines);
  }
  if (model.fields.some((f) => f.check.kind === 'string')) L.push('        uint16 r;');
  if (model.recipeFields.length) L.push('        uint16 f;');
  if (model.recipeFields.length && !model.fields.some((f) => f.check.kind === 'string')) L.push('        uint16 r;');
  L.push(...indent(fieldLines, 8), '        return (REASON_OK, 0);', '    }', '');
  sec('recipes');
  L.push('    function _checkSide(Side memory d, ReleaseContext memory ctx, uint16 base) private pure returns (uint16 r, uint16 f) {');
  L.push(...indent(sideCheckLines(D, model), 8), '    }', '');
  L.push('    function _checkBranch(Branch memory br, ReleaseContext memory ctx, uint16 base) private pure returns (uint16, uint16) {');
  L.push(...indent(branchCheckLines(D, model), 8), '    }', '');
  sec('add-ons');
  const listField = model.fields.find((f) => f.check.kind === 'addOns');
  L.push('    function _checkAddOns(BoxSpec memory s, ReleaseContext memory ctx) private pure returns (uint16, uint16) {');
  L.push(`        uint256 count = s.${listField.name}.length;`);
  L.push(`        if (count > ${D.bound(listField.check.maxCount, 'uint256')}) return (REASON_TOO_MANY_ADD_ONS, ${solConstName(listField.name)});`);
  L.push('        for (uint256 i; i < count; ++i) {', `            uint16 id = s.${listField.name}[i].id;`, '            if (i != 0) {');
  L.push(`                uint16 previous = s.${listField.name}[i - 1].id;`);
  L.push(`                if (id < previous || (id == previous && !_repeatable(id))) return (REASON_ADD_ON_ORDER, ${solConstName(listField.name)});`);
  L.push('            }', `            (uint16 r, uint16 f) = _checkAddOn(s, ctx, id, s.${listField.name}[i].params);`, '            if (r != REASON_OK) return (r, f);', '        }');
  L.push('        return (REASON_OK, 0);', '    }', '');
  const repeatable = model.addOns.filter((a) => a.repeatable);
  L.push('    function _repeatable(uint16 id) private pure returns (bool) {');
  L.push(`        return ${repeatable.length ? repeatable.map((a) => `id == ADD_ON_${snake(a.key)}`).join(' || ') : 'id != id'};`, '    }', '');
  L.push('    function _checkAddOn(BoxSpec memory s, ReleaseContext memory ctx, uint16 id, bytes memory p)', '        private', '        pure', '        returns (uint16, uint16)', '    {');
  for (const a of model.addOns) L.push(`        if (id == ADD_ON_${snake(a.key)}) return _check${pascal(a.key)}(s, ctx, p);`);
  L.push(`        return (REASON_ADD_ON_UNKNOWN, ${solConstName(listField.name)});`, '    }', '');
  /** A parameter list with each name its body never reads left unnamed (no unused-parameter warning). */
  const params = (list, lines) => {
    const code = lines.filter((l) => !l.trimStart().startsWith('//')).join('\n');
    return list.map(([type, name]) => (new RegExp(`\\b${name}\\b`).test(code) ? `${type} ${name}` : type)).join(', ');
  };
  for (const a of model.addOns) {
    const lines = addOnCheckLines(D, model, a);
    L.push(`    /// @dev Add-on ${a.id} \`${a.key}\`: ${a.title}.`);
    L.push(`    function _check${pascal(a.key)}(${params([['BoxSpec memory', 's'], ['ReleaseContext memory', 'ctx'], ['bytes memory', 'p']], lines)})`, '        private', '        pure', '        returns (uint16, uint16)', '    {');
    L.push(...indent(lines, 8), '    }', '');
  }
  sec('rules');
  const rules = ruleParts(D, model);
  L.push(`    function _checkRules(${params([['BoxSpec memory', 's'], ['ReleaseContext memory', 'ctx']], rules.lines)}) private pure returns (uint16, uint16) {`);
  if (rules.runs.length) L.push('        uint16 r;');
  if (rules.runs.length || rules.cfg.length) L.push('        uint16 f;');
  L.push(...indent(rules.lines, 8), '    }', '');
  for (const [expr, { name, args }] of D.lifted) {
    const types = { s: 'BoxSpec memory', ctx: 'ReleaseContext memory' };
    L.push('    /// @dev Whether any branch in use matches (shared by the rules that ask).');
    L.push(`    function _${name}(${args.map((a) => `${types[a]} ${a}`).join(', ')}) private pure returns (bool) {`, `        return ${expr};`, '    }', '');
  }
  for (const run of rules.runs) {
    const list = [...(run.indexed ? [['uint256', 'k']] : []), ['BoxSpec memory', 's'], ['ReleaseContext memory', 'ctx'], ['Side memory', 'd'], ...(run.scope === 'branch' ? [['Branch memory', 'br']] : []), ['bool', 'buyers'], ['uint16', 'base']];
    const what = run.indexed ? `Rule \`k\` of a run of ${run.scope} rules (rule-major: \`_checkRules\` loops k)` : `A run of ${run.scope} rules, in source order,`;
    L.push(`    /// @dev ${what} on one ${run.scope} (\`buyers\`: the buyers' side; \`base\`: its sub-field base).`);
    L.push(`    function _${run.name}(${params(list, run.lines)})`, '        private', '        pure', '        returns (uint16, uint16)', '    {');
    L.push(...indent(run.lines, 8), '    }', '');
  }
  for (const h of rules.cfg) {
    const branch = h.scope === 'cfgBranch';
    L.push(`    /// @dev The plug-in cfg budget on one ${branch ? 'branch' : 'side'}: adds its cfg bytes to \`cfg\`; the params sub-field that crosses the bound, else 0.`);
    L.push(`    function _${h.name}(${branch ? 'Branch memory br' : 'Side memory d'}, uint256 cfg, uint16 base) private pure returns (uint256, uint16${branch ? '' : ' f'}) {`);
    L.push(...indent(h.lines, 8), '    }', '');
  }
  sec('shop contents (frozen IShopVaultV2)');
  L.push('    function _checkShop(BoxSpec memory s) private pure returns (uint16, uint16) {');
  L.push(...indent(shopCheckLines(D, model), 8), '    }', '');
  L.push(SOL_KINDS, '', solAllowed([...model.stringRules.values()]), '', SOL_SHARED, '', SOL_V2_ONLY, '}', '');
  return L.join('\n');
}

export { emitSolidity, emitSolidityV2 };
