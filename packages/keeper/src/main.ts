import { keeperContracts, keeperMulticall } from './tick-reads';
import { keeperTransport } from './rpc';
import { createPublicClient, defineChain, http, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemChain, checkChainId } from './chain';
import { describeConfig, destinationGasAdapters, privateSendsReady, secretsOf, startupWarnings } from './config';
import { loadProcessConfig } from './set';
import { makeLogger } from './log';
import { FeeUnavailableError } from './gas';
import { publishMonitorView } from './monitor';
import { cryptoRng } from './rng';
import { runTick, type KeeperState } from './run';
import { StateStore } from './state';
import { SentBook } from './sent';
import { startAtlasService } from './atlas-service';

/** The keeper's process: one tick per new block, until SIGINT or SIGTERM. Dry run unless SH_KEEPER_DRY_RUN=0. */
async function main() {
  const cfg = loadProcessConfig(process.env,process.argv.slice(2));
  const log = makeLogger(secretsOf(cfg));
  const chain = defineChain({
    id: cfg.chainId, contracts: keeperContracts(cfg.chainId),
    name: `chain ${cfg.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: keeperTransport(cfg, { batch: { batchSize: 32, wait: 8 }, retryCount: 3 }, message => log.warn(message)), batch: keeperMulticall(cfg.chainId) });
  try {
    await checkChainId(pub, cfg.chainId, cfg.allowMainnet);
  } catch (error) {
    // Error messages from the node are untrusted; the logger keeps only the class name.
    log.error('startup check failed', { error });
    process.exitCode = 1;
    return;
  }
  const privatePub = cfg.privateRpcUrl ? createPublicClient({ chain, transport: http(cfg.privateRpcUrl, { retryCount: 1 }) }) : null;
  // No viem nonce manager: the adapter numbers each key's sends itself (review round 1, H2).
  const account = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : null;
  const privateAccount = cfg.privateSendKey ? privateKeyToAccount(cfg.privateSendKey) : null;
  if (account && cfg.keeperAddress && account.address.toLowerCase() !== cfg.keeperAddress.toLowerCase()) {
    throw new Error('SH_KEEPER_ADDRESS does not match signer');
  }
  const keeper: Address = account?.address ?? cfg.keeperAddress ?? '0x000000000000000000000000000000000000dEaD';
  const g = destinationGasAdapters(cfg.destinationGas, pub);
  const port = new ViemChain(cfg, pub, keeper, { public: account, private: privateAccount }, privatePub, log,
    g.reader, g.estimator);
  log.info('keeper starting', { summary: describeConfig(cfg), keeper, privateSender: privateAccount?.address ?? null });
  for (const warning of startupWarnings(cfg)) log.warn(warning);

  // Dry runs use a separate journal. A restart cannot replenish live budgets or forget waiting money.
  const identity = [cfg.chainId, keeper.toLowerCase(), cfg.boxRegistry?.toLowerCase() ?? '', cfg.box0?.coordinator.toLowerCase() ?? ''].join(':');
  const store = new StateStore(cfg.stateFile + (cfg.dryRun ? '.dry' : ''), identity);
  let state: KeeperState;
  try {
    state = store.load();
    // SH-249: live sends save each signed transaction beside the journal before broadcasting it. Dry runs sign nothing.
    if (!cfg.dryRun) port.track(new SentBook(store.loadSent(state), entries => store.saveSent(entries)));
  } catch (error) { store.close(); throw error; }
  // SH-266: Atlas prices for the income rule (chain 97, only with SH_KEEPER_ATLAS=1; the same part as the packaged
  // service's, atlas-service.ts).
  const atlas = startAtlasService({ env: process.env, cfg, log });
  const checkpoint = async (next: KeeperState, now: bigint) => { store.save(next, now); state = next; };
  const monitorFile = cfg.monitorFile ? cfg.monitorFile + (cfg.dryRun ? '.dry' : '') : null;
  let lastBlock = -1n;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!controller.signal.aborted) {
    try {
      const head = await pub.getBlockNumber();
      if (head !== lastBlock) {
        lastBlock = head;
        // SH-266: Atlas prices, read at most every 15 s.
        if (atlas) await atlas.beforeTick();
        const out = await runTick(port, state, {
          ...cfg,
          keeper,
          privateEndpoint: privateSendsReady(cfg),
          rng: cryptoRng,
          checkpoint,
          signal: controller.signal,
        }, log);
        state = out.state;
        // After the tick's durable checkpoint. A failed write leaves the old view to age; the tick itself stands.
        if (monitorFile) {
          try { publishMonitorView(monitorFile, cfg.chainId, identity, out); }
          catch (error) { log.warn('keeper monitor view not published', { error }); }
        }
        if (out.report.sent.length > 0) log.info('tick', { block: out.report.block, sent: out.report.sent.length, skipped: out.report.skipped.length });
      }
    } catch (error) {
      // The World read already logged this fixed warning once; the next block retries without changing state.
      if (!(error instanceof FeeUnavailableError)) log.error('tick failed', { error });
    }
    await new Promise((resolve) => setTimeout(resolve, cfg.pollMs));
  }
  store.close();
  log.info('keeper stopped');
}

main().catch((error: unknown) => {
  makeLogger([]).error('keeper failed', { error });
  process.exitCode = 1;
});
