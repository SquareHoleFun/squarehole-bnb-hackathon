import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createChain, privateKeyToAccount, tokenAbi } from '../services/agents/chain.mjs';
import { createAgents } from '../services/agents/engine.mjs';
import { config, prompts, expense, pay, response, scratch, address } from './fixtures/agents/helpers.mjs';
const { createPublicClient, createWalletClient, defineChain, http, toHex } = createRequire(new URL('../../../packages/keeper/package.json', import.meta.url))('viem');

describe('agents stand-in Allowance Module on Anvil (no external RPC)', () => {
  let child, pub, wallet, rpcUrl, c, chain, snapshot, artifacts;
  const owner = privateKeyToAccount('0x' + '8'.padStart(64, '0'));
  const manager = privateKeyToAccount('0x' + '9'.padStart(64, '0'));
  beforeAll(async () => {
    mkdirSync('.cache/tmp', { recursive: true });
    execFileSync('forge', ['build', '--offline', '--root', '.', '--contracts', 'infra/server/test/fixtures/agents',
      '--out', '.cache/agents-contracts/out', '--cache-path', '.cache/agents-contracts/cache', '--use', '0.8.26'],
    { encoding: 'utf8', timeout: 60000, stdio: 'pipe' });
    artifacts = Object.fromEntries(['MockToken', 'MockSafe', 'MockAllowance'].map(name => [name,
      JSON.parse(readFileSync(`.cache/agents-contracts/out/AllowanceFixture.sol/${name}.json`, 'utf8'))]));
    child = spawn('anvil', ['--host', '127.0.0.1', '--port', '0', '--accounts', '0', '--chain-id', '11155111', '--hardfork', 'cancun'],
      { cwd: resolve('.cache/tmp'), stdio: ['ignore', 'pipe', 'pipe'] });
    rpcUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Anvil listener timeout')), 15000); let out = '';
      child.stdout.on('data', chunk => { out += chunk; const m = out.match(/Listening on 127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); } });
      child.stderr.on('data', () => {});
      child.once('error', () => { clearTimeout(timer); reject(new Error('Anvil unavailable')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Anvil exited before listening; sandbox may refuse listeners')); });
    });
    pub = createPublicClient({ transport: http(rpcUrl), cacheTime: 0, pollingInterval: 100 });
    wallet = createWalletClient({ account: owner, transport: http(rpcUrl), chain: defineChain({ id: 11155111, name: 'fixture',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }) });
    for (const account of [owner, manager]) await pub.request({ method: 'anvil_setBalance', params: [account.address, toHex(100n * 10n ** 18n)] });
    const deploy = async (name, args = []) => {
      const a = artifacts[name], hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
    };
    c = config(); c.manager.address = manager.address;
    c.token = await deploy('MockToken'); c.module = await deploy('MockAllowance'); c.safe = await deploy('MockSafe', [c.module]);
    await write('MockToken', c.token, 'mint', [c.safe, 1000000000n]);
    await write('MockAllowance', c.module, 'setAllowance', [c.safe, manager.address, c.token, 300000000n]);
    snapshot = await pub.request({ method: 'evm_snapshot' });
  }, shLimit(120000));
  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  }, shLimit(30000));
  beforeEach(async () => {
    await pub.request({ method: 'evm_revert', params: [snapshot] }); snapshot = await pub.request({ method: 'evm_snapshot' });
    chain = createChain({ config: c, rpcUrl, signer: () => manager, confirmations: 1n });
  }, shLimit(30000));
  const write = async (name, target, functionName, args) => pub.waitForTransactionReceipt({ hash:
    await wallet.writeContract({ address: target, abi: artifacts[name].abi, functionName, args }) });
  const balance = who => pub.readContract({ address: c.token, abi: artifacts.MockToken.abi, functionName: 'balanceOf', args: [who] });
  it('transfers only through the module; restart after lost response cannot double pay', async () => {
    const disk = scratch(), model = vi.fn(async () => response(pay)), realBroadcast = chain.broadcast;
    chain.broadcast = async tx => {
      expect(disk.journal().sends[0].hash).toBe(tx.hash);
      await realBroadcast(tx); throw new Error('lost response');
    };
    let agent = await createAgents({ ...disk, config: c, prompts, mode: 'live', chain, model, jobs: () => [expense()] });
    await agent.cycle(); agent.close();
    await pub.waitForTransactionReceipt({ hash: disk.journal().sends[0].hash });
    agent = await createAgents({ ...disk, config: c, prompts, mode: 'live', chain, model, jobs: () => [expense()] });
    try {
      await agent.cycle(); await agent.cycle(); expect(await balance(c.manager.payees.cleaner)).toBe(100000000n);
      expect(await chain.remaining()).toBe(200000000n); expect(model).toHaveBeenCalledOnce();
      expect(disk.journal().sends[0].status).toBe('confirmed');
    } finally { agent.close(); }
  }, shLimit(120000));
  it('dry-run leaves chain balances and nonces unchanged', async () => {
    const disk = scratch(), before = await pub.getTransactionCount({ address: manager.address });
    const agent = await createAgents({ ...disk, config: c, prompts, mode: 'dry-run', chain, model: async () => response(pay), jobs: () => [expense()] });
    try {
      await agent.cycle(); expect(await balance(c.manager.payees.cleaner)).toBe(0n);
      expect(await pub.getTransactionCount({ address: manager.address })).toBe(before);
    } finally { agent.close(); }
  }, shLimit(120000));
  it('enforces the weekly cap on-chain and refuses low allowance before signing', async () => {
    const tx = await chain.prepare({ ...pay, amountRaw: '300000000' });
    await pub.waitForTransactionReceipt({ hash: await chain.broadcast(tx) });
    expect(await chain.remaining()).toBe(0n);
    await expect(chain.prepare({ ...pay, amountRaw: '1' })).rejects.toThrow('allowance');
    const managerWallet = createWalletClient({ account: manager, chain: wallet.chain, transport: http(rpcUrl) });
    await expect(pub.simulateContract({ address: c.module, abi: artifacts.MockAllowance.abi, functionName: 'executeAllowanceTransfer', account: manager,
      args: [c.safe, c.token, address(6), 1n, address(0), 0n, manager.address, '0x'] })).rejects.toThrow();
    await expect(pub.simulateContract({ address: c.token, abi: tokenAbi, functionName: 'transfer', account: managerWallet.account, args: [address(6), 1n] })).rejects.toThrow();
    await pub.request({ method: 'evm_increaseTime', params: [604800] }); await pub.request({ method: 'evm_mine' });
    expect(await chain.remaining()).toBe(300000000n);
  }, shLimit(120000));
});
