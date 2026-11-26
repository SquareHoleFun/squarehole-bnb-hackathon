import assert from 'node:assert/strict';

/** Only localForge can broadcast this fixture: its loopback/anvil guard and Solidity LocalTwin both apply. */
export async function setupJunkyard(chain, localForge) {
  const output = await localForge(chain, '../chain/scripts/solidity/JunkyardLocal.s.sol:JunkyardLocalSetup',
    'runLocal(address,address,address)', [chain.factory, chain.accounts.actor, chain.accounts.backup], chain.accounts.deployer, 'junkyard-fixtures');
  const entries = Object.fromEntries([...output.matchAll(/LOCALV2\|(\w+)\|(0x[0-9a-fA-F]{40})/g)].map(m => [m[1], m[2]]));
  const names = ['junkyardGold', 'junkyardSafe', 'scrap0', 'scrap1', 'scrap2', 'scrap3', 'scrap4', 'junkyardUnlisted'];
  for (const name of names) assert.ok(entries[name] && BigInt(entries[name]) !== 0n, `missing Junkyard fixture ${name}`);
  assert.equal(new Set(names.map(name => entries[name].toLowerCase())).size, names.length, 'Junkyard fixtures must be distinct');
  const listingId = output.match(/JUNKYARD_LISTING\|([1-9][0-9]*)\b/)?.[1];
  assert.ok(listingId && BigInt(listingId) < 1n << 32n, 'missing Junkyard listing');
  return { gold: entries.junkyardGold, safe: entries.junkyardSafe, listingId,
    collections: Object.fromEntries(['bent-cans', 'lost-cogs', 'split-boots', 'cracked-mugs', 'tangled-wires'].map((key, i) => [key, entries[`scrap${i}`]])),
    unlistedCollection: entries.junkyardUnlisted,
    controls: 'Issuer is accounts.deployer; setPaused, setFrozen and setFeeBps. All start disabled.',
    custody: 'Local contract-holder double owned by accounts.actor; not a production Safe.',
    items: { starter: ['1', '2'], actor: ['100', '101', '102', '103', '104', '105', '106', '107'], backup: ['200', '201', '202', '203', '204', '205', '206', '207'] } };
}
