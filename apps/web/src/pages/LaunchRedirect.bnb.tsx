/**
 * SH-258 round 3: the BNB Chain testnet build's box 0 redirect (build/bnb-variants.ts takes this file in place of
 * LaunchRedirect.tsx). Its routes lead to the feed there (routes.tsx). Same exports, nothing of box 0.
 */
import { Navigate } from 'react-router';

export function LaunchRedirect() {
  return <Navigate replace to="/" />;
}
export default LaunchRedirect;
