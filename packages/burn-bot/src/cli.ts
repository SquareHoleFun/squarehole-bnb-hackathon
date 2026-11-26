import { readFileSync } from 'node:fs';
import { createPublicClient, http, type Hex } from 'viem';
import { describeCalls } from './builders';
import { Bot } from './bot';
import { ViemChainReader } from './chain';
import { parseRunnerConfig } from './config';
import { Journal, toWire } from './journal';
import { ViemQuoteSource } from './quotes';
import { runCycle } from './runner';
import { hash, requireThat } from './schema';
import { SafeTransactionService } from './service';
import { CommandDigestSigner } from './signer';
import { SqliteAppendStore } from './store';

export function parseCliArgs(argv: string[]) {
  let config: string | undefined, signerCommand: string | undefined, mode: string | undefined, allowMainnet = false;
  const cancel: Hex[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--propose') { requireThat(!mode, 'choose one mode'); mode = arg; }
    else if (arg === '--allow-mainnet') allowMainnet = true;
    else if (arg === '--config' || arg === '--signer-command' || arg === '--cancel') {
      const value = argv[++i]; requireThat(value && !value.startsWith('--'), 'flag value required');
      if (arg === '--config') { requireThat(!config, 'duplicate config'); config = value; }
      else if (arg === '--signer-command') { requireThat(!signerCommand, 'duplicate signer'); signerCommand = value; }
      else cancel.push(hash.parse(value));
    } else throw new Error('unknown runner flag');
  }
  requireThat(config, '--config required');
  requireThat(mode !== '--propose' || signerCommand, '--propose requires --signer-command');
  return { config, signerCommand, cancel, dryRun: mode !== '--propose', allowMainnet };
}
export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = parseCliArgs(argv);
  const config = parseRunnerConfig(JSON.parse(readFileSync(args.config, 'utf8')), args.allowMainnet);
  const rpcUrl = environment[config.rpcEnv], serviceUrl = environment[config.serviceEnv];
  requireThat(rpcUrl && serviceUrl, 'configured endpoint environment variables required');
  requireThat(!config.journal.endsWith('.dry'), 'configure the base journal path; dry suffix is automatic');
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
  const reader = new ViemChainReader(config.manifest, { ...client, getBlock: args => args.blockNumber !== undefined
    ? client.getBlock({ blockNumber: args.blockNumber }) : client.getBlock({ blockTag: args.blockTag }) }, config, args.allowMainnet);
  const quotes = new ViemQuoteSource(config.manifest, config.quoters, client, args.allowMainnet);
  const service = new SafeTransactionService(config.manifest.chainId, serviceUrl, fetch, args.allowMainnet);
  const signer = !args.dryRun && args.signerCommand ? new CommandDigestSigner(args.signerCommand) : undefined;
  const store = new SqliteAppendStore(`${config.journal}${args.dryRun ? '.dry' : ''}`);
  try {
    const journal = new Journal(store), bot = new Bot(config.manifest, journal);
    const result = await runCycle({ bot, reader, quotes, service, signer, dryRun: args.dryRun, allowMainnet: args.allowMainnet, cancel: args.cancel });
    process.stdout.write(`${JSON.stringify(toWire({ ...result, proposals: result.proposals.map(p => ({ ...p, decodedCalls: describeCalls(p.draft.calls, config.manifest.routes) })), journalHead: journal.head }), null, 2)}\n`);
  } finally { store.close(); }
}
