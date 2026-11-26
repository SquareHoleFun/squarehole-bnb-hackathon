import { address, hex, keccak256, chainId, requireValue } from './verify-sources-common.mjs';
import { inventory } from './verify-sources-inventory.mjs';
import { sourcePlan, defaultBuildOptions } from './verify-sources-build.mjs';
export { inventory } from './verify-sources-inventory.mjs';
export { runExplorer } from './verify-sources-explorer.mjs';

export async function makePlan(manifest, options = {}) {
  const id = chainId(manifest.chainId, options.allowMainnet);
  const data = inventory(manifest, options.supplement);
  const records = data.contracts;
  const byAddress = new Map();
  for (const record of records.filter((r) => r.kind === 'source')) {
    requireValue(record.codeHash, 'supplement must provide missing runtime hashes');
    byAddress.set(record.address, await sourcePlan(record, records, { ...defaultBuildOptions(options), chainId: id }));
  }
  for (const record of records.filter((r) => r.kind !== 'source')) {
    if (record.kind === 'clone') {
      const implementation = address(record.clone.implementation);
      const target = byAddress.get(implementation);
      requireValue(target?.kind === 'source', 'clone implementation needs verified local source binding');
      requireValue(['standard', 'receiving'].includes(record.clone.kind), 'unsupported clone runtime');
      const receiving = record.clone.kind === 'receiving';
      const args = hex(record.clone.arguments);
      const runtime = `0x${receiving ? '36600557005b' : ''}363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d9160${receiving ? '31' : '2b'}57fd5bf3${args.slice(2)}`;
      requireValue(keccak256(runtime) === hex(record.codeHash, 32), 'clone runtime hash mismatch');
      byAddress.set(record.address, { kind: 'clone', address: record.address, codeHash: hex(record.codeHash, 32), runtime,
        implementation, cloneArguments: args, contract: target.contract, sourcePath: target.sourcePath,
        compilerVersion: target.compilerVersion, settings: target.settings, libraries: target.libraries,
        dependencies: [implementation], note: 'Fixed proxy with appended immutable arguments: verify its implementation; request explorer proxy association or a similar match. This is not a separate Solidity deployment.' });
    } else {
      requireValue(record.kind === 'external', 'unknown verification record kind');
      byAddress.set(record.address, { kind: 'external', address: record.address,
        codeHash: record.codeHash ? hex(record.codeHash, 32) : null, dependencies: [],
        note: 'Pre-existing dependency; no local source-verification claim. Supply its source binding to verify it in this run.' });
    }
  }
  const contracts = []; const active = new Set(); const done = new Set();
  function visit(entry) {
    if (done.has(entry.address)) return;
    requireValue(!active.has(entry.address), 'cyclic linked library dependencies'); active.add(entry.address);
    for (const at of entry.dependencies) { requireValue(byAddress.has(at), 'missing source dependency'); visit(byAddress.get(at)); }
    active.delete(entry.address); done.add(entry.address); contracts.push(entry);
  }
  for (const entry of byAddress.values()) visit(entry);
  return { format: 'squarehole.source-verification-plan/1', chainId: id, manifestStatus: manifest.status ?? null,
    notes: data.notes, contracts };
}
