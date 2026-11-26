import type { Address } from 'viem';
import { useApp, useChainRead } from './app-context';
import { readShopInfo, readShopNow } from './shop';

export function useShopStock(shop: Address, account?: Address) {
  const { config } = useApp();
  const info = useChainRead((c) => readShopInfo(c, config, shop), [shop]);
  const ours = info.state === 'ok' && info.value.kind === 'ours' ? info.value.info : null;
  const now = useChainRead((c) => (ours ? readShopNow(c, ours, account) : Promise.resolve(undefined)), [shop, ours !== null, account], {
    keepOnChange: true, owner: account ?? '', forOtherOwner: (v) => (v ? { ...v, balance: undefined, allowance: undefined } : v),
  });
  return { info, ours, now };
}
