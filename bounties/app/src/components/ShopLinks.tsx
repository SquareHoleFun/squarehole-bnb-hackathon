/**
 * SH-288: the way from a token's page (a Flap sale, a Four.meme token) to its cards: the shops our factory made for
 * the token that this launch stands behind (lib/shop.ts `linkedShops`): the ones its rules name as a payee (`payees`),
 * else the ones its creator made (`creator`, or the Flap sale's creator from our launcher factories' events). Never a
 * shop by anyone else; nothing without a factory in the deployment file or a token. While the rules are unknown
 * (`payees === null`), the creator's links stay visible and the card previews wait.
 */
import { ShopCards } from './ShopCard';
import { useShopStock } from '../lib/use-shop-stock';
import type { Address } from 'viem';
import { useApp, useChainRead } from '../lib/app-context';
import { flapCreatorOf, linkedShops } from '../lib/shop';
import { useShareFigure } from '../picture/live-figures';

export function ShopLinks({ token, symbol, creator, flapLauncher, payees }: { token?: Address; symbol: string; creator?: Address; flapLauncher?: Address; payees?: readonly Address[] | null }) {
  const { config } = useApp();
  const shops = useChainRead(async (c) => {
    if (!token || !config.shops) return undefined;
    const by = creator ?? (flapLauncher ? await flapCreatorOf(c, config, flapLauncher) : null);
    return linkedShops(c, config, token, { payees, creator: by });
  }, [token ?? '', config.shops?.factory ?? '', creator ?? '', flapLauncher ?? '', (payees ?? []).join(',')]);
  // SH-319: how many card shops, for the page's picture (this panel's own read).
  useShareFigure('shops', token && config.shops && shops.state === 'ok' && shops.value ? shops.value.length : undefined);
  if (!token || !config.shops || shops.state !== 'ok' || !shops.value || shops.value.length === 0) return null;
  return (
    <>
      {payees !== null && shops.value.map((shop) => <ShopPreview key={shop} shop={shop} />)}
      <p className="shop-links" data-testid="shop-links">
        {shops.value.map((shop) => (
          <a key={shop} className="btn" href={`#/shop/${shop}`}>{symbol} cards</a>
        ))}
      </p>
    </>
  );
}

function ShopPreview({ shop }: { shop: Address }) {
  const { ours, now } = useShopStock(shop);
  return ours?.tokenLive && now.state === 'ok' && now.value ? <ShopCards info={ours} cards={now.value.cards} /> : null;
}
