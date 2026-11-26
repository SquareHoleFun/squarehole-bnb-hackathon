// READ-ONLY on the real BSC Testnet (or the endpoint given): the smallest raise the REAL Launcher Factory accepts
// through the Portal today with the page's other defaults (600,000,000 tokens for sale, 16 BNB curve depth), found by
// bisection on the factory's own `liquidityFloor`; and what a creator then sends. Nothing is sent.
// usage: node scripts/smallest-sale.mjs [rpcUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, formatEther, http } from 'viem';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const addresses = JSON.parse(fs.readFileSync(path.join(app, 'public/addresses.json'), 'utf8'));
const abi = JSON.parse(fs.readFileSync(path.join(app, '../flap/abi/CurveLauncherFactory.json'), 'utf8'));
const c = createPublicClient({ transport: http(process.argv[2] ?? addresses.rpcUrls[0]) });
const factory = addresses.flap.curveLauncherFactory;
const SALE = 600_000_000n * 10n ** 18n;
const VIRTUAL = 16n * 10n ** 18n;
const viaPortal = true;

async function passes(target) {
  try {
    const [, raise, poolToken, total] = await c.readContract({ address: factory, abi, functionName: 'curveFor', args: [SALE, target, VIRTUAL] });
    const [usd, need] = await c.readContract({ address: factory, abi, functionName: 'liquidityFloor', args: [raise, poolToken, total, viaPortal] });
    return { ok: usd >= need, usd, need, raise };
  } catch {
    return { ok: false };
  }
}

let lo = 10n ** 15n; // 0.001 BNB
let hi = 5n * 10n ** 18n; // 5 BNB
if (!(await passes(hi)).ok) throw new Error('even 5 BNB does not pass the floor');
if ((await passes(lo)).ok) hi = lo;
while (hi - lo > 10n ** 14n) {
  const mid = (lo + hi) / 2n;
  if ((await passes(mid)).ok) hi = mid;
  else lo = mid;
}
// Round up to the next 0.01 BNB, as a person would type it.
const step = 10n ** 16n;
const target = ((hi + step - 1n) / step) * step;
const at = await passes(target);
const fee = await c.readContract({ address: factory, abi, functionName: 'creationFee' });
const block = await c.getBlockNumber();
console.log(JSON.stringify({
  block: block.toString(),
  factory,
  smallestTargetBnb: formatEther(target),
  floorUsd: formatEther(at.need ?? 0n),
  poolUsdAtTarget: formatEther(at.usd ?? 0n),
  creationFeeBnb: formatEther(fee),
  completeAloneBnb: formatEther(target + (target * 100n) / 10000n),
}, null, 2));
