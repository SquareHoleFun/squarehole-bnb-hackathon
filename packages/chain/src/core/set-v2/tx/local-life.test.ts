import { expect, it, vi } from 'vitest';
import { afterSetWindow, prepareFundedSetPick } from '../../../../scripts/lib/set-v2-local-actions.mjs';

it('af1 F2 waits for each completed box effective opening plus its hook window before an ordinary recipe', async()=>{
  let now=100n;
  const mine=vi.fn(async(at:bigint)=>{now=at;});
  for(const opening of [101n,900n]) {
    const recipe=vi.fn(async()=>{expect(now).toBeGreaterThanOrEqual(opening+384n);});
    await afterSetWindow({effectiveOpenAt:async()=>opening,windowSeconds:async()=>384n,mineTo:mine,recipe});
    expect(recipe).toHaveBeenCalledOnce();
  }
  expect(mine.mock.calls).toEqual([[485n],[1284n]]);
  const recipe=vi.fn();
  await expect(afterSetWindow({effectiveOpenAt:async()=>0n,windowSeconds:async()=>384n,mineTo:mine,recipe})).rejects.toThrow(/closed/);
  expect(recipe).not.toHaveBeenCalled();
});

it('af1 F3 buys real-pool shortfall before returning a fresh fee-inclusive pick quote and pinned balance', async()=>{
  let block=1n,held=797058867754607625913344077n;
  const needed=839093554684395535846756857n;
  const prepare=vi.fn(async()=>({blockNumber:block,quote:{tokenIn:needed+block},limit:needed*101n/100n}));
  const balance=vi.fn(async(at:bigint)=>{expect(at).toBe(block);return held;});
  const buy=vi.fn(async()=>{held+=25n*10n**24n;block++;});
  const result=await prepareFundedSetPick({prepare,balance,buy});
  expect(buy).toHaveBeenCalledTimes(2);
  expect(prepare).toHaveBeenCalledTimes(3);
  expect(result.blockNumber).toBe(3n);
  expect(held).toBeGreaterThanOrEqual(result.quote.tokenIn);
  expect(balance.mock.calls).toEqual([[1n],[2n],[3n]]);
});

it('af1 F3 refuses insufficient pool funding and skips buying when the fresh quote is already covered', async()=>{
  const prepare=async()=>({blockNumber:1n,quote:{tokenIn:84n}});
  const buy=vi.fn(async()=>{});
  await expect(prepareFundedSetPick({prepare,balance:async()=>79n,buy})).rejects.toThrow(/balance.*pick/);
  expect(buy).toHaveBeenCalledTimes(8);
  buy.mockClear();
  expect(await prepareFundedSetPick({prepare,balance:async()=>84n,buy})).toEqual(await prepare());
  expect(buy).not.toHaveBeenCalled();
});
