import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feeRulesAbi } from '../src/abi/feeRules';

// The page's typed pile ABI must match what the two entries export: same names, same input and output types.
const here = path.dirname(fileURLToPath(import.meta.url));
const exported = [
  ['flap PileVault', '../../flap/abi/PileVault.json'],
  ['openfour FeeRules', '../../openfour/abi/FeeRules.json'],
] as const;

type Item = { type: string; name?: string; inputs?: { type: string; indexed?: boolean }[]; outputs?: { type: string }[] };
const sig = (x: Item) =>
  `${x.type} ${x.name}(${(x.inputs ?? []).map((i) => i.type + (i.indexed ? ' indexed' : '')).join(',')})` +
  (x.type === 'function' ? ` -> (${(x.outputs ?? []).map((o) => o.type).join(',')})` : '');

describe('pile ABI against the entries’ exports', () => {
  for (const [name, rel] of exported) {
    it(name, () => {
      const abi = JSON.parse(fs.readFileSync(path.join(here, rel), 'utf8')) as Item[];
      const theirs = new Set(abi.map(sig));
      const missing = (feeRulesAbi as unknown as readonly Item[]).map(sig).filter((s) => !theirs.has(s));
      expect(missing).toEqual([]);
    });
  }
});
