import { describe, expect, it } from 'vitest';
import { encodeFunctionData } from 'viem';
import { abiFor } from '../../src/abi';
import { ViemChain } from '../../src/chain';
import { loadConfig, destinationGasReader } from '../../src/config';
import { feesFor, transactionGas, type PendingGasEstimator } from '../../src/gas';
import { fakeClient, fakeNode } from '../support/fake-rpc';
import { addr, keeper, quiet } from '../support/v2';

const env = { SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
  SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' };
const c = { job: 'receiverPayFit', version: 2, to: addr(80), fn: 'payFit', args: [], key: 'policy-fit' } as const;
const fees = feesFor(1n, 1n);
const block = { gasLimit: 30_000_000n, timestamp: 1n };

describe('KEEPER-WIRE explicit destination policy and paired pending estimation', () => {
  it('requires an explicit fork and cap even on a familiar chain id', () => {
    for (const chainId of ['1', '11155111', '123456']) {
      expect(() => loadConfig({ SH_KEEPER_RPC_URL: env.SH_KEEPER_RPC_URL, SH_KEEPER_CHAIN_ID: chainId })).toThrow(/DESTINATION_FORK|TRANSACTION_GAS_CAP/);
      for (const fork of ['cancun', 'osaka', 'amsterdam']) {
        expect(loadConfig({ ...env, SH_KEEPER_CHAIN_ID: chainId, SH_KEEPER_ALLOW_MAINNET: '1', SH_KEEPER_DESTINATION_FORK: fork }).destinationGas)
          .toEqual({ fork, transactionCap: 16_777_216n });
      }
    }
  });

  it('validates decimal caps and permits an uncapped policy only for explicit Cancun', () => {
    for (const cap of ['', '0', '-1', '1.2', '1e7', '0xffffff', '16777217', 'none']) {
      expect(() => loadConfig({ ...env, SH_KEEPER_TRANSACTION_GAS_CAP: cap })).toThrow(/TRANSACTION_GAS_CAP/);
    }
    expect(() => loadConfig({ ...env, SH_KEEPER_DESTINATION_FORK: 'auto' })).toThrow(/DESTINATION_FORK/);
    expect(loadConfig({ ...env, SH_KEEPER_DESTINATION_FORK: 'cancun', SH_KEEPER_TRANSACTION_GAS_CAP: 'none' }).destinationGas)
      .toEqual({ fork: 'cancun', transactionCap: null });
    expect(() => loadConfig({ ...env, SH_KEEPER_TRANSACTION_GAS_CAP: undefined })).toThrow(/TRANSACTION_GAS_CAP/);
  });

  it('uses the selected rules, refuses missing Amsterdam state gas and never derives it from total gas', async () => {
    const cfg = loadConfig(env);
    expect(await destinationGasReader(cfg.destinationGas)(c, 100_000n, block))
      .toEqual({ fork: 'osaka', transactionCap: 16_777_216n });
    const reader = destinationGasReader({ fork: 'amsterdam', transactionCap: 16_777_216n });
    await expect(reader(c, 100_000n, block)).rejects.toThrow(/state gas/);
  });

  it('retains both components of one estimate for the exact pending calldata, signer and fees', async () => {
    const node = fakeNode();
    node.calls[`${c.to}:payFit`] = () => 1n;
    const cfg = loadConfig({ ...env, SH_KEEPER_DESTINATION_FORK: 'amsterdam' });
    const requests: unknown[] = [];
    const estimator: PendingGasEstimator = async request => {
      requests.push(request);
      return { gas: 24_000_000n, stateGas: 10_000_000n };
    };
    const chain = new ViemChain(cfg, fakeClient(node), keeper, { public: null, private: null }, null, quiet,
      destinationGasReader(cfg.destinationGas), estimator);
    const sim = await chain.simulate(c, fees);
    expect(sim).toEqual({ ok: true, tipWei: null, estimate: 24_000_000n });
    expect(requests).toEqual([{ account: keeper, to: c.to, data: encodeFunctionData({ abi: abiFor(c), functionName: c.fn }),
      blockTag: 'pending', maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }]);
    await expect(chain.gasConstraints({ ...c }, sim.estimate)).rejects.toThrow(/state gas/);
    await expect(chain.gasConstraints(c, sim.estimate + 1n)).rejects.toThrow(/estimate/);
    // A rejected/mismatched estimate cannot be replayed; repeat the simulation for a fresh pair.
    await chain.simulate(c, fees);
    const rules = await chain.gasConstraints(c, sim.estimate);
    expect(rules.stateGas).toBe(10_000_000n);
    expect(transactionGas(c.job, sim.estimate, rules)).toBe(26_777_216n);
    await expect(chain.gasConstraints(c, sim.estimate)).rejects.toThrow(/state gas/);
  });

  it('clears a prior estimate when a later simulation has no useful work', async () => {
    const node = fakeNode();
    node.calls[`${c.to}:payFit`] = () => 1n;
    const cfg = loadConfig({ ...env, SH_KEEPER_DESTINATION_FORK: 'amsterdam' });
    const chain = new ViemChain(cfg, fakeClient(node), keeper, { public: null, private: null }, null, quiet,
      destinationGasReader(cfg.destinationGas), async () => ({ gas: 100_000n, stateGas: 10_000n }));
    await chain.simulate(c, fees);
    node.calls[`${c.to}:payFit`] = () => 0n;
    expect((await chain.simulate(c, fees)).ok).toBe(false);
    await expect(chain.gasConstraints(c, 100_000n)).rejects.toThrow(/state gas/);
  });
});
