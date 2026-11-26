import { privateKeyToAccount } from './deps.mjs';
import { address } from './options.mjs';
import { Failure, hex } from './chain.mjs';

async function cast(io, cfg, argv) {
  const args = [...argv.slice(0, argv[0] === 'wallet' ? 2 : 1), '--ledger',
    ...(cfg.hdPath ? ['--hd-path', cfg.hdPath] : []), ...argv.slice(argv[0] === 'wallet' ? 2 : 1)];
  const run = binary => new Promise((resolve, reject) => {
    const child = io.spawn(binary, args, {
      env: { PATH: io.env.PATH, HOME: io.env.HOME, TERM: io.env.TERM, ETH_RPC_URL: cfg.rpc },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let text = '', size = 0;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Failure('cast timed out')); }, 180000);
    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) { child.kill('SIGTERM'); finish(new Failure('cast output refused')); }
      else text += chunk;
    });
    // Provider and device errors may include secrets. Never forward child output.
    child.stderr.on('data', () => {});
    child.once('error', error => finish(error));
    child.once('close', code => finish(code === 0 ? null : new Failure('cast failed'), text.trim()));
  });
  try { return await run(cfg.cast ?? 'cast'); }
  catch (error) {
    if (!cfg.cast && error.code === 'ENOENT' && io.env.HOME) {
      try { return await run(`${io.env.HOME}/.foundry/bin/cast`); } catch { /* fixed reason below */ }
    }
    throw new Failure('cast unavailable or failed');
  }
}
export async function signer(io, cfg) {
  if (cfg.keyEnv) {
    const key = io.env[cfg.keyEnv];
    if (!/^0x[\da-f]{64}$/i.test(key ?? '')) throw new Failure('signer unavailable');
    try {
      const account = privateKeyToAccount(key);
      return { address: account.address, async send(conn, chainId, action, quote, data) {
        // The mined count: a run replaces its own transaction left pending by an earlier run (a receipt timeout after
        // the base fee rose) at this run's fresh fee, instead of queueing a copy behind it that would later revert.
        const nonce = BigInt(await conn.rpc('eth_getTransactionCount', [account.address, 'latest']));
        // Chain identifiers and nonces are viem's integer API; amounts and times stay bigint.
        if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Failure('nonce unavailable');
        const raw = await account.signTransaction({
          type: 'eip1559', chainId: Number(chainId), nonce: Number(nonce), to: action.to, data, value: 0n,
          gas: quote.gas, maxFeePerGas: quote.maxFee, maxPriorityFeePerGas: quote.tip,
        });
        return conn.rpc('eth_sendRawTransaction', [raw]);
      } };
    } catch { throw new Failure('signer unavailable'); }
  }
  if (cfg.ledger) {
    const sender = await cast(io, cfg, ['wallet', 'address']);
    if (!address(sender)) throw new Failure('Ledger address unavailable');
    return { address: sender, async send(_conn, _chainId, action, quote) {
      const result = await cast(io, cfg, ['send', '--gas-limit', String(quote.gas), '--gas-price', String(quote.maxFee),
        '--priority-gas-price', String(quote.tip), '--json', action.to, action.signature, ...action.args.map(String)]);
      try {
        const hash = JSON.parse(result).transactionHash;
        if (!/^0x[\da-f]{64}$/i.test(hash)) throw new Error();
        return hash;
      } catch { throw new Failure('cast receipt unavailable'); }
    } };
  }
  return null;
}
export async function affordable(conn, sender, block, quote, spent, cfg) {
  if (spent + quote.cost > cfg.maxRun) throw new Failure('run spending limit reached');
  const balance = BigInt(await conn.rpc('eth_getBalance', [sender, hex(block.number)]));
  if (quote.cost > balance) throw new Failure('account balance limit reached');
}
