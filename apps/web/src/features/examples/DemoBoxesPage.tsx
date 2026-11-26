import { Link } from 'react-router';
import { TESTNET } from '@squarehole/chain/write/wallet';
import { boxPath, formatBoxId } from '../boxes/box-id';
import list from './demo-boxes-97.json' with { type: 'json' };

/**
 * SH-261: the Examples page of the BNB Chain testnet build. The explainer's page (ExamplesDoor) shows ETH coins and
 * Sepolia's price coins, so this build shows the demo boxes that exist on chain 97 instead: each one's name and ticker,
 * linked to its box page, which shows the box as the chain has it. The list is written by
 * packages/chain/scripts/bnb-boxes/demo-list.mjs from the real runs' state files and checked on the chain (each box
 * listed only with a GREEN read-back and the same token and spec hash at its coordinator). No picture, no amount.
 */
export interface DemoBox { readonly id: string; readonly name: string; readonly ticker: string; readonly chainId: number; readonly token: string }
export const DEMO_BOXES_97: readonly DemoBox[] = list.boxes;

/** The demo boxes this build offers: chain 97's in the BNB Chain testnet build, none in any other. */
export const demoBoxes = (): readonly DemoBox[] => DEMO_BOXES_97.filter((box) => box.chainId === TESTNET.chainId);

export function DemoBoxesPage({ boxes = demoBoxes() }: { readonly boxes?: readonly DemoBox[] }) {
  return (
    <section className="sh-page" aria-labelledby="sh-demo-boxes-title">
      <h1 id="sh-demo-boxes-title" className="sh-page__title">Examples</h1>
      <ul className="sh-demo-boxes">
        {boxes.map((box) => (
          <li key={box.id} data-demo-box={box.id}>
            <Link to={boxPath(formatBoxId(box.chainId, box.token))}>{box.name}</Link> <span>{box.ticker}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
