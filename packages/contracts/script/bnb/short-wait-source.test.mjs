// SH-300: the two ten-minute variants differ from the release's own sources ONLY where their header says: the import
// paths, their own names, and the one wait condition (plus the header comment and, in the shop, the constant that
// names the ten minutes). Each test makes exactly those edits to the release's source and asserts the result is the
// variant, text for text; any other difference fails it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = path => readFileSync(join(here, path), 'utf8');
const header = text => text.replace(/\n\/\/ SH-300 \(BNB Chain testnet only\)[^\n]*\n(?:\/\/[^\n]*\n)*\n/, '\n');
const edit = (text, pairs) => pairs.reduce((t, [from, to]) => {
  assert.ok(t.includes(from), `the release's source holds ${from}`);
  return t.split(from).join(to);
}, text);

test('BoxSpecV2ShortWait is BoxSpecV2 with 600 s added to the shop wait condition, nothing else', () => {
  const original = read('../../src/box-v2/BoxSpecV2.sol');
  const variant = header(read('BoxSpecV2ShortWait.sol'));
  const expected = edit(original, [
    ['from "./interfaces/', 'from "../../src/box-v2/interfaces/'],
    ['library BoxSpecV2 {', 'library BoxSpecV2ShortWait {'],
    ['if (_pw(p, 9) != 604_800 &&', 'if (_pw(p, 9) != 600 && _pw(p, 9) != 604_800 &&'],
  ]);
  assert.equal(variant, expected);
  // The condition sits in _checkShop, after its box-type gate: only a shop's contents reach it.
  const shop = original.slice(original.indexOf('function _checkShop('));
  assert.ok(shop.indexOf('if (s.boxType != BOX_TYPE_SHOP) return (REASON_OK, 0);') < shop.indexOf('_pw(p, 9) != 604_800'));
  assert.equal(original.split('_pw(p, 9)').length - 1, 4, 'word 9 is read in _checkShop only: its uint32 bound and the wait line');
  assert.equal(shop.split('_pw(p, 9)').length - 1, 4);
});

test('ShopVaultV2ShortWait is ShopVaultV2 with the ten minutes added to its wait condition, nothing else', () => {
  const original = read('../../src/box-v2/ShopVaultV2.sol');
  const variant = header(read('ShopVaultV2ShortWait.sol'));
  const expected = edit(original, [
    ['from "../box/', 'from "../../src/box/'],
    ['from "../libraries/', 'from "../../src/libraries/'],
    ['from "./interfaces/', 'from "../../src/box-v2/interfaces/'],
    ['from "./libraries/', 'from "../../src/box-v2/libraries/'],
    ['ShopTBurnerV2', 'ShopTBurnerV2ShortWait'],
    ['contract ShopVaultV2 is IShopVaultV2, BoxCloneBase, TransientReentrancyGuard {',
      'contract ShopVaultV2ShortWait is IShopVaultV2, BoxCloneBase, TransientReentrancyGuard {\n    /// @notice SH-300: the short list delay this variant accepts beside 7, 14 and 30 days.\n    uint32 private constant SHORT_WAIT = 10 minutes;'],
    ['|| (cfg.listDelay != 7 days &&', '|| (cfg.listDelay != SHORT_WAIT && cfg.listDelay != 7 days &&'],
  ]);
  assert.equal(variant, expected);
});
