import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { shopAbi, shopFactoryAbi } from '../src/abi/shop';

// SH-288: the page's hand-typed shop ABI against the ABIs the shared core exports (bounties/core/abi, written by its
// script/export-abi.sh): every function, event and error the page names exists there with the same input types (events
// with their indexed marks). Skipped until the core's shop is on the branch; SHOP_CORE_ABI names another folder.
const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.SHOP_CORE_ABI ?? path.join(here, '../../core/abi');
const files = [['RailShop', shopAbi], ['RailShopFactory', shopFactoryAbi]] as const;
const present = files.every(([name]) => existsSync(path.join(DIR, `${name}.json`)));

type Item = { type: string; name?: string; inputs?: readonly { type: string; indexed?: boolean }[] };
const sig = (x: Item) => `${x.type} ${x.name}(${(x.inputs ?? []).map((i) => i.type + (i.indexed ? ' indexed' : '')).join(',')})`;

describe.skipIf(!present)('the shop ABI against the shared core’s export', () => {
  for (const [name, ours] of files) {
    it(name, () => {
      const theirs = new Set((JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as Item[]).map(sig));
      expect((ours as readonly Item[]).map(sig).filter((s) => !theirs.has(s))).toEqual([]);
    });
  }
});
