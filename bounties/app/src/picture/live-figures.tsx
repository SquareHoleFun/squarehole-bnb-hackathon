/**
 * SH-319: the panels of a launched token's page share what they already read (the pile, the rules, the holders'
 * stake, the card shops) with the page's picture. Nothing here reads the chain; outside a page that listens, sharing
 * does nothing.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { LiveFigures } from './live-picture';

type Share = <K extends keyof LiveFigures>(key: K, value: LiveFigures[K] | undefined) => void;

const ShareContext = createContext<Share | null>(null);

/** The page's provider: wrap the page in it with the `share` of useLiveFigures. */
export const FiguresShare = ShareContext.Provider;

/** The page's figures and the function its panels share through. */
export function useLiveFigures(): [LiveFigures, Share] {
  const [figures, setFigures] = useState<LiveFigures>({});
  const share = useCallback<Share>((key, value) => setFigures((old) => (old[key] === value ? old : { ...old, [key]: value })), []);
  return [figures, share];
}

const signature = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x)) ?? '';

/** A panel shares one figure (undefined while it has none); shared again only when it changes, taken back on leaving. */
export function useShareFigure<K extends keyof LiveFigures>(key: K, value: LiveFigures[K] | undefined): void {
  const share = useContext(ShareContext);
  const latest = useRef(value);
  latest.current = value;
  const sig = signature(value);
  useEffect(() => {
    share?.(key, latest.current);
  }, [share, key, sig]);
  useEffect(() => () => share?.(key, undefined), [share, key]);
}
