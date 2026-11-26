import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

const require = createRequire(new URL('../../../../packages/keeper/package.json', import.meta.url));
export const v = require('viem');
export const accounts = require('viem/accounts');
export const root = new URL('../../../../', import.meta.url);
export const read = path => readFileSync(new URL(path, root), 'utf8');
export function canonical(name) {
  const text = read(`packages/chain/src/abi/${name}.ts`);
  return JSON.parse(text.slice(text.indexOf('= [') + 2, text.lastIndexOf(' as const;')));
}
const backedText = read('packages/contracts/src/box/randomness/BoxBackedSource.sol');
const backedAbi = v.parseAbi([
  'function DRAND() view returns (address)',
  'function backupOf(uint256 round) view returns (uint64 startedAt, uint64 targetBlock, uint64 fixedAt, bytes32 mix)',
  'function startBackup(uint256 round, uint256 headerBlock, bytes header) returns (uint256 target)',
  'function fixBackup(uint256 round, bytes header) returns (bytes32 mix)',
  ...[...backedText.matchAll(/(?:event|error) \w+\([^;]*\);/g)].map(m => m[0].slice(0, -1)),
]);
export const abi = [...backedAbi, ...['boxTickets', 'drandSource', 'boxCoordinator', 'boxRegistry', 'boxVault'].flatMap(canonical)];
export const vectors = JSON.parse(read('packages/contracts/test/vectors/drand-quicknet-box.json'));
export const runtime = JSON.parse(read('scripts/box/drand-rescue/test/source-runtime.json')).runtime;
export const backed = '0x4fe27ae2810dada5f2f0f425f6623fdbe6a321fb';
export const backedRuntime = JSON.parse(read('scripts/box/drand-rescue/test/backed-runtime.json')).runtime;
export const source = '0xbeece13fbdd67d0a696cb7cfd28103ed37ba79a6';
export const ticket1 = '0x1000000000000000000000000000000000000001';
export const ticket2 = '0x1000000000000000000000000000000000000002';
export const vault = '0x2000000000000000000000000000000000000001';
export const registry = '0x3000000000000000000000000000000000000001';
export const coordinator = '0x4000000000000000000000000000000000000001';
export const r0 = 32654000n;
export const time = round => 1692803367n + (round - 1n) * 3n;
export const hex = n => `0x${n.toString(16)}`;
export function answer(round) {
  const i = vectors.rounds.findIndex(r => BigInt(r) === round);
  assert.notEqual(i, -1);
  return { round: String(round), signature: vectors.signatures[i].slice(2), randomness: vectors.randomness[i].slice(2) };
}
export function ticket(overrides = {}) {
  return {
    source, phase: 2, gate: time(r0) - 12n,
    state: { minted: 5n, slots: 5n, wordRequestedAt: time(r0) - 12n, wordAcceptedAt: 0n,
      terminalAt: 0n, drawsRequested: 0n, drawsSettled: 0n },
    requests: new Map([[0n, { requestedAt: time(r0) - 12n, round: r0 }]]), ...overrides,
  };
}
export function fixture(options = {}) {
  const key = accounts.generatePrivateKey();
  const marker = randomBytes(12).toString('hex');
  const token = `${randomBytes(5).toString('hex')}:${marker}`;
  const model = {
    chain: 11155111n, now: time(r0) + 3600n, block: 100n, base: 1n, tip: 1n,
    gas: 100001n, gasLimit: 30000000n, balance: 10n ** 20n, nonce: 0n,
    tickets: new Map([[ticket1, ticket()]]), posted: new Map(), sent: [], calls: [], relays: [], mail: [],
    backedCode: backedRuntime, drand: source, backups: new Map(), finalized: 99n, blocks: new Map(), rawHeaders: true,
    simulations: [], cast: [], out: '', err: '', code: runtime, receipts: new Map(),
    env: { RESCUE_KEY: key, RESCUE_RPC: `https://rpc.invalid/${marker}`, MAIL_TOKEN: token, MAIL_URL: `https://mailer.invalid/${marker}` },
    ...options,
  };
  model.blockData = number => {
    if (model.blocks.has(number)) return model.blocks.get(number);
    const names = ['parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot', 'receiptsRoot', 'logsBloom',
      'difficulty', 'number', 'gasLimit', 'gasUsed', 'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas'];
    const fields = [v.zeroHash, v.zeroHash, source, v.zeroHash, v.zeroHash, v.zeroHash, `0x${'00'.repeat(256)}`,
      '0x', v.toHex(number), v.toHex(model.gasLimit), '0x', v.toHex(model.now - (model.block - number) * 12n),
      '0x', `0x${'12'.repeat(32)}`, '0x0000000000000000', model.base ? v.toHex(model.base) : '0x'];
    const raw = v.toRlp(fields);
    const block = { ...Object.fromEntries(fields.map((value, i) => [names[i], value === '0x' && [7, 10, 15].includes(i) ? '0x0' : value])), hash: v.keccak256(raw), transactions: [] };
    const data = { raw, block };
    model.blocks.set(number, data);
    return data;
  };
  const backupError = (fn, args) => {
    const [round] = args, b = model.backups.get(round) ?? [0n, 0n, 0n, v.zeroHash];
    if (fn === 'startBackup') {
      if (model.now <= time(round) + 432000n) return 'BackupTooEarly';
      if (model.now > time(round) + 496800n) return 'BackupTooLate';
      if (b[0]) return 'BackupAlreadyStarted';
      if (model.posted.has(round)) return 'RoundAlreadyPosted';
      if (args[1] >= model.block || model.block - args[1] > 8n) return 'HeaderUnavailable';
      if (v.keccak256(args[2]) !== model.blockData(args[1]).block.hash) return 'WrongHeader';
    } else if (fn === 'fixBackup') {
      if (!b[0]) return 'NoBackup';
      if (b[2]) return 'BackupAlreadyFixed';
      if (b[1] >= model.block || model.block - b[1] > 8191n) return 'HeaderUnavailable';
      if (v.keccak256(args[1]) !== model.blockData(b[1]).block.hash) return 'WrongHeader';
    }
    return null;
  };
  const logFor = (functionName, args) => {
    if (['startBackup', 'fixBackup'].includes(functionName)) {
      const eventName = functionName === 'startBackup' ? 'BackupStarted' : 'BackupFixed';
      const b = model.backups.get(args[0]);
      return { address: backed,
        topics: v.encodeEventTopics({ abi, eventName, args: { round: args[0], by: accounts.privateKeyToAccount(key).address } }),
        data: v.encodeAbiParameters(abi.find(e => e.type === 'event' && e.name === eventName).inputs.filter(i => !i.indexed),
          functionName === 'startBackup' ? [b[1]] : [b[1], b[3]]) };
    }
    const eventName = functionName === 'postRound' ? 'RoundPosted' : 'GraduationWordStored';
    const event = abi.find(e => e.type === 'event' && e.name === eventName);
    const values = functionName === 'postRound'
      ? { round: args[0], randomness: v.zeroHash, poster: accounts.privateKeyToAccount(key).address, bounty: 0n }
      : { word: `0x${'12'.repeat(32)}`, q: 5n, readyAt: model.now };
    // Event argument names come from the canonical ABI, including the graduation slots field.
    const nonIndexed = event.inputs.filter(i => !i.indexed);
    const dataValues = functionName === 'postRound' ? [v.zeroHash, 0n] : [`0x${'12'.repeat(32)}`, 5n, model.now];
    return { address: functionName === 'postRound' ? source : ticket1,
      topics: v.encodeEventTopics({ abi, eventName, args: values }),
      data: v.encodeAbiParameters(nonIndexed, dataValues) };
  };
  model.apply = tx => {
    const { functionName, args = [] } = v.decodeFunctionData({ abi, data: tx.data });
    model.sent.push({ ...tx, functionName, args });
    model.nonce++;
    model.block++;
    const t = model.tickets.get(tx.to.toLowerCase());
    assert.equal(backupError(functionName, args), null, 'send obeys the on-chain backup checks');
    if (functionName === 'startBackup') model.backups.set(args[0], [model.now, model.block + 256n, 0n, v.zeroHash]);
    else if (functionName === 'fixBackup') {
      const b = model.backups.get(args[0]);
      b[2] = model.now; b[3] = model.blockData(b[1]).block.mixHash;
    } else if (functionName === 'postRound') {
      assert.equal(tx.to.toLowerCase(), source, 'postRound belongs on DRAND');
      model.posted.set(args[0], model.now);
    }
    else if (functionName === 'requestGraduationWord') {
      t.state.wordRequestedAt = model.now;
      t.requests.set(0n, { requestedAt: model.now, round: (model.now + 12n - 1692803367n + 2n) / 3n + 1n });
    } else if (functionName === 'acceptGraduationWord') {
      t.state.wordAcceptedAt = model.now;
      t.phase = 3;
    } else assert.fail(`forbidden send ${functionName}`);
    const hash = v.keccak256(v.toHex(`transaction ${model.nonce}`));
    model.receipts.set(hash, { transactionHash: hash, status: model.receiptStatus ?? '0x1',
      blockNumber: hex(model.block), blockHash: v.zeroHash, from: tx.from ?? accounts.privateKeyToAccount(key).address,
      to: tx.to, transactionIndex: '0x0', cumulativeGasUsed: hex(model.gas), gasUsed: hex(model.gas),
      effectiveGasPrice: '0x1', logsBloom: `0x${'00'.repeat(256)}`, type: '0x2',
      logs: model.noLogs || functionName === 'requestGraduationWord' ? [] : [logFor(functionName, args)] });
    return hash;
  };
  model.rpc = async (method, params) => {
    model.calls.push({ method, params });
    assert.notEqual(method, 'eth_getLogs', 'discovery must never request logs');
    if (model.rpcHook) {
      const result = await model.rpcHook(method, params);
      if (result !== undefined) return result;
    }
    if (method === 'eth_chainId') return hex(model.chain);
    if (method === 'eth_getBlockByNumber') {
      if (params[0] === 'finalized') return { number: hex(model.finalized) };
      const n = params[0] === 'latest' ? model.block : BigInt(params[0]);
      if (params[0] === 'latest') return { ...model.blockData(n).block, timestamp: hex(model.now), baseFeePerGas: hex(model.base), gasLimit: hex(model.gasLimit) };
      return model.blockData(n).block;
    }
    if (method === 'debug_getRawHeader') {
      if (!model.rawHeaders) throw { code: -32601, data: '0x', message: model.env.RESCUE_RPC };
      return model.blockData(BigInt(params[0])).raw;
    }
    if (method === 'eth_getCode') {
      assert.equal(params[1], hex(model.block));
      return params[0].toLowerCase() === source ? model.code : params[0].toLowerCase() === backed ? model.backedCode : '0x6000';
    }
    if (method === 'eth_maxPriorityFeePerGas') return hex(model.tip);
    if (method === 'eth_getBalance') return hex(model.balance);
    if (method === 'eth_getTransactionCount') return hex(model.nonce);
    if (method === 'eth_estimateGas') {
      const tx = params[0];
      // Geth/Anvil cap affordable gas when an estimate supplies a nonzero fee cap.
      const feeCap = BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? '0x0');
      if (feeCap * model.gas + BigInt(tx.value ?? '0x0') > model.balance) {
        throw { code: -32000, data: '0x', message: 'insufficient funds for gas * price + value' };
      }
      return hex(model.gas);
    }
    if (method === 'eth_getTransactionReceipt') return model.receipts.get(params[0]) ?? null;
    if (method === 'eth_sendRawTransaction') {
      const tx = v.parseTransaction(params[0]);
      assert.equal(tx.chainId, 11155111);
      assert.equal(tx.value ?? 0n, 0n);
      return model.apply(tx);
    }
    if (method === 'eth_call') {
      assert.equal(params[1], hex(model.block), 'all calls must use the snapshot block');
      const { functionName: fn, args = [] } = v.decodeFunctionData({ abi, data: params[0].data });
      const t = model.tickets.get(params[0].to.toLowerCase());
      const result = value => v.encodeFunctionResult({ abi, functionName: fn, result: value });
      if (fn === 'DRAND') return result(model.drand);
      if (fn === 'backupOf') return result(model.backups.get(args[0]) ?? [0n, 0n, 0n, v.zeroHash]);
      if (fn === 'source') return result(t.source);
      if (fn === 'status') return result(t.state);
      if (fn === 'phase') return result(t.phase);
      if (fn === 'vault') return result(vault);
      if (fn === 'gateOpenedAt') return result([...model.tickets.values()][0].gate);
      if (fn === 'coordinatorOf') { assert.equal(args[0], 0n); return result(coordinator); }
      if (fn === 'tickets') return result(ticket1);
      if (fn === 'requestOf' || fn === 'wordOf') {
        const q = model.tickets.get(args[0].toLowerCase()).requests.get(args[1]);
        assert.ok(q, `unexpected key ${args[1]}`);
        if (fn === 'requestOf') return result([q.requestedAt, q.round]);
        const backup = params[0].to.toLowerCase() === backed && model.backups.get(q.round);
        const at = backup?.[0] ? backup[2] : model.posted.get(q.round) ?? 0n;
        return result([at === 0n ? v.zeroHash : (q.word ?? `0x${'12'.repeat(32)}`), at]);
      }
      assert.ok(['postRound', 'acceptGraduationWord', 'requestGraduationWord', 'startBackup', 'fixBackup'].includes(fn));
      model.simulations.push({ fn, args, from: params[0].from });
      const failure = model.simulate?.(fn, args) ?? backupError(fn, args) ?? (fn === 'postRound' && model.posted.has(args[0]) ? 'RoundKnown' : null);
      if (failure) throw { code: 3, data: v.encodeErrorResult({ abi, errorName: failure,
        args: abi.find(e => e.type === 'error' && e.name === failure).inputs.map((_, i) => typeof args[i] === 'bigint' ? args[i] : 0n) }), message: model.env.RESCUE_RPC };
      if (fn === 'acceptGraduationWord') {
        const q = t.requests.get(0n);
        const b = t.source === backed && model.backups.get(q.round);
        assert.ok(b?.[0] ? b[2] : model.posted.has(q.round), 'cannot accept before a post or fix');
      }
      return result(fn === 'startBackup' ? model.block + 256n : ['postRound', 'fixBackup'].includes(fn) ? v.zeroHash : undefined);
    }
    assert.fail(`unexpected RPC ${method}`);
  };
  model.io = {
    env: model.env, stdin: Readable.from(['yes\n']),
    stdout: { write: text => { model.out += text; } }, stderr: { write: text => { model.err += text; } },
    fetch: async (url, init) => {
      if (url === model.env.RESCUE_RPC) {
        const req = JSON.parse(init.body);
        try { return Response.json({ jsonrpc: '2.0', id: req.id, result: await model.rpc(req.method, req.params) }); }
        catch (error) {
          if (!error.code || !error.data) throw error;
          return Response.json({ jsonrpc: '2.0', id: req.id, error });
        }
      }
      if (url === `${model.env.MAIL_URL}/alert`) {
        model.mail.push({ url, init });
        if (model.mailer) return model.mailer(url, init);
        return Response.json({ id: 'offline' }, { status: model.mailStatus ?? 202 });
      }
      model.relays.push({ url, init });
      if (model.relay) return model.relay(url, init, model.relays.length);
      return Response.json(answer(BigInt(url.split('/').at(-1))));
    },
    spawn: (binary, args, opts) => {
      model.cast.push({ binary, args, opts });
      const child = new EventEmitter();
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.kill = () => {};
      queueMicrotask(() => {
        let output = accounts.privateKeyToAccount(key).address;
        if (args[0] === 'send') {
          const pos = args.findIndex(a => [source, backed, ticket1, ticket2].includes(a.toLowerCase()));
          const signature = args[pos + 1];
          const fn = signature.split('(')[0];
          const values = fn === 'startBackup' ? [BigInt(args[pos + 2]), BigInt(args[pos + 3]), args[pos + 4]]
            : ['postRound', 'fixBackup'].includes(fn) ? [BigInt(args[pos + 2]), args[pos + 3]] : [];
          const hash = model.apply({ to: args[pos], data: v.encodeFunctionData({ abi, functionName: fn, args: values }) });
          output = JSON.stringify({ transactionHash: hash });
        }
        child.stdout.push(output);
        child.stdout.push(null);
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    },
  };
  model.args = ['--rpc-env', 'RESCUE_RPC', '--tickets', ticket1, '--key-env', 'RESCUE_KEY', '--yes'];
  model.safe = () => {
    for (const secret of [model.env.RESCUE_RPC, key, token, marker]) assert.ok(!(model.out + model.err + model.mail.map(m => m.init.body).join('')).includes(secret));
  };
  return model;
}
export function manifest(overrides = {}) {
  mkdirSync(new URL('.cache/drand-rescue/', root), { recursive: true });
  const path = new URL(`.cache/drand-rescue/manifest-${randomBytes(5).toString('hex')}.json`, root);
  writeFileSync(path, JSON.stringify({ schema: 'squarehole.core-deployment/v1', status: 'deployed', chainId: 11155111,
    versions: [{ version: 2 }, { version: 1, registry: { address: registry, codeHash: v.keccak256('0x6000') } }],
    ...overrides }));
  return path.pathname;
}
