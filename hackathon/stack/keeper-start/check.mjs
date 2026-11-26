// SH-259 rule E: the keeper's own start check on the BNB Chain testnet stack, preloaded by compose.yaml (`node --import`)
// before infra/server/services/run.mjs, at EVERY start (a restart, `compose up keeper`, a ship, a rollback). It refuses
// (exit 78, nothing else runs) unless:
//   - the release's manifest (/check/97.json) has the digest the settings folder approves (/check/approved-97.sha256,
//     <etc>/approved-97.sha256, outside every release);
//   - the keeper's effective chain, registry and start block are the manifest's;
//   - its fee floor and ceiling are those of hackathon/stack/keeper-fees-97.json (/check/keeper-fees-97.json), whose
//     digest the same approved list names (the keeper signs at each tick's eth_gasPrice plus a quarter between them);
//   - its Atlas switch (SH_KEEPER_ATLAS): 0 while the settings folder approves no Atlas file (/check/approved-atlas.sha256
//     empty), else 1 and the release's 97-atlas.json has the approved digest.
// Fixed messages only; no setting's value is printed.
import { createHash } from 'node:crypto';

const FEES = 'hackathon/stack/keeper-fees-97.json';
const MANIFEST = 'packages/contracts/deployments/core-v1/97.json';

const pinnedOf = (approvedText, path) => approvedText.split('\n').map(l => l.match(/^([0-9a-f]{64}) {2}(.+)$/)).filter(Boolean)
  .filter(m => m[2] === path).map(m => m[1]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function startCheck(env, manifestBytes, approvedText, feesBytes) {
  const pinned = pinnedOf(approvedText, MANIFEST);
  if (pinned.length !== 1) return 'the approved digests do not name the manifest once';
  if (digest(manifestBytes) !== pinned[0]) return 'the manifest is not the approved one';
  const feesPinned = pinnedOf(approvedText, FEES);
  if (feesPinned.length !== 1) return 'the approved digests do not name the fee file once';
  if (!feesBytes || digest(feesBytes) !== feesPinned[0]) return 'the fee file is not the approved one';
  let fees;
  try { fees = JSON.parse(feesBytes.toString('utf8')); } catch { return 'the fee file is not JSON'; }
  if (fees?.chainId !== 97 || !/^[1-9][0-9]{0,29}$/.test(String(fees.floorWei)) || !/^[1-9][0-9]{0,29}$/.test(String(fees.ceilingWei))) {
    return 'the fee file is malformed';
  }
  let m;
  try { m = JSON.parse(manifestBytes.toString('utf8')); } catch { return 'the manifest is not JSON'; }
  const release = Array.isArray(m?.releases) ? m.releases[0] : undefined;
  const registry = release?.registry?.address, start = release?.startBlock;
  if (m?.chainId !== 97 || typeof registry !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(registry)
    || !/^[0-9]+$/.test(String(start))) return 'the manifest is malformed';
  if (env.SH_KEEPER_CHAIN_ID !== '97') return 'the chain is not the manifest\'s';
  if (typeof env.SH_KEEPER_BOX_REGISTRY !== 'string' || env.SH_KEEPER_BOX_REGISTRY.toLowerCase() !== registry.toLowerCase()) {
    return 'the registry is not the manifest\'s';
  }
  if (env.SH_KEEPER_FROM_BLOCK !== String(start)) return 'the start block is not the manifest\'s';
  if (env.SH_KEEPER_PRIORITY_FEE_WEI !== String(fees.floorWei)) return 'SH_KEEPER_PRIORITY_FEE_WEI is not the approved fee floor';
  if (env.SH_KEEPER_MAX_FEE_WEI !== String(fees.ceilingWei)) return 'SH_KEEPER_MAX_FEE_WEI is not the approved fee ceiling';
  return null;
}

const ATLAS = 'packages/contracts/deployments/bnb-testnet/97-atlas.json';
/** The Atlas switch against the approved Atlas file (null: they agree): on exactly when that file is approved. */
export function atlasCheck(env, atlasBytes, approvedText) {
  const lines = approvedText.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return env.SH_KEEPER_ATLAS === '0' ? null : 'SH_KEEPER_ATLAS is on while no Atlas file is approved';
  const m = lines.length === 1 ? lines[0].match(/^([0-9a-f]{64}) {2}(.+)$/) : null;
  if (!m || m[2] !== ATLAS) return 'the approved Atlas digest is malformed';
  if (!atlasBytes || digest(atlasBytes) !== m[1]) return 'the Atlas file is not the approved one';
  let a;
  try { a = JSON.parse(atlasBytes.toString('utf8')); } catch { return 'the Atlas file is not JSON'; }
  if (a?.chainId !== 97) return 'the Atlas file is not for chain 97';
  return env.SH_KEEPER_ATLAS === '1' ? null : 'SH_KEEPER_ATLAS is off while an Atlas file is approved';
}

