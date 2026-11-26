/**
 * Format 2's checks, written once for both twins (M1-10-b). Each check is built as lines over a dialect, `dialect('sol')`
 * or `dialect('ts')`, so the Solidity library and the TypeScript twin get the same checks in the same order from the
 * same code (the review lens: no rule only one twin has). Predicates fold to true or false where the side or branch
 * decides them, so the emitted code never tests a constant, and a conjunct a rule's `when` (or an earlier conjunct of
 * an `all`) already holds folds to true. Part of generate-v2.mjs (emit-solidity.mjs, emit-ts.mjs).
 */
import { pascal, snake, solConstName, solInt } from './model.mjs';
import { SIDES, isSmallUint, sideOf } from './model-v2.mjs';

/** Kinds of canonical params (runtime.ts ParamKind, Solidity `_K_*`); `bytes` has a string's layout. */
const KIND = { uint8: 'UINT8', uint16: 'UINT16', uint32: 'UINT32', uint64: 'UINT64', uint128: 'UINT128', uint256: 'UINT256', bool: 'BOOL', address: 'ADDRESS', bytes32: 'BYTES32', string: 'STRING', bytes: 'STRING', 'bytes32[]': 'BYTES32_ARRAY' };
export const kindOf = (type, model) => KIND[type] ?? model.fail(`no params kind for ${type}`);
const KIND_CODE = { UINT8: 1, UINT16: 2, UINT32: 3, UINT64: 4, UINT128: 5, UINT256: 6, BOOL: 7, ADDRESS: 8, BYTES32: 9, STRING: 10, BYTES32_ARRAY: 11 };
/** Solidity: the kinds of a params list as one bytes literal, read by `_kinds` (runtime.ts ParamKind's numbers). */
export const kindsHex = (model, members) => `_kinds(hex"${members.map((m) => KIND_CODE[kindOf(m.type, model)].toString(16).padStart(2, '0')).join('')}")`;
const isDynamic = (type) => type === 'bytes' || type === 'string';
const OPS = { eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };

export function dialect(lang, model) {
  const sol = lang === 'sol';
  const used = new Set();
  const constType = (name) => model.constants.get(name)?.type ?? model.fail(`unknown constant ${name}`);
  const D = {
    sol,
    used,
    model,
    lifted: new Map(),
    tab: sol ? '    ' : '  ',
    eq: sol ? '==' : '===',
    ne: sol ? '!=' : '!==',
    op: (o) => (sol ? OPS[o] : { '==': '===', '!=': '!==' }[OPS[o]] ?? OPS[o]),
    call: (name, ...args) => (used.add(name), sol ? `_${name}(${args.join(', ')})` : `${name}(${args.join(', ')})`),
    field: (path) => (sol ? solConstName(path) : /^[A-Za-z_]\w*$/.test(path) ? `Field.${path}` : `Field['${path}']`),
    ret: (reason, field) => (sol ? `return (REASON_${model.reason(reason)}, ${field});` : `return verdict(Reason.${model.reason(reason)}, ${field});`),
    enumConst: (e, m) => (sol ? `${snake(e)}_${snake(m)}` : `${e}.${m}`),
    /** A literal for a field of `type`: number for small uints in TS, bigint otherwise. */
    lit: (v, type) => (sol ? solInt(v) : isSmallUint(type) ? String(v) : `${BigInt(v)}n`),
    /** A params word (uint256 / bigint) and its literals. */
    pw: (ref, i) => D.call('pw', ref, String(i)),
    dynLen: (ref, i) => D.call('dynLen', ref, String(i)),
    wlit: (v) => (sol ? solInt(v) : `${BigInt(v)}n`),
    wenum: (e, m) => (sol ? `${snake(e)}_${snake(m)}` : `BigInt(${e}.${m})`),
    wconst: (c) => (constType(c), sol ? c : `BigInt(${c})`),
    /** A bound compared with a value of `type`. */
    bound: (b, type) => {
      if (typeof b === 'number' || typeof b === 'string') return D.lit(b, type);
      if (b.const) {
        const small = isSmallUint(constType(b.const));
        if (sol) return b.const;
        if (isSmallUint(type)) return small ? b.const : `Number(${b.const})`;
        return small ? `BigInt(${b.const})` : b.const;
      }
      if (b.field) return sol ? `uint256(s.${b.field})` : isSmallUint(type) ? `s.${b.field}` : `BigInt(s.${b.field})`;
      return model.fail(`bad bound ${JSON.stringify(b)}`);
    },
    addr: (w) => D.call(sol ? 'addr' : 'wordAddress', w),
    addrEq: (a, b) => (sol ? `${a} == ${b}` : (used.add('sameAddress'), `sameAddress(${a}, ${b})`)),
    isZero: (ref, type) => {
      if (type === 'address') return sol ? `${ref} == address(0)` : (used.add('isZeroHex'), `isZeroHex(${ref})`);
      if (type === 'bytes32') return sol ? `${ref} == bytes32(0)` : (used.add('isZeroHex'), `isZeroHex(${ref})`);
      if (type === 'string') return sol ? `bytes(${ref}).length == 0` : (used.add('hexLength'), `hexLength(${ref}) === 0`);
      if (type === 'bytes') return sol ? `${ref}.length == 0` : (used.add('hexLength'), `hexLength(${ref}) === 0`);
      if (type === 'bool') return `!${ref}`;
      return `${ref} ${sol ? '==' : '==='} ${D.lit(0, type)}`;
    },
    inList: (v, list) => (sol ? D.call(list.endsWith('offeredAddOns') ? 'in16' : 'inList', v, list) : `${list}.includes(${v})`),
    sameBytes: (a, b) => (sol ? `keccak256(${a}) == keccak256(${b})` : D.call('sameHex', a, b)),
    canonical: (ref, struct) => (sol ? D.call('isCanonical', ref, kindsHex(model, model.structs.get(struct).members)) : (used.add('canonicalParams'), `canonicalParams(hexToBytes(${ref}), KINDS_${snake(struct)}) !== null`)),
    /** Lines that run a sub-check and return its verdict when it refuses. */
    propagate: (call) => (sol ? [`(r, f) = ${call};`, 'if (r != REASON_OK) return (r, f);'] : [`v = ${call};`, 'if (v.reason !== Reason.OK) return v;']),
    id: (path) => D.field(path),
  };
  return D;
}

// ------------------------------------------------------------------------------------------------- boolean folding
const grouped = (x) => {
  if (!x.startsWith('(') || !x.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === '(') depth++;
    else if (x[i] === ')' && --depth === 0 && i < x.length - 1) return false;
  }
  return true;
};
export const AND = (xs) => {
  const ys = [];
  for (const x of xs) {
    if (x === false) return false;
    if (x !== true) ys.push(x);
  }
  return ys.length === 0 ? true : ys.length === 1 ? ys[0] : `(${ys.join(' && ')})`;
};
export const OR = (xs) => {
  const ys = [];
  for (const x of xs) {
    if (x === true) return true;
    if (x !== false) ys.push(x);
  }
  return ys.length === 0 ? false : ys.length === 1 ? ys[0] : `(${ys.join(' || ')})`;
};
const isCall = (x) => /^[\w.]+\(/.test(x) && grouped(x.slice(x.indexOf('(')));
export const NOT = (x) => {
  if (x === true || x === false) return !x;
  if (x.startsWith('!') && (grouped(x.slice(1)) || isCall(x.slice(1)) || /^[\w.]+$/.test(x.slice(1)))) return x.slice(1);
  return grouped(x) || isCall(x) || /^[\w.]+$/.test(x) ? `!${x}` : `!(${x})`;
};

/** The parts of a top-level `a && b && …` (depth 0), or null where the text is no pure conjunction. */
function conjuncts(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (depth === 0 && s.startsWith('||', i)) return null;
    else if (depth === 0 && s.startsWith(' && ', i)) {
      parts.push(s.slice(start, i));
      start = i + 4;
    }
  }
  parts.push(s.slice(start));
  return parts.length > 1 ? parts : null;
}

/** What a folded expression that holds implies: itself and, for an `&&` group, each conjunct (recursively). */
export function factsOf(x, into = new Set()) {
  if (typeof x !== 'string' || into.has(x)) return into;
  into.add(x);
  if (grouped(x)) for (const part of conjuncts(x.slice(1, -1)) ?? []) factsOf(part, into);
  return into;
}

/** `x`, or true where the facts of `env` (a rule's `when`, the conjuncts before it) already hold it. */
const fact = (env, x) => (typeof x === 'string' && env.known?.has(x) ? true : x);

/** AND of `xs` in order, each folded under the facts of `env` and of the conjuncts before it. */
function andIn(env, xs) {
  let known = env.known;
  const ys = [];
  for (const x of xs) {
    const y = typeof x === 'string' && known?.has(x) ? true : x;
    ys.push(y);
    if (typeof y === 'string') known = factsOf(y, new Set(known));
  }
  return fact(env, AND(ys));
}

// ------------------------------------------------------------------------------------------------- predicates
/** Every branch by absolute path (no facts: their expressions are shared or lifted into functions of their own). */
function branchEnvs(env, model) {
  const out = [];
  for (const f of model.recipeFields) {
    for (const br of ['a', 'b']) out.push({ ...env, known: undefined, scope: 'branch', side: sideOf(f), sideRef: `s.${f.name}`, sideField: f.name, br, brRef: `s.${f.name}.${br}` });
  }
  return out;
}

/** Every side by absolute path (no facts). */
function sideEnvs(env, model) {
  return model.recipeFields.map((f) => ({ ...env, known: undefined, scope: 'side', side: sideOf(f), sideRef: `s.${f.name}`, sideField: f.name }));
}

/** The split values that leave b all zero (NoSplit). */
const bZero = (D, model, ref) => OR(model.recipe.splits.filter((x) => x.bZero).map((x) => `${ref}.split ${D.eq} ${D.enumConst('Split', x.name)}`));
/** b's predicate only counts where the split uses b. */
const guardB = (env, D, model, x) => (env.br === 'b' ? AND([NOT(bZero(D, model, env.sideRef)), x]) : x);

/**
 * `ref` is one of `names` (members of `enumName`). Where `checked` (rules and add-on `requires`, which run after every
 * field passed, so each leg, destination and split read there is a member), the shorter of the list and its complement:
 * "in all members" is true, "Depth takes only P or T" is `leg != Convert`.
 */
function membersIn(D, ref, enumName, names, checked = false) {
  const members = D.model.enums.get(enumName).members;
  const values = [...new Set(names.map((n) => members.find((m) => m.name === n)?.value ?? D.model.fail(`${enumName} has no member ${n}`)))].sort((x, y) => x - y);
  const contiguous = (vs) => vs.length >= 3 && vs.every((v, i) => i === 0 || v === vs[i - 1] + 1);
  const test = (vs) => {
    // Three or more contiguous members: one range check (smaller code, same verdict).
    const name = (v) => D.enumConst(enumName, members.find((m) => m.value === v).name);
    if (contiguous(vs)) return `(${ref} >= ${name(vs[0])} && ${ref} <= ${name(vs.at(-1))})`;
    return OR(vs.map((v) => `${ref} ${D.eq} ${name(v)}`));
  };
  if (!checked) return test(values);
  const rest = members.map((m) => m.value).filter((v) => !values.includes(v));
  const cost = (vs) => (contiguous(vs) ? 2 : vs.length);
  return cost(rest) < cost(values) ? NOT(test(rest)) : test(values);
}

/** A params member: its index and type in `struct`. */
function memberOf(model, struct, name) {
  const members = model.structs.get(struct)?.members ?? model.fail(`no frozen struct ${struct}`);
  const index = members.findIndex((m) => m.name === name);
  if (index < 0) model.fail(`${struct} has no member ${name}`);
  return { index, type: members[index].type };
}

/** A comparison on one params member (`legParam`, `destParam`, `splitParam`, or an X target's reads). */
function paramCmp(D, model, ref, struct, name, p) {
  const { index, type } = memberOf(model, struct, name);
  if (p.zero || p.nonZero) {
    const value = isDynamic(type) ? D.dynLen(ref, index) : D.pw(ref, index);
    const z = `${value} ${D.eq} ${D.wlit(0)}`;
    return p.zero ? z : NOT(z);
  }
  const value = (v) => {
    if (typeof v === 'number') return D.wlit(v);
    if (typeof v === 'string') {
      const e = model.enumRef(v);
      return D.wenum(e.enum, e.member);
    }
    if (v.param) return D.pw(ref, memberOf(model, struct, v.param).index);
    if (v.const) return D.wconst(v.const);
    return model.fail(`bad param value ${JSON.stringify(v)}`);
  };
  if (isDynamic(type)) model.fail(`${struct}.${name}: only zero or nonZero on bytes`);
  const w = D.pw(ref, index);
  if (p.in) return OR(p.in.map((v) => `${w} ${D.eq} ${value(v)}`));
  const op = Object.keys(OPS).find((o) => o in p) ?? model.fail(`no comparison in ${JSON.stringify(p)}`);
  return `${w} ${D.op(op)} ${value(p[op])}`;
}

/** The legs of `side` whose output is `what` (P, T or X). */
const legsProducing = (model, side, what) => model.recipe.legs.filter((l) => l.produces[side] === what);

/**
 * An expression that depends on the branch's side: folded where the side is known, else both sides' expressions joined
 * by the run's side flag (`buyers`), or one of them where both sides give the same.
 */
function perSide(env, D, fn) {
  if (env.side) return fn(env.side);
  const [b, s] = SIDES.map(fn);
  if (b === s) return b;
  return OR([AND([env.sideFlag, b]), AND([NOT(env.sideFlag), s])]);
}

/** For each X leg on this branch: its fixed target's token (how == Fixed), as an address expression. */
function fixedXTargets(D, model, env, side) {
  return legsProducing(model, side, 'X').map((l) => {
    const ref = `${env.brRef}.legParams`;
    return {
      guard: andIn(env, [`${env.brRef}.leg ${D.eq} ${D.enumConst('Leg', l.name)}`, paramCmp(D, model, ref, l.params, 'how', { eq: 'TargetHow.Fixed' })]),
      leg: l,
      ref,
      token: D.addr(D.pw(ref, memberOf(model, l.params, 'token').index)),
      listingId: D.pw(ref, memberOf(model, l.params, 'listingId').index),
    };
  });
}

const pricingRef = (model) => `s.${model.fields.find((f) => f.check.kind === 'listing').name}`;

/**
 * Compiles a predicate to true, false or an expression of the dialect. `env.known` holds the facts already true where the
 * expression runs (a rule's `when`, earlier conjuncts): an expression among them folds to true.
 */
export function compile(p, env) {
  return fact(env, compileOne(p, env));
}

function compileOne(p, env) {
  const { D, model } = env;
  if (p === undefined || p.always) return true;
  if (p.never) return false;
  if (p.all) {
    // Each conjunct under the facts of the ones before it (a && b is a && b, with a's facts true inside b).
    let known = env.known;
    const xs = [];
    for (const q of p.all) {
      const x = compile(q, { ...env, known });
      xs.push(x);
      if (typeof x === 'string') known = factsOf(x, new Set(known));
    }
    return AND(xs);
  }
  if (p.any) return OR(p.any.map((x) => compile(x, env)));
  if (p.not) return NOT(compile(p.not, env));
  const need = (scope) => (env.scope === scope || (scope === 'side' && env.scope === 'branch')) || model.fail(`${Object.keys(p)[0]} needs a ${scope} scope`);

  // Anywhere.
  if (p.field) {
    const type = model.typeAt(p.field);
    const ref = `s.${p.field}`;
    const top = model.fieldByName.get(p.field);
    const v = (x) => {
      if (typeof x !== 'string') return D.lit(x, type);
      const e = model.enumRef(x, top?.check.enum);
      return D.enumConst(e.enum, e.member);
    };
    if ('eq' in p) return `${ref} ${D.eq} ${v(p.eq)}`;
    if ('ne' in p) return `${ref} ${D.ne} ${v(p.ne)}`;
    if (p.in) return OR(p.in.map((x) => `${ref} ${D.eq} ${v(x)}`));
    if (p.lt) {
      const other = model.typeAt(p.lt.field);
      if (isSmallUint(type) !== isSmallUint(other)) model.fail(`lt: ${p.field} and ${p.lt.field} need the same TS type`);
      return `${ref} < s.${p.lt.field}`;
    }
    if (p.zero) return D.isZero(ref, type);
    if (p.nonZero) return NOT(D.isZero(ref, type));
    return model.fail(`bad field predicate ${JSON.stringify(p)}`);
  }
  if (p.hasAddOn) {
    const a = model.addOnByKey.get(p.hasAddOn) ?? model.fail(`unknown add-on ${p.hasAddOn}`);
    return D.call('hasAddOn', 's', D.sol ? `ADD_ON_${snake(a.key)}` : `AddOnId.${pascal(a.key)}`);
  }
  if (p.addOnParam) {
    const { addOn: key, param, eq } = p.addOnParam;
    const a = model.addOnByKey.get(key) ?? model.fail(`addOnParam: unknown add-on ${key}`);
    const i = a.params.findIndex((x) => x.name === param);
    if (i < 0 || a.params[i].type === 'string') model.fail(`addOnParam: ${key} has no static param ${param}`);
    const value = typeof eq === 'string' ? D.wenum(...enumOfParam(model, a.params[i], eq)) : D.wlit(eq);
    return D.call('addOnWordIs', 's', D.sol ? `ADD_ON_${snake(a.key)}` : `AddOnId.${pascal(a.key)}`, String(i), value);
  }
  if (p.param !== undefined) {
    // Inside an add-on's `requires`: one of its decoded uint params.
    const a = env.addOn ?? model.fail(`param ${p.param} outside an add-on`);
    const i = a.params.findIndex((x) => x.name === p.param);
    if (i < 0) model.fail(`add-on ${a.key}: no param ${p.param}`);
    const w = D.sol ? `w[${i}]` : `word(w, ${i})`;
    const value = (x) => (typeof x === 'string' ? D.wenum(...enumOfParam(model, a.params[i], x)) : D.wlit(x));
    if ('eq' in p) return `${w} ${D.eq} ${value(p.eq)}`;
    if ('ne' in p) return `${w} ${D.ne} ${value(p.ne)}`;
    return model.fail(`bad param predicate ${JSON.stringify(p)}`);
  }
  if (p.ctx) return `ctx.${p.ctx}`;
  if (p.anyBranch) {
    // Over the four branches by absolute path, so it is the same expression wherever it is used: one shared function.
    const expr = OR(branchEnvs(env, model).map((b) => guardB(b, D, model, compile(p.anyBranch, b))));
    if (typeof expr !== 'string') return expr;
    if (!D.lifted.has(expr)) D.lifted.set(expr, { name: `anyBranch${D.lifted.size + 1}`, args: /\bctx\b/.test(expr) ? ['s', 'ctx'] : ['s'] });
    const { name, args } = D.lifted.get(expr);
    return D.call(name, ...args);
  }
  if (p.onSide) {
    const f = model.recipeFields.find((x) => sideOf(x) === p.onSide) ?? model.fail(`onSide ${p.onSide}`);
    return compile(p.is, { ...env, scope: 'side', side: p.onSide, sideRef: `s.${f.name}`, sideField: f.name });
  }
  if (p.sidesSame) {
    const [x, y] = model.recipeFields;
    return AND(p.sidesSame.map((path) => {
      const type = model.typeAt(`${x.name}.${path}`);
      return type === 'bytes' ? D.sameBytes(`s.${x.name}.${path}`, `s.${y.name}.${path}`) : `s.${x.name}.${path} ${D.eq} s.${y.name}.${path}`;
    }));
  }
  if (p.countAtMost) {
    if (p.countAtMost.throughBranch) need('branch');
    const { branches, sides, addOns = [], max, throughBranch } = p.countAtMost;
    const each = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
    const terms = [
      ...branchEnvs(env, model).flatMap((b) => each(branches).map((q) => AND([...(throughBranch ? [`base >= ${D.lit(model.fieldId(`${b.sideField}.${b.br}.leg`) - model.recipe.sub.leg, 'uint16')}`] : []), guardB(b, D, model, compile(q, b))]))),
      ...sideEnvs(env, model).flatMap((s) => each(sides).map((q) => compile(q, s))),
      ...addOns.map((k) => compile({ hasAddOn: k }, env)),
    ];
    const fixed = terms.filter((t) => t === true).length;
    const open = terms.filter((t) => typeof t === 'string');
    if (open.length === 0) return BigInt(fixed) <= (max.const ? model.constants.get(max.const).value : BigInt(max));
    if (D.sol) {
      // Right-nested (a + (b + (c + …))): Solidity's legacy code generator evaluates a sum's right operand first, so a
      // left-nested sum of many terms keeps them all on the stack (stack too deep).
      const sum = [...(fixed ? [String(fixed)] : []), ...open.map((t) => D.call('one', t))].reduceRight((acc, x) => (acc === null ? x : `${x} + (${acc})`), null);
      return `${sum} <= ${D.bound(max, 'uint256')}`;
    }
    return `BigInt(${fixed ? `${fixed} + ` : ''}[${open.join(', ')}].filter(Boolean).length) <= ${D.bound(max, 'uint256')}`;
  }

  // Per side.
  if (p.split) return need('side') && membersIn(D, `${env.sideRef}.split`, 'Split', p.split, env.checked);
  if (p.splitParam) {
    need('side');
    const sp = model.recipe.splits.find((x) => x.name === p.of) ?? model.fail(`splitParam of ${p.of}`);
    return andIn(env, [`${env.sideRef}.split ${D.eq} ${D.enumConst('Split', sp.name)}`, paramCmp(D, model, `${env.sideRef}.splitParams`, sp.params, p.splitParam, p)]);
  }
  if (p.a || p.b) {
    need('side');
    const br = p.a ? 'a' : 'b';
    const b = { ...env, scope: 'branch', br, brRef: `${env.sideRef}.${br}` };
    return guardB(b, D, model, compile(p[br], b));
  }
  if (p.branchesSame) return need('side') && D.call('sameBranch', `${env.sideRef}.a`, `${env.sideRef}.b`);

  // Per branch.
  if (env.scope !== 'branch') return model.fail(`${Object.keys(p)[0]} needs a branch scope`);
  if (p.side) {
    if (!SIDES.includes(p.side)) model.fail(`side ${p.side}`);
    return env.side ? env.side === p.side : p.side === SIDES[0] ? env.sideFlag : NOT(env.sideFlag);
  }
  if (p.leg) return membersIn(D, `${env.brRef}.leg`, 'Leg', p.leg, env.checked);
  if (p.dest) return membersIn(D, `${env.brRef}.dest`, 'Dest', p.dest, env.checked);
  if (p.produces) {
    return perSide(env, D, (side) => membersIn(D, `${env.brRef}.leg`, 'Leg', model.recipe.legs.filter((l) => p.produces.includes(l.produces[side])).map((l) => l.name), env.checked));
  }
  if (p.producesEth) {
    return perSide(env, D, (side) => {
      const fromP = AND([membersIn(D, `${env.brRef}.leg`, 'Leg', legsProducing(model, side, 'P').map((l) => l.name), env.checked), D.isZero(`${pricingRef(model)}.token`, 'address')]);
      return OR([fromP, ...fixedXTargets(D, model, env, side).map((x) => AND([x.guard, D.isZero(x.token, 'address')]))]);
    });
  }
  if (p.legParam || p.destParam) {
    const [table, key, ref] = p.legParam ? [model.recipe.legs, 'leg', `${env.brRef}.legParams`] : [model.recipe.dests, 'dest', `${env.brRef}.destParams`];
    const owner = table.find((x) => x.name === p.of) ?? model.fail(`${key}Param of ${p.of}`);
    if (!owner.params) model.fail(`${p.of} has no params`);
    return andIn(env, [`${env.brRef}.${key} ${D.eq} ${D.enumConst(key === 'leg' ? 'Leg' : 'Dest', owner.name)}`, paramCmp(D, model, ref, owner.params, p.legParam ?? p.destParam, p)]);
  }
  if (p.convertListing) {
    const c = p.convertListing;
    return perSide(env, D, (side) => OR(legsProducing(model, side, 'X').map((l) => {
      const ref = `${env.brRef}.legParams`;
      const id = D.pw(ref, memberOf(model, l.params, 'listingId').index);
      const token = D.addr(D.pw(ref, memberOf(model, l.params, 'token').index));
      const isLeg = `${env.brRef}.leg ${D.eq} ${D.enumConst('Leg', l.name)}`;
      if (c === 'known') return andIn(env, [isLeg, D.call('listingKnown', 'ctx', id)]);
      if (c === 'tokenMatches') return andIn(env, [isLeg, D.call('listingTokenIs', 'ctx', id, token)]);
      if (c === 'notPricingToken') return andIn(env, [isLeg, NOT(D.addrEq(token, `${pricingRef(model)}.token`))]);
      if (c.pathPoolsAtMost !== undefined) {
        return andIn(env, [isLeg, `${D.call('listingPools', 'ctx', `${pricingRef(model)}.listingId`)} + ${D.call('listingPools', 'ctx', id)} <= ${D.bound(c.pathPoolsAtMost, 'uint256')}`]);
      }
      return model.fail(`convertListing ${JSON.stringify(c)}`);
    })));
  }
  if (p.boxTarget) {
    const ref = `${env.brRef}.destParams`;
    return OR(model.recipe.dests.filter((d) => d.params && model.structs.get(d.params).members.some((m) => m.name === 'boxId')).map((d) => {
      const ri = D.pw(ref, memberOf(model, d.params, 'registryIndex').index);
      const boxId = D.pw(ref, memberOf(model, d.params, 'boxId').index);
      const isDest = `${env.brRef}.dest ${D.eq} ${D.enumConst('Dest', d.name)}`;
      if (p.boxTarget === 'known') return andIn(env, [isDest, D.call('targetKnown', 'ctx', ri, boxId)]);
      if (p.boxTarget === 'box0') return andIn(env, [isDest, `${ri} ${D.eq} ${D.wconst('BOX0_REGISTRY_INDEX')}`, `${boxId} ${D.eq} ${D.wconst('BOX0_BOX_ID')}`]);
      if (p.boxTarget === 'pricedInOutput') {
        return andIn(env, [isDest, perSide(env, D, (side) => {
          const fromP = AND([membersIn(D, `${env.brRef}.leg`, 'Leg', legsProducing(model, side, 'P').map((l) => l.name), env.checked), D.call('targetPricedIn', 'ctx', ri, boxId, `${pricingRef(model)}.listingId`)]);
          return OR([fromP, ...fixedXTargets(D, model, env, side).map((x) => AND([x.guard, D.call('targetPricedIn', 'ctx', ri, boxId, x.listingId)]))]);
        })]);
      }
      return model.fail(`boxTarget ${p.boxTarget}`);
    }));
  }
  return model.fail(`bad predicate ${JSON.stringify(p)}`);
}

function enumOfParam(model, param, text) {
  const e = model.enumRef(text, param.enum);
  return [e.enum, e.member];
}

// ------------------------------------------------------------------------------------------------- field checks
/** The field's own check, inside `zeroWhen` when it has one (MUST_BE_ZERO while the predicate holds). */
export function fieldCheckLines(D, model, f) {
  const own = ownFieldCheck(D, model, f);
  if (f.check.zeroWhen === undefined) return own;
  const when = compile(f.check.zeroWhen, { D, model, scope: 'box' });
  const lines = [`if (${when}) {`, `${D.tab}if (${NOT(D.isZero(`s.${f.name}`, f.type))}) ${D.ret('MUST_BE_ZERO', D.id(f.name))}`];
  if (own.length) lines.push('} else {', ...own.map((l) => `${D.tab}${l}`));
  lines.push('}');
  return lines;
}

function ownFieldCheck(D, model, f) {
  const c = f.check;
  const id = D.id(f.name);
  const ref = `s.${f.name}`;
  switch (c.kind) {
    case 'byBoxType': {
      const lines = [];
      for (const [name, check] of Object.entries(c.checks)) {
        lines.push(`${lines.length ? '} else ' : ''}if (s.boxType ${D.eq} ${D.enumConst('BoxType', name)}) {`,
          ...ownFieldCheck(D, model, { ...f, check }).map((line) => `${D.tab}${line}`));
      }
      lines.push('} else {', `${D.tab}if (${NOT(D.isZero(ref, f.type))}) ${D.ret('MUST_BE_ZERO', id)}`, '}');
      return lines;
    }
    case 'pile': {
      const canonical = (name) => {
        const members = model.structs.get(name).members;
        return D.sol ? D.call('isCanonical', ref, kindsHex(model, members))
          : (D.used.add('canonicalParams'), `canonicalParams(hexToBytes(${ref}), [${members.map((m) => `ParamKind.${kindOf(m.type, model)}`).join(', ')}]) !== null`);
      };
      const preset = OR(c.presets.map(v => `${D.pw(ref, 2)} ${D.eq} ${D.wlit(v)}`));
      const valid = OR([canonical('PileParams'), AND([canonical('PileParamsV21'), preset])]);
      const chosen = OR(['buyers', 'sellers'].map(side => `s.${side}.a.dest ${D.eq} ${D.enumConst('Dest', 'BudgetOrPile')}`));
      return [`if (${NOT(valid)}) ${D.ret(c.reason, id)}`,
        `if (${AND([chosen, NOT(D.addrEq(D.addr(D.pw(ref, 0)), 's.pricing.token'))])}) ${D.ret(c.reason, id)}`];
    }
    case 'params': {
      const members = model.structs.get(c.struct).members;
      const canonical = D.sol
        ? D.call('isCanonical', ref, kindsHex(model, members))
        : (D.used.add('canonicalParams'), `canonicalParams(hexToBytes(${ref}), [${members.map((m) => `ParamKind.${kindOf(m.type, model)}`).join(', ')}]) !== null`);
      return [`if (${NOT(canonical)}) ${D.ret(c.reason, id)}`];
    }
    case 'uint': {
      const reason = c.reason ?? 'OUT_OF_RANGE';
      if (c.allowed) return [`if (${NOT(OR(c.allowed.map((v) => `${ref} ${D.eq} ${D.lit(v, f.type)}`)))}) ${D.ret(reason, id)}`];
      const range = OR([`${ref} < ${D.bound(c.min, f.type)}`, ...(c.max === undefined ? [] : [`${ref} > ${D.bound(c.max, f.type)}`])]);
      return [`if (${c.orZero ? AND([NOT(D.isZero(ref, f.type)), range]) : range}) ${D.ret(reason, id)}`];
    }
    case 'enum': {
      const e = model.enums.get(c.enum);
      const lines = [`if (${NOT(membersIn(D, ref, c.enum, e.members.map((m) => m.name)))}) ${D.ret('NOT_A_MEMBER', id)}`];
      if (c.offered.length !== e.members.length) lines.push(`if (${NOT(membersIn(D, ref, c.enum, c.offered))}) ${D.ret('NOT_OFFERED', id)}`);
      if (c.inContext) lines.push(`if (!${D.inList(ref, `ctx.${c.inContext}`)}) ${D.ret('NOT_OFFERED', id)}`);
      return lines;
    }
    case 'string': {
      const r = model.stringRules.get(c.rule) ?? model.fail(`field ${f.name}: rule ${c.rule}`);
      const call = D.sol
        ? `_checkString(bytes(${ref}), ${D.bound(c.minBytes, 'uint256')}, ${D.bound(c.maxBytes, 'uint256')}, RULE_${r.name})`
        : (D.used.add('checkString'), `checkString(hexToBytes(${ref}), ${D.bound(c.minBytes, 'uint32')}, ${D.bound(c.maxBytes, 'uint32')}, RULE_RANGES.${r.name}, RULE_PREFIXES.${r.name})`);
      return [`r = ${call};`, D.sol ? `if (r != REASON_OK) return (r, ${id});` : `if (r !== Reason.OK) return verdict(r, ${id});`];
    }
    case 'bytes': {
      const len = D.sol ? `${ref}.length` : (D.used.add('hexLength'), `hexLength(${ref})`);
      const type = D.sol ? 'uint256' : 'uint32';
      const lines = [`if (${len} < ${D.bound(c.minBytes, type)} || ${len} > ${D.bound(c.maxBytes, type)}) ${D.ret('LENGTH_OUT_OF_RANGE', id)}`];
      if (c.format === 'METADATA_TABLE_V1') {
        const ok = D.sol ? `_tableV1(${ref})` : (D.used.add('tableV1'), `tableV1(hexToBytes(${ref}), Number(MAX_TRAIT_TYPES), RULE_RANGES.JSON_TEXT)`);
        lines.push(`if (!${ok}) ${D.ret('METADATA_TABLE_MALFORMED', id)}`);
      } else if (c.format !== undefined) model.fail(`field ${f.name}: format ${c.format}`);
      return lines;
    }
    case 'nonZero':
      return [`if (${D.isZero(ref, f.type)}) ${D.ret('ZERO_VALUE', id)}`];
    case 'zero':
      return [`if (${NOT(D.isZero(ref, f.type))}) ${D.ret('MUST_BE_ZERO', id)}`];
    case 'listing':
      return [
        `if (!${D.call('listingKnown', 'ctx', `${ref}.listingId`)}) ${D.ret(c.unknown, id)}`,
        `if (!${D.call('listingTokenIs', 'ctx', `${ref}.listingId`, `${ref}.token`)}) ${D.ret(c.mismatch, id)}`,
      ];
    case 'listingRaise':
      return [`if (!${D.call('raiseMatches', 'ctx', `${pricingRef(model)}.listingId`, ref)}) ${D.ret(c.reason, id)}`];
    case 'recipe':
      return D.propagate(D.sol ? `_checkSide(${ref}, ctx, ${solInt(f.id * 1000)})` : `checkSide(${ref}, ctx, ${f.id * 1000})`);
    case 'addOns':
      return D.propagate(D.sol ? '_checkAddOns(s, ctx)' : 'checkAddOns(s, ctx)');
    case 'any':
      return [];
    default:
      return model.fail(`field ${f.name}: unknown check ${c.kind}`);
  }
}

// ------------------------------------------------------------------------------------------------- recipe structure
/** checkBranch(br, ctx, base): members, the context's offers, then each params blob canonical for its leg or dest. */
export function branchCheckLines(D, model) {
  const { sub, legs, dests, malformed } = model.recipe;
  const at = (k) => `base + ${sub[k]}`;
  const lines = [];
  for (const [key, enumName, list, table] of [['leg', 'Leg', 'offeredLegs', legs], ['dest', 'Dest', 'offeredDests', dests]]) {
    lines.push(`if (${NOT(membersIn(D, `br.${key}`, enumName, table.map((x) => x.name)))}) ${D.ret('NOT_A_MEMBER', at(key))}`);
    const offered = model.contexts[0][list].map((value) => table.find((x) => x.value === value).name);
    lines.push(`if (${NOT(membersIn(D, `br.${key}`, enumName, offered))}) ${D.ret('NOT_OFFERED', at(key))}`);
  }
  for (const [key, enumName, table] of [['leg', 'Leg', legs], ['dest', 'Dest', dests]]) {
    const place = `${key}Params`;
    const ref = `br.${place}`;
    let first = true;
    const offered = model.contexts[0][key === 'leg' ? 'offeredLegs' : 'offeredDests'];
    for (const x of table.filter((y) => y.params && offered.includes(y.value))) {
      lines.push(`${first ? '' : '} else '}if (br.${key} ${D.eq} ${D.enumConst(enumName, x.name)}${x.paramsWhenLeg ? ` && br.leg ${D.eq} ${D.enumConst('Leg', x.paramsWhenLeg)}` : ''}) {`);
      first = false;
      lines.push(`${D.tab}if (${NOT(D.canonical(ref, x.params))}) ${D.ret(malformed.byStruct?.[x.params] ?? malformed[place], at(place))}`);
      const env = { D, model, scope: 'branch', brRef: 'br', known: new Set([`br.${key} ${D.eq} ${D.enumConst(enumName, x.name)}`]) };
      for (const c of x.checks) {
        const cond = refusal(c, env);
        if (cond !== false) lines.push(`${D.tab}if (${cond}) ${D.ret(c.reason, at(place))}`);
      }
    }
    lines.push(`${first ? '' : '} else '}if (${NOT(D.isZero(ref, 'bytes'))}) {`, `${D.tab}${D.ret(malformed[place], at(place))}`, '}');
  }
  lines.push(D.sol ? 'return (REASON_OK, 0);' : 'return OK;');
  return lines;
}

/** checkSide(d, ctx, base): branch a, the split and its params, then branch b (all zero where the split leaves it out). */
export function sideCheckLines(D, model) {
  const { sub, splits, malformed, bNotZero } = model.recipe;
  const lines = [...D.propagate(D.sol ? '_checkBranch(d.a, ctx, base)' : 'checkBranch(d.a, ctx, base)')];
  lines.push(`if (${NOT(membersIn(D, 'd.split', 'Split', splits.map((x) => x.name)))}) ${D.ret('NOT_A_MEMBER', `base + ${sub.split}`)}`);
  let first = true;
  for (const x of splits.filter((y) => y.params)) {
    lines.push(`${first ? '' : '} else '}if (d.split ${D.eq} ${D.enumConst('Split', x.name)}) {`);
    first = false;
    lines.push(`${D.tab}if (${NOT(D.canonical('d.splitParams', x.params))}) ${D.ret(malformed.byStruct?.[x.params] ?? malformed.splitParams, `base + ${sub.splitParams}`)}`);
    const env = { D, model, scope: 'side', sideRef: 'd', known: new Set([`d.split ${D.eq} ${D.enumConst('Split', x.name)}`]) };
    for (const c of x.checks) {
      const cond = refusal(c, env);
      if (cond !== false) lines.push(`${D.tab}if (${cond}) ${D.ret(c.reason, `base + ${sub.splitParams}`)}`);
    }
  }
  lines.push(`${first ? '' : '} else '}if (${NOT(D.isZero('d.splitParams', 'bytes'))}) {`, `${D.tab}${D.ret(malformed.splitParams, `base + ${sub.splitParams}`)}`, '}');
  lines.push(`if (${bZero(D, model, 'd')}) {`);
  for (const [k, type] of [['leg', 'uint8'], ['dest', 'uint8'], ['legParams', 'bytes'], ['destParams', 'bytes']]) {
    lines.push(`${D.tab}if (${NOT(D.isZero(`d.b.${k}`, type))}) ${D.ret(bNotZero, `base + ${sub.bOffset + sub[k]}`)}`);
  }
  lines.push('} else {', ...D.propagate(D.sol ? `_checkBranch(d.b, ctx, base + ${sub.bOffset})` : `checkBranch(d.b, ctx, base + ${sub.bOffset})`).map((l) => `${D.tab}${l}`), '}');

  lines.push(D.sol ? 'return (REASON_OK, 0);' : 'return OK;');
  return lines;
}

/** Opaque params structs used by recipes or core bytes fields, in first-use order.
 * Both kinds lists and public TypeScript tuple encoders use this one inventory.
 */
export function recipeStructs(model) {
  const { legs, dests, splits } = model.recipe;
  const contents = model.fields.flatMap((f) => f.check.kind === 'byBoxType'
    ? Object.values(f.check.checks).flatMap(c => c.kind === 'pile' ? ['PileParams', 'PileParamsV21'] : c.kind === 'params' ? [c.struct] : []) : []);
  return [...new Set([...legs, ...dests, ...splits].map((x) => x.params).filter(Boolean).concat(contents))];
}

// ------------------------------------------------------------------------------------------------- rules
/** `when` and `require` of a rule to its refusal condition: `require` folds under the facts `when` holds. */
function refusal(rule, env) {
  const when = compile(rule.when, env);
  return AND([when, NOT(compile(rule.require, { ...env, known: factsOf(when, new Set(env.known)) }))]);
}

/**
 * The rules in source order. A run of consecutive branch rules is one function, called for buyers.a, buyers.b, sellers.a
 * and sellers.b (b only where the split uses it); a run of side rules is one function called for each side. The source's
 * `ruleOrder` sets what a call checks:
 * - `rule-major`: rule k of the run. The function takes k (each rule that can refuse gets the next k, from 0), and
 *   checkRules loops k over the run, each k over every branch (side), so an earlier rule decides before a later one.
 * - `branch-major`: every rule of the run, in order, so a branch's (side's) first failing rule decides before the next
 *   branch's. `endRun` ends a run, so the next rules start again at buyers.a; each run costs its four call sites.
 * Both forms keep one copy of each rule's condition (measured on the validator probe: SH-V2-M1-10B.md). Returns
 * `checkRules`'s body, the run functions ({ name, scope, indexed, lines }) and the cfg budget's helpers
 * ({ name, scope, lines }).
 */
export function ruleParts(D, model) {
  const lines = [];
  const runs = [];
  const cfg = [];
  let cfgRules = 0;
  const { sub } = model.recipe;
  const offset = (rel) => {
    const [br, k] = rel.includes('.') ? rel.split('.') : [null, rel];
    if (!(k in sub)) model.fail(`rule field ${rel}: not a recipe sub-field`);
    return (br === 'b' ? sub.bOffset : 0) + sub[k];
  };
  // Rules run after every field and add-on passed: each leg, destination and split they read is a member (`checked`).
  const box = { D, model, scope: 'box', checked: true };
  for (let i = 0; i < model.rules.length; ) {
    const rule = model.rules[i];
    if (rule.cfgBudget !== undefined) {
      const parts = cfgBudgetParts(D, model, rule, ++cfgRules);
      lines.push(`// ${rule.name}`, ...parts.lines);
      cfg.push(...parts.helpers);
      i++;
      continue;
    }
    if (rule.scope === 'box') {
      lines.push(`// ${rule.name}`);
      const cond = refusal(rule, box);
      if (cond === true) model.fail(`rule ${rule.name} refuses every spec`);
      if (cond !== false) lines.push(`if (${cond}) ${D.ret(rule.reason, D.id(rule.field))}`);
      i++;
      continue;
    }
    // A run of rules of one scope, up to a rule that ends it.
    const scope = rule.scope;
    const run = [];
    while (i < model.rules.length && model.rules[i].scope === scope && model.rules[i].cfgBudget === undefined) {
      run.push(model.rules[i++]);
      if (run.at(-1).endRun) break;
    }
    const name = `${scope}Rules${runs.length + 1}`;
    const env = { ...box, scope, sideRef: 'd', sideFlag: 'buyers', ...(scope === 'branch' ? { brRef: 'br' } : {}) };
    const refusals = run.map((r) => {
      const cond = OR((r.checks ?? [r]).map((c) => refusal(c, env)));
      if (cond === true) model.fail(`rule ${r.name} refuses every spec`);
      return cond;
    });
    // Rule-major with two or more rules that can refuse: the run is indexed by k (one rule needs no index).
    const count = refusals.filter((c) => c !== false).length;
    const indexed = model.ruleOrder === 'rule-major' && count > 1;
    const body = [];
    let k = 0;
    run.forEach((r, j) => {
      body.push(`// ${r.name}`);
      const cond = refusals[j];
      if (cond !== false) {
        for (const c of r.checks ?? [r]) {
          const test = refusal(c, env);
          if (test !== false) body.push(`if (${indexed ? AND([`k ${D.eq} ${k}`, test]) : test}) ${D.ret(c.reason ?? r.reason, `base + ${offset(c.field)}`)}`);
        }
        k++;
      }
    });
    body.push(D.sol ? 'return (REASON_OK, 0);' : 'return OK;');
    runs.push({ name, scope, indexed, lines: body });
    lines.push(`// ${run.map((r) => r.name).join('; ')}`);
    const calls = [];
    for (const f of model.recipeFields) {
      const flag = sideOf(f) === SIDES[0] ? 'true' : 'false';
      const call = (br, base) => {
        const args = [...(indexed ? ['k'] : []), 's', 'ctx', `s.${f.name}`, ...(scope === 'branch' ? [`s.${f.name}.${br}`] : []), flag, base];
        return D.propagate(D.sol ? `_${name}(${args.join(', ')})` : `${name}(${args.join(', ')})`);
      };
      if (scope === 'side') calls.push(...call(null, D.lit(f.id * 1000, 'uint16')));
      else {
        calls.push(...call('a', D.lit(f.id * 1000, 'uint16')));
        calls.push(`if (${NOT(bZero(D, model, `s.${f.name}`))}) {`, ...call('b', D.lit(f.id * 1000 + sub.bOffset, 'uint16')).map((l) => `${D.tab}${l}`), '}');
      }
    }
    if (!indexed) lines.push(...calls);
    else lines.push(D.sol ? `for (uint256 k; k < ${count}; ++k) {` : `for (let k = 0; k < ${count}; k++) {`, ...calls.map((l) => `${D.tab}${l}`), '}');
  }
  lines.push(D.sol ? 'return (REASON_OK, 0);' : 'return OK;');
  return { lines, runs, cfg };
}

/**
 * All plug-in `cfg` bytes of a box together, in sub-field order (each side's a, split, then b), refused at the
 * params that cross the bound. Two helpers carry the running total: `cfgBranchK` (a branch's leg and destination params)
 * and `cfgSideK` (a side's branches and split params); they return the total and the crossing sub-field (Solidity: its
 * id, 0 for none; TypeScript: the verdict). `checkRules` calls `cfgSideK` per side.
 */
function cfgBudgetParts(D, model, rule, k) {
  const { sub, legs, dests, splits } = model.recipe;
  const sol = D.sol;
  const max = D.bound(rule.cfgBudget, 'uint256');
  const reason = model.reason(rule.reason);
  const acc = sol ? 'cfg' : 'c';
  const adds = (table, enumName, holder, key, place) => table
    .filter((x) => x.params && model.structs.get(x.params).members.some((m) => m.name === 'cfg'))
    .map((x) => `if (${holder}.${key} ${D.eq} ${D.enumConst(enumName, x.name)}) ${acc} += ${D.dynLen(`${holder}.${place}`, memberOf(model, x.params, 'cfg').index)};`);
  const over = (at) => (sol ? `if (cfg > ${max}) return (cfg, ${at});` : `if (c > ${max}) return [c, verdict(Reason.${reason}, ${at})];`);
  const done = sol ? 'return (cfg, 0);' : 'return [c, OK];';
  const branchName = `cfgBranch${k}`;
  const sideName = `cfgSide${k}`;
  const fn = (name) => (sol ? `_${name}` : name);

  const branch = sol ? [] : ['let c = cfg;'];
  for (const [table, enumName, key, place] of [[legs, 'Leg', 'leg', 'legParams'], [dests, 'Dest', 'dest', 'destParams']]) {
    const a = adds(table, enumName, 'br', key, place);
    if (a.length) branch.push(...a, over(`base + ${sub[place]}`));
  }
  const hasBranch = branch.length > (sol ? 0 : 1);
  branch.push(done);

  const side = [];
  const visit = (br, at) => {
    if (sol) side.push(`(cfg, f) = ${fn(branchName)}(d.${br}, cfg, ${at});`, 'if (f != 0) return (cfg, f);');
    else side.push(`${br === 'a' ? 'let [c, v]' : '[c, v]'} = ${fn(branchName)}(d.${br}, ${br === 'a' ? 'cfg' : 'c'}, ${at});`, 'if (v.reason !== Reason.OK) return [c, v];');
  };
  if (hasBranch) visit('a', 'base');
  else if (!sol) side.push('let c = cfg;');
  const splitAdds = adds(splits, 'Split', 'd', 'split', 'splitParams');
  if (splitAdds.length) side.push(...splitAdds, over(`base + ${sub.splitParams}`));
  if (hasBranch) visit('b', `base + ${sub.bOffset}`);
  side.push(done);

  const calls = ['{', `${D.tab}${sol ? 'uint256 cfg;' : 'let cfg: bigint;'}`];
  model.recipeFields.forEach((f, i) => {
    const first = i === 0;
    const last = i === model.recipeFields.length - 1;
    const args = `s.${f.name}, ${first ? (sol ? '0' : '0n') : 'cfg'}, ${D.lit(f.id * 1000, 'uint16')}`;
    if (sol) calls.push(`${D.tab}(${last ? '' : 'cfg'}, f) = ${fn(sideName)}(${args});`, `${D.tab}if (f != 0) return (REASON_${reason}, f);`);
    else calls.push(`${D.tab}${last ? `v = ${sideName}(${args})[1]` : `[cfg, v] = ${sideName}(${args})`};`, `${D.tab}if (v.reason !== Reason.OK) return v;`);
  });
  calls.push('}');
  const helpers = [...(hasBranch ? [{ name: branchName, scope: 'cfgBranch', lines: branch }] : []), { name: sideName, scope: 'cfgSide', lines: side }];
  return { lines: calls, helpers };
}

// ------------------------------------------------------------------------------------------------- add-ons
/** One add-on's check: offered by the release, its box types, canonical params, each param, its `requires`. */
export function addOnCheckLines(D, model, a) {
  const base = D.id(`addOns.${a.key}`);
  if (a.reserved) return [D.ret('ADD_ON_NOT_AVAILABLE', base)];
  if (!model.contexts[0].offeredAddOns.includes(a.id)) return [D.ret('ADD_ON_NOT_AVAILABLE', base)];
  const lines = [];
  // Field 2 refuses a box type the release does not offer before any add-on runs, so an add-on open to every offered
  // type needs no check.
  const boxType = model.fieldByName.get('boxType');
  if (boxType.check.kind !== 'enum') model.fail('field boxType: an enum check with `offered`');
  if (!boxType.check.offered.every((t) => a.boxTypes.includes(t))) lines.push(`if (${NOT(membersIn(D, 's.boxType', boxType.check.enum, a.boxTypes))}) ${D.ret('ADD_ON_CONFLICT', base)}`);
  if (a.params.length === 0) {
    lines.push(`if (p.length ${D.ne} 0) ${D.ret('ADD_ON_PARAMS_MALFORMED', base)}`);
  } else if (D.sol) {
    lines.push(`(bool ok, uint256[] memory w) = _canonical(p, ${kindsHex(model, a.params)});`, `if (!ok) ${D.ret('ADD_ON_PARAMS_MALFORMED', base)}`);
    if (a.params.some((x) => x.type === 'string')) lines.push('uint16 r;');
  } else {
    D.used.add('canonicalParams');
    D.used.add('ParamKind');
    D.used.add('word');
    lines.push(`const w = canonicalParams(p, [${a.params.map((x) => `ParamKind.${kindOf(x.type, model)}`).join(', ')}]);`, `if (w === null) ${D.ret('ADD_ON_PARAMS_MALFORMED', base)}`);
  }
  a.params.forEach((x, i) => {
    const id = D.id(`addOns.${a.key}.${x.name}`);
    const w = D.sol ? `w[${i}]` : `word(w, ${i})`;
    if (x.type === 'string') {
      const r = model.stringRules.get(x.rule) ?? model.fail(`add-on ${a.key}.${x.name}: rule ${x.rule}`);
      if (D.sol) lines.push(`r = _checkStringAt(p, ${w}, ${solInt(x.minBytes)}, ${solInt(x.maxBytes)}, RULE_${r.name});`, `if (r != REASON_OK) return (r, ${id});`);
      else {
        D.used.add('checkStringAt');
        lines.push(`const r${i} = checkStringAt(p, ${w}, ${x.minBytes}, ${x.maxBytes}, RULE_RANGES.${r.name}, RULE_PREFIXES.${r.name});`, `if (r${i} !== Reason.OK) return verdict(r${i}, ${id});`);
      }
    } else if (x.type === 'bytes32[]') {
      const read = D.sol ? `_word(p, ${w})` : (D.used.add('readWordAt'), `readWordAt(p, ${w})`);
      lines.push(`if (${read} > ${D.wlit(x.maxItems)}) ${D.ret('LENGTH_OUT_OF_RANGE', id)}`);
      if (x.nonZeroItems) lines.push(`if (!${D.sol ? `_nonZeroItems(p, ${w})` : (D.used.add('nonZeroItems'), `nonZeroItems(p, ${w})`)}) ${D.ret('ZERO_VALUE', id)}`);
    } else if (x.allowed) {
      lines.push(`if (${NOT(OR(x.allowed.map((v) => `${w} ${D.eq} ${D.wlit(v)}`)))}) ${D.ret(x.reason ?? 'NOT_A_MEMBER', id)}`);
    } else if (x.enum) {
      const e = model.enums.get(x.enum);
      lines.push(`if (${NOT(OR(e.members.map((m) => `${w} ${D.eq} ${D.wenum(x.enum, m.name)}`)))}) ${D.ret('NOT_A_MEMBER', id)}`);
      if (x.offered && x.offered.length !== e.members.length) lines.push(`if (${NOT(OR(x.offered.map((m) => `${w} ${D.eq} ${D.wenum(x.enum, m)}`)))}) ${D.ret('NOT_OFFERED', id)}`);
    } else if ('min' in x || 'max' in x) {
      const cond = OR([...('min' in x ? [`${w} < ${D.bound(x.min, 'uint256')}`] : []), ...('max' in x ? [`${w} > ${D.bound(x.max, 'uint256')}`] : [])]);
      lines.push(`if (${cond}) ${D.ret('OUT_OF_RANGE', id)}`);
    }
    if (x.nonZero) lines.push(`if (${w} ${D.eq} ${D.wlit(0)}) ${D.ret('ZERO_VALUE', id)}`);
  });
  for (const req of a.requires) {
    const ok = compile(req.predicate, { D, model, scope: 'box', addOn: a, checked: true });
    if (ok !== true) lines.push(`if (${NOT(ok)}) ${D.ret(req.reason, base)}`);
  }
  lines.push(D.sol ? 'return (REASON_OK, 0);' : 'return OK;');
  return lines;
}

// ------------------------------------------------------------------------------------------------- shop contents
/** Canonical opaque ShopConfigV2, then prices/presets/list/seed. Called only after all existing fields/rules.
 * Bound the tails before any variable read; interpret narrow words only after checking padding. No ABI decoder
 * can throw on malformed contents, and at most 64 collections bound duplicate checks to 2016 comparisons.
 */
export function shopCheckLines(D, model) {
  const { words, headWords, minBytes, maxCollections, presets, loaderId, minimumSeedGives } = model.shop;
  const w = D.wlit;
  const read = (index) => D.sol ? `_pw(p, ${index})` : (D.used.add('readWordAt'), `readWordAt(p, ${w(32)} * (${index}))`);
  const at = (name) => read(w(words[name].index));
  const ret = (reason) => D.ret(reason, D.id('contentsParams'));
  const done = D.sol ? 'return (REASON_OK, 0);' : 'return OK;';
  const declare = (name, expr) => `${D.sol ? 'uint256' : 'const'} ${name} = ${expr};`;
  const loop = (name, start, end) => `for (${D.sol ? 'uint256' : 'let'} ${name} = ${start}; ${name} < ${end}; ++${name}) {`;
  const countIndex = headWords + 1;
  const firstAddress = headWords + 2;
  const firstTier = `${w(headWords + 3)} + n`;
  const len = D.sol ? 'p.length' : 'BigInt(p.length)';
  const lines = [
    `if (s.boxType ${D.ne} ${D.enumConst('BoxType', 'SHOP')}) ${done}`,
    D.sol ? 'bytes memory p = s.contentsParams;' : 'const p = hexToBytes(s.contentsParams);',
    declare('n', read(w(countIndex))),
    `if (${read(w(0))} ${D.ne} ${w(32)} || ${at('collections')} ${D.ne} ${w(headWords * 32)} || n > ${w(maxCollections)}) ${ret('RECIPE_RULE')}`,
    `if (${len} ${D.ne} ${w(minBytes)} + n * ${w(64)} || ${at('tiers')} ${D.ne} ${w((headWords + 1) * 32)} + n * ${w(32)} || ${read(`${w(firstAddress)} + n`)} ${D.ne} n) ${ret('RECIPE_RULE')}`,
  ];
  for (const name of ['pickBps', 'weeklyBps', 'collectionBps', 'listDelay', 'curator']) {
    const bits = words[name].type === 'address' ? 160 : Number(words[name].type.slice(4));
    lines.push(`if (${at(name)} > ${w((1n << BigInt(bits)) - 1n)}) ${ret('RECIPE_RULE')}`);
  }
  lines.push(loop('i', w(0), 'n'),
    `${D.tab}if (${read(`${w(firstAddress)} + i`)} > ${w((1n << 160n) - 1n)} || ${read(`${firstTier} + i`)} > ${w(255)}) ${ret('RECIPE_RULE')}`, '}',
    `${D.sol ? 'uint256' : 'let'} previous = ${w(0)};`,
    loop('i', w(words.givePricesT.index), w(words.givePricesT.index + words.givePricesT.width)),
    `${D.tab}${declare('price', read('i'))}`,
    `${D.tab}if (price <= previous) ${ret('OUT_OF_RANGE')}`, `${D.tab}previous = price;`, '}');
  for (const [name, values] of Object.entries(presets)) {
    lines.push(`if (${values.map((v) => `${at(name)} ${D.ne} ${w(v)}`).join(' && ')}) ${ret('NOT_A_MEMBER')}`);
  }
  lines.push(`${D.sol ? 'uint256' : 'let'} minInitialGiveT = previous;`,
    loop('i', w(0), 'n'),
    `${D.tab}${declare('addressWord', read(`${w(firstAddress)} + i`))}`,
    `${D.tab}if (addressWord ${D.eq} ${w(0)}) ${ret('ZERO_VALUE')}`,
    `${D.tab}if (${read(`${firstTier} + i`)} > ${w(words.givePricesT.width - 1)}) ${ret('OUT_OF_RANGE')}`,
    `${D.tab}${declare('giveT', read(`${w(words.givePricesT.index)} + ${read(`${firstTier} + i`)}`))}`,
    `${D.tab}if (giveT < minInitialGiveT) minInitialGiveT = giveT;`,
    `${D.tab}${loop('j', w(0), 'i')}`,
    `${D.tab}${D.tab}if (${read(`${w(firstAddress)} + j`)} ${D.eq} addressWord) ${ret('RECIPE_RULE')}`,
    `${D.tab}}`, '}',
    `if (${at('seedT')} ${D.ne} ${w(0)} && !${D.call('hasAddOn', 's', String(loaderId))}) ${ret('ADD_ON_REQUIRED')}`,
    // minimumSeedGives is pinned by shopModel to the canonical F132 source rule.
    '// F132: the allowance floor needs only two cheapest initially listed gives, even for an empty shop.',
    '// Division refuses an unrepresentable required seed without overflowing uint256.',
    declare('seed', at('seedT')),
    `if (n ${D.eq} ${w(0)} || seed / ${w(minimumSeedGives)} < minInitialGiveT) ${ret('OUT_OF_RANGE')}`,
    done);
  return lines;
}
