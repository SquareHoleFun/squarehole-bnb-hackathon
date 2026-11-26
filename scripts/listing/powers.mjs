import { addressWord, decodeEventLog, keccak256, lower, parseAbi, toEventSelector, toFunctionSelector, toHex, ZERO } from './common.mjs';

const slot = label => toHex(BigInt(keccak256(toHex(label))) - 1n, { size: 32 });
export const SLOTS = {
  implementation: slot('eip1967.proxy.implementation'), admin: slot('eip1967.proxy.admin'), beacon: slot('eip1967.proxy.beacon'),
  legacyImplementation: keccak256(toHex('org.zeppelinos.proxy.implementation')),
  legacyAdmin: keccak256(toHex('org.zeppelinos.proxy.admin')), proxiable: keccak256(toHex('PROXIABLE')),
};
const FUNCTIONS = {
  upgrade: ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'changeAdmin(address)', 'setImplementation(address)', 'diamondCut((address,uint8,bytes4[])[],address,bytes)'],
  owner: ['owner()', 'getOwner()', 'admin()', 'transferOwnership(address)', 'acceptOwnership()'],
  pause: ['pause()', 'unpause()', 'paused()', 'setPaused(bool)', 'pauseManager()', 'pauser()'],
  roles: ['hasRole(bytes32,address)', 'grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'getRoleAdmin(bytes32)', 'getRoleMember(bytes32,uint256)'],
  blacklist: ['blacklist(address)', 'unBlacklist(address)', 'addBlackList(address)', 'removeBlackList(address)', 'isBlacklisted(address)', 'isBlackListed(address)', 'getBlackListStatus(address)', 'setBlacklisted(address,bool)'],
  freeze: ['freeze(address)', 'unfreeze(address)', 'isFrozen(address)', 'wipeFrozenAddress(address)', 'destroyBlackFunds(address)', 'setCompliance(address)', 'compliance()'],
  fee: ['setFee(uint256)', 'setFees(uint256,uint256)', 'setParams(uint256,uint256)', 'setTaxFeePercent(uint256)', 'setFeeRate(uint256)', 'setTransferFee(uint256)', 'feeRate()', 'basisPointsRate()', 'maximumFee()'],
  mint: ['mint(address,uint256)', 'mint(uint256)', 'issue(uint256)', 'configureMinter(address,uint256)', 'masterMinter()', 'minter()', 'isMinter(address)'],
  burn: ['burn(uint256)', 'burnFrom(address,uint256)', 'burn(address,uint256)', 'redeem(uint256)'],
  rebase: ['rebase(uint256)', 'rebase(uint256,uint256)', 'rebase(int256)', 'setRebase(uint256)', 'scaledBalanceOf(address)', 'sharesOf(address)', 'getSharesByPooledEth(uint256)'],
};
const GETTERS = { 'owner()': 'address', 'getOwner()': 'address', 'admin()': 'address', 'paused()': 'bool',
  'pauseManager()': 'address', 'pauser()': 'address', 'compliance()': 'address', 'masterMinter()': 'address', 'minter()': 'address',
  'feeRate()': 'uint256', 'basisPointsRate()': 'uint256', 'maximumFee()': 'uint256' };
const roleAbi = parseAbi(['event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)',
  'event RoleRevoked(bytes32 indexed role,address indexed account,address indexed sender)']);

/** Recognize Solidity's flat, definite-length CBOR map plus its uint16 byte length. */
function compilerMetadataStart(bytes) {
  const end = bytes.length - 2;
  if (end < 1) return bytes.length;
  const size = bytes.readUInt16BE(end), start = end - size;
  if (!size || start <= 0) return bytes.length;
  let offset = start;
  // Only decode the map, strings and booleans used by Solidity. Unknown encodings
  // stay in the scan; no recursion, allocations from declared lengths or dependencies.
  function item() {
    if (offset >= end) return null;
    const header = bytes[offset++], major = header >> 5, info = header & 31;
    if (major === 7 && (info === 20 || info === 21)) return { major, value: info === 21 };
    if (![2, 3, 5].includes(major) || info > 27) return null;
    let length = info;
    if (info >= 24) {
      const width = 2 ** (info - 24);
      if (offset + width > end) return null;
      length = 0;
      for (let i = 0; i < width; i++) {
        length = length * 256 + bytes[offset++];
        if (length > size) return null; // Bound before any loss of integer precision.
      }
    }
    if (major === 5) return { major, length };
    if (offset + length > end) return null;
    const data = bytes.subarray(offset, offset + length);
    offset += length;
    return { major, data };
  }
  const map = item(), keys = new Set();
  if (map?.major !== 5 || !map.length || map.length > 5) return bytes.length;
  for (let i = 0; i < map.length; i++) {
    const key = item(), value = item();
    if (key?.major !== 3 || !value) return bytes.length;
    const name = key.data.toString('utf8');
    if (keys.has(name)) return bytes.length;
    keys.add(name);
    let valid = false;
    switch (name) {
      case 'ipfs':
        valid = value.major === 2 && value.data.length === 34 && value.data[0] === 0x12 && value.data[1] === 0x20;
        break;
      case 'bzzr0': case 'bzzr1':
        valid = value.major === 2 && value.data.length === 32;
        break;
      case 'solc':
        valid = (value.major === 2 && value.data.length === 3)
          || (value.major === 3 && /^\d+\.\d+\.\d+[-+][0-9A-Za-z.+-]+$/.test(value.data.toString('utf8')));
        break;
      case 'experimental':
        valid = value.major === 7 && value.value === true;
        break;
    }
    if (!valid) return bytes.length;
  }
  return offset === end && [...keys].some(key => key !== 'experimental') ? start : bytes.length;
}

/** Skip validated compiler metadata and PUSH data; matches still require source review. */
export function instructions(code) {
  const selectors = new Set(); let delegate = false;
  const runtime = Buffer.from(code.slice(2), 'hex');
  const bytes = runtime.subarray(0, compilerMetadataStart(runtime));
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === 0xf4 || op === 0xf2) delegate = true;
    if (op === 0x63 && i + 4 < bytes.length) selectors.add(`0x${bytes.subarray(i + 1, i + 5).toString('hex')}`);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return { selectors, delegate };
}

export async function issuerPowers(reader, config, token, code) {
  const report = { code: [], proxies: [], functions: [], getters: [], roles: [], roleScanFromBlock: config.scanFromBlock,
    unknowns: ['Selector scanning is not proof of absence of issuer powers. Unrecognized selectors, custom storage, external compliance and future upgrades need source review.'],
    policyBlocks: [] };
  const seen = new Set();
  async function inspect(address, bytecode, storageAddress, depth) {
    if (seen.has(address) || depth > 4) { report.policyBlocks.push('unresolved-proxy'); return; }
    seen.add(address); report.code.push({ address, codeHash: keccak256(bytecode) });
    const scan = instructions(bytecode);
    for (const [power, signatures] of Object.entries(FUNCTIONS)) for (const signature of signatures) {
      if (scan.selectors.has(toFunctionSelector(signature))) report.functions.push({ power, signature, codeAddress: address, evidence: 'PUSH4 selector; semantics and authorization unverified' });
    }
    if (depth > 0 && !scan.delegate) return;
    const slots = {};
    for (const [name, key] of Object.entries(SLOTS)) {
      try { slots[name] = addressWord(await reader.storage(storageAddress, key)); }
      catch { report.unknowns.push(`unreadable proxy slot ${name}`); report.policyBlocks.push('unresolved-proxy'); }
    }
    let target = ZERO, proxy;
    if (slots.implementation && slots.implementation !== ZERO) {
      target = slots.implementation; proxy = { kind: 'eip1967', implementation: target, admin: slots.admin ?? null };
    } else if (slots.beacon && slots.beacon !== ZERO) {
      proxy = { kind: 'beacon', beacon: slots.beacon, admin: slots.admin ?? null };
      try {
        target = lower(await reader.read(slots.beacon, 'function implementation() view returns (address)'));
        proxy.implementation = target;
        proxy.beaconOwner = lower(await reader.read(slots.beacon, 'function owner() view returns (address)'));
        report.code.push({ address: slots.beacon, codeHash: keccak256(await reader.code(slots.beacon)) });
      } catch { report.policyBlocks.push('unresolved-proxy'); }
    } else if (slots.legacyImplementation && slots.legacyImplementation !== ZERO) {
      target = slots.legacyImplementation; proxy = { kind: 'zeppelin-legacy', implementation: target, admin: slots.legacyAdmin ?? null };
    } else if (slots.proxiable && slots.proxiable !== ZERO) {
      target = slots.proxiable; proxy = { kind: 'eip1822', implementation: target, admin: null };
    } else if (/^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3/i.test(bytecode)) {
      target = `0x${bytecode.slice(22, 62)}`; proxy = { kind: 'eip1167', implementation: target, admin: null };
    } else if (scan.delegate) {
      // Includes custom/diamond proxies; never label these immutable just because 1967 slots are empty.
      report.proxies.push({ address, kind: 'unresolved-delegatecall', admin: null }); report.policyBlocks.push('unresolved-proxy');
    }
    if (proxy) {
      report.proxies.push({ address, ...proxy });
      if (proxy.admin && proxy.admin !== ZERO) {
        try { proxy.adminOwner = lower(await reader.read(proxy.admin, 'function owner() view returns (address)'));
          report.proxies[report.proxies.length - 1].adminOwner = proxy.adminOwner; } catch { /* EOA or non-Ownable admin; address remains evidence */ }
      }
      if (target !== ZERO) {
        try {
          const implementationCode = await reader.code(target);
          if (implementationCode === '0x') report.policyBlocks.push('unresolved-proxy');
          else await inspect(target, implementationCode, storageAddress, depth + 1);
        } catch { report.policyBlocks.push('unresolved-proxy'); }
      } else report.policyBlocks.push('unresolved-proxy');
    }
  }
  // A proxy's implementation uses the proxy's storage; a non-delegating implementation ends traversal.
  await inspect(token, code, token, 0);
  for (const [signature, type] of Object.entries(GETTERS)) {
    try {
      const value = await reader.read(token, `function ${signature} view returns (${type})`);
      report.getters.push({ signature, value, evidence: 'eth_call at token/proxy address; getter alone does not prove authorization' });
    } catch { /* Absent/reverting getters are never interpreted as absence of powers. */ }
  }
  for (const signature of ['isBlacklisted(address)', 'isBlackListed(address)', 'getBlackListStatus(address)', 'isFrozen(address)', 'isMinter(address)']) {
    if (!report.functions.some(f => f.signature === signature)) continue;
    for (const account of [config.safe, config.registry.address, config.market.v4.manager.address]) {
      try { report.getters.push({ signature, account, value: await reader.read(token, `function ${signature} view returns (bool)`, [account]) }); }
      catch { report.unknowns.push(`getter unavailable: ${signature}`); }
    }
  }
  try {
    const logs = await reader.logs(token, [[toEventSelector(roleAbi[0]), toEventSelector(roleAbi[1])]], BigInt(config.scanFromBlock));
    const members = new Map();
    for (const log of logs) {
      const event = decodeEventLog({ abi: roleAbi, ...log });
      const role = event.args.role.toLowerCase(), account = lower(event.args.account);
      members.set(`${role}:${account}`, { role, account });
    }
    for (const member of members.values()) {
      try { report.roles.push({ ...member, active: await reader.read(token, 'function hasRole(bytes32,address) view returns (bool)', [member.role, member.account]),
        adminRole: await reader.read(token, 'function getRoleAdmin(bytes32) view returns (bytes32)', [member.role]) }); }
      catch { report.roles.push({ ...member, active: 'unknown', adminRole: 'unknown' }); }
    }
  } catch { report.unknowns.push('role history unavailable; membership incomplete'); }
  for (const name of ['DEFAULT_ADMIN_ROLE', 'MINTER_ROLE', 'BURNER_ROLE', 'PAUSER_ROLE', 'BLACKLISTER_ROLE']) {
    try { report.roles.push({ name, role: await reader.read(token, `function ${name}() view returns (bytes32)`) }); }
    catch { /* A familiar role name is not evidence that the token implements it. */ }
  }
  if (report.functions.some(f => f.power === 'rebase')) report.policyBlocks.push('rebase');
  if (report.functions.some(f => f.power === 'fee')) report.policyBlocks.push('fee-switch');
  report.policyBlocks = [...new Set(report.policyBlocks)];
  return report;
}

export function issuerSheet(coin, snapshot) {
  const lines = [`# Issuer powers: ${coin.token}`, '', `Chain: 1. Finalized block: ${snapshot.number}; hash: ${snapshot.hash}.`, '',
    'This is code/storage evidence, not proof of absence of issuer powers. Selector presence does not prove a function is reachable or who may call it. An upgrade can change all observed behavior.', '',
    `Class: ${coin.class}. Batch eligible: ${coin.eligible ? 'yes' : 'no'}.`, '', '## Proxies and control', ''];
  for (const p of coin.powers.proxies) lines.push(`- ${JSON.stringify(p)}`);
  if (!coin.powers.proxies.length) lines.push('- No recognized proxy found; custom indirection remains possible.');
  lines.push('', '## Detected capabilities', '');
  for (const f of coin.powers.functions) lines.push(`- ${f.power}: \`${f.signature}\` in ${f.codeAddress}; ${f.evidence}.`);
  lines.push('', '## Storage-backed reads and roles', '');
  for (const g of [...coin.powers.getters, ...coin.powers.roles]) lines.push(`- ${JSON.stringify(g, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  lines.push('', `Role logs scanned from block ${coin.powers.roleScanFromBlock}; earlier grants and nonstandard roles may be missing.`, '', '## Admission and limits', '');
  for (const c of coin.checks) lines.push(`- ${c.id}: **${c.status}** — ${c.detail}`);
  for (const u of coin.powers.unknowns) lines.push(`- ${u}`);
  lines.push('', 'Listing is permanent. Pauses, blacklists, freezes, fees, rebases, minting or administrator burns can impair holdings and claims after this observation. Source and issuer review remains necessary.', '');
  return lines.join('\n');
}
