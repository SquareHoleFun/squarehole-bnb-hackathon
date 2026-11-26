import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters } from 'viem';
import { abiOf, decodeParamsV2, encodeParamsV2, parseSolidity, readShapes } from './spec-types-v2.mjs';

const inline = `
/// @notice Ordered recipe settings.
struct OrderedParams { uint256 seed; address owner; uint256[] ids; uint8 ceilingPreset; }
/// @notice Available choices.
enum Choice { None, Keep, Eat }
`;
const multiline = `
/// @notice Ordered recipe settings.
struct OrderedParams {
    uint256 seed;
    address owner;
    uint256[] ids;
    uint8 ceilingPreset;
}
/// @notice Available choices.
enum Choice {
    None,
    Keep,
    Eat
}
`;

test('inline structs preserve declaration order, types and NatSpec alongside enums', () => {
  const parsed = parseSolidity(inline);
  assert.deepEqual(parsed, parseSolidity(multiline));
  assert.deepEqual(parsed.structs, [{
    name: 'OrderedParams',
    doc: 'Ordered recipe settings.',
    fields: [
      { name: 'seed', type: 'uint256', doc: '' },
      { name: 'owner', type: 'address', doc: '' },
      { name: 'ids', type: 'uint256[]', doc: '' },
      { name: 'ceilingPreset', type: 'uint8', doc: '' },
    ],
  }]);
  assert.deepEqual(parsed.enums, [{
    name: 'Choice',
    doc: 'Available choices.',
    members: [
      { name: 'None', value: 0, doc: '' },
      { name: 'Keep', value: 1, doc: '' },
      { name: 'Eat', value: 2, doc: '' },
    ],
  }]);
});

test('inline struct params encode in declaration order, independent of object key order', () => {
  const parsed = parseSolidity(inline);
  const shapes = { structs: new Map(parsed.structs.map(s => [s.name, s.fields])) };
  const values = { ceilingPreset: 2, ids: [9n, 3n], owner: `0x${'11'.repeat(20)}`, seed: 180000000000000000000000000n };
  const abi = [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256[]' }, { type: 'uint8' }];
  const ordered = [values.seed, values.owner, values.ids, values.ceilingPreset];
  const encoded = encodeAbiParameters(abi, ordered);
  assert.equal(encodeParamsV2(shapes, 'OrderedParams', values), encoded);
  assert.deepEqual(decodeParamsV2(shapes, 'OrderedParams', encoded), values);
  assert.equal(
    encodeAbiParameters([abiOf(shapes, 'OrderedParams')], [values]),
    encodeAbiParameters([{ type: 'tuple', components: abi }], [ordered]),
  );
});

test('the actual inline ShopDestParams shape encodes its ceiling as one canonical ABI word', () => {
  const shapes = readShapes();
  assert.deepEqual(shapes.structs.get('ShopDestParams'), [{ name: 'ceilingPreset', type: 'uint8', doc: '' }]);
  const encoded = `0x${'1'.padStart(64, '0')}`;
  assert.equal(encodeParamsV2(shapes, 'ShopDestParams', { ceilingPreset: 1 }), encoded);
  assert.deepEqual(decodeParamsV2(shapes, 'ShopDestParams', encoded), { ceilingPreset: 1 });
});
