import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { buildListingKit } from '../kit.mjs';
import { notBox } from '../checks.mjs';
import { Reader } from '../rpc.mjs';
import { parseInput } from '../config.mjs';
import { cloneCode, CEILING } from '../common.mjs';
import { issuerPowers, SLOTS, instructions } from '../powers.mjs';
import { fakeRpc, input, A, H, PLAIN, FEE, PAUSED, unpack } from './rpc.mjs';
const { parseAbi, encodeFunctionResult, encodeAbiParameters, decodeFunctionData, toFunctionSelector, keccak256, encodeEventTopics } =
  createRequire(new URL('../../../packages/burn-bot/package.json', import.meta.url))('viem');

const feeSelector = toFunctionSelector('setFee(uint256)');
const metadataSignals = `f4f263${feeSelector.slice(2)}`;
const solcEntry = '64736f6c634300081c'; // "solc": bytes([0, 8, 28])
function ipfsEntry(signals = metadataSignals) {
  // "ipfs": bytes(sha2-256 multihash); obviously fake digest bytes.
  return `646970667358221220${signals.padEnd(64, '0')}`;
}
function withMetadata(code: string, cbor = `a2${ipfsEntry()}${solcEntry}`) {
  return `${code}${cbor}${(cbor.length / 2).toString(16).padStart(4, '0')}`;
}

describe('ListingChecks boundary and batch parity', () => {
  it('reads token admission metadata in the registry caller context', async () => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    rpc.request = (method, params) => method === 'eth_call' && params[0].to === PLAIN
      && params[0].data === toFunctionSelector('decimals()') && params[0].from !== A(1)
      ? Promise.resolve(H(19)) : original(method, params);
    const result = await buildListingKit(input(), rpc, true);
    expect(result.coins[0].eligible).toBe(true);
    expect(result.coins[0].decimals).toBe('18');
  });
  it('pins current-release box proof to the factory uint256 role selector', async () => {
    const holder = A(77), token = `0x${keccak256(`0xd694${holder.slice(2)}01`).slice(-40)}`;
    const reader = { tag: '0x1', call: async () => H(77), read: async (_to, signature) => {
      if (signature.includes('directory')) return [];
      if (signature.includes('boxIdOf')) return [true, 0n];
      if (signature.includes('boxCount')) return 1n;
      if (signature.includes('coordinatorOf')) return holder;
      if (signature.includes('token()')) return token;
      if (signature.includes('factory()')) return A(88);
      expect(signature).toBe('function implementation(uint256) view returns (address)');
      return A(99);
    } };
    expect(await notBox(reader, A(5), token, `${cloneCode(A(99))}${'00'.repeat(137)}`)).toBe(false);
    expect(await notBox(reader, A(5), token, cloneCode(A(99)))).toBe(true);
  });

  it.each([
    ['ceiling', `0x${CEILING.toString(16)}`, 'address-ceiling'],
    ['weth', A(4), 'class'],
  ])('rejects %s independently of route discovery', async (_name, token, id) => {
    const config = { ...input(), tokens: [{ token, class: 'OTHER' }], raisePolicy: { kind: 'fixed', amounts: { [token]: '1000000' } } };
    const result = await buildListingKit(config, fakeRpc(), true);
    expect(result.coins[0].checks).toContainEqual(expect.objectContaining({ id, status: 'fail' }));
    expect(result.safeBatch.transactions).toEqual([]);
  });

  it('treats delegation and malformed code as failures but still reports subsequent coins', async () => {
    for (const code of [`0xef0100${A(999).slice(2)}`, null, 'garbage']) {
      const rpc = fakeRpc(), original = rpc.request.bind(rpc);
      rpc.request = (method, params) => method === 'eth_getCode' && params[0] === PLAIN ? Promise.resolve(code) : original(method, params);
      const result = await buildListingKit(input(), rpc, true);
      expect(result.coins[0].eligible).toBe(false);
      expect(result.coins[5].eligible).toBe(true);
    }
  });

  it.each(['0x', H(1)])('refuses malformed or registered ERC777 implementers', async data => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    rpc.request = (method, params) => {
      if (method === 'eth_getCode' && params[0].startsWith('0x1820')) return Promise.resolve('0x6000');
      if (method === 'eth_call' && params[0].to.startsWith('0x1820')) return Promise.resolve(data);
      return original(method, params);
    };
    const result = await buildListingKit(input(), rpc, true);
    expect(result.coins[0].checks).toContainEqual(expect.objectContaining({ id: 'no-erc777', status: 'fail' }));
    expect(result.safeBatch.transactions).toEqual([]);
  });

  it('resets nonzero approvals and the packed MultiSend matches the builder calls exactly', async () => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    rpc.request = (method, params) => method === 'eth_call' && params[0].data.startsWith(toFunctionSelector('allowance(address,address)'))
      ? Promise.resolve(H(12345)) : original(method, params);
    const result = await buildListingKit(input(), rpc, true);
    const decoded = decodeFunctionData({ abi: parseAbi(['function multiSend(bytes) payable']), data: result.multiSend.data });
    const calls = unpack(decoded.args[0]);
    expect(calls).toHaveLength(8);
    expect(calls.map(c => ({ to: c.to, data: c.data }))).toEqual(result.safeBatch.transactions.map(c => ({ to: c.to, data: c.data })));
    expect(calls.every(c => c.operation === '00' && c.value === 0n)).toBe(true);
    const amounts = calls.filter(c => c.data.startsWith('0x095ea7b3')).map(c => BigInt(`0x${c.data.slice(-64)}`));
    expect(amounts).toEqual([0n, 10000n, 0n, 10000n]);
  });

  it('withholds the whole batch when separately passing coins interact badly', async () => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method === 'eth_call' && params.length === 3 && params[0].data !== '0x') {
        const decoded = decodeFunctionData({ abi: parseAbi(['function multiSend(bytes) payable']), data: params[0].data });
        if (unpack(decoded.args[0]).length > 3) throw new Error('obviously fake combined failure');
      }
      return original(method, params);
    };
    const result = await buildListingKit(input(), rpc, true);
    expect(result.safeBatch.transactions).toEqual([]);
    expect(result.multiSend).toBeNull();
    expect(result.coins[0].checks.at(-1).id).toBe('combined-batch');
  });
});

describe('issuer control evidence', () => {
  it.each([
    ['DELEGATECALL', 'f4'], ['CALLCODE', 'f2'], ['fee selector', `63${feeSelector.slice(2)}`],
  ])('does not block or publish %s found only in Solidity metadata', async (_name, signals) => {
    const code = withMetadata('0x600000', `a2${ipfsEntry(signals)}${solcEntry}`);
    expect((code.length - '0x600000'.length) / 2).toBe(53); // 51-byte CBOR + uint16 length.
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    rpc.request = (method, params) => method === 'eth_getCode' && params[0] === PLAIN
      ? Promise.resolve(code) : original(method, params);
    const result = await buildListingKit({ ...input(), tokens: [input().tokens[0]] }, rpc, true);
    const coin = result.coins[0];
    expect(coin.checks.filter(c => c.id !== 'issuer-policy').every(c => c.status === 'pass')).toBe(true);
    expect(coin.eligible).toBe(true);
    expect(coin.powers.proxies).toEqual([]);
    expect(coin.powers.functions).toEqual([]);
    expect(coin.powers.policyBlocks).toEqual([]);
    expect(coin.powers.code).toEqual([{ address: PLAIN, codeHash: keccak256(code) }]);
    expect(result.issuerSheets[PLAIN]).not.toMatch(/unresolved-delegatecall|setFee/);
    expect(result.safeBatch.transactions).toHaveLength(3);
    expect(result.runner.routes).toHaveLength(1);
  });

  it.each([
    ['IPFS', `a2${ipfsEntry()}${solcEntry}`],
    ['reordered keys', `a2${solcEntry}${ipfsEntry()}`],
    ['Swarm bzzr0', `a165627a7a72305820${metadataSignals.padEnd(64, '0')}`],
    ['Swarm bzzr1', `a265627a7a72315820${metadataSignals.padEnd(64, '0')}${solcEntry}`],
    ['solc only', 'a164736f6c63430008f4'],
    ['prerelease and experimental', `a3${ipfsEntry()}64736f6c6373302e382e32392d646576656c6f702e66616b656c6578706572696d656e74616cf5`],
  ])('excludes a complete %s compiler metadata map from instruction analysis', (_name, cbor) => {
    expect(instructions(withMetadata('0x600000', cbor))).toEqual({ delegate: false, selectors: new Set() });
  });

  it.each([
    ['non-map', `82${ipfsEntry()}${solcEntry}`],
    ['unknown key', `a26466616b6558221220${metadataSignals.padEnd(64, '0')}${solcEntry}`],
    ['wrong hash type', `a2646970667378221220${metadataSignals.padEnd(64, '0')}${solcEntry}`],
    ['wrong multihash prefix', `a2646970667358220000${metadataSignals.padEnd(64, '0')}${solcEntry}`],
    ['wrong digest length', `a2646970667358211220${metadataSignals.padEnd(62, '0')}${solcEntry}`],
    ['duplicate key', `a3${ipfsEntry()}${solcEntry}${solcEntry}`],
    ['truncated map', `a3${ipfsEntry()}${solcEntry}`],
    ['truncated value', `a2${ipfsEntry()}${solcEntry.slice(0, -2)}`],
    ['extra item', `a2${ipfsEntry()}${solcEntry}00`],
    ['invalid solc type', `a2${ipfsEntry()}64736f6c6300`],
    ['oversized length', `a2${ipfsEntry()}64736f6c635bffffffffffffffff`],
    ['indefinite map', `bf${ipfsEntry()}${solcEntry}ff`],
    ['reserved length', `a2${ipfsEntry()}64736f6c635c`],
  ])('keeps scanning a %s trailer instead of trusting its length alone', (_name, cbor) => {
    const scan = instructions(withMetadata('0x00', cbor));
    expect(scan.delegate).toBe(true);
    expect(scan.selectors).toContain(feeSelector);
  });

  it.each(['', '0000', 'ffff', '0032', '0034'])('keeps scanning metadata with missing or incorrect footer %s', footer => {
    const scan = instructions(`0x00a2${ipfsEntry()}${solcEntry}${footer}`);
    expect(scan.delegate).toBe(true);
    expect(scan.selectors).toContain(feeSelector);
  });

  it.each([
    ['DELEGATECALL', 'f4', 'unresolved-proxy'], ['CALLCODE', 'f2', 'unresolved-proxy'],
    ['fee selector', `63${feeSelector.slice(2)}50`, 'fee-switch'],
  ])('still blocks executable %s preceding valid compiler metadata', async (_name, executable, block) => {
    const code = withMetadata(`0x${executable}00`);
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    rpc.request = (method, params) => method === 'eth_getCode' && params[0] === PLAIN
      ? Promise.resolve(code) : original(method, params);
    const result = await buildListingKit({ ...input(), tokens: [input().tokens[0]] }, rpc, true);
    expect(result.coins[0].checks.filter(c => c.id !== 'issuer-policy').every(c => c.status === 'pass')).toBe(true);
    expect(result.coins[0].eligible).toBe(false);
    expect(result.coins[0].powers.policyBlocks).toContain(block);
    expect(result.coins[0].powers.code).toEqual([{ address: PLAIN, codeHash: keccak256(code) }]);
    expect(result.safeBatch.transactions).toEqual([]);
  });

  it('does not advertise a default admin role without an observed getter or event', async () => {
    const config = parseInput(input(), true), reader = await new Reader(fakeRpc(), config).init();
    const powers = await issuerPowers(reader, config, PLAIN, await reader.code(PLAIN));
    expect(powers.roles).toEqual([]);
  });
  it('does not mistake PUSH payload bytes for opcodes or promise selector semantics', () => {
    expect(instructions(`0x7f${'f4'.repeat(32)}00`).delegate).toBe(false);
    expect(instructions('0xf4').delegate).toBe(true);
  });

  it('recognizes immutable clones, legacy and beacon proxies and blocks unknown delegatecall', async () => {
    for (const kind of ['clone', 'legacy', 'beacon', 'unknown']) {
      const rpc = fakeRpc(), original = rpc.request.bind(rpc);
      rpc.request = (method, params) => {
        if (method === 'eth_getStorageAt' && params[0] === PLAIN) {
          if (kind === 'legacy' && params[1] === SLOTS.legacyImplementation) return Promise.resolve(H(80));
          if (kind === 'legacy' && params[1] === SLOTS.legacyAdmin) return Promise.resolve(H(81));
          if (kind === 'beacon' && params[1] === SLOTS.beacon) return Promise.resolve(H(82));
        }
        if (method === 'eth_call' && params[0].to === A(82) && params[0].data === toFunctionSelector('implementation()')) return Promise.resolve(H(80));
        return original(method, params);
      };
      const config = parseInput(input(), true), reader = await new Reader(rpc, config).init();
      const result = await issuerPowers(reader, config, PLAIN, kind === 'clone' ? cloneCode(A(80)) : '0xf4');
      if (kind === 'unknown') expect(result.policyBlocks).toContain('unresolved-proxy');
      else {
        expect(result.proxies[0].kind).toBe(kind === 'clone' ? 'eip1167' : kind === 'legacy' ? 'zeppelin-legacy' : 'beacon');
        expect(result.functions).toContainEqual(expect.objectContaining({ power: 'pause', codeAddress: A(80) }));
        expect(result.policyBlocks).not.toContain('unresolved-proxy');
      }
    }
  });

  it('reconstructs roles from grant/revoke logs and reads current membership and admin role', async () => {
    const rpc = fakeRpc(), original = rpc.request.bind(rpc);
    const abi = parseAbi(['event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)',
      'function hasRole(bytes32,address) view returns (bool)', 'function getRoleAdmin(bytes32) view returns (bytes32)']);
    rpc.request = (method, params) => {
      if (method === 'eth_getLogs' && params[0].address === PAUSED && BigInt(params[0].fromBlock) === 0n) return Promise.resolve([{
        address: PAUSED, blockNumber: '0x64', blockHash: H(100), logIndex: '0x0', removed: false, data: '0x',
        topics: encodeEventTopics({ abi, eventName: 'RoleGranted', args: { role: H(1), account: A(81), sender: A(81) } }),
      }]);
      if (method === 'eth_call' && params[0].to === PAUSED) {
        if (params[0].data.startsWith(toFunctionSelector('hasRole(bytes32,address)'))) return Promise.resolve(encodeFunctionResult({ abi, functionName: 'hasRole', result: true }));
        if (params[0].data.startsWith(toFunctionSelector('getRoleAdmin(bytes32)'))) return Promise.resolve(encodeAbiParameters([{ type: 'bytes32' }], [H(0)]));
      }
      return original(method, params);
    };
    const config = parseInput(input(), true), reader = await new Reader(rpc, config).init();
    const result = await issuerPowers(reader, config, PAUSED, await reader.code(PAUSED));
    expect(result.roles).toContainEqual({ role: H(1), account: A(81), active: true, adminRole: H(0) });
    const fee = await issuerPowers(reader, config, FEE, await reader.code(FEE));
    expect(fee.policyBlocks).toContain('fee-switch');
  });
});
