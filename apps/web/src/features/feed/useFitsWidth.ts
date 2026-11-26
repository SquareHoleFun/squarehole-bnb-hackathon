import { useCallback, useState, useSyncExternalStore } from 'react';

/**
 * Whether an element is at least `minWidth` CSS pixels wide, from the element's own box rather than the viewport.
 * The feed table needs room that depends on the sidebar, the icon rail and zoom, so a viewport media query cannot
 * tell whether it fits (02-DESIGN: never a sideways-scrolling table).
 *
 * Attach the returned callback ref. The width is read during layout (the ref commits before paint), so the first
 * frame already shows the right layout. Before the element is measured (first render, or no layout engine such as
 * jsdom) the answer is `whenUnmeasured`.
 */
export function useFitsWidth(
  minWidth: number,
  whenUnmeasured = true,
): readonly [ref: (element: HTMLElement | null) => void, fits: boolean] {
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
  const fits = useSyncExternalStore(
    subscribe,
    () => {
      const width = element ? element.getBoundingClientRect().width : 0;
      return width === 0 ? whenUnmeasured : width >= minWidth;
    },
    () => whenUnmeasured,
  );
  return [setElement, fits] as const;
}
