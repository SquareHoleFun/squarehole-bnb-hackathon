import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, zeroAddress } from 'viem';
import { expect } from '@playwright/test';
import * as transport from './chain.mjs';
import { contractReady, loadExamples } from '../../../../../packages/box-spec/examples/v2/registry.mjs';
import { ROOT } from './support.mjs';
import { priceSymbol } from '../../../../../packages/chain/scripts/create-example-v2.mjs';

// Expose private page functions without modifying the browser module for test access.
async function load(file, overrides = {}, exports = '') {
  const url = new URL(file, import.meta.url);
  const module = new SourceTextModule(readFileSync(url, 'utf8') + exports, { identifier: url.href });
  await module.link(async specifier => {
    const values = overrides[specifier] ?? await import(new URL(specifier, url).href);
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    });
  });
  await module.evaluate();
  return module.namespace;
}

const raw = readFileSync(new URL('.cache/examples-e2e/contract-replay.json', ROOT), 'utf8');
const result = JSON.parse(raw.slice(raw.indexOf('{')));
const runs = Object.values(result).flatMap(suite => Object.values(suite.test_results ?? {}));
assert.equal(runs.length, 14, 'generate all fourteen real-contract traces first with offline.mjs --json');
assert.ok(runs.every(run => run.status === 'Success'), 'the real-contract harness must pass before replay');
const examples = loadExamples();

function replay(run, mutate = () => {}) {
  const records = run.decoded_logs.filter(line => line.startsWith('REPLAY_')).map(line => line.split('|'));
  const id = records.find(row => row[0] === 'REPLAY_ID')[1];
  const example = examples.find(row => row.id === id);
  const types = ['address', 'address', 'address', 'address', 'address', 'address', 'address', 'uint256', 'address'].map(type => ({ type }));
  const [coordinator, token, hook, receiver, holderLedger, itemLedger, p, raise, keeper] = decodeAbiParameters(types, records.find(row => row[0] === 'REPLAY_BOX')[1]);
  const box = { coordinator, token, hook, receiver, holderLedger, itemLedger, p, raise };
  const chain = { accounts: { keeper } };
  const carry = records.find(row => row[0] === 'REPLAY_CARRY').slice(1).map(BigInt);
  let phase = 'before';
  const receipt = { transactionHash: '0x01', gasUsed: 0n, effectiveGasPrice: 0n, logs: records.filter(row => row[0] === 'REPLAY_LOG').map(row => {
    const [address, topics, data] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes32[]' }, { type: 'bytes' }], row[1]);
    return { address, topics, data };
  }) };
  const read = async (_chain, name, address, functionName, args = []) => {
    const abi = transport.artifact(name).abi;
    const calldata = encodeFunctionData({ abi, functionName, args });
    const row = records.find(row => row[0] === 'REPLAY_READ' && row[1] === phase && row[2].toLowerCase() === address.toLowerCase() && row[3] === calldata);
    assert.ok(row, `uncaptured ${id} ${phase} ${name}.${functionName}`);
    const value = decodeFunctionResult({ abi, functionName, data: row[4] });
    return mutate({ phase, name, address, functionName, args, value, box }) ?? value;
  };
  const balance = async (_chain, asset, address) => {
    const row = records.find(row => row[0] === 'REPLAY_BALANCE' && row[1] === phase && row[2].toLowerCase() === asset.toLowerCase() && row[3].toLowerCase() === address.toLowerCase());
    assert.ok(row, `uncaptured balance ${phase} ${asset} ${address}`);
    return BigInt(row[4]);
  };
  const call = async (_chain, name, address, method) => {
    assert.equal(phase, 'before'); assert.equal(address, coordinator); assert.equal(name, 'BoxCoordinatorV2');
    assert.equal(method, example.life === 'failure' ? 'fail' : 'graduate');
    phase = 'after'; return receipt;
  };
  return { example, box, chain, carry: { buyers: carry[0], sellers: carry[1] }, io: { ...transport, read, call, balance } };
}

for (const run of runs) {
  const { example } = replay(run);
  test(`${example.id}: browser accounting accepts the real EVM transition`, async () => {
    const r = replay(run); const evidence = {};
    const accounting = await load('./accounting.mjs', { './chain.mjs': r.io, '@playwright/test': { expect }, viem: await import('viem') });
    if (example.life === 'failure') {
      assert.equal(typeof accounting.fail, 'function', 'failure needs an independent pre-transition accounting helper');
      await accounting.fail(r.chain, r.example, r.box, r.carry, evidence);
      assert.ok(evidence.failureRouting.before.creatorP > 0n);
      assert.ok(evidence.failureRouting.expected.pot > 0n);
    } else {
      await accounting.graduate(r.chain, r.example, r.box, evidence);
      assert.ok(evidence.graduation.migration.qLeft > 0n, 'exercise real unused migration principal');
    }
  });
  for (const corruption of example.life === 'failure' ? ['pot', 'creator-to-fit', 'safe-destination'] : ['hook-remainder', 'migration-liquidity']) {
    test(`${example.id}: rejects one-unit ${corruption} corruption`, async () => {
      const r = replay(run, ({ phase, name, functionName, args, value, box }) => {
        if (phase !== 'after') return;
        if (corruption === 'hook-remainder' && name === 'PoolManager' && functionName === 'balanceOf' && args[0] === box.hook) return value - 1n;
        if (corruption === 'migration-liquidity' && functionName === 'pairedLiquidity') return value + 1n;
        if (['creator-to-fit', 'safe-destination'].includes(corruption) && functionName === 'fitOwed') return value + 1n;
        if (corruption === 'safe-destination' && functionName === 'platformOwed') return value - 1n;
        if ((corruption === 'pot' || corruption === 'creator-to-fit') && functionName === 'claimState') return [value[0] - 1n, value[1]];
        if ((corruption === 'pot' || corruption === 'creator-to-fit') && name === 'PoolManager' && functionName === 'balanceOf' && args[0] === box.coordinator) return value - 1n;
      });
      if (['pot', 'creator-to-fit'].includes(corruption)) {
        r.io.events = (...args) => transport.events(...args).map(event => args[3] === 'PotFixed' ? { ...event, pot: event.pot - 1n } : event);
      }
      const accounting = await load('./accounting.mjs', { './chain.mjs': r.io, '@playwright/test': { expect }, viem: await import('viem') });
      const action = example.life === 'failure'
        ? () => accounting.fail(r.chain, r.example, r.box, r.carry, {})
        : () => accounting.graduate(r.chain, r.example, r.box, {});
      await assert.rejects(action, error => error.name !== 'TypeError' && /expect\(|migration|failure/.test(error.message));
    });
  }
}

// Every current contract recipe, including one gated only on the site (FE12), keeps its page-unit check.
for (const example of examples.filter(contractReady)) {
  test(`${example.id}: exact box-page raise and claim units match the pinned renderer`, async () => {
    // The current renderer names the native coin ETH and a listed coin by its own symbol() (SH-BOX-LIFE-VIEW § 3): the
    // record's coin is coinLabelV2's, which the local coins answer with their stand-ins (TEST_* keys, priceSymbol).
    const renderer = readFileSync(new URL('apps/web/src/features/core/v2/record-v2.ts', ROOT), 'utf8');
    assert.match(renderer, /const coin = coinLabelV2\(record\.q, coinSymbol\);/);
    assert.match(renderer, /pairAsset: coin,/);
    const labels = readFileSync(new URL('apps/web/src/features/core/v2/price-coin.ts', ROOT), 'utf8');
    assert.match(labels, /if \(NATIVE\.test\(q\)\) return 'ETH';\s+return symbol \?\? shortCoinV2\(q\);/);
    const symbol = example.priceCoin.symbol === 'ETH' ? 'ETH' : priceSymbol(example.priceCoin.symbol);
    const p = symbol === 'ETH' ? zeroAddress : '0x0000000000000000000000000000000000000001';
    const box = { p, decimals: example.priceCoin.decimals === '6' ? 6 : 18, token: '0x02', coordinator: '0x03' };
    const at = { raise: BigInt(example.raise.amount), graduated: false, failed: false };
    const { formatUnits } = await import('viem');
    const main = `Recorded raise: ${formatUnits(at.raise, box.decimals)} ${symbol}`;
    const page = {
      goto: async () => {}, getByText: () => ({ click: async () => {} }),
      locator: selector => ({ text: selector === 'main' ? main : example.ticker, dom: true }),
      getByRole: role => ({ text: role === 'heading' ? example.name : '', dom: true }),
    };
    const pageExpect = value => value?.dom ? {
      toBeVisible: async () => {}, toHaveCount: async () => {},
      toHaveText: async text => assert.equal(value.text, text),
      toContainText: async text => assert.ok(value.text.includes(text), `page contains ${value.text}, expected ${text}`),
    } : expect(value);
    // Every double encodes through the ABI the browser read uses: a function that ABI lacks fails here as on chain.
    const io = { ...transport, read: async (_chain, name, _address, fn) => {
      encodeFunctionData({ abi: transport.artifact(name).abi, functionName: fn });
      if (fn === 'q') return p;
      throw new Error(`unexpected ${fn}`);
    } };
    const readContract = async ({ address, abi, functionName }) => {
      encodeFunctionData({ abi, functionName }); assert.equal(address, p);
      // As the local coins answer: TEST_* recipe keys carry their stand-in symbols (tGOLD, tFROG), as ExampleLives.t.sol pins.
      if (functionName === 'symbol') return priceSymbol(example.priceCoin.symbol);
      if (functionName === 'decimals') return box.decimals;
      throw new Error(`unexpected ${functionName}`);
    };
    const life = await load('./life.mjs', {
      './chain.mjs': io, '@playwright/test': { expect: pageExpect }, viem: await import('viem'),
      '../../../../../packages/box-spec/src/layout-v2.ts': { boxCurve: () => {} },
      '../../../../../packages/chain/scripts/local-core-v2-chain.mjs': {
        localClient: () => ({ readContract }), mineTo: () => {}, readLocalBox: async () => at,
      },
      // The page's Raise sheet as recordedRaise() returns it: its text with the (?) open (SH-255; once the Fees card).
      '../helpers.mjs': { boxPath: () => '/', recordedRaise: async () => main, openDetails: async () => {} },
      // The audited card at the head, as the real feed returns it once currentCard settles.
      './feed.mjs': { listedCard: async () => { throw new Error('unexpected listing wait'); },
        currentCard: async () => ({ ...at, failed: null, verified: true, stale: false, asOf: { block: '1' }, row: { record: { raise: example.raise.amount, q: p } } }) },
    }, '\nexport { pageState, amountText };');
    await life.pageState(page, {}, example, box);
    assert.equal(life.amountText(box, 1234567890123456789n, example.priceCoin.symbol), `${formatUnits(1234567890123456789n, box.decimals)} ${symbol}`, 'claims use the same exact unit as the raise');
  });
}
