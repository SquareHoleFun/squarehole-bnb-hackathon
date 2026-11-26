import { viem } from './deps.mjs';
import { ABI } from './abi.mjs';
import { CHAIN_HASH } from './quicknet.mjs';
import { signatureXY } from './signature.mjs';
import { json } from './http.mjs';
import { Failure, errorName, hex, same } from './chain.mjs';
import { fees } from './plan.mjs';
import { blockHeader } from './header.mjs';

const skips = new Set(['WordAlreadyRequested', 'WordAlreadyAccepted', 'RoundKnown', 'BackupAlreadyStarted', 'BackupAlreadyFixed', 'RoundAlreadyPosted']);
const backupReasons = {
  BackupTooEarly: 'backup too early', BackupTooLate: 'backup too late', HeaderUnavailable: 'backup header unavailable',
  WrongHeader: 'backup wrong header', NoBackup: 'backup not started', BadHeader: 'backup header refused',
};
async function simulate(conn, sender, block, action) {
  try {
    await conn.client.simulateContract({ account: sender, address: action.to, abi: ABI,
      functionName: action.functionName, args: action.args, value: 0n, blockNumber: block.number });
    return 'ready';
  } catch (error) {
    const name = errorName(error);
    if (skips.has(name)) return 'skip';
    if (Object.hasOwn(backupReasons, name)) throw new Failure(backupReasons[name]);
    if (name === 'InvalidSignature') return 'invalid-signature';
    throw new Failure('action simulation failed');
  }
}
export async function prepare(io, conn, cfg, sender, block, action, previous) {
  if (action.conditional) return { action };
  if (action.kind === 'start') {
    const parent = block.number - 1n;
    action.args = [action.args[0], parent, await blockHeader(conn, parent)];
  } else if (action.kind === 'fix') {
    action.args = [action.args[0], await blockHeader(conn, action.targetBlock)];
  }
  let state;
  if (action.kind === 'post') {
    let nextRelay = 0;
    if (previous?.action.args.length === 2) {
      action.args = previous.action.args;
      state = await simulate(conn, sender, block, action);
      if (state === 'skip') return { action, skip: true };
      nextRelay = previous.nextRelay;
    }
    for (let i = nextRelay; state !== 'ready' && i < cfg.relays.length; i++) {
      let signature;
      try {
        const data = await json(io, `${cfg.relays[i]}/${CHAIN_HASH}/public/${action.args[0]}`, {
          headers: { accept: 'application/json', 'User-Agent': 'squarehole-drand-rescue/1' },
        }, { limit: 8192, timeout: 10000 });
        signature = signatureXY(data, action.args[0]);
      } catch { continue; }
      action.args = [action.args[0], signature];
      state = await simulate(conn, sender, block, action);
      if (state === 'skip') return { action, skip: true };
      nextRelay = i + 1;
    }
    if (state !== 'ready') throw new Failure('no valid relay answer');
    previous = { nextRelay };
  } else {
    state = await simulate(conn, sender, block, action);
    if (state === 'skip') return { action, skip: true };
    if (state !== 'ready') throw new Failure('action simulation failed');
  }
  const tip = BigInt(await conn.rpc('eth_maxPriorityFeePerGas'));
  const data = viem.encodeFunctionData({ abi: ABI, functionName: action.functionName, args: action.args });
  // Keyless estimates omit fees so Geth/Anvil do not cap gas by the placeholder's balance.
  // The quote below still uses current fees; signed estimates retain their real fee fields.
  const estimateFees = cfg.keyEnv || cfg.ledger
    ? { maxFeePerGas: hex(2n * block.base + tip), maxPriorityFeePerGas: hex(tip) } : {};
  const estimate = BigInt(await conn.rpc('eth_estimateGas', [{
    from: sender, to: action.to, data, value: '0x0', ...estimateFees,
  }, hex(block.number)]));
  if (estimate <= 0n) throw new Failure('gas estimate unavailable');
  return { action, data, quote: fees(action, block, tip, estimate, cfg), nextRelay: previous?.nextRelay };
}
export async function receipt(conn, hash, action) {
  // One hard deadline, including stalled RPC calls; never resubmit on an ambiguous outcome.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Failure('receipt timed out')), 180000);
  });
  const controller = new AbortController();
  const work = async () => {
    while (!controller.signal.aborted) {
      const r = await conn.rpc('eth_getTransactionReceipt', [hash]);
      if (controller.signal.aborted) break;
      if (r) {
        if (r.status !== '0x1' || !same(r.transactionHash, hash)) throw new Failure('transaction receipt failed');
        const eventName = { post: 'RoundPosted', start: 'BackupStarted', fix: 'BackupFixed' }[action.kind];
        if (eventName) {
          const found = r.logs?.some(log => {
            if (!same(log.address, action.to)) return false;
            try {
              const decoded = viem.decodeEventLog({ abi: ABI, data: log.data, topics: log.topics, strict: true });
              return decoded.eventName === eventName && decoded.args.round === action.args[0];
            } catch { return false; }
          });
          if (!found) throw new Failure(`${eventName} missing from receipt`);
        }
        return r;
      }
      await new Promise(resolve => {
        const stop = () => { clearTimeout(poll); resolve(); };
        const poll = setTimeout(() => { controller.signal.removeEventListener('abort', stop); resolve(); }, 1000);
        controller.signal.addEventListener('abort', stop, { once: true });
      });
    }
  };
  try { return await Promise.race([timeout, work()]); }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function confirmed(io) {
  io.stdout.write('Type exactly yes to send this plan (including conditional accepts): ');
  let line = '';
  for await (const chunk of io.stdin) {
    line += chunk.toString();
    const end = line.indexOf('\n');
    if (end >= 0) return line.slice(0, end).replace(/\r$/, '') === 'yes';
    if (line.length > 16) return false;
  }
  // EOF is never confirmation, even after an unterminated "yes".
  return false;
}
