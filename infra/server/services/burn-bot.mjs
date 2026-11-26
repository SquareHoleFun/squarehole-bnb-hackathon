import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { botArguments } from './runtime.mjs';
import { parseCliArgs } from '../../../packages/burn-bot/src/cli.ts';
import { parseRunnerConfig } from '../../../packages/burn-bot/src/config.ts';
import { Bot } from '../../../packages/burn-bot/src/bot.ts';
import { Journal } from '../../../packages/burn-bot/src/journal.ts';
import { SqliteAppendStore } from '../../../packages/burn-bot/src/store.ts';
import { ViemChainReader } from '../../../packages/burn-bot/src/chain.ts';
import { ViemQuoteSource } from '../../../packages/burn-bot/src/quotes.ts';
import { SafeTransactionService } from '../../../packages/burn-bot/src/service.ts';
import { CommandDigestSigner } from '../../../packages/burn-bot/src/signer.ts';
import { runCycle } from '../../../packages/burn-bot/src/runner.ts';

const { createPublicClient, http } = createRequire(new URL('../../../packages/burn-bot/package.json', import.meta.url))('viem');

export async function createDriver(env, service) {
  const args = parseCliArgs(botArguments(env, service));
  const config = parseRunnerConfig(JSON.parse(readFileSync(args.config, 'utf8')), args.allowMainnet);
  if (config.journal !== '/state/burn-bot.sqlite') throw new Error('persistent journal path required');
  const rpcUrl = env[config.rpcEnv], serviceUrl = env[config.serviceEnv];
  if (!rpcUrl || !serviceUrl) throw new Error('endpoints required');
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 15_000 }) });
  const quotes = new ViemQuoteSource(config.manifest, config.quoters, client, args.allowMainnet);
  const safe = new SafeTransactionService(config.manifest.chainId, serviceUrl, fetch, args.allowMainnet);
  const signer = !args.dryRun ? new CommandDigestSigner(args.signerCommand) : undefined;
  const store = new SqliteAppendStore(`${config.journal}${args.dryRun ? '.dry' : ''}`);
  try {
    const bot = new Bot(config.manifest, new Journal(store));
    return {
      async cycle() {
        // Block evidence belongs to this cycle; durable pending work stays in the Bot journal.
        const reader = new ViemChainReader(config.manifest, { ...client, getBlock: value => value.blockNumber !== undefined
          ? client.getBlock({ blockNumber: value.blockNumber }) : client.getBlock({ blockTag: value.blockTag }) }, config, args.allowMainnet);
        // Signed proposal/journal contents stay in the durable store, never container stdout.
        await runCycle({ bot, reader, quotes, service: safe, signer, dryRun: args.dryRun, allowMainnet: args.allowMainnet, cancel: [] });
        return true;
      },
      close() { store.close(); },
    };
  } catch (error) { store.close(); throw error; }
}
