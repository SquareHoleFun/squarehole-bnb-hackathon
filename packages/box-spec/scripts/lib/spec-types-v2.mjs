/**
 * BoxSpec format 2's shapes as the checker reads them (M1-11): enums and structs parsed at run time from the files M1-00
 * froze (packages/contracts/src/box-v2/interfaces/SpecTypes.sol, RecipeTypes.sol, IListingRegistry.sol), with each
 * member's NatSpec, so nothing about the shape is written down twice. Encoders follow the frozen wire rules: the spec
 * hash is keccak256(abi.encode(spec)); params are canonical abi.encode of the params tuple's members as a list (empty
 * params are 0x). This is wave 1's stand-in for M1-10's generated TypeScript twin, whose encoder it must equal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeAbiParameters, encodeAbiParameters, keccak256 } from 'viem';
import { repoDir } from './spec-model.mjs';

export const INTERFACES_DIR = join(repoDir, 'packages/contracts/src/box-v2/interfaces');
const FILES = { structs: ['SpecTypes.sol', 'RecipeTypes.sol', 'IShopVaultV2.sol'], enums: ['SpecTypes.sol', 'RecipeTypes.sol', 'IListingRegistry.sol'] };
const ELEMENTARY = /^(uint\d+|int\d+|address|bool|bytes\d*|string)$/;

/** Enums and structs of one Solidity source: { enums: [{ name, doc, members: [{ name, value, doc }] }], structs }. */
export function parseSolidity(text) {
  const enums = [];
  const structs = [];
  let doc = [];
  let open = null;
  const expanded = text.replace(/(enum|struct) (\w+)\s*\{([^}\n]*)\}/g, (_, kind, name, body) => {
    const separator = kind === 'enum' ? ',' : ';';
    const items = body.split(separator).map((item) => item.trim()).filter(Boolean);
    return `${kind} ${name} {\n${items.map((item) => `${item}${separator}`).join('\n')}\n}`;
  });
  for (const raw of expanded.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('///')) {
      doc.push(line.replace(/^\/\/\/\s?(@\w+\s+)?/, ''));
      continue;
    }
    const head = /^(enum|struct)\s+(\w+)\s*\{$/.exec(line);
    if (head) {
      open = { kind: head[1], name: head[2], doc: doc.join(' '), items: [] };
      doc = [];
    } else if (open && line === '}') {
      (open.kind === 'enum' ? enums : structs).push(open.kind === 'enum' ? { name: open.name, doc: open.doc, members: open.items } : { name: open.name, doc: open.doc, fields: open.items });
      open = null;
    } else if (open?.kind === 'enum' && /^\w+,?$/.test(line)) {
      open.items.push({ name: line.replace(',', ''), value: open.items.length, doc: doc.join(' ') });
    } else if (open?.kind === 'struct' && /^[\w[\]]+\s+\w+;$/.test(line)) {
      const [type, name] = line.slice(0, -1).split(/\s+/);
      open.items.push({ name, type, doc: doc.join(' ') });
    }
    if (!line.startsWith('///')) doc = [];
  }
  return { enums, structs };
}

/** The frozen shapes: Map enum name -> { members }, Map struct name -> fields (in order). */
export function readShapes(dir = INTERFACES_DIR) {
  const parsed = Object.fromEntries([...new Set([...FILES.structs, ...FILES.enums])].map((f) => [f, parseSolidity(readFileSync(join(dir, f), 'utf8'))]));
  const enums = new Map(FILES.enums.flatMap((f) => parsed[f].enums.map((e) => [e.name, e])));
  const structs = new Map(FILES.structs.flatMap((f) => parsed[f].structs.map((s) => [s.name, s.fields])));
  return { enums, structs };
}

/** The enum a uint8 field carries, from its NatSpec ("A `Leg` value", "a `BoxType` value"), or undefined. */
export function enumOfField(shapes, field) {
  const m = /\b[Aa]n? `(\w+)` value/.exec(field.doc ?? '');
  return m && shapes.enums.has(m[1]) ? m[1] : undefined;
}

/** The params struct an enum member takes ("legParams: `ConvertLegParams`"), or undefined for none. */
export function paramsOfMember(member, which) {
  return new RegExp(`${which}: \`(\\w+)\``).exec(member.doc ?? '')?.[1];
}

/** The viem ABI parameter for a struct (a tuple) or a field type. */
export function abiOf(shapes, type, name) {
  const suffix = /\[\d*\]$/.exec(type)?.[0] ?? '';
  const base = suffix ? type.slice(0, -suffix.length) : type;
  const at = name === undefined ? {} : { name };
  if (ELEMENTARY.test(base)) return { ...at, type };
  const fields = shapes.structs.get(base);
  if (!fields) throw new Error(`no frozen struct ${base}`);
  return { ...at, type: `tuple${suffix}`, components: fields.map((f) => abiOf(shapes, f.type, f.name)) };
}

/** abi.encode(spec) for a wire spec (field names as SpecTypes.sol names them). */
export const encodeSpecV2 = (shapes, wire) => encodeAbiParameters([abiOf(shapes, 'BoxSpec')], [wire]);
export const specHashV2 = (shapes, wire) => keccak256(encodeSpecV2(shapes, wire));

/** Canonical params of `struct` from `values` by member name: abi.encode of the members as a list. */
export function encodeParamsV2(shapes, struct, values) {
  const fields = shapes.structs.get(struct);
  return encodeAbiParameters(fields.map((f) => abiOf(shapes, f.type, f.name)), fields.map((f) => values[f.name]));
}

/** The params decoded by member name, or null when they are not exactly the canonical encoding. */
export function decodeParamsV2(shapes, struct, hex) {
  const fields = shapes.structs.get(struct);
  try {
    const decoded = decodeAbiParameters(fields.map((f) => abiOf(shapes, f.type, f.name)), hex);
    const values = Object.fromEntries(fields.map((f, i) => [f.name, decoded[i]]));
    return encodeParamsV2(shapes, struct, values) === String(hex).toLowerCase() ? values : null;
  } catch {
    return null;
  }
}
