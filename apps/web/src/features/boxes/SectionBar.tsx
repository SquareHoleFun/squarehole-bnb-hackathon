/**
 * The section bar: the same four slots for every box (BOX-INTERFACE § 4), as tabs. The selected tab is in the URL
 * (`?tab=`, a Map allowlist), so a shared link opens the same section. Keyboard: Left/Right move and select (wrapping),
 * Home/End jump to the ends; only the selected tab is in the tab order.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

export interface Section<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

/**
 * The selected section from `?tab=`; without one, `fallback` (a token-only box opens on Token) or the first section.
 * Selecting the default drops the parameter, so the plain link stays the box's own.
 */
export function useSectionParam<Id extends string>(sections: readonly Section<Id>[], fallback?: Id): [Id, (id: Id) => void] {
  const [params, setParams] = useSearchParams();
  const allowed = new Map(sections.map((section) => [section.id as string, section.id]));
  const first = fallback !== undefined && allowed.has(fallback) ? fallback : sections[0]?.id;
  if (first === undefined) throw new Error('A section bar needs sections');
  const selected = allowed.get(params.get('tab') ?? '') ?? first;
  const select = (id: Id) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id === first) next.delete('tab');
        else next.set('tab', id);
        return next;
      },
      { replace: true },
    );
  return [selected, select];
}

export function SectionBar<Id extends string>({
  sections,
  selected,
  onSelect,
  label,
  idPrefix,
  children,
}: {
  sections: readonly Section<Id>[];
  selected: Id;
  onSelect: (id: Id) => void;
  label: string;
  idPrefix: string;
  children: ReactNode;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = sections.length - 1;
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1) : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (target === null) return;
    event.preventDefault();
    const section = sections[target];
    if (!section) return;
    onSelect(section.id);
    tabs.current[target]?.focus();
  }
  return (
    <>
      <div className="sh-box-sections" role="tablist" aria-label={label}>
        {sections.map((section, index) => (
          <button
            key={section.id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${section.id}`}
            className="sh-box-sections__tab"
            aria-selected={selected === section.id}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected === section.id ? 0 : -1}
            onClick={() => onSelect(section.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {section.label}
          </button>
        ))}
      </div>
      <section className="sh-box-panel" id={`${idPrefix}-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${selected}`}>
        {children}
      </section>
    </>
  );
}
