#!/usr/bin/env node
/**
 * SH-261: a compact, committed record of the demo boxes' real runs, extracted read-only from the run folder's state and
 * result files (the README's statements point here):
 *
 *   node packages/chain/scripts/bnb-boxes/extract-real.mjs --dir <the real runs' folder> --out hackathon/real-97-demo-boxes.json
 *
 * Per box: coordinator, token, createBox hash, the read-back's count, every transaction of the life (step, call, hash,
 * sender), and the payouts (the holders' claims of the stock box and of Pile Party; Rent Free's house 1 and its burns;
 * The Alchemist's conversion, burn and redemption; what Pile Furnace sent to the dead address). Nothing else is copied.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stateStore } from './chain.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const dir = resolve(flag('--dir'));
const plain = value => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
const out = { schema: 'squarehole.demo-boxes-real-runs/1', chainId: 97, source: 'the real runs\' state and result files of 25 and 26 November 2026, read only', boxes: {} };
// The boxes of real.mjs's BOXES table that ran: railholders is Pile Party (a holders life), rail is Pile Furnace (an
// eat life).
for (const box of ['stock', 'rentfree', 'converter', 'railholders', 'rail']) {
  let state;
  try { state = stateStore(join(dir, `${box}.json`)).data; } catch { continue; }
  const result = state.memo['create:result'];
  if (!result) continue;
  let life = null;
  try { life = JSON.parse(readFileSync(join(dir, `${box}-life.json`), 'utf8')); } catch { /* no life yet */ }
  const entry = {
    coordinator: result.coordinator, token: result.token, createTx: result.readBack.createTx,
    readBack: `${result.readBack.rows.filter(r => r.same).length} of ${result.readBack.rows.length} fields equal`,
    transactions: Object.entries(state.tx).map(([step, tx]) => ({ step, call: tx.label, hash: tx.hash, from: tx.from })),
  };
  if (life?.claimed) Object.assign(entry, { claims: life.claimed.map(c => ({ holder: c.holder, rawPriceCoin: c.quote, hash: c.hash })), totalRawPriceCoin: life.total });
  if (life?.claim) Object.assign(entry, { house1: { takenOutRawBoxTokens: life.taken.paid, principalRawBoxTokens: life.taken.principal, pickFeeBps: life.taken.bps, claimedRawPriceCoin: life.claim.received },
    burns: [life.graduationBurn, life.burned].map(b => ({ hash: b.hash ?? null, burnedRawBoxTokens: b.burned ?? b.tBurned ?? null })) });
  if (life?.conversion) Object.assign(entry, { conversion: life.conversion, burned: life.burned, redeemed: life.redeemed });
  if (life?.eats) Object.assign(entry, { toDeadAddress: life.eats.map(e => ({ rawPriceCoin: e.amount, hash: e.hash })), totalRawPriceCoinToDeadAddress: life.total });
  out.boxes[box] = plain(entry);
}
writeFileSync(resolve(flag('--out')), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`${Object.keys(out.boxes).join(', ')} written\n`);
