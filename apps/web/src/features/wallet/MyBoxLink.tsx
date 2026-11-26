import { Link, useInRouterContext } from 'react-router';
import { MY_BOX_SHOWN } from '../../shell/nav-items';

/**
 * "Open My Box" in a connected wallet's window: a plain link to the wallet box of the connected account (view of what
 * it holds; opening it moves nothing). Outside a router (isolated wallet tests) it is left out.
 */
export function MyBoxLink({ onOpen }: { onOpen: () => void }) {
  const routed = useInRouterContext();
  // SH-276 B / SH-291: wherever the navigation shows My Box (every network since SH-291).
  if (!routed || !MY_BOX_SHOWN) return null;
  return (
    <Link to="/my-box" className="sh-wallet-dialog__mybox" onClick={onOpen}>
      Open My Box
    </Link>
  );
}
