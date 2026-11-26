import { roundTime } from './quicknet.mjs';
import { Failure } from './chain.mjs';

// Date is used only to format the decimal timestamp; all readiness and duration decisions use bigint.
function utc(seconds) {
  const date = new Date(0);
  date.setUTCSeconds(seconds.toString());
  return date.toISOString().replace('.000Z', 'Z');
}
export async function waitForRound(io, conn, action, state) {
  // The initial block and request reads use the same deadline as the later polls.
  const until = io.clock() + 30000n;
  const ticket = state.tickets.find(t => t.address === action.to);
  const block = await conn.block();
  const q = await conn.read(block, ticket.source, 'requestOf', [ticket.address, 0n]);
  if (BigInt(q[0]) === 0n || BigInt(q[1]) === 0n) throw new Failure('pending request missing');
  const target = roundTime(BigInt(q[1]));
  let latest = block;
  while (latest.now < target) {
    const remaining = until - io.clock();
    if (remaining <= 0n) {
      break;
    }
    await io.wait(remaining < 1000n ? remaining : 1000n);
    const budget = until - io.clock();
    if (budget <= 0n) break;
    try { latest = await conn.block({ timeout: (budget < 10000n ? budget : 10000n).toString() }); }
    catch (error) {
      if (io.clock() >= until) break;
      throw error;
    }
  }
  if (latest.now >= target) return true;
  io.stdout.write(`run again after ${utc(target)}\n`);
  return false;
}
