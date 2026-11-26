/**
 * SH-SEP-MANIFEST: the Sepolia writer of the manifest's v2 `releases`, on the fork simulation's public release plan
 * (test-support/sepolia-release-fixture.ts). The output must load through `parseCoreManifestV2` (the indexer's and
 * the CoW poster's own loaders are exercised in their packages), and every identity must agree across the plan,
 * the broadcast run, VerifyCoreV2's output, the founder's registry address and box 0's v1 manifest.
 */
import { describe, expect, it } from 'vitest';
import { parseCoreManifestV2, releaseOfRegistry } from './manifest-v2';
import { DRAND_SOURCE, RANDOMNESS_SOURCE, RANDOMNESS_SOURCE_CODE_HASH, BUILD_PROFILE_REHEARSAL } from '@squarehole/box-spec';
import { buildSepoliaRelease, RELEASE_RAISE_WEI, returnedManifest, SepoliaReleaseError, verifiedRelease, type SepoliaReleaseInputs } from './sepolia-release';
import { EVIDENCE_OFFSET, FORK_DEPLOYER, RUN_START_OFFSET, SHOP_BURNER, forkPlan, forkRun, forkV1Manifest, forkVerifyOutput, type Json } from './test-support/sepolia-release-fixture';

const inputs = (o: Partial<SepoliaReleaseInputs> = {}): SepoliaReleaseInputs => {
  const plan = forkPlan();
  return { v1Manifest: forkV1Manifest(plan), plan, run: forkRun(plan), verifyOutput: forkVerifyOutput(plan), registry: plan.registry, ...o };
};
const refusal = (o: Partial<SepoliaReleaseInputs>): string => {
  try {
    buildSepoliaRelease(inputs(o));
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  return 'accepted';
};
const withRun = (edit: (run: Json) => void): Partial<SepoliaReleaseInputs> => {
  const run = forkRun();
  edit(run);
  return { run };
};
const withPlan = (edit: (plan: Json) => void): Partial<SepoliaReleaseInputs> => {
  const plan = forkPlan();
  edit(plan);
  return { plan };
};

describe('SH-SEP-MANIFEST Sepolia v2 releases writer', () => {
  it('writes the v1 envelope unchanged plus one release built from the fork plan', () => {
    const plan = forkPlan();
    const v1 = forkV1Manifest(plan);
    const { json, manifest, report } = buildSepoliaRelease(inputs({ v1Manifest: v1 }));
    const { releases, ...envelope } = json;
    expect(envelope).toEqual(v1);
    expect(releases).toHaveLength(1);
    const release = manifest.releases[0];
    expect(release?.factory.address.toLowerCase()).toBe(plan.factory.toLowerCase());
    expect(release?.registry.address.toLowerCase()).toBe(plan.registry.toLowerCase());
    expect(release?.listingRegistry.address.toLowerCase()).toBe(plan.listingRegistry.toLowerCase());
    expect(release?.versionCodeHash).toBe(plan.versionCodeHash);
    expect(release?.startBlock).toBe(String(BigInt(plan.observedBlock) + RUN_START_OFFSET));
    expect(Object.keys(release?.implementations ?? {}).sort()).toEqual(['coordinator', 'token', 'hook', 'hookExtension', 'vault', 'collection', 'receiver', 'launchRouter', 'tickets', 'royaltyRouter', 'itemLedger', 'holderLedger', 'starterSetLoader', 'tokenLedger', 'shopVault', 'pileVault'].sort());
    // Slot addresses and hashes are the plan's own (slot 16 item ledger, slot 22 pile vault).
    expect(release?.implementations.itemLedger?.address.toLowerCase()).toBe(plan.implementations[16].toLowerCase());
    expect(release?.implementations.pileVault?.codeHash).toBe(plan.implementationCodeHashes[22]);
    expect(release?.implementations.hookExtension.address.toLowerCase()).toBe(plan.parts[plan.partNames.indexOf('BoxHookV2Extension')].toLowerCase());
    expect(release?.safes.platform.owners).toEqual([FORK_DEPLOYER.toLowerCase()]);
    expect(release?.safes.fit.threshold).toBe('2');
    expect(release?.safes.fit.controlTransferProof).toBe('pending');
    expect(report).toMatchObject({ transactions: 38, deployer: FORK_DEPLOYER, extraCreated: [SHOP_BURNER], replaced: false });
    expect(report.lastBlock - report.startBlock).toBe(37n);
    expect(releaseOfRegistry(manifest, plan.registry)).toBe(release);
  });

  it('the written text parses back to the same manifest (the services load it in packages/indexer and packages/cow-poster tests)', () => {
    const { json } = buildSepoliaRelease(inputs());
    expect(parseCoreManifestV2(JSON.parse(`${JSON.stringify(json, null, 2)}\n`))).toEqual(parseCoreManifestV2(json));
  });

  it('records the founder\'s control-transfer transactions when given, and refuses a malformed hash', () => {
    const tx = (label: string) => `0x${label.repeat(64).slice(0, 64)}` as `0x${string}`;
    const { manifest } = buildSepoliaRelease(inputs({ controlProofs: { fit: { inTx: tx('a'), outTx: tx('b') } } }));
    expect(manifest.releases[0]?.safes.fit.controlTransferProof).toBe(`sepolia 1000000000000 wei: in ${tx('a')}, out ${tx('b')}`);
    expect(manifest.releases[0]?.safes.platform.controlTransferProof).toBe('pending');
    expect(refusal({ controlProofs: { platform: { inTx: '0x12', outTx: tx('b') } } })).toMatch(/not a transaction hash/);
  });

  it('keeps another release, refuses a second copy of this one unless replace is given', () => {
    const first = buildSepoliaRelease(inputs()).json;
    const other = { ...(first.releases as Json[])[0], registry: { address: '0x1111111111111111111111111111111111111111', codeHash: `0x${'1'.repeat(64)}` } };
    expect(refusal({ v1Manifest: first })).toMatch(/already lists a release/);
    const again = buildSepoliaRelease(inputs({ v1Manifest: first, replace: true }));
    expect(again.report.replaced).toBe(true);
    expect(again.manifest.releases).toHaveLength(1);
    const both = buildSepoliaRelease(inputs({ v1Manifest: { ...first, releases: [other] } }));
    expect(both.manifest.releases.map((r) => r.registry.address.toLowerCase())).toEqual(['0x1111111111111111111111111111111111111111', forkPlan().registry.toLowerCase()]);
  });

  it('refuses a v1 manifest that is not box 0 on Sepolia, or whose evidence block is before the last v2 receipt', () => {
    expect(refusal({ v1Manifest: { schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11155111, network: 'sepolia' } })).toMatch(/not deployed/);
    expect(refusal({ v1Manifest: { ...forkV1Manifest(), chainId: 31337, network: 'local' } })).toMatch(/not Sepolia/);
    const plan = forkPlan();
    const first = BigInt(plan.observedBlock) + RUN_START_OFFSET;
    const last = first + 37n;
    expect(refusal({ v1Manifest: forkV1Manifest(plan, first - 1n) })).toMatch(/rewrite it with write-core-manifest/);
    // Between the first and the last receipt the factory (the last transaction) does not exist yet at the evidence
    // block the services read, although the parser's own startBlock check would pass.
    expect(refusal({ v1Manifest: forkV1Manifest(plan, first) })).toMatch(new RegExp(`before the last v2 receipt \\(block ${last}\\)`));
    expect(refusal({ v1Manifest: forkV1Manifest(plan, last - 1n) })).toMatch(/before the last v2 receipt/);
    expect(refusal({ v1Manifest: forkV1Manifest(plan, last) })).toBe('accepted');
    expect(EVIDENCE_OFFSET).toBeGreaterThan(RUN_START_OFFSET + 37n);
  });

  it('refuses a plan whose box 0, chain contracts or platform Safe differ from the v1 manifest', () => {
    const v1 = forkV1Manifest();
    expect(refusal({ v1Manifest: { ...v1, versions: [{ ...v1.versions[0], registry: { ...v1.versions[0].registry, address: '0x2222222222222222222222222222222222222222' } }] } })).toMatch(/box 0's registry/);
    for (const key of ['poolManager', 'weth', 'randomness']) {
      expect(refusal({ v1Manifest: { ...v1, chain: { ...v1.chain, [key]: { ...v1.chain[key], address: '0x3333333333333333333333333333333333333333' } } } })).toMatch(new RegExp(key));
    }
    expect(refusal({ v1Manifest: { ...v1, chain: { ...v1.chain, platformSafe: { ...v1.chain.platformSafe, address: '0x4444444444444444444444444444444444444444' } } } })).toMatch(/platform Safe/);
  });

  it('refuses a registry the founder reports that is not the plan\'s', () => {
    expect(refusal({ registry: '0x5555555555555555555555555555555555555555' })).toMatch(/registry/);
    expect(refusal({ registry: 'box registry' })).toMatch(/registry/);
  });

  it('refuses an inconsistent plan: format, chain, slot map, unused slots, duplicate parts', () => {
    expect(refusal(withPlan((p) => { p.format = 'squarehole.core-v2-release/1'; }))).toMatch(/format/);
    expect(refusal(withPlan((p) => { p.chainId = '1'; }))).toMatch(/chainId/);
    expect(refusal(withPlan((p) => { p.implementations[16] = p.implementations[17]; }))).toMatch(/slot 16/);
    expect(refusal(withPlan((p) => { p.implementationCodeHashes[22] = `0x${'9'.repeat(64)}`; }))).toMatch(/slot 22/);
    expect(refusal(withPlan((p) => { p.implementations[18] = p.implementations[0]; }))).toMatch(/unused implementation slot 18/);
    expect(refusal(withPlan((p) => { p.partNames[1] = p.partNames[0]; }))).toMatch(/listed twice/);
    expect(refusal(withPlan((p) => { p.royaltyCowHandlerCodeHash = `0x${'8'.repeat(64)}`; }))).toMatch(/royaltyCowHandler/);
    expect(refusal(withPlan((p) => { p.checks = p.planner; }))).toMatch(/checks/);
  });

  it('refuses a release built with the 1/10 rehearsal raise, and a plan without the native listing snapshot', () => {
    expect(forkPlan().listings['0'].raise).toBe(RELEASE_RAISE_WEI.toString());
    const rehearsal = BUILD_PROFILE_REHEARSAL.values.RAISE.toString();
    // The same raise in the plan and in the run: both were simulated and sent with a leftover FOUNDRY_PROFILE=rehearsal.
    const plan = forkPlan();
    plan.listings['0'].raise = rehearsal;
    expect(refusal({ plan, run: forkRun(plan), verifyOutput: forkVerifyOutput(plan) })).toMatch(/FOUNDRY_PROFILE=rehearsal/);
    expect(refusal(withPlan((p) => { delete p.listings; }))).toMatch(/plan: listings/);
    expect(refusal(withPlan((p) => { p.listings['0'].token = p.weth; }))).toMatch(/plan: listings/);
  });

  it('refuses a broadcast run that is incomplete, failed, from two senders or not the reviewed plan', () => {
    expect(refusal(withRun((r) => { r.receipts.pop(); }))).toMatch(/38 transactions but 37 receipts/);
    expect(refusal(withRun((r) => { r.receipts[5].status = '0x0'; }))).toMatch(/status 0x0/);
    expect(refusal(withRun((r) => { r.pending = [{}]; }))).toMatch(/pending/);
    expect(refusal(withRun((r) => { r.transactions[3].transaction.from = '0x6666666666666666666666666666666666666666'; }))).toMatch(/more than one sender/);
    expect(refusal(withRun((r) => { r.chain = 1; }))).toMatch(/chain/);
    expect(refusal(withRun((r) => { r.transactions[0].additionalContracts = []; r.transactions = r.transactions.filter((t: Json) => t.contractName !== 'BoxVaultV2'); r.receipts = r.receipts.filter((x: Json) => r.transactions.some((t: Json) => t.hash === x.transactionHash)); }))).toMatch(/did not create BoxVaultV2, VaultViews/);
    expect(refusal(withRun((r) => { delete r.returns.manifest; }))).toMatch(/returns/);
    expect(refusal(withRun((r) => { r.returns.manifest.value = '{'; }))).toMatch(/not JSON/);
    expect(refusal(withRun((r) => { r.returns.manifest.value = '[1]'; }))).toMatch(/not JSON/);
    // A plain (unescaped) JSON string is read too.
    expect(refusal(withRun((r) => { r.returns.manifest.value = JSON.stringify(returnedManifest(r.returns.manifest.value)); }))).toBe('accepted');
    expect(forkRun().returns.manifest.value.startsWith('{\\"')).toBe(true);
    expect(refusal(withRun((r) => { const m = returnedManifest(r.returns.manifest.value) as Json; m.factory = m.planner; r.returns.manifest.value = JSON.stringify(m); }))).toMatch(/differs from the reviewed plan in factory/);
    expect(refusal(withRun((r) => { const m = returnedManifest(r.returns.manifest.value) as Json; m.safes.fit.owners.reverse(); r.returns.manifest.value = JSON.stringify(m); }))).toMatch(/in safes/);
    // Every field but the simulation's status and block must match, not only the contract identities.
    for (const [field, edit] of [
      ['listings', (m: Json) => { m.listings['0'].raise = '1'; }],
      ['composableCow', (m: Json) => { m.composableCow = m.weth; }],
      ['cowSettlement', (m: Json) => { m.cowSettlement = m.weth; }],
      ['royaltyMinimumLot', (m: Json) => { m.royaltyMinimumLot = '1'; }],
      ['remainingProofs', (m: Json) => { delete m.remainingProofs; }],
    ] as const) {
      expect(refusal(withRun((r) => { const m = returnedManifest(r.returns.manifest.value) as Json; edit(m); r.returns.manifest.value = JSON.stringify(m); }))).toMatch(new RegExp(`in ${field} `));
    }
    expect(refusal(withRun((r) => { const m = returnedManifest(r.returns.manifest.value) as Json; m.observedBlock = '1'; m.status = 'x'; r.returns.manifest.value = JSON.stringify(m); }))).toBe('accepted');
    expect(refusal(withRun((r) => { for (const x of r.receipts) x.blockNumber = '0x1'; }))).toMatch(/not after the plan's observed block/);
  });

  it('refuses VerifyCoreV2 output that failed, verified another factory or lacks its event', () => {
    const plan = forkPlan();
    expect(refusal({ verifyOutput: forkVerifyOutput(plan, { success: false }) })).toMatch(/did not succeed/);
    expect(refusal({ verifyOutput: forkVerifyOutput(plan, { factory: plan.planner }) })).toMatch(/verified factory/);
    expect(refusal({ verifyOutput: forkVerifyOutput(plan, { parts: 41n }) })).toMatch(/41 parts/);
    expect(refusal({ verifyOutput: 'Script ran successfully.' })).toMatch(/found 0/);
    expect(refusal({ verifyOutput: `${forkVerifyOutput(plan)}\n${forkVerifyOutput(plan)}` })).toMatch(/found 2/);
    const noEvent = JSON.stringify({ success: true, raw_logs: [] });
    expect(refusal({ verifyOutput: noEvent })).toMatch(/ReleaseCodeVerified/);
    expect(verifiedRelease(forkVerifyOutput(plan)).versionCodeHash).toBe(plan.versionCodeHash);
  });

  it('every refusal is a SepoliaReleaseError or the shared parser\'s ChainConfigError, never a silent write', () => {
    try {
      buildSepoliaRelease(inputs({ registry: '0x5555555555555555555555555555555555555555' }));
    } catch (error) {
      expect(error).toBeInstanceOf(SepoliaReleaseError);
    }
  });
});


it('F143: a Sepolia v2 plan uses DrandSource behind the v1 manifest; another address is refused', () => {
  const plan = forkPlan();
  plan.randomness = DRAND_SOURCE;
  const old = forkV1Manifest(plan);
  const v1 = { ...old, chain: { ...old.chain, randomness: { address: RANDOMNESS_SOURCE, codeHash: RANDOMNESS_SOURCE_CODE_HASH } } };
  expect(buildSepoliaRelease(inputs({ plan, run: forkRun(plan), verifyOutput: forkVerifyOutput(plan), v1Manifest: v1 })).json.chain).toEqual(v1.chain);
  for (const address of [RANDOMNESS_SOURCE, '0x2222222222222222222222222222222222222222']) {
    const wrong = { ...plan, randomness: address };
    expect(refusal({ plan: wrong, run: forkRun(wrong), verifyOutput: forkVerifyOutput(wrong), v1Manifest: v1 })).toMatch(/plan: randomness .* differs/);
  }
});
