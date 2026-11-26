/**
 * SH-258 round 3: the BNB Chain testnet build's old pair page (build/bnb-variants.ts takes this file in place of
 * FitPairPage.tsx). Its routes lead to the feed there (routes.tsx). Same exports, nothing of box 0.
 */
import { Navigate } from 'react-router';

export interface FitPairPageProps {
  readonly build?: unknown;
}

export function FitPairPage() {
  return <Navigate replace to="/" />;
}
export default FitPairPage;
