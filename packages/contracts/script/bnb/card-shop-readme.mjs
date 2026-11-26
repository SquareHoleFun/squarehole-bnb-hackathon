#!/usr/bin/env node
/**
 * SH-262: the card shop's row in `hackathon/README.md`, written from the deployment file the real run produced
 * (`packages/contracts/deployments/bnb-testnet/97-cards.json`), never typed by hand. Run from the repository root:
 *
 *   node packages/contracts/script/bnb/card-shop-readme.mjs [--cards <97-cards.json>] [--check]
 *
 * It replaces the card shop's row of the demo-box table (the row starting `| A card shop |` or `| Card Shop (CARD) |`);
 * `--check` only compares and exits 1 when the README differs. No chain read.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const README = join(ROOT, 'hackathon/README.md');
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The row, from the deployment file. The date is the creation's, in the event's time zone (+07). */
export function cardShopRow(cards) {
  assert.equal(cards.schema, 'square-hole-bnb-testnet-cards/1');
  assert.equal(cards.chainId, 97);
  const token = cards.box.boxToken;
  assert.match(token, ADDRESS);
  const created = new Date((Number(cards.box.createdAt) + 7 * 3600) * 1000);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const date = `${created.getUTCDate()} ${months[created.getUTCMonth()]} ${created.getUTCFullYear()}`;
  return `| Card Shop (CARD) | \`card-shop\`, Shop, priced in tUSDC | trading cards in four rarity tiers (our own art, ${cards.starterCards} starter cards)`
    + ' bought and sold by the box\'s shop at four fixed prices, one per tier; on the site a visitor buys CARD and picks a card'
    + ' out of the shop for twice its tier\'s price (sell-backs open seven days after the box was created)'
    + ` | [\`${token}\`](https://testnet.bscscan.com/token/${token}) | ${date} |`;
}

export function withRow(readme, row) {
  const lines = readme.split('\n');
  const at = lines.findIndex(line => line.startsWith('| A card shop |') || line.startsWith('| Card Shop (CARD) |'));
  assert.ok(at >= 0, 'the README has no card shop row');
  lines[at] = row;
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--cards');
  const cards = JSON.parse(readFileSync(resolve(i === -1 ? join(ROOT, 'packages/contracts/deployments/bnb-testnet/97-cards.json') : args[i + 1]), 'utf8'));
  const before = readFileSync(README, 'utf8');
  const after = withRow(before, cardShopRow(cards));
  if (args.includes('--check')) {
    process.stdout.write(after === before ? 'the card shop row is current\n' : 'the card shop row differs from the deployment file\n');
    process.exitCode = after === before ? 0 : 1;
  } else {
    writeFileSync(README, after);
    process.stdout.write('the card shop row written from the deployment file\n');
  }
}
