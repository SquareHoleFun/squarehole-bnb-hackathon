#!/usr/bin/env node
/**
 * Read-only facts about BNB Chain testnet (chain id 97) for the indexer and the keeper (SH-259 Part 1).
 * Public endpoints only; it sends no transaction, holds no key and puts nothing of ours in a request (the log probes
 * read the testnet's WBNB, a public contract). Every answer is printed with the call that produced it.
 *
 *   node hackathon/scripts/chain97-probe.mjs [--quick]
 *
 * --quick skips the burst probes (rate limits). Exit code 0 unless no endpoint answered at all.
 */
const ENDPOINTS = [
  'https://bsc-testnet-dataseed.bnbchain.org',
  'https://bsc-testnet.bnbchain.org',
  'https://bsc-prebsc-dataseed.bnbchain.org',
  'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  'https://data-seed-prebsc-2-s1.bnbchain.org:8545',
  'https://data-seed-prebsc-1-s2.bnbchain.org:8545',
  'https://bsc-testnet-rpc.publicnode.com',
  'https://bsc-testnet.drpc.org',
  'https://bsc-testnet.public.blastapi.io',
  'https://endpoints.omniatech.io/v1/bsc/testnet/public',
  'https://bsc-testnet.blockpi.network/v1/rpc/public',
  'https://api.zan.top/bsc-testnet',
  'https://bnb-testnet.api.onfinality.io/public',
];
const WS_ENDPOINTS = ['wss://bsc-testnet-rpc.publicnode.com', 'wss://bsc-testnet.drpc.org'];
const WBNB = '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd';
const quick = process.argv.includes('--quick');
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const ms = (t0) => Math.round(performance.now() - t0);

let id = 0;
async function rpc(url, method, params = [], timeoutMs = 20_000) {
  const t0 = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, status: response.status, error: `HTTP ${response.status}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`, ms: ms(t0) }; }
    if (body.error) return { ok: false, status: response.status, code: body.error.code, error: String(body.error.message).slice(0, 120), ms: ms(t0) };
    return { ok: true, status: response.status, result: body.result, ms: ms(t0) };
  } catch (error) {
    return { ok: false, error: `${error.name}: ${String(error.message).slice(0, 80)}`, ms: ms(t0) };
  }
}

const say = (line) => process.stdout.write(`${line}\n`);

async function endpoint(url) {
  say(`=== ${url}`);
  const chain = await rpc(url, 'eth_chainId');
  if (!chain.ok) { say(`eth_chainId: ${chain.error}`); return null; }
  const [latest, safe, finalized] = await Promise.all(['latest', 'safe', 'finalized'].map((tag) => rpc(url, 'eth_getBlockByNumber', [tag, false])));
  if (!latest.ok || !latest.result) { say(`eth_getBlockByNumber(latest): ${latest.error ?? 'null'}`); return null; }
  const head = BigInt(latest.result.number);
  say(`eth_chainId ${BigInt(chain.result)}; latest ${head} (${latest.ms} ms)`);
  for (const [tag, answer] of [['safe', safe], ['finalized', finalized]]) {
    say(`eth_getBlockByNumber("${tag}"): ${answer.ok && answer.result ? `${head - BigInt(answer.result.number)} blocks behind latest` : answer.error ?? 'null'}`);
  }
  const ranges = {};
  for (const span of [100n, 1_000n, 5_000n, 10_000n, 50_000n]) {
    const answer = await rpc(url, 'eth_getLogs', [{ fromBlock: hex(head - span), toBlock: hex(head), address: WBNB }], 30_000);
    ranges[span] = answer.ok;
    say(`eth_getLogs over ${span} blocks (WBNB): ${answer.ok ? `${answer.result.length} logs` : answer.error} in ${answer.ms} ms`);
    if (!answer.ok && span >= 1_000n) break;
  }
  const near = await rpc(url, 'eth_getLogs', [{ fromBlock: hex(head - 2n), toBlock: 'latest', address: WBNB }]);
  say(`eth_getLogs [head-2, "latest"] (WBNB): ${near.ok ? `${near.result.length} logs` : near.error} in ${near.ms} ms`);
  const byHash = await rpc(url, 'eth_getLogs', [{ blockHash: latest.result.hash, address: WBNB }]);
  say(`eth_getLogs by blockHash (EIP-234): ${byHash.ok ? `${byHash.result.length} logs` : byHash.error} in ${byHash.ms} ms`);
  return { url, head, logs: ranges[100n] === true, ranges };
}

/** Requests in parallel waves; counts answers, refusals by kind, and the time taken. */
async function burst(url, label, total, concurrency, call) {
  const t0 = performance.now();
  const kinds = new Map();
  let next = 0;
  const worker = async () => {
    while (next < total) {
      next += 1;
      const answer = await call();
      const kind = answer.ok ? 'ok' : `${answer.status ?? '-'} ${answer.code ?? ''} ${answer.error}`.trim().slice(0, 90);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const seconds = (performance.now() - t0) / 1000;
  say(`burst ${label} on ${url}: ${total} requests, ${concurrency} at a time, ${seconds.toFixed(1)} s (${(total / seconds).toFixed(1)}/s): ${[...kinds].map(([k, n]) => `${n} ${k}`).join('; ')}`);
}

async function ws(url) {
  if (typeof WebSocket === 'undefined') { say(`${url}: no WebSocket in this Node`); return; }
  const heads = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); resolve(); }, 12_000);
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'eth_subscription') heads.push({ number: BigInt(message.params.result.number), at: performance.now() });
      if (message.error) { say(`${url}: ${message.error.message}`); clearTimeout(timer); socket.close(); resolve(); }
    };
    socket.onerror = () => { say(`${url}: socket error`); clearTimeout(timer); resolve(); };
  });
  const span = heads.length > 1 ? Number(heads.at(-1).number - heads[0].number) : 0;
  say(`newHeads over WebSocket ${url}: ${heads.length} heads in ${((performance.now() - t0) / 1000).toFixed(1)} s, block numbers advanced ${span}`);
}

async function chainFacts(url) {
  say(`=== chain facts (${url})`);
  const gasPrice = await rpc(url, 'eth_gasPrice');
  const tip = await rpc(url, 'eth_maxPriorityFeePerGas');
  say(`eth_gasPrice: ${gasPrice.ok ? `${BigInt(gasPrice.result)} wei` : gasPrice.error}; eth_maxPriorityFeePerGas: ${tip.ok ? `${BigInt(tip.result)} wei` : tip.error}`);
  const history = await rpc(url, 'eth_feeHistory', [hex(20), 'latest', [10, 50, 90]]);
  if (history.ok) {
    const base = [...new Set(history.result.baseFeePerGas.map((v) => BigInt(v).toString()))];
    const rewards = history.result.reward.flat().map((v) => BigInt(v));
    const min = rewards.reduce((a, b) => (b < a ? b : a), rewards[0] ?? 0n);
    const max = rewards.reduce((a, b) => (b > a ? b : a), rewards[0] ?? 0n);
    say(`eth_feeHistory(20 blocks, [10,50,90]): base fees seen ${base.join(', ')} wei; priority fees paid ${min} to ${max} wei`);
  } else say(`eth_feeHistory: ${history.error}`);
  const latest = await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
  const head = BigInt(latest.result.number);
  say(`latest block keys: ${Object.keys(latest.result).sort().join(',')}`);
  const types = new Map();
  let blocks = 0;
  for (let n = head; n > head - 200n; n -= 1n) {
    const block = await rpc(url, 'eth_getBlockByNumber', [hex(n), true]);
    if (!block.ok || !block.result) continue;
    blocks += 1;
    for (const tx of block.result.transactions) types.set(tx.type, (types.get(tx.type) ?? 0) + 1);
  }
  say(`transaction types in the last ${blocks} blocks: ${[...types].sort().map(([t, n]) => `type ${t}: ${n}`).join(', ')}`);
  const pace = await rpc(url, 'eth_getBlockByNumber', [hex(head - 2_000n), false]);
  if (pace.ok) {
    const stamp = (b) => (b.milliTimestamp ? BigInt(b.milliTimestamp) : BigInt(b.timestamp) * 1000n);
    say(`2000 blocks took ${stamp(latest.result) - stamp(pace.result)} ms (milliTimestamp): ${Number(stamp(latest.result) - stamp(pace.result)) / 2000} ms a block`);
  }
  const config = await rpc(url, 'eth_config');
  say(`eth_config (EIP-7910): ${config.ok ? JSON.stringify(config.result).slice(0, 600) : config.error}`);
  // EIP-7825 (Osaka): a transaction gas limit above 2^24 is refused; at 2^24 a plain call runs.
  for (const gas of [16_777_216n, 16_777_217n]) {
    const answer = await rpc(url, 'eth_call', [{ to: '0x000000000000000000000000000000000000dEaD', gas: hex(gas) }, 'latest']);
    say(`eth_call with gas ${gas}: ${answer.ok ? `answers ${answer.result}` : answer.error}`);
  }
  // CLZ (EIP-7939, Osaka): init code PUSH1 1, CLZ, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN; returns 255 if CLZ runs.
  const clz = await rpc(url, 'eth_call', [{ data: '0x60011e60005260206000f3' }, 'latest']);
  say(`eth_call of init code using CLZ (0x1e): ${clz.ok ? `returns ${BigInt(clz.result)}` : clz.error}`);
  // P256VERIFY (EIP-7951, Osaka) at 0x100: an invalid signature returns empty output if the precompile exists.
  const p256 = await rpc(url, 'eth_call', [{ to: '0x0000000000000000000000000000000000000100', data: `0x${'00'.repeat(160)}`, gas: hex(100_000) }, 'latest']);
  const p256Code = await rpc(url, 'eth_estimateGas', [{ to: '0x0000000000000000000000000000000000000100', data: `0x${'00'.repeat(160)}` }, 'latest']);
  say(`P256VERIFY at 0x100: eth_call ${p256.ok ? `returns ${p256.result}` : p256.error}; eth_estimateGas ${p256Code.ok ? BigInt(p256Code.result) : p256Code.error} (a plain empty account costs 21000 plus calldata)`);
  for (const [address, name, bytes] of [['0x0b', 'BLS12_G1ADD', 256], ['0x0f', 'BLS12_PAIRING_CHECK', 0], ['0x10', 'BLS12_MAP_FP_TO_G1', 64], ['0x11', 'BLS12_MAP_FP2_TO_G2', 128]]) {
    const answer = await rpc(url, 'eth_call', [{ to: `0x${address.slice(2).padStart(40, '0')}`, data: `0x${'00'.repeat(bytes)}` }, 'latest']);
    say(`${name} at ${address}: ${answer.ok ? `returns ${(answer.result.length - 2) / 2} bytes` : answer.error}`);
  }
}

const answered = [];
for (const url of ENDPOINTS) {
  const found = await endpoint(url);
  if (found) answered.push(found);
}
if (answered.length === 0) { say('no endpoint answered'); process.exit(1); }
for (const url of WS_ENDPOINTS) await ws(url);
const facts = answered.find((e) => e.url.includes('publicnode')) ?? answered[0];
await chainFacts(facts.url);
if (!quick) {
  say('=== bursts (rate limits)');
  for (const e of answered) {
    await burst(e.url, 'eth_blockNumber', 60, 10, () => rpc(e.url, 'eth_blockNumber'));
    if (e.logs) {
      const head = e.head;
      let k = 0n;
      await burst(e.url, 'eth_getLogs over 100 blocks', 30, 6, () => rpc(e.url, 'eth_getLogs', [{ fromBlock: hex(head - 200n - 100n * (k += 1n)), toBlock: hex(head - 101n - 100n * k), address: WBNB }]));
    }
  }
}
say(`=== done ${new Date().toISOString()}`);
