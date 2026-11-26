import { useCallback, useState, useSyncExternalStore } from 'react';

/**
 * An element's rendered width in whole CSS pixels, kept current with a ResizeObserver, so the chart is drawn at its
 * real size (labels stay legible on phones instead of scaling down with a viewBox). `fallback` is used before the
 * element is measured and where there is no layout engine (jsdom).
 */
export function useElementWidth(fallback: number): readonly [ref: (element: HTMLElement | null) => void, width: number] {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!element || typeof ResizeObserver !== 'function') return () => undefined;
      const observer = new ResizeObserver(onChange);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [element],
  );
  const width = useSyncExternalStore(
    subscribe,
    () => {
      const measured = element ? Math.floor(element.getBoundingClientRect().width) : 0;
      return measured > 0 ? measured : fallback;
    },
    () => fallback,
  );
  return [setElement, width] as const;
}
