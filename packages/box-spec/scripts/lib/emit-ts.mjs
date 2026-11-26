/** The TypeScript emitter: packages/box-spec/src/generated/box-spec.v1.ts. Part of generate.mjs. */
import {
  NETWORKS,
  STRICTEST_NETWORK,
  fail,
  spec,
  UINT_BITS,
  isSmallUint,
  paramKindName,
  constants,
  enums,
  enumValue,
  rules,
  reasons,
  fields,
  addOns,
  fieldIds,
  contexts,
  contextIndex,
  snake,
  pascal,
  tsBig,
  bound,
  predicate,
} from './model.mjs';
import { addOnCheckLines, branchCheckLines, dialect, fieldCheckLines, kindOf, recipeStructs, ruleParts, shopCheckLines, sideCheckLines } from './checks-v2.mjs';

// ---------------------------------------------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------------------------------------------

/** `bytesForm`: the form whose strings are their raw bytes (hex), as Solidity sees them on the wire. */
function tsType(type, bytesForm = false) {
  if (type === 'AddOn[]') return 'readonly AddOnV1[]';
  if (type === 'string') return bytesForm ? 'Hex' : 'string';
  if (type === 'address') return 'Address';
  if (type === 'bytes' || type === 'bytes32') return 'Hex';
  if (type === 'bool') return 'boolean';
  if (type in UINT_BITS) return isSmallUint(type) ? 'number' : 'bigint';
  return fail(`no TS type for ${type}`);
}

function tsZod(type) {
  if (type === 'AddOn[]') return 'z.array(z.object({ id: uintN(16), params: hexBytes }))';
  if (type === 'string') return 'z.string()';
  if (type === 'address') return 'address';
  if (type === 'bytes') return 'hexBytes';
  if (type === 'bytes32') return 'bytes32';
  if (type in UINT_BITS) return isSmallUint(type) ? `uintN(${UINT_BITS[type]})` : `uintBig(${UINT_BITS[type]})`;
  return fail(`no zod type for ${type}`);
}

/** The field's own check, or with `zeroWhen` (F70): zero (or empty) while the predicate holds, its own check otherwise. */
function tsFieldCheck(f) {
  const own = tsOwnFieldCheck(f);
  const when = f.check.zeroWhen;
  if (when === undefined) return own;
  const lines = [`if (${predicate(when, 'ts')}) {`, `  if (${tsNonZero(f)}) return verdict(Reason.MUST_BE_ZERO, Field.${f.name});`];
  if (own.length) lines.push('} else {', ...own.map((line) => `  ${line}`));
  lines.push('}');
  return lines;
}

/** On the bytes form: strings and bytes are hex. */
function tsNonZero(f) {
  const ref = `s.${f.name}`;
  if (f.type === 'string' || f.type === 'bytes') return `hexLength(${ref}) !== 0`;
  if (f.type === 'bytes32' || f.type === 'address') return `!isZeroHex(${ref})`;
  if (f.type in UINT_BITS) return `${ref} !== ${isSmallUint(f.type) ? '0' : '0n'}`;
  return fail(`field ${f.name}: no zero test for ${f.type}`);
}

function tsOwnFieldCheck(f) {
  const c = f.check;
  const id = `Field.${f.name}`;
  const ref = `s.${f.name}`;
  switch (c.kind) {
    case 'uint': {
      const reason = `Reason.${c.reason ?? 'OUT_OF_RANGE'}`;
      const lit = (v) => (isSmallUint(f.type) ? String(v) : tsBig(v));
      if (c.allowed) return [`if (!(${c.allowed.map((v) => `${ref} === ${lit(v)}`).join(' || ')})) return verdict(${reason}, ${id});`];
      const range = c.max === undefined ? `${ref} < ${bound(c.min, 'ts', f.type)}` : `${ref} < ${bound(c.min, 'ts', f.type)} || ${ref} > ${bound(c.max, 'ts', f.type)}`;
      return [`if (${c.orZero ? `${ref} !== ${isSmallUint(f.type) ? '0' : '0n'} && (${range})` : range}) return verdict(${reason}, ${id});`];
    }
    case 'enum': {
      const e = enums.get(f.enum);
      const members = e.members.map((m) => `${ref} === ${f.enum}.${m.name}`).join(' || ');
      const offered = c.offered.map((m) => `${ref} === ${f.enum}.${m}`).join(' || ');
      const lines = [`if (!(${members})) return verdict(Reason.NOT_A_MEMBER, ${id});`];
      // F74 U1: a field with members offered only on some networks reads the network's list (mainnet = Solidity's).
      if (byNetwork(e)) lines.push(`if (!(OFFERED_ON[network].${f.name} ?? []).includes(${ref})) return verdict(Reason.NOT_OFFERED, ${id});`);
      else if (c.offered.length !== e.members.length) lines.push(`if (!(${offered})) return verdict(Reason.NOT_OFFERED, ${id});`);
      if (c.inContext) lines.push(`if (!ctx.${c.inContext}.includes(${ref})) return verdict(Reason.NOT_OFFERED, ${id});`);
      return lines;
    }
    case 'string':
      return [
        `r = checkString(hexToBytes(${ref}), ${bound(c.minBytes, 'ts', 'uint32')}, ${bound(c.maxBytes, 'ts', 'uint32')}, RULE_RANGES.${c.rule}, RULE_PREFIXES.${c.rule});`,
        `if (r !== Reason.OK) return verdict(r, ${id});`,
      ];
    case 'bytes': {
      const lines = [
        `if (hexLength(${ref}) < ${bound(c.minBytes, 'ts', 'uint32')} || hexLength(${ref}) > ${bound(c.maxBytes, 'ts', 'uint32')}) return verdict(Reason.LENGTH_OUT_OF_RANGE, ${id});`,
      ];
      // Core item 9: the metadata table's format v1, after its length (Solidity `_tableV1`).
      if (c.format === 'METADATA_TABLE_V1') lines.push(`if (!tableV1(hexToBytes(${ref}), Number(MAX_TRAIT_TYPES), RULE_RANGES.JSON_TEXT)) return verdict(Reason.METADATA_TABLE_MALFORMED, ${id});`);
      return lines;
    }
    case 'nonZero':
      return [`if (isZeroHex(${ref})) return verdict(Reason.ZERO_VALUE, ${id});`];
    case 'listedQ':
      return [`if (!isListed(${ref}, ctx.qList)) return verdict(Reason.Q_NOT_LISTED, ${id});`];
    case 'raisePreset':
      return [`if (!isPreset(s.q, ${ref}, ctx.qList)) return verdict(Reason.RAISE_NOT_A_PRESET, ${id});`];
    case 'any':
    case 'addOns':
      return [];
    default:
      return fail(`field ${f.name}: unknown check ${c.kind}`);
  }
}

/** Whether an enum's offer depends on the network (F74 U1 offeredOn, or notBuiltOn): then its checks read OFFERED_ON. */
const byNetwork = (e) => e.members.some((m) => m.offeredOn !== undefined || m.notBuiltOn !== undefined);
/** Whether an add-on's checks depend on the network (an enum parameter with such members). */
const addOnByNetwork = (a) => a.params.some((p) => p.enum && byNetwork(enums.get(p.enum)));

function tsAddOnFunction(a) {
  const base = `Field['addOns.${a.key}']`;
  const L = [];
  L.push(`/** Add-on ${a.id} \`${a.key}\`: ${a.title}. */`);
  L.push(`function check${pascal(a.key)}(s: BoxSpecV1Bytes, p: Uint8Array${addOnByNetwork(a) ? ', network: Network' : ''}): Verdict {`);
  L.push(`  if (!(${a.versions.map((v) => `s.version === ${v}`).join(' || ')})) return verdict(Reason.ADD_ON_NOT_AVAILABLE, ${base});`);
  L.push(`  if (!${predicate({ field: 'boxType', in: a.boxTypes }, 'ts')}) return verdict(Reason.ADD_ON_CONFLICT, ${base});`);
  if (a.params.length === 0) {
    L.push(`  if (p.length !== 0) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, ${base});`);
  } else {
    L.push(`  const w = canonicalParams(p, [${a.params.map((x) => `ParamKind.${paramKindName(x.type)}`).join(', ')}]);`);
    L.push(`  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, ${base});`);
    a.params.forEach((param, i) => {
      const id = `Field['addOns.${a.key}.${param.name}']`;
      const word = `word(w, ${i})`;
      if (param.type === 'string') {
        L.push(`  const r${i} = checkStringAt(p, ${word}, ${param.minBytes}, ${param.maxBytes}, RULE_RANGES.${param.rule}, RULE_PREFIXES.${param.rule});`);
        L.push(`  if (r${i} !== Reason.OK) return verdict(r${i}, ${id});`);
      } else if (param.type in UINT_BITS && ('min' in param || 'max' in param)) {
        const cond = [];
        if ('min' in param) cond.push(`${word} < ${bound(param.min, 'ts', 'uint256')}`);
        if ('max' in param) cond.push(`${word} > ${bound(param.max, 'ts', 'uint256')}`);
        L.push(`  if (${cond.join(' || ')}) return verdict(Reason.OUT_OF_RANGE, ${id});`);
      } else if (param.allowed) {
        L.push(`  if (!(${param.allowed.map((v) => `${word} === ${tsBig(v)}`).join(' || ')})) return verdict(Reason.NOT_A_MEMBER, ${id});`);
      } else if (param.enum) {
        const set = enums.get(param.enum).members.map((m) => `${word} === BigInt(${param.enum}.${m.name})`).join(' || ');
        L.push(`  if (!(${set})) return verdict(Reason.NOT_A_MEMBER, ${id});`);
        if (byNetwork(enums.get(param.enum))) {
          L.push(`  if (!(OFFERED_ON[network]['addOns.${a.key}.${param.name}'] ?? []).includes(Number(${word}))) return verdict(Reason.NOT_OFFERED, ${id});`);
        } else if (param.offered && param.offered.length !== enums.get(param.enum).members.length) {
          const offered = param.offered.map((m) => `${word} === BigInt(${param.enum}.${m})`).join(' || ');
          L.push(`  if (!(${offered})) return verdict(Reason.NOT_OFFERED, ${id});`);
        }
      } else if (param.type === 'bytes32[]') {
        L.push(`  if (readWordAt(p, ${word}) > ${tsBig(param.maxItems)}) return verdict(Reason.LENGTH_OUT_OF_RANGE, ${id});`);
        if (param.nonZeroItems) L.push(`  if (!nonZeroItems(p, ${word})) return verdict(Reason.ZERO_VALUE, ${id});`);
      } else if (param.nonZeroIff) {
        const when = predicate({ param: param.nonZeroIff.param, eq: param.nonZeroIff.eq }, 'ts', a);
        L.push(`  if (${when}) {`);
        L.push(`    if (${word} === 0n) return verdict(Reason.ZERO_VALUE, ${id});`);
        L.push(`  } else if (${word} !== 0n) {`);
        L.push(`    return verdict(Reason.MUST_BE_ZERO, ${id});`);
        L.push('  }');
      } else if (param.nonZero) {
        L.push(`  if (${word} === 0n) return verdict(Reason.ZERO_VALUE, ${id});`);
      }
    });
  }
  for (const req of a.requires) L.push(`  if (!(${predicate(req.predicate, 'ts', a)})) return verdict(Reason.${req.reason}, ${base});`);
  L.push('  return OK;');
  L.push('}');
  return L.join('\n');
}

function tsParamType(type) {
  if (type === 'bytes32[]') return 'readonly Hex[]';
  if (type === 'string') return 'string';
  if (type === 'address') return 'Address';
  if (type === 'bytes32') return 'Hex';
  if (type === 'bool') return 'boolean';
  return isSmallUint(type) ? 'number' : 'bigint';
}

/**
 * Menus for forms (box creation flow § 2.2): each fee-kind enum's members with their `kind`, `paidIn` and
 * `buys`/`sells`, and what each enum field or add-on parameter offers (its `offered` members, or its `allowed` list).
 * Data only: validate() does not read it, so a page can build its choices from the source instead of a copy.
 */
function emitMenus(L) {
  L.push('// ------------------------------------------------------------------------------------------------ menus (data for forms)');
  L.push("export type FeeKind = 'CREATOR' | 'HOLDERS' | 'BURN' | 'STREAM';");
  L.push('/** An enum member with its fee-kind metadata (F70): what a payout does. validate() does not read it. */');
  L.push('export interface EnumMemberInfo {');
  L.push('  readonly name: string;');
  L.push('  readonly value: number;');
  L.push('  readonly kind: FeeKind;');
  L.push("  readonly paidIn: 'Q' | 'T';");
  L.push('  readonly buys: boolean;');
  L.push('  readonly sells: boolean;');
  L.push('  /** F74 U1: the networks where a creator may choose it (mainnet: what validate() offers; Sepolia: what core v1 builds). */');
  L.push('  readonly offeredOn: readonly Network[];');
  L.push("  /** The note the page shows beside it where it is offered early (\"pending legal review\"), else null. */");
  L.push('  readonly pending: string | null;');
  L.push('}');
  const withKinds = [...enums.values()].filter((e) => e.members.some((m) => m.kind !== undefined));
  /** The field that uses an enum, for its strictest `offered` list. */
  const fieldOf = (e) => fields.find((f) => f.enum === e.name);
  const networksOf = (e, m) => {
    const f = fieldOf(e);
    const strict = !f?.check.offered || f.check.offered.includes(m.name);
    return strict ? NETWORKS.filter((n) => !(m.notBuiltOn ?? []).includes(n)) : NETWORKS.filter((n) => (m.offeredOn ?? []).includes(n));
  };
  L.push('/** The fee-kind enums (QStream, TStream), member by member, in value order. */');
  L.push('export const ENUM_MEMBERS: Readonly<Record<string, readonly EnumMemberInfo[]>> = {');
  for (const e of withKinds) {
    L.push(`  ${e.name}: [`);
    for (const m of [...e.members].sort((a, b) => a.value - b.value)) {
      if (m.kind === undefined || m.paidIn === undefined) fail(`${e.name}.${m.name}: a fee-kind enum names kind and paidIn for every member`);
      const on = networksOf(e, m).map((n) => `'${n}'`).join(', ');
      const pending = m.pending === undefined ? 'null' : `'${m.pending.replace(/'/g, "\\'")}'`;
      L.push(`    { name: '${m.name}', value: ${m.value}, kind: '${m.kind}', paidIn: '${m.paidIn}', buys: ${m.buys === true}, sells: ${m.sells === true}, offeredOn: [${on}], pending: ${pending} },`);
    }
    L.push('  ],');
  }
  L.push('};');
  // [path, enum or null, strictest values (numbers), every value's members for the network lists]
  const offered = [];
  const amounts = [];
  for (const f of fields) {
    if (f.check.kind === 'enum' && f.check.offered) offered.push([f.name, enums.get(f.enum), f.check.offered]);
  }
  for (const a of addOns) {
    for (const param of a.params) {
      const path = `addOns.${a.key}.${param.name}`;
      // An amount (a wide uint, F74 U2) is a bigint list: never a JS number.
      if (param.allowed && !isSmallUint(param.type)) amounts.push([path, param.allowed]);
      else if (param.allowed) offered.push([path, null, param.allowed]);
      else if (param.enum) offered.push([path, enums.get(param.enum), param.offered ?? enums.get(param.enum).members.map((m) => m.name)]);
    }
  }
  const key = (p) => (/^[A-Za-z_]\w*$/.test(p) ? p : `'${p}'`);
  /**
   * The values offered on `network`: validate()'s list less the members not built there (notBuiltOn), plus the members
   * offered early there (offeredOn), in value order then.
   */
  const valuesOn = (e, list, network) => {
    if (!e) return list.map((v) => Number(v));
    if (network === STRICTEST_NETWORK || !byNetwork(e)) return list.map((m) => enumValue(e.name, m));
    const on = (m) => (list.includes(m.name) && !(m.notBuiltOn ?? []).includes(network)) || (m.offeredOn ?? []).includes(network);
    return e.members.filter(on).map((m) => m.value);
  };
  L.push('/** What each enum field and menu parameter offers creators on the strictest network (mainnet), which is what validate() and Solidity accept (values, in the source order). */');
  L.push(`export const OFFERED: Readonly<Record<string, readonly number[]>> = {\n${offered.map(([p, e, list]) => `  ${key(p)}: [${valuesOn(e, list, STRICTEST_NETWORK).join(', ')}],`).join('\n')}\n};`);
  L.push('/** Amount menus (F74 U2), in Q raw units: bigint, never a JS number. */');
  L.push(`export const OFFERED_AMOUNTS: Readonly<Record<string, readonly bigint[]>> = {\n${amounts.map(([p, list]) => `  ${key(p)}: [${list.map(tsBig).join(', ')}],`).join('\n')}\n};`);
  L.push("/** F74 U1: where a creator may choose a value. `mainnet` is validate()'s own lists (the default); the Demo also offers holder payouts early with a pending note; Sepolia leaves out what core v1 does not build (NOT_BUILT). A local chain runs the same contracts as Sepolia. */");
  L.push(`export type Network = ${NETWORKS.map((n) => `'${n}'`).join(' | ')};`);
  L.push(`export const NETWORKS: readonly Network[] = [${NETWORKS.map((n) => `'${n}'`).join(', ')}];`);
  L.push(`export const STRICTEST_NETWORK: Network = '${STRICTEST_NETWORK}';`);
  L.push('/** OFFERED per network: the same keys, each list widened by the members offered early there (offeredOn) and narrowed by those not built there (notBuiltOn). */');
  L.push('export const OFFERED_ON: Readonly<Record<Network, Readonly<Record<string, readonly number[]>>>> = {');
  for (const n of NETWORKS) {
    L.push(`  ${n}: {`);
    for (const [p, e, list] of offered) L.push(`    ${key(p)}: [${valuesOn(e, list, n).join(', ')}],`);
    L.push('  },');
  }
  L.push('};');
  const pending = [...enums.values()].filter((e) => byNetwork(e));
  L.push("/** The note shown beside a member offered early (F74 U1: 'pending legal review'), by enum and member name. */");
  L.push('export const PENDING: Readonly<Record<string, Readonly<Record<string, string>>>> = {');
  for (const e of pending) {
    L.push(`  ${e.name}: { ${e.members.filter((m) => m.pending).map((m) => `${m.name}: '${m.pending.replace(/'/g, "\\'")}'`).join(', ')} },`);
  }
  L.push('};');
  const notBuilt = [...enums.values()].filter((e) => e.members.some((m) => m.notBuilt));
  L.push("/** Why a member validate() offers is left out on Sepolia (core v1 does not build it there: the receiver reverts ActionNotBuilt), by enum and member name. */");
  L.push('export const NOT_BUILT: Readonly<Record<string, Readonly<Record<string, string>>>> = {');
  for (const e of notBuilt) {
    L.push(`  ${e.name}: { ${e.members.filter((m) => m.notBuilt).map((m) => `${m.name}: '${m.notBuilt.replace(/'/g, "\\'")}'`).join(', ')} },`);
  }
  L.push('};');
  L.push('');
}

function tsQList(ctx) {
  const items = ctx.qList.map(
    (q) =>
      `  { token: '${q.token}', decimals: ${q.decimals}, qClass: QClass.${q.qClass}, raisePresets: [${q.presets.map(tsBig).join(', ')}] },`,
  );
  return [`/** ${ctx.status} */`, `export const Q_LIST_${snake(ctx.name)}: readonly QAsset[] = [`, ...items, '];'].join('\n');
}

function tsContext(ctx) {
  const N = snake(ctx.name);
  const open = ctx.gradLayoutsOpen ? ` (${ctx.gradLayoutsOpen})` : '';
  return [
    `/** Version context \`${ctx.name}\`: its Q list and graduated layout(s)${open}. */`,
    `export const CONTEXT_${N}: VersionContext = {`,
    `  qList: Q_LIST_${N},`,
    `  gradLayouts: [${ctx.gradLayouts.map((g) => `GradLayout.${g}`).join(', ')}],`,
    '};',
  ].join('\n');
}

function emitTs() {
  const L = [];
  L.push('// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from packages/box-spec/box-spec.v1.json');
  L.push('// and packages/box-spec/add-ons.v1.json (`pnpm box-spec:write`); `pnpm check:box-spec` (in `pnpm verify`) fails when stale.');
  L.push('// The Solidity twin is packages/contracts/src/box/BoxSpecV1.sol; both run the shared vectors (BC-001).');
  L.push("import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256, stringToHex, type Address, type Hex } from 'viem';");
  L.push("import { z } from 'zod';");
  L.push(
    "import { canonicalParams, checkString, checkStringAt, hexLength, isZeroHex, nonZeroItems, ParamKind, readWordAt, sameAddress, tableV1, type Verdict, word } from '../runtime';",
  );
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ fixed values');
  for (const c of constants.values()) {
    L.push(`/** ${c.source} */`);
    if (c.type === 'address') L.push(`export const ${c.name}: Address = '${c.value}';`);
    else if (c.type === 'bytes32') L.push(`export const ${c.name}: Hex = '${c.value}';`);
    else if (isSmallUint(c.type) || c.type === 'int24') L.push(`export const ${c.name} = ${c.value.toString()};`);
    else L.push(`export const ${c.name} = ${tsBig(c.value)};`);
  }
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ enums (uint8)');
  for (const e of enums.values()) {
    L.push(`export const ${e.name} = { ${e.members.map((m) => `${m.name}: ${m.value}`).join(', ')} } as const;`);
  }
  L.push('');
  L.push(`export const StringRule = { ${[...rules.values()].map((r) => `${r.name}: ${r.id}`).join(', ')} } as const;`);
  L.push('/** Allowed byte ranges (inclusive) per string rule. */');
  L.push(
    `export const RULE_RANGES = {\n${[...rules.values()].map((r) => `  ${r.name}: [${r.allowed.map(([lo, hi]) => `[${lo}, ${hi}]`).join(', ')}],`).join('\n')}\n} as const satisfies Readonly<Record<string, readonly (readonly [number, number])[]>>;`,
  );
  L.push('/** The prefix a non-empty string of the rule must start with, as bytes (none: empty). */');
  L.push(
    `export const RULE_PREFIXES = {\n${[...rules.values()].map((r) => `  ${r.name}: [${r.prefix ? [...Buffer.from(r.prefix, 'ascii')].join(', ') : ''}],`).join('\n')}\n} as const satisfies Readonly<Record<string, readonly number[]>>;`,
  );
  L.push('');
  L.push(`export const Reason = {\n${[...reasons].map(([n, c]) => `  ${n}: ${c},`).join('\n')}\n} as const;`);
  L.push(`export const REASON_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Reason).map(([k, v]) => [v, k]));`);
  L.push('');
  L.push(`export const Field = {\n${[...fieldIds].map(([p, id]) => `  ${/^[A-Za-z_]\w*$/.test(p) ? p : `'${p}'`}: ${id},`).join('\n')}\n} as const;`);
  L.push(`export const FIELD_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Field).map(([k, v]) => [v, k]));`);
  L.push('');
  L.push(`export const AddOnId = { ${addOns.map((a) => `${pascal(a.key)}: ${a.id}`).join(', ')} } as const;`);
  L.push(`export const ADD_ON_KEYS: Readonly<Record<number, string>> = { ${addOns.map((a) => `${a.id}: '${a.key}'`).join(', ')} };`);
  for (const a of addOns) {
    for (const c of a.constants) L.push(`export const ADD_ON_${snake(a.key)}_${c.name} = ${tsBig(c.value)};`);
  }
  L.push('');
  emitMenus(L);
  L.push('// ------------------------------------------------------------------------------------------------ types');
  L.push('export interface AddOnV1 {');
  L.push('  readonly id: number;');
  L.push('  /** abi.encode(<the add-on`s parameter tuple>), canonical (add-ons.v1.json). */');
  L.push('  readonly params: Hex;');
  L.push('}');
  L.push('');
  L.push('/**');
  L.push(' * The BoxSpec in wire form, field for field the Solidity struct `BoxSpecV1.BoxSpec`, with its strings as JS strings');
  L.push(' * (UTF-8 on the wire). For specs this code builds; to check bytes from elsewhere use `validateEncodedBoxSpecV1`.');
  L.push(' */');
  L.push('export interface BoxSpecV1 {');
  for (const f of fields) L.push(`  readonly ${f.name}: ${tsType(f.type)};`);
  L.push('}');
  L.push('');
  L.push('/**');
  L.push(' * The same struct with every string field as its raw bytes (hex), exactly as Solidity sees them: the form');
  L.push(' * `validateBoxSpecV1Bytes` checks. The ABI encoding of a string and of the same bytes is identical.');
  L.push(' */');
  L.push('export interface BoxSpecV1Bytes {');
  for (const f of fields) L.push(`  readonly ${f.name}: ${tsType(f.type, true)};`);
  L.push('}');
  L.push('');
  L.push('export interface QAsset {');
  L.push('  readonly token: Address;');
  L.push('  readonly decimals: number;');
  L.push('  readonly qClass: number;');
  L.push('  readonly raisePresets: readonly bigint[];');
  L.push('}');
  L.push('');
  L.push('/** What a version, not the creator, chooses (Solidity `BoxSpecV1.VersionContext`): passed to validate() with the spec. */');
  L.push('export interface VersionContext {');
  L.push('  readonly qList: readonly QAsset[];');
  L.push('  /** GradLayout values the version allows; a spec naming another one is NOT_OFFERED. */');
  L.push('  readonly gradLayouts: readonly number[];');
  L.push('}');
  L.push('');
  for (const a of addOns) {
    if (a.params.length === 0) {
      L.push(`export type ${pascal(a.key)}Params = Record<string, never>;`);
      continue;
    }
    L.push(`export interface ${pascal(a.key)}Params {`);
    for (const p of a.params) L.push(`  readonly ${p.name}: ${tsParamType(p.type)};`);
    L.push('}');
  }
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ ABI');
  for (const bytesForm of [false, true]) {
    if (bytesForm) L.push('/** BOX_SPEC_V1_ABI with every `string` as `bytes`: the same wire encoding, decoded without UTF-8 decoding. */');
    L.push(`export const BOX_SPEC_V1_${bytesForm ? 'BYTES_' : ''}ABI = {`);
    L.push("  type: 'tuple',");
    L.push('  components: [');
    for (const f of fields) {
      if (f.type === 'AddOn[]') {
        L.push(
          `    { name: '${f.name}', type: 'tuple[]', components: [{ name: 'id', type: 'uint16' }, { name: 'params', type: 'bytes' }] },`,
        );
      } else {
        L.push(`    { name: '${f.name}', type: '${bytesForm && f.type === 'string' ? 'bytes' : f.type}' },`);
      }
    }
    L.push('  ],');
    L.push('} as const;');
    L.push('');
  }
  L.push('export const Q_LIST_ABI = {');
  L.push("  type: 'tuple[]',");
  L.push('  components: [');
  L.push("    { name: 'token', type: 'address' },");
  L.push("    { name: 'decimals', type: 'uint8' },");
  L.push("    { name: 'qClass', type: 'uint8' },");
  L.push("    { name: 'raisePresets', type: 'uint256[]' },");
  L.push('  ],');
  L.push('} as const;');
  L.push('');
  L.push('export const VERSION_CONTEXT_ABI = {');
  L.push("  type: 'tuple',");
  L.push('  components: [');
  L.push("    { name: 'qList', type: 'tuple[]', components: Q_LIST_ABI.components },");
  L.push("    { name: 'gradLayouts', type: 'uint8[]' },");
  L.push('  ],');
  L.push('} as const;');
  L.push('');
  L.push('export const ADD_ON_PARAMS_ABI = {');
  for (const a of addOns) {
    L.push(`  ${a.id}: [${a.params.map((p) => `{ name: '${p.name}', type: '${p.type}' }`).join(', ')}],`);
  }
  L.push('} as const;');
  L.push('');
  L.push('export function encodeBoxSpecV1(spec: BoxSpecV1): Hex {');
  L.push('  return encodeAbiParameters([BOX_SPEC_V1_ABI], [spec]);');
  L.push('}');
  L.push('');
  L.push('export function decodeBoxSpecV1(encoded: Hex): BoxSpecV1 {');
  L.push('  return decodeAbiParameters([BOX_SPEC_V1_ABI], encoded)[0];');
  L.push('}');
  L.push('');
  L.push('/** keccak256(abi.encode(spec)): the same bytes as Solidity`s `BoxSpecV1.specHash`. */');
  L.push('export function specHash(spec: BoxSpecV1): Hex {');
  L.push('  return keccak256(encodeBoxSpecV1(spec));');
  L.push('}');
  L.push('');
  const stringFields = fields.filter((f) => f.type === 'string');
  L.push('/** The bytes form of a spec built here: each string as its UTF-8 bytes, as viem encodes it. */');
  L.push('export function toBoxSpecV1Bytes(spec: BoxSpecV1): BoxSpecV1Bytes {');
  L.push(`  return { ...spec, ${stringFields.map((f) => `${f.name}: stringToHex(spec.${f.name})`).join(', ')} };`);
  L.push('}');
  L.push('');
  L.push('export function encodeBoxSpecV1Bytes(spec: BoxSpecV1Bytes): Hex {');
  L.push('  return encodeAbiParameters([BOX_SPEC_V1_BYTES_ABI], [spec]);');
  L.push('}');
  L.push('');
  L.push('/**');
  L.push(' * Decodes ABI bytes with every string kept as its raw bytes (no UTF-8 decoding, no BOM stripping, no U+FFFD), and');
  L.push(' * throws unless they are exactly the canonical encoding of what they decode to: viem keeps an address word`s low 20');
  L.push(' * bytes and reads a uintN word whole where Solidity`s `abi.decode` reverts (box 0`s own review W3-U9-1, F147).');
  L.push(' */');
  L.push('export function decodeBoxSpecV1Bytes(encoded: Hex): BoxSpecV1Bytes {');
  L.push('  const spec = decodeAbiParameters([BOX_SPEC_V1_BYTES_ABI], encoded)[0];');
  L.push('  if (canonicalOrNull(spec) !== encoded.toLowerCase()) throw new Error(\'BoxSpecV1 bytes are not canonical ABI (abi.encode of the decoded spec differs)\');');
  L.push('  return spec;');
  L.push('}');
  L.push('');
  L.push('/** encodeBoxSpecV1Bytes(spec), or null where a decoded value does not fit its type (viem refuses to encode it). */');
  L.push('function canonicalOrNull(spec: BoxSpecV1Bytes): Hex | null {');
  L.push('  try {');
  L.push('    return encodeBoxSpecV1Bytes(spec);');
  L.push('  } catch {');
  L.push('    return null;');
  L.push('  }');
  L.push('}');
  L.push('');
  L.push('/**');
  L.push(' * Solidity`s verdict on ABI bytes from anywhere (an event, a calldata copy, another tool): decodes them without UTF-8');
  L.push(' * decoding and checks the raw bytes, as `BoxSpecV1.validate(abi.decode(encoded), ctx)` does. Throws on bytes that');
  L.push(' * are not canonical ABI: every encoding `abi.decode` reverts on (bytes that are not a BoxSpec) and the others it');
  L.push(' * would decode (trailing bytes, a dirty pad, moved dynamic data), so it gives Solidity`s verdict or throws.');
  L.push(' */');
  L.push('export function validateEncodedBoxSpecV1(encoded: Hex, ctx: VersionContext, network: Network = STRICTEST_NETWORK): Verdict {');
  L.push('  return validateBoxSpecV1Bytes(decodeBoxSpecV1Bytes(encoded), ctx, network);');
  L.push('}');
  L.push('');
  L.push('/**');
  L.push(' * Solidity`s `specHash(abi.decode(encoded))` for canonical ABI bytes (the chain`s own: the `BoxSpec` log carries');
  L.push(' * abi.encode(spec)), which is keccak256(encoded). Never decodes strings; throws on bytes that are not canonical');
  L.push(' * (decodeBoxSpecV1Bytes), so it never returns the hash of other bytes than those given.');
  L.push(' */');
  L.push('export function specHashOfEncoded(encoded: Hex): Hex {');
  L.push('  return keccak256(encodeBoxSpecV1Bytes(decodeBoxSpecV1Bytes(encoded)));');
  L.push('}');
  L.push('');
  L.push('export function decodeQList(encoded: Hex): readonly QAsset[] {');
  L.push('  return decodeAbiParameters([Q_LIST_ABI], encoded)[0];');
  L.push('}');
  L.push('');
  L.push('export function encodeVersionContext(ctx: VersionContext): Hex {');
  L.push('  return encodeAbiParameters([VERSION_CONTEXT_ABI], [ctx]);');
  L.push('}');
  L.push('');
  L.push('export function decodeVersionContext(encoded: Hex): VersionContext {');
  L.push('  return decodeAbiParameters([VERSION_CONTEXT_ABI], encoded)[0];');
  L.push('}');
  L.push('');
  for (const a of addOns) {
    const P = pascal(a.key);
    if (a.params.length === 0) {
      L.push(`export function encode${P}Params(): Hex {`);
      L.push("  return '0x';");
    } else {
      L.push(`export function encode${P}Params(params: ${P}Params): Hex {`);
      L.push(`  return encodeAbiParameters(ADD_ON_PARAMS_ABI[${a.id}], [${a.params.map((p) => `params.${p.name}`).join(', ')}]);`);
    }
    L.push('}');
    L.push('');
    L.push(`export function decode${P}Params(params: Hex): ${P}Params {`);
    if (a.params.length === 0) {
      L.push(`  if (params !== '0x') throw new Error('${a.key} takes no parameters');`);
      L.push('  return {};');
    } else {
      L.push(`  const [${a.params.map((p) => p.name).join(', ')}] = decodeAbiParameters(ADD_ON_PARAMS_ABI[${a.id}], params);`);
      L.push(`  return { ${a.params.map((p) => p.name).join(', ')} };`);
    }
    L.push('}');
    L.push('');
  }
  for (const ctx of spec.contexts) {
    L.push(tsQList(contexts[contextIndex(ctx.name)]));
    L.push('');
    L.push(tsContext(contexts[contextIndex(ctx.name)]));
    L.push('');
  }
  L.push('// ------------------------------------------------------------------------------------------------ validate');
  L.push('const OK: Verdict = { reason: Reason.OK, field: 0 };');
  L.push('const verdict = (reason: number, field: number): Verdict => ({ reason, field });');
  L.push('');
  L.push('/**');
  L.push(' * (Reason.OK, 0) for a valid spec built here, else the first failing check`s reason and field id, as Solidity returns');
  L.push(' * them for its encoding. Its strings are checked as the UTF-8 bytes they encode to. `network` (F74 U1) widens what');
  L.push(' * is offered where a value is offered early (Demo: holder payouts); the default, mainnet, is Solidity`s check exactly.');
  L.push(' */');
  L.push('export function validateBoxSpecV1(s: BoxSpecV1, ctx: VersionContext, network: Network = STRICTEST_NETWORK): Verdict {');
  L.push('  return validateBoxSpecV1Bytes(toBoxSpecV1Bytes(s), ctx, network);');
  L.push('}');
  L.push('');
  L.push('/** The validator itself, on raw string bytes: Solidity`s `BoxSpecV1.validate` check for check (on mainnet, the default). */');
  L.push('export function validateBoxSpecV1Bytes(s: BoxSpecV1Bytes, ctx: VersionContext, network: Network = STRICTEST_NETWORK): Verdict {');
  L.push('  const fields = checkFields(s, ctx, network);');
  L.push('  if (fields.reason !== Reason.OK) return fields;');
  L.push('  const addOns = checkAddOns(s, network);');
  L.push('  if (addOns.reason !== Reason.OK) return addOns;');
  L.push('  return checkRules(s, ctx);');
  L.push('}');
  L.push('');
  L.push('function checkFields(s: BoxSpecV1Bytes, ctx: VersionContext, network: Network): Verdict {');
  L.push('  let r: number;');
  for (const f of fields) {
    const lines = tsFieldCheck(f);
    if (lines.length === 0) continue;
    L.push(`  // ${f.id} ${f.name}`);
    for (const line of lines) L.push(`  ${line}`);
  }
  L.push('  return OK;');
  L.push('}');
  L.push('');
  L.push('function checkAddOns(s: BoxSpecV1Bytes, network: Network): Verdict {');
  L.push(`  if (s.addOns.length > Number(MAX_ADD_ONS)) return verdict(Reason.TOO_MANY_ADD_ONS, Field.addOns);`);
  L.push('  let previous: number | undefined;');
  L.push('  for (const addOn of s.addOns) {');
  L.push('    const id = addOn.id;');
  L.push('    if (previous !== undefined && (id < previous || (id === previous && !repeatable(id)))) {');
  L.push('      return verdict(Reason.ADD_ON_ORDER, Field.addOns);');
  L.push('    }');
  L.push('    const result = checkAddOn(s, id, hexToBytes(addOn.params), network);');
  L.push('    if (result.reason !== Reason.OK) return result;');
  L.push('    previous = id;');
  L.push('  }');
  L.push('  return OK;');
  L.push('}');
  L.push('');
  const rep = addOns.filter((a) => a.repeatable);
  L.push('function repeatable(id: number): boolean {');
  L.push(`  return ${rep.length ? rep.map((a) => `id === AddOnId.${pascal(a.key)}`).join(' || ') : 'false'};`);
  L.push('}');
  L.push('');
  L.push('function checkAddOn(s: BoxSpecV1Bytes, id: number, p: Uint8Array, network: Network): Verdict {');
  for (const a of addOns) L.push(`  if (id === AddOnId.${pascal(a.key)}) return check${pascal(a.key)}(s, p${addOnByNetwork(a) ? ', network' : ''});`);
  L.push('  return verdict(Reason.ADD_ON_UNKNOWN, Field.addOns);');
  L.push('}');
  L.push('');
  for (const a of addOns) {
    L.push(tsAddOnFunction(a));
    L.push('');
  }
  L.push('function checkRules(s: BoxSpecV1Bytes, ctx: VersionContext): Verdict {');
  for (const rule of spec.rules) {
    L.push(`  // ${rule.name} (${rule.source})`);
    L.push(`  if (${predicate(rule.when, 'ts')} && !(${predicate(rule.require, 'ts')})) return verdict(Reason.${rule.reason}, Field.${rule.field});`);
  }
  L.push('  return OK;');
  L.push('}');
  L.push('');
  L.push('function hasAddOn(s: BoxSpecV1Bytes, id: number): boolean {');
  L.push('  return s.addOns.some((a) => a.id === id);');
  L.push('}');
  L.push('');
  L.push('/** An entry of add-on `id` holds `value` in head word `index` (rules only: they run after every add-on passed). */');
  L.push('function addOnWordIs(s: BoxSpecV1Bytes, id: number, index: number, value: bigint): boolean {');
  L.push('  return s.addOns.some((a) => a.id === id && readWordAt(hexToBytes(a.params), BigInt(32 * index)) === value);');
  L.push('}');
  L.push('');
  L.push('function isListed(q: Address, qList: readonly QAsset[]): boolean {');
  L.push('  return qList.some((x) => sameAddress(x.token, q));');
  L.push('}');
  L.push('');
  L.push('/** The first listed entry for `q` decides, as in Solidity. */');
  L.push('function isPreset(q: Address, raise: bigint, qList: readonly QAsset[]): boolean {');
  L.push('  const entry = qList.find((x) => sameAddress(x.token, q));');
  L.push('  return entry !== undefined && entry.raisePresets.includes(raise);');
  L.push('}');
  L.push('');
  L.push('function qClassOf(q: Address, qList: readonly QAsset[]): number {');
  L.push('  return qList.find((x) => sameAddress(x.token, q))?.qClass ?? 0;');
  L.push('}');
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ zod');
  L.push('const uintN = (bits: number) => z.number().int().min(0).max(2 ** bits - 1);');
  L.push('const uintBig = (bits: number) => z.bigint().min(0n).max((1n << BigInt(bits)) - 1n);');
  L.push("const hexBytes = z.custom<Hex>((v) => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v), 'hex bytes');");
  L.push("const bytes32 = z.custom<Hex>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v), '32 hex bytes');");
  L.push("const address = z.custom<Address>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v), 'an address');");
  L.push('');
  L.push('/**');
  L.push(' * The zod schema of a BoxSpecV1 built here (JS strings): the ABI types, then `validateBoxSpecV1` against `ctx` (and');
  L.push(' * `network`, F74 U1; mainnet by default). A refused spec has one issue whose `params` carry the same `{ reason, field }`');
  L.push(' * as Solidity`s `validate()`.');
  L.push(' */');
  L.push('export function boxSpecV1Schema(ctx: VersionContext, network: Network = STRICTEST_NETWORK) {');
  L.push('  return z');
  L.push('    .object({');
  for (const f of fields) L.push(`      ${f.name}: ${tsZod(f.type)},`);
  L.push('    })');
  L.push('    .superRefine((spec, refinement) => {');
  L.push('      const v = validateBoxSpecV1(spec, ctx, network);');
  L.push('      if (v.reason === Reason.OK) return;');
  L.push("      const field = FIELD_NAMES[v.field] ?? 'spec';");
  L.push('      refinement.addIssue({');
  L.push("        code: 'custom',");
  L.push("        message: `${REASON_NAMES[v.reason] ?? 'UNKNOWN'} at ${field}`,");
  L.push("        path: [field.split('.')[0] ?? field],");
  L.push('        params: { reason: v.reason, field: v.field },');
  L.push('      });');
  L.push('    });');
  L.push('}');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// TypeScript, format 2 (M1-10-b): src/generated/box-spec.v2.ts, the twin of src/box-v2/BoxSpecV2.sol
// ---------------------------------------------------------------------------------------------------------------

/** runtime.ts's exports the twin may import (each only where a check uses it). */
const RUNTIME_V2 = ['canonicalParams', 'checkString', 'checkStringAt', 'hexLength', 'isZeroHex', 'nonZeroItems', 'ParamKind', 'readWordAt', 'sameAddress', 'tableV1', 'word'];

/** Local helpers of the twin, each the Solidity helper of the same name (BoxSpecV2.sol), with the helpers it calls. */
const TS_HELPERS_V2 = {
  pw: [['readWordAt'], '/** Head word `i` of canonical params (Solidity `_pw`). */\nfunction pw(p: Hex, i: number): bigint {\n  return readWordAt(hexToBytes(p), BigInt(32 * i));\n}'],
  dynLen: [['readWordAt'], '/** The length of a dynamic member of canonical params (Solidity `_dynLen`). */\nfunction dynLen(p: Hex, i: number): bigint {\n  const b = hexToBytes(p);\n  return readWordAt(b, readWordAt(b, BigInt(32 * i)));\n}'],
  wordAddress: [[], "const wordAddress = (w: bigint): Address => `0x${w.toString(16).padStart(40, '0')}`;"],
  sameHex: [[], 'const sameHex = (a: Hex, b: Hex): boolean => a.toLowerCase() === b.toLowerCase();'],
  listingKnown: [[], 'function listingKnown(ctx: ReleaseContextV2, id: bigint | number): boolean {\n  return ctx.listing.kind !== 0 && BigInt(ctx.listing.id) === BigInt(id);\n}'],
  listingTokenIs: [['listingKnown', 'sameAddress'], 'function listingTokenIs(ctx: ReleaseContextV2, id: bigint | number, token: Address): boolean {\n  return listingKnown(ctx, id) && sameAddress(ctx.listing.token, token);\n}'],
  raiseMatches: [['listingKnown'], 'function raiseMatches(ctx: ReleaseContextV2, id: bigint | number, raise: bigint): boolean {\n  return listingKnown(ctx, id) && raise === ctx.listing.raise;\n}'],
  sameBranch: [['sameHex'], 'function sameBranch(x: BranchV2, y: BranchV2): boolean {\n  return x.leg === y.leg && x.dest === y.dest && sameHex(x.legParams, y.legParams) && sameHex(x.destParams, y.destParams);\n}'],
  hasAddOn: [[], 'function hasAddOn(s: BoxSpecV2Bytes, id: number): boolean {\n  return s.addOns.some((a) => a.id === id);\n}'],
  addOnWordIs: [['readWordAt'], '/** An entry of add-on `id` holds `value` in head word `index` (rules only: they run after every add-on passed). */\nfunction addOnWordIs(s: BoxSpecV2Bytes, id: number, index: number, value: bigint): boolean {\n  return s.addOns.some((a) => a.id === id && readWordAt(hexToBytes(a.params), BigInt(32 * index)) === value);\n}'],
};

function emitTsV2(model) {
  const D = dialect('ts', model);
  const { structs } = model;
  const hasString = (name) => structs.get(name).members.some((m) => m.type === 'string' || (structs.has(m.type.replace(/\[\]$/, '')) && hasString(m.type.replace(/\[\]$/, ''))));
  const structName = (name, bytesForm) => `${name}V2${bytesForm && hasString(name) ? 'Bytes' : ''}`;
  const tsTypeOf = (type, bytesForm) => {
    if (type.endsWith('[]')) return `readonly ${tsTypeOf(type.slice(0, -2), bytesForm)}[]`;
    if (structs.has(type)) return structName(type, bytesForm);
    return { address: 'Address', bool: 'boolean', bytes32: 'Hex', bytes: 'Hex', string: bytesForm ? 'Hex' : 'string' }[type] ?? (isSmallUint(type) ? 'number' : 'bigint');
  };
  const abiOf = (name, type, bytesForm) => {
    const base = type.replace(/\[\]$/, '');
    const arr = base === type ? '' : '[]';
    const named = name === null ? '' : `name: '${name}', `;
    if (structs.has(base)) return `{ ${named}type: 'tuple${arr}', components: [${structs.get(base).members.map((m) => abiOf(m.name, m.type, bytesForm)).join(', ')}] }`;
    return `{ ${named}type: '${bytesForm && base === 'string' ? 'bytes' : base}${arr}' }`;
  };
  const zodOf = (type) => {
    if (type.endsWith('[]')) return `z.array(${zodOf(type.slice(0, -2))})`;
    if (structs.has(type)) return `z.object({ ${structs.get(type).members.map((m) => `${m.name}: ${zodOf(m.type)}`).join(', ')} })`;
    return { address: 'address', bool: 'z.boolean()', bytes32: 'bytes32', bytes: 'hexBytes', string: 'z.string()' }[type] ?? (isSmallUint(type) ? `uintN(${UINT_BITS[type]})` : `uintBig(${UINT_BITS[type]})`);
  };
  const reachable = (name, out = new Set()) => {
    if (out.has(name)) return out;
    out.add(name);
    for (const m of structs.get(name).members) {
      const base = m.type.replace(/\[\]$/, '');
      if (structs.has(base)) reachable(base, out);
    }
    return out;
  };
  const typeNames = [...reachable('BoxSpec'), ...reachable('ReleaseContext'), ...recipeStructs(model)];
  const specEnums = [...model.enums.values()].filter((e) => !e.frozen || /\/(SpecTypes|RecipeTypes)\.sol$/.test(e.file));

  // The checks first: they record which runtime and local helpers the file needs.
  const body = [];
  const fn = (signature, lines, params = []) => {
    const text = lines.filter((l) => !l.trimStart().startsWith('//')).join('\n');
    let sig = signature;
    for (const p of params) if (!new RegExp(`\\b${p}\\b`).test(text)) sig = sig.replace(new RegExp(`\\b${p}:`), `_${p}:`);
    body.push(`${sig} {`, ...lines.map((l) => (l ? `  ${l}` : l)), '}', '');
  };
  const fieldLines = [];
  for (const f of model.fields) {
    const lines = fieldCheckLines(D, model, f);
    if (lines.length) fieldLines.push(`// ${f.id} ${f.name}`, ...lines);
  }
  const decl = [];
  if (model.fields.some((f) => f.check.kind === 'string')) decl.push('let r: number;');
  if (model.recipeFields.length) decl.push('let v: Verdict;');
  fn('function checkFields(s: BoxSpecV2Bytes, ctx: ReleaseContextV2): Verdict', [...decl, ...fieldLines, 'return OK;'], ['ctx']);
  fn('function checkSide(d: SideV2, ctx: ReleaseContextV2, base: number): Verdict', ['let v: Verdict;', ...sideCheckLines(D, model)]);
  fn('function checkBranch(br: BranchV2, ctx: ReleaseContextV2, base: number): Verdict', branchCheckLines(D, model), ['ctx']);
  const listField = model.fields.find((f) => f.check.kind === 'addOns');
  fn('function checkAddOns(s: BoxSpecV2Bytes, ctx: ReleaseContextV2): Verdict', [
    `if (BigInt(s.${listField.name}.length) > ${D.bound(listField.check.maxCount, 'uint256')}) return verdict(Reason.TOO_MANY_ADD_ONS, ${D.id(listField.name)});`,
    'let previous: number | undefined;',
    `for (const addOn of s.${listField.name}) {`,
    '  const id = addOn.id;',
    `  if (previous !== undefined && (id < previous || (id === previous && !repeatable(id)))) return verdict(Reason.ADD_ON_ORDER, ${D.id(listField.name)});`,
    '  const result = checkAddOn(s, ctx, id, hexToBytes(addOn.params));',
    '  if (result.reason !== Reason.OK) return result;',
    '  previous = id;',
    '}',
    'return OK;',
  ]);
  const rep = model.addOns.filter((a) => a.repeatable);
  fn('function repeatable(id: number): boolean', [`return ${rep.length ? rep.map((a) => `id === AddOnId.${pascal(a.key)}`).join(' || ') : 'false'};`]);
  fn('function checkAddOn(s: BoxSpecV2Bytes, ctx: ReleaseContextV2, id: number, p: Uint8Array): Verdict', [
    ...model.addOns.map((a) => `if (id === AddOnId.${pascal(a.key)}) return check${pascal(a.key)}(${a.reserved ? '' : 's, ctx, p'});`),
    `return verdict(Reason.ADD_ON_UNKNOWN, ${D.id(listField.name)});`,
  ]);
  for (const a of model.addOns) {
    body.push(`/** Add-on ${a.id} \`${a.key}\`: ${a.title}. */`);
    fn(`function check${pascal(a.key)}(${a.reserved ? '' : 's: BoxSpecV2Bytes, ctx: ReleaseContextV2, p: Uint8Array'}): Verdict`, addOnCheckLines(D, model, a), ['s', 'ctx', 'p']);
  }
  fn('function checkShop(s: BoxSpecV2Bytes): Verdict', shopCheckLines(D, model));
  const rules = ruleParts(D, model);
  fn('function checkRules(s: BoxSpecV2Bytes, ctx: ReleaseContextV2): Verdict', [...(rules.runs.length || rules.cfg.length ? ['let v: Verdict;'] : []), ...rules.lines], ['s', 'ctx']);
  for (const [expr, { name, args }] of D.lifted) {
    const types = { s: 'BoxSpecV2Bytes', ctx: 'ReleaseContextV2' };
    body.push('/** Whether any branch in use matches (shared by the rules that ask). */');
    fn(`function ${name}(${args.map((a) => `${a}: ${types[a]}`).join(', ')}): boolean`, [`return ${expr};`]);
  }
  for (const run of rules.runs) {
    const what = run.indexed ? `Rule \`k\` of a run of ${run.scope} rules (rule-major: \`checkRules\` loops k)` : `A run of ${run.scope} rules, in source order,`;
    body.push(`/** ${what} on one ${run.scope} (\`buyers\`: the buyers' side; \`base\`: its sub-field base). */`);
    const br = run.scope === 'branch' ? ' br: BranchV2,' : '';
    fn(`function ${run.name}(${run.indexed ? 'k: number, ' : ''}s: BoxSpecV2Bytes, ctx: ReleaseContextV2, d: SideV2,${br} buyers: boolean, base: number): Verdict`, run.lines, ['s', 'ctx', 'd', 'br', 'buyers', 'base']);
  }
  for (const h of rules.cfg) {
    const branch = h.scope === 'cfgBranch';
    body.push(`/** The plug-in cfg budget on one ${branch ? 'branch' : 'side'}: the running total and the refusal where its params cross the bound. */`);
    fn(`function ${h.name}(${branch ? 'br: BranchV2' : 'd: SideV2'}, cfg: bigint, base: number): [bigint, Verdict]`, h.lines);
  }
  D.used.add('ParamKind');
  const helpers = [];
  const addHelper = (name) => {
    if (helpers.includes(name) || !(name in TS_HELPERS_V2)) return;
    for (const dep of TS_HELPERS_V2[name][0]) {
      D.used.add(dep);
      addHelper(dep);
    }
    helpers.push(name);
  };
  for (const name of [...D.used]) addHelper(name);

  const L = [];
  L.push(`// GENERATED FILE, do not edit: packages/box-spec/scripts/generate-v2.mjs writes it from ${model.labels.spec}`);
  L.push(`// and ${model.labels.addOns}; \`node packages/box-spec/scripts/generate-v2.mjs --check\` fails when stale.`);
  L.push('// The Solidity twin is packages/contracts/src/box-v2/BoxSpecV2.sol; both come from scripts/lib/checks-v2.mjs over the');
  L.push("// types ticket M1-00 froze (SpecTypes.sol, RecipeTypes.sol). Every enum is a uint8 on the wire; 0 is never a member.");
  L.push("import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256, stringToHex, type Address, type Hex } from 'viem';");
  L.push("import { z } from 'zod';");
  L.push(`import { ${RUNTIME_V2.filter((n) => D.used.has(n)).join(', ')}, type Verdict } from '../runtime';`);
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ fixed values');
  L.push("/** False for the real M1-10 source; kept as the release boundary marker. A deploy must assert it is false. */");
  L.push('export const SOURCE_IS_STUB: boolean = false;');
  for (const c of model.constants.values()) {
    L.push(`/** ${c.source} */`);
    if (c.type === 'address') L.push(`export const ${c.name}: Address = '${c.value}';`);
    else if (c.type === 'bytes32') L.push(`export const ${c.name}: Hex = '${c.value}';`);
    else if (c.type.endsWith('[]')) L.push(`export const ${c.name} = [${c.value.map((v) => isSmallUint(c.type.slice(0, -2)) ? v.toString() : tsBig(v)).join(', ')}] as const;`);
    else L.push(`export const ${c.name} = ${isSmallUint(c.type) ? c.value.toString() : tsBig(c.value)};`);
  }
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ enums (uint8)');
  for (const e of specEnums) L.push(`export const ${e.name} = { ${e.members.map((m) => `${m.name}: ${m.value}`).join(', ')} } as const;`);
  L.push(`export const StringRule = { ${[...model.stringRules.values()].map((r) => `${r.name}: ${r.id}`).join(', ')} } as const;`);
  L.push(`export const RULE_RANGES = {\n${[...model.stringRules.values()].map((r) => `  ${r.name}: [${r.allowed.map(([lo, hi]) => `[${lo}, ${hi}]`).join(', ')}],`).join('\n')}\n} as const satisfies Readonly<Record<string, readonly (readonly [number, number])[]>>;`);
  L.push(`export const RULE_PREFIXES = {\n${[...model.stringRules.values()].map((r) => `  ${r.name}: [${r.prefix ? [...Buffer.from(r.prefix, 'ascii')].join(', ') : ''}],`).join('\n')}\n} as const satisfies Readonly<Record<string, readonly number[]>>;`);
  L.push(`export const Reason = {\n${[...model.reasons].map(([n, c]) => `  ${n}: ${c},`).join('\n')}\n} as const;`);
  L.push('export const REASON_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Reason).map(([k, v]) => [v, k]));');
  L.push(`export const Field = {\n${[...model.fieldIds].map(([p, id]) => `  ${/^[A-Za-z_]\w*$/.test(p) ? p : `'${p}'`}: ${id},`).join('\n')}\n} as const;`);
  L.push('export const FIELD_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Field).map(([k, v]) => [v, k]));');
  L.push(`export const AddOnId = { ${model.addOns.map((a) => `${pascal(a.key)}: ${a.id}`).join(', ')} } as const;`);
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ types (frozen shapes)');
  for (const name of typeNames) {
    for (const bytesForm of hasString(name) ? [false, true] : [false]) {
      L.push(`/** Solidity \`${name}\` (${structs.get(name).file.split('/').pop()})${bytesForm ? ', every string as its raw bytes' : ''}. */`);
      L.push(`export interface ${structName(name, bytesForm)} {`, ...structs.get(name).members.map((m) => `  readonly ${m.name}: ${tsTypeOf(m.type, bytesForm)};`), '}');
    }
  }
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ ABI');
  for (const bytesForm of [false, true]) {
    L.push(`export const BOX_SPEC_V2_${bytesForm ? 'BYTES_' : ''}ABI = {`, "  type: 'tuple',", '  components: [');
    for (const m of structs.get('BoxSpec').members) L.push(`    ${abiOf(m.name, m.type, bytesForm)},`);
    L.push('  ],', '} as const;');
  }
  L.push(`export const RELEASE_CONTEXT_V2_ABI = ${abiOf(null, 'ReleaseContext', false)} as const;`);
  L.push('/** Each params tuple, as its members list: canonical params are `encodeAbiParameters` of these (abi.encode of the members). */');
  L.push(`export const PARAMS_V2_ABI = {\n${recipeStructs(model).map((n) => `  ${n}: [${structs.get(n).members.map((m) => abiOf(m.name, m.type, false)).join(', ')}],`).join('\n')}\n} as const;`);
  L.push(`export const ADD_ON_PARAMS_V2_ABI = {\n${model.addOns.map((a) => `  ${a.id}: [${a.params.map((x) => `{ name: '${x.name}', type: '${x.type}' }`).join(', ')}],`).join('\n')}\n} as const;`);
  L.push('');
  L.push('export function encodeBoxSpecV2(spec: BoxSpecV2): Hex {', '  return encodeAbiParameters([BOX_SPEC_V2_ABI], [spec]);', '}');
  L.push('export function decodeBoxSpecV2(encoded: Hex): BoxSpecV2 {', '  return decodeAbiParameters([BOX_SPEC_V2_ABI], encoded)[0];', '}');
  L.push('export function encodeBoxSpecV2Bytes(spec: BoxSpecV2Bytes): Hex {', '  return encodeAbiParameters([BOX_SPEC_V2_BYTES_ABI], [spec]);', '}');
  L.push('/** Decodes ABI bytes with every string kept as its raw bytes (no UTF-8 decoding), as Solidity sees them. */');
  L.push('export function decodeBoxSpecV2Bytes(encoded: Hex): BoxSpecV2Bytes {', '  return decodeAbiParameters([BOX_SPEC_V2_BYTES_ABI], encoded)[0];', '}');
  const strings = structs.get('BoxSpec').members.filter((m) => m.type === 'string');
  L.push('/** The bytes form of a spec built here: each string as its UTF-8 bytes, as viem encodes it. */');
  L.push(`export function toBoxSpecV2Bytes(spec: BoxSpecV2): BoxSpecV2Bytes {\n  return { ...spec, ${strings.map((m) => `${m.name}: stringToHex(spec.${m.name})`).join(', ')} };\n}`);
  L.push('/** keccak256(abi.encode(spec)): Solidity`s `BoxSpecV2.specHash`. */');
  L.push('export function specHashV2(spec: BoxSpecV2): Hex {', '  return keccak256(encodeBoxSpecV2(spec));', '}');
  L.push('/** Solidity`s `specHash(abi.decode(encoded))`: the canonical re-encoding of the decoded bytes, strings never decoded. */');
  L.push('export function specHashOfEncodedV2(encoded: Hex): Hex {', '  return keccak256(encodeBoxSpecV2Bytes(decodeBoxSpecV2Bytes(encoded)));', '}');
  L.push('export function encodeReleaseContextV2(ctx: ReleaseContextV2): Hex {', '  return encodeAbiParameters([RELEASE_CONTEXT_V2_ABI], [ctx]);', '}');
  L.push('export function decodeReleaseContextV2(encoded: Hex): ReleaseContextV2 {', '  return decodeAbiParameters([RELEASE_CONTEXT_V2_ABI], encoded)[0];', '}');
  for (const n of recipeStructs(model)) {
    const ms = structs.get(n).members;
    L.push(`export function encode${n}(p: ${n}V2): Hex {`, `  return encodeAbiParameters(PARAMS_V2_ABI.${n}, [${ms.map((m) => `p.${m.name}`).join(', ')}]);`, '}');
    L.push(`export function decode${n}(p: Hex): ${n}V2 {`, `  const [${ms.map((m) => m.name).join(', ')}] = decodeAbiParameters(PARAMS_V2_ABI.${n}, p);`, `  return { ${ms.map((m) => m.name).join(', ')} };`, '}');
  }
  L.push('');
  L.push('// ------------------------------------------------------------------------------------------------ validate');
  L.push('const OK: Verdict = { reason: Reason.OK, field: 0 };', 'const verdict = (reason: number, field: number): Verdict => ({ reason, field });');
  for (const n of recipeStructs(model)) {
    const name = `KINDS_${snake(n)}`;
    if (body.some((line) => line.includes(name))) L.push(`const ${name} = [${structs.get(n).members.map((m) => `ParamKind.${kindOf(m.type, model)}`).join(', ')}];`);
  }
  L.push('');
  L.push('/** (Reason.OK, 0) for a valid spec built here, else the first failing check`s reason and field id, as Solidity returns them. */');
  L.push('export function validateBoxSpecV2(s: BoxSpecV2, ctx: ReleaseContextV2): Verdict {', '  return validateBoxSpecV2Bytes(toBoxSpecV2Bytes(s), ctx);', '}');
  L.push('/** The validator itself, on raw string bytes: Solidity`s `BoxSpecV2.validate` check for check. */');
  L.push('export function validateBoxSpecV2Bytes(s: BoxSpecV2Bytes, ctx: ReleaseContextV2): Verdict {');
  L.push('  const fields = checkFields(s, ctx);', '  if (fields.reason !== Reason.OK) return fields;', '  const rules = checkRules(s, ctx);', '  if (rules.reason !== Reason.OK) return rules;', '  return checkShop(s);', '}');
  L.push('/**');
  L.push(' * Solidity`s verdict on well-formed ABI bytes (as `abi.encode` writes them). viem decodes some malformed words that');
  L.push(' * `abi.decode` reverts on (a uint8 word over 255, an address word with high bits set), so a verdict here does not prove');
  L.push(' * the bytes decode on chain; it throws where viem cannot decode them.');
  L.push(' */');
  L.push('export function validateEncodedBoxSpecV2(encoded: Hex, ctx: ReleaseContextV2): Verdict {', '  return validateBoxSpecV2Bytes(decodeBoxSpecV2Bytes(encoded), ctx);', '}', '');
  L.push(...body);
  for (const h of helpers) L.push(TS_HELPERS_V2[h][1], '');
  L.push('// ------------------------------------------------------------------------------------------------ zod');
  L.push('const uintN = (bits: number) => z.number().int().min(0).max(2 ** bits - 1);');
  L.push('const uintBig = (bits: number) => z.bigint().min(0n).max((1n << BigInt(bits)) - 1n);');
  L.push("const hexBytes = z.custom<Hex>((v) => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v), 'hex bytes');");
  L.push("const bytes32 = z.custom<Hex>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v), '32 hex bytes');");
  L.push("const address = z.custom<Address>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v), 'an address');");
  L.push('/** The zod schema of a BoxSpecV2 built here: the ABI types, then `validateBoxSpecV2` against `ctx`; a refusal carries Solidity`s { reason, field }. */');
  L.push('export function boxSpecV2Schema(ctx: ReleaseContextV2) {');
  L.push('  return z', '    .object({');
  for (const m of structs.get('BoxSpec').members) L.push(`      ${m.name}: ${zodOf(m.type)},`);
  L.push('    })', '    .superRefine((spec, refinement) => {', '      const v = validateBoxSpecV2(spec, ctx);', '      if (v.reason === Reason.OK) return;');
  L.push("      const field = FIELD_NAMES[v.field] ?? 'spec';", "      refinement.addIssue({ code: 'custom', message: `${REASON_NAMES[v.reason] ?? 'UNKNOWN'} at ${field}`, path: [field.split('.')[0] ?? field], params: { reason: v.reason, field: v.field } });");
  L.push('    });', '}', '');
  return L.join('\n');
}

export { emitTs, emitTsV2 };
