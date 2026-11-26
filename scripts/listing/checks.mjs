import { addressWord, BURN_SELECTOR, CEILING, cloneCode, ERC1820, keccak256, lower, need, PROBE_AMOUNT, toFunctionSelector, toHex, word, ZERO } from './common.mjs';
import { listingCalls, simulate } from './batch.mjs';

const revert = error => error?.code === 3 || (typeof error?.data === 'string' && /^0x[0-9a-f]*$/i.test(error.data));
const check = (id, status, detail) => ({ id, status, detail });
export async function notBox(reader, registry, token, code) {
  let holder;
  try { holder = addressWord(await reader.call(token, 'function initialHolder() view returns (address)', [], reader.tag,
    { gas: '0xd6d8', ...(reader.config ? { from: reader.config.registry.address } : {}) })); }
  catch (error) { if (revert(error) || error?.message === 'malformed word' || error?.message === 'malformed address') return true; throw error; }
  const directory = await reader.read(registry, 'function directory() view returns (address[])');
  need(directory.length <= 255, 'box directory too large');
  const registries = [registry, ...directory.map(lower)];
  for (let i = 0; i < registries.length; i++) {
    const r = registries[i];
    const [recorded, id] = await reader.read(r, 'function boxIdOf(address) view returns (bool,uint256)', [holder]);
    if (!recorded) continue;
    if (id >= await reader.read(r, 'function boxCount() view returns (uint256)')
      || lower(await reader.read(r, 'function coordinatorOf(uint256) view returns (address)', [id])) !== holder
      || lower(await reader.read(holder, 'function token() view returns (address)')) !== token) return true;
    if (i === 0) {
      if ((code.length - 2) / 2 !== 45 + 137 || token !== `0x${keccak256(`0xd694${holder.slice(2)}01`).slice(-40)}`) return true;
      const factory = await reader.read(r, 'function factory() view returns (address)');
      const impl = await reader.read(factory, 'function implementation(uint256) view returns (address)', [1n]);
      if (!code.toLowerCase().startsWith(cloneCode(lower(impl)))) return true;
    }
    return false;
  }
  return true;
}

export async function staticChecks(reader, config, coin, boxRegistry) {
  const checks = [];
  const run = async (id, fn, detail) => {
    try { const ok = await fn(); checks.push(check(id, ok ? 'pass' : 'fail', detail)); }
    catch { checks.push(check(id, 'unknown', 'read unavailable or malformed; no admission')); }
  };
  let code = '0x', decimals = null, held = null, allowance = null;
  const caller = { from: config.registry.address };
  try { code = await reader.code(coin.token); } catch { /* code check below remains a failure */ }
  await run('not-box-token', () => notBox(reader, boxRegistry, coin.token, code), 'BoxTokenProof reverse identity; external price coins only');
  await run('code', () => code !== '0x' && !(code.length === 48 && code.startsWith('0xef0100')), 'contract code, excluding EIP-7702 delegation');
  await run('address-ceiling', () => BigInt(coin.token) < CEILING, 'strictly below the ListingChecks address ceiling');
  await run('decimals', async () => {
    try { decimals = word(await reader.call(coin.token, 'function decimals() view returns (uint8)', [], reader.tag, caller)); }
    catch { return false; }
    return decimals >= 6n && decimals <= 18n;
  }, 'exactly one word, 6 through 18');
  await run('no-erc777', async () => {
    if (await reader.code(ERC1820) === '0x') return true;
    try { return word(await reader.call(ERC1820, 'function getInterfaceImplementer(address,bytes32) view returns (address)',
      [coin.token, keccak256(toHex('ERC777Token'))], reader.tag, caller), false) === 0n; } catch { return false; }
  }, 'ERC-1820 ERC777Token registration; malformed registry answer fails closed');
  await run('class', () => coin.token !== config.weth && coin.token !== ZERO, 'STABLE, STOCK or OTHER; native ETH and WETH excluded');
  await run('not-listed', async () => !(await reader.read(config.registry.address, 'function newestListingOf(address) view returns (bool,uint32)', [coin.token]))[0], 'F123 one permanent row per coin');
  await run('probe-reads', async () => {
    held = word(await reader.call(coin.token, 'function balanceOf(address) view returns (uint256)', [config.safe], reader.tag, caller), false);
    allowance = word(await reader.call(coin.token, 'function allowance(address,address) view returns (uint256)', [config.safe, config.registry.address], reader.tag, caller), false);
    return true;
  }, 'funder balance and allowance readable');
  return { checks, code, decimals, held, allowance };
}

function simulationFailure(error) {
  const data = error?.data;
  if (data?.startsWith(toFunctionSelector('ListingRefused(uint8)')) && data.length === 74) {
    const reason = BigInt(`0x${data.slice(10)}`);
    return check('transfers', 'fail', `ListingRefused enum ${reason.toString()} (3: TRANSFER_NOT_EXACT; 5: ALLOWLIST_ONLY)`);
  }
  if (data === toFunctionSelector('BurnRefused()')) return check('burn', 'fail', 'CheckedBurn refused exact supply/balance reduction');
  return check('transfers', 'fork run needed', 'read-only admission unavailable or reverted without a recognized outcome; fund dust and rehearse on a fork');
}
export async function probeChecks(reader, config, coin, state, raise, royaltyLot) {
  const checks = [];
  if (raise !== null) {
    try {
      need(raise >= 1000000n && raise < 1n << 128n, 'raise bounds');
      await reader.call(config.registry.address, 'function checkLayout(uint256) view', [raise]);
      checks.push(check('raise-buildable', 'pass', 'ListingRegistry.checkLayout at the snapshot'));
    } catch { checks.push(check('raise-buildable', 'fail', 'raise bounds/layout could not be established')); }
  } else checks.push(check('raise-buildable', 'unknown', 'no proposed raise'));
  if (!royaltyLot || raise === null || state.held === null || state.held < PROBE_AMOUNT || state.allowance === null
    || state.checks.some(c => c.status !== 'pass') || checks.some(c => c.status !== 'pass')) {
    checks.push(check('transfers', 'fork run needed', 'requires passing static checks, buildable raise and 10000 raw units held by the Safe'));
    if (coin.burnSelector) checks.push(check('burn', 'fork run needed', 'admission prerequisites incomplete'));
    return { checks };
  }
  const calls = listingCalls(config, coin, raise, state.allowance, royaltyLot, false);
  try { await simulate(reader, config, calls); checks.push(check('transfers', 'pass', 'real add() through PoolManager; only Safe code overridden; all probe movements revert')); }
  catch (error) { checks.push(simulationFailure(error)); }
  if (coin.burnSelector) {
    if (checks.some(c => c.status !== 'pass')) checks.push(check('burn', 'fork run needed', 'transfer admission incomplete'));
    else {
      try {
        need(coin.burnSelector === BURN_SELECTOR, 'unsupported burn selector');
        await simulate(reader, config, listingCalls(config, coin, raise, state.allowance, royaltyLot));
        checks.push(check('burn', 'pass', 'real addWithBurn: exact pull, unchanged supply on pull, then exact own-balance and supply decrease'));
      } catch (error) {
        const failure = simulationFailure(error);
        checks.push({ ...failure, id: 'burn' });
      }
    }
  }
  return { checks };
}
