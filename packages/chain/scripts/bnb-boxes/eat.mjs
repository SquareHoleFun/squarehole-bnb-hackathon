/**
 * SH-286: the life of a box whose fees EAT its price coin (a coin launched on another platform): bought into on the
 * curve, filled, graduated, then its waiting price coin eaten (sent to 0xdEaD, or burned where the listing records a
 * checked burn); traded after graduation (the sale fees sold for the price coin), collected, eaten again. Every eat is
 * proven from its own receipt: `PriceCoinEaten` with a positive amount, the receiver's `eatenP` grown by exactly it,
 * and the coin's balance at 0xdEaD grown by exactly it (or, burned, its supply down by exactly it).
 */
import assert from 'node:assert/strict';
import { erc20Abi, parseAbi } from 'viem';
import './ts.mjs';
import { readBox, buy, sell, afterGraduationTrades } from './life.mjs';

const coreV2 = await import('../../../../packages/chain/src/core/v2/index.ts');
const DEAD = '0x000000000000000000000000000000000000dEaD';
const EAT = parseAbi([
  'function eatPriceCoin() returns (uint256)',
  'function eatPendingP() view returns (uint256)',
  'function eatenP() view returns (uint256)',
  'function priceBurnSelector() view returns (bytes4)',
  'event PriceCoinEaten(address indexed asset, uint256 amount, uint256 total, bool burned)',
]);

/** One collect; its Collected event (the buyers' and sellers' price coin it booked). */
async function collect(chain, box, keeper, label) {
  return chain.act(`collect ${label}`, async () => {
    const receipt = await chain.send(keeper, box.receiver, coreV2.receiverV2Abi, 'collect', ['0x0000000000000000000000000000000000000000']);
    const [collected] = chain.events(receipt, coreV2.receiverV2Abi, 'Collected', box.receiver);
    assert.ok(collected, `collect ${label}: Collected`);
    return { hash: receipt.transactionHash, block: receipt.blockNumber, buyersP: collected.buyersP, sellersP: collected.sellersP,
      eatPending: await chain.read(box.receiver, EAT, 'eatPendingP', [], receipt.blockNumber) };
  });
}

/** One eat: what waits goes to 0xdEaD (or burns), shown by its own receipt and the reads at its block. */
async function eat(chain, box, keeper, label) {
  return chain.act(`eat ${label}`, async () => {
    const receipt = await chain.send(keeper, box.receiver, EAT, 'eatPriceCoin');
    const at = receipt.blockNumber;
    const [event] = chain.events(receipt, EAT, 'PriceCoinEaten', box.receiver);
    assert.ok(event && event.amount > 0n, `eat ${label}: a positive PriceCoinEaten in ${receipt.transactionHash}`);
    const read = (address, abi, fn, args, block) => chain.read(address, abi, fn, args, block);
    const eaten = [await read(box.receiver, EAT, 'eatenP', [], at - 1n), await read(box.receiver, EAT, 'eatenP', [], at)];
    assert.equal(eaten[1] - eaten[0], event.amount, `eat ${label}: eatenP grew by exactly the amount`);
    if (event.burned) {
      const supply = [await read(box.p, erc20Abi, 'totalSupply', [], at - 1n), await read(box.p, erc20Abi, 'totalSupply', [], at)];
      assert.equal(supply[0] - supply[1], event.amount, `eat ${label}: the coin's supply fell by exactly the amount`);
    } else {
      const dead = [await read(box.p, erc20Abi, 'balanceOf', [DEAD], at - 1n), await read(box.p, erc20Abi, 'balanceOf', [DEAD], at)];
      assert.equal(dead[1] - dead[0], event.amount, `eat ${label}: 0xdEaD received exactly the amount`);
    }
    return { hash: receipt.transactionHash, amount: event.amount, total: event.total, burned: event.burned };
  });
}

export async function eatLife(chain, coordinator, { swapper, keeper, a, b, tradeAfter = null }) {
  const box = await readBox(chain, coordinator);
  const collects = [];
  await chain.act('past the launch window', async () => { await chain.mineTo((await chain.read(box.hook, coreV2.hookV2Abi, 'windowEndsAt')) + 1n); return chain.now(); });
  const tenth = box.raise / 10n;
  const boughtA = await chain.act('raising: A buys a tenth', () => buy(chain, box, a, tenth, swapper));
  await chain.act('raising: B buys a tenth', () => buy(chain, box, b, tenth, swapper));
  await chain.act('raising: A sells a quarter', () => sell(chain, box, a, boughtA / 4n, swapper));
  collects.push(await collect(chain, box, keeper, 'raising'));
  for (let i = 1; i <= 6; i += 1) {
    const filled = await chain.act(`fill ${i}`, async () => {
      if (await chain.remember('closed', () => chain.read(box.hook, coreV2.hookV2Abi, 'closed'))) return 'closed';
      return buy(chain, box, a, box.raise / 4n, swapper);
    });
    if (filled === 'closed') break;
  }
  assert.ok(await chain.read(box.hook, coreV2.hookV2Abi, 'closed'), 'the curve filled');
  collects.push(await collect(chain, box, keeper, 'filled'));
  // Graduated already (read before a send, kept): accepted; otherwise the keeper's graduate, its receipt required.
  await chain.act('graduate', async () => {
    if (await chain.remember('graduated', () => chain.read(box.coordinator, coreV2.coordinatorV2Abi, 'graduated'))) return 'already';
    return (await chain.send(keeper, box.coordinator, coreV2.coordinatorV2Abi, 'graduate')).transactionHash;
  });
  collects.push(await collect(chain, box, keeper, 'graduated'));
  const eats = [await eat(chain, box, keeper, 'the fees of the raise')];
  // After graduation: trades, their sale fees sold for the price coin (a positive FeesSold), collected, eaten.
  const sold = await afterGraduationTrades(chain, box, { keeper, b, amount: tradeAfter ?? tenth, swapper });
  collects.push(await collect(chain, box, keeper, 'after graduation'));
  assert.ok(collects.at(-1).sellersP > 0n, 'the sellers\' fees sold were collected');
  eats.push(await eat(chain, box, keeper, 'the fees after graduation'));
  const total = eats.reduce((n, e) => n + BigInt(e.amount), 0n);
  assert.ok(eats.every(e => BigInt(e.amount) > 0n), 'every eat moved the price coin');
  return { box: { coordinator, token: box.token, p: box.p, raise: box.raise, receiver: box.receiver }, collects, feesSold: sold, eats, total, gasPaid: chain.gasPaid() };
}
