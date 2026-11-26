import { describe, expect, it, vi } from 'vitest';

// Local JS operations stay outside the production TypeScript entry surface.
const localSet = await import(new URL('./set-v2-local.mjs', import.meta.url).href);
const { localForge } = await import(new URL('../local-core-v2-chain.mjs', import.meta.url).href);

vi.mock('./core-v2-local-runtime.mjs', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  assertLocalRpc: vi.fn(),
  rpc: vi.fn().mockResolvedValue('0x32'),
  json: JSON.stringify,
}));

const chain = {
  rpcUrl: 'http://127.0.0.1:8566',
  genesisFactory: '0x1111111111111111111111111111111111111111',
  fit: '0x2222222222222222222222222222222222222222',
  accounts: { deployer: '0x3333333333333333333333333333333333333333' },
};
const script = 'script/local/SetReleaseLocal.s.sol:SetReleaseLocal';
const checksLibrary = '0x4444444444444444444444444444444444444444';
const libraries = [`src/box-v2/libraries/FactoryChecksCurve.sol:FactoryChecksCurve:${checksLibrary}`];

describe('AF2 local set release broadcast boundary', () => {
  it('awaits mined parts before a fresh factory run and passes only the address handoff', async () => {
    let mined: ((output: string) => void) | undefined;
    const partsReceipt = new Promise<string>(resolve => { mined = resolve; });
    const forge = vi.fn().mockReturnValueOnce(partsReceipt).mockRejectedValueOnce(new Error('factory sentinel'));
    const pending = localSet.deployLocalSet(chain, forge, {});
    const failed = expect(pending).rejects.toThrow('factory sentinel');
    await vi.waitFor(() => expect(forge).toHaveBeenCalledTimes(1));
    // The handoff contains ABI-encoded addresses, never simulated runtime hashes.
    const parts = `0x${'00'.repeat(960)}`;
    if (!mined) throw new Error('missing receipt resolver');
    mined(`LOCALSET|parts|${parts}\nLOCALSET|checksLibrary|${checksLibrary}`);
    await failed;
    expect(forge.mock.calls[0]).toEqual([chain, script, 'runParts(address,address)',
      [chain.genesisFactory, chain.fit], chain.accounts.deployer, 'set-release-parts']);
    expect(forge.mock.calls[1]).toEqual([chain, script, 'runLocal(address,address,bytes)',
      [chain.genesisFactory, chain.fit, parts], chain.accounts.deployer, 'set-release', undefined, libraries]);
  });

  it('does not attempt the factory when the parts broadcast fails', async () => {
    const forge = vi.fn().mockRejectedValue(new Error('parts failed'));
    await expect(localSet.deployLocalSet(chain, forge, {})).rejects.toThrow('parts failed');
    expect(forge).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing address handoff before attempting the factory', async () => {
    const forge = vi.fn().mockResolvedValue('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL');
    await expect(localSet.deployLocalSet(chain, forge, {})).rejects.toThrow('local set parts did not return their addresses');
    expect(forge).toHaveBeenCalledTimes(1);
  });

  it('pins the factory constructor to the library used by the already mined checks', async () => {
    const run = vi.fn().mockResolvedValue('ONCHAIN EXECUTION COMPLETE & SUCCESSFUL');
    await localForge(chain, script, 'runLocal(address,address,bytes)', [], chain.accounts.deployer, 'set-release', {
      assertLocalRpc: vi.fn(), run,
      runLocalStep: async (_chain: unknown, _name: string, operation: () => Promise<string>) => operation(),
    }, libraries);
    expect(run.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--libraries', libraries[0], '--broadcast', '--slow', '--isolate']));
  });
});
