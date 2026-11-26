#!/usr/bin/env node
// SH-EX-O1: an open kit's settings file, its numbered pictures and traits.csv, as `node scripts/kits/bundle.mjs <kit>`
// writes them into the kit's ignored build/ folder (the same bytes: scripts/kits `buildKit` and `settingsText`), into a
// fresh folder this suite owns instead. Items that are the same picture are hard links of one file, so 500 items take
// the disk of their 12 pictures. Run in its own Node process: the kit tooling loads the page's TypeScript through Node's
// own transformer (scripts/kits/app.mjs), which a Playwright worker must not share.
// SH-EX-LMV2: `--bindings PUBLIC_JSON` binds the kit as `scripts/kits/settings.mjs --bindings` does (scripts/kits
// README, "Binding the setup"): Link Marines version 2 is bound to the local chain's LINK listing, as the founder binds
// the Sepolia tLINK listing.
import { linkSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildKit, cliArgs, settingsText } from '../../../../../scripts/kits/settings.mjs';

const [id, destination, ...rest] = process.argv.slice(2);
if (!id || !destination || !(rest.length === 0 || (rest.length === 2 && rest[0] === '--bindings'))) throw new Error('usage: kit-files.mjs KIT DESTINATION [--bindings PUBLIC_JSON]');
// The kit tooling's own argument check refuses unknown or malformed binding fields.
const { bindings } = rest.length ? cliArgs([id, ...rest]) : { bindings: {} };
const kit = await buildKit(id, bindings);
rmSync(destination, { recursive: true, force: true });
mkdirSync(join(destination, 'items'), { recursive: true });
const firsts = new Map();
for (const item of kit.items) {
  const path = join(destination, 'items', `${item.id}.png`);
  const first = firsts.get(item.sha256);
  if (first) linkSync(first, path);
  else { writeFileSync(path, item.bytes); firsts.set(item.sha256, path); }
  // SH-CREATE-ITEM-MODELS: a 3D kit's reviewed model beside its picture, as `scripts/kits/bundle.mjs` writes items/.
  if (item.model) writeFileSync(join(destination, 'items', `${item.id}.glb`), item.model.bytes);
}
writeFileSync(join(destination, 'items', 'traits.csv'), kit.traitsCsv);
writeFileSync(join(destination, `${id}-boxspec-v2.json`), settingsText(kit));
process.stdout.write(`${JSON.stringify({ id, items: kit.items.length, pictures: firsts.size, models: kit.items.filter((item) => item.model).length, unresolved: kit.unresolved.map((entry) => entry.field), bound: Object.keys(bindings).length > 0 })}\n`);
