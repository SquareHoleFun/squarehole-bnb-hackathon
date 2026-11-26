/**
 * SH-EXISTING-NFTS-E08C: a windowed list for up to 10,000 rows of equal height (a set's full list on the Overview, a
 * box's members on its page). Only the rows on screen (and a few around them) are in the page; the list keeps its
 * full height, so the scroll bar and the position are true. A screen reader hears each row's place in the whole list
 * (`aria-setsize`, `aria-posinset`); the scrolling region takes focus, so a keyboard scrolls it too.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import './set-list.css';

export interface VirtualListProps<T> {
  readonly items: readonly T[];
  /** Each row's height in pixels (rows never grow). */
  readonly rowHeight: number;
  /** The most the list takes on the page, in pixels; a short list takes only its rows. */
  readonly height: number;
  /** The list's accessible name. */
  readonly label: string;
  readonly keyOf: (item: T, index: number) => string;
  readonly render: (item: T, index: number) => ReactNode;
  /** Rows kept beyond each edge of the view. */
  readonly overscan?: number;
  readonly className?: string;
}

export function VirtualList<T>({ items, rowHeight, height, label, keyOf, render, overscan = 6, className }: VirtualListProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [view, setView] = useState(height);
  const total = items.length * rowHeight;
  const shown = Math.max(rowHeight, Math.min(height, total));
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setView(element.clientHeight > 0 ? element.clientHeight : shown);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);
  // A list that got shorter keeps its scroll position inside it.
  const scrolled = Math.min(top, Math.max(0, total - view));
  const first = Math.max(0, Math.floor(scrolled / rowHeight) - overscan);
  const last = Math.min(items.length, Math.ceil((scrolled + view) / rowHeight) + overscan);
  return (
    <div ref={ref} className={`sh-set-vlist${className ? ` ${className}` : ''}`} style={{ height: shown }} tabIndex={0} role="region" aria-label={label}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}>
      <ul className="sh-set-vlist__rows" aria-label={label} style={{ height: total }}>
        {items.slice(first, last).map((item, offset) => {
          const index = first + offset;
          return (
            <li key={keyOf(item, index)} className="sh-set-vlist__row" aria-setsize={items.length} aria-posinset={index + 1} style={{ top: index * rowHeight, height: rowHeight }}>
              {render(item, index)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
