/**
 * The box pages' sheet: a side panel on wide screens, a bottom sheet on phones (the example sheet, the phone's
 * counters). A modal dialog: focus moves to its heading when it opens and back to what opened it when it closes; Tab
 * stays inside; Escape, Close and a tap on the backdrop close it.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function BoxSheet({ titleId, title, onClose, children, className = '' }: { titleId: string; title: ReactNode; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('h2')?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    // Keep focus in the sheet: wrap from the last control to the first and back.
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((element) => !element.closest('[hidden]'));
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = ref.current?.contains(active) ?? false;
    const onHeading = active instanceof HTMLElement && active.tagName === 'H2';
    if (event.shiftKey && (active === first || onHeading || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }
  return createPortal(
    <div className="sh-box-sheet__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={ref} className={`sh-box-sheet ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <div className="sh-box-sheet__head">
          <h2 id={titleId} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="sh-button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
