/**
 * "Start from a template" (F128): one tile per generic recipe (icon, a 1-3 word name, one short line) and Blank, at the
 * start of the v2 flow. A tile is a button: pressing it fills the recipe's fields (templates.ts), never the price coin,
 * a name or a ticker; the one last chosen stays pressed while the creator changes anything after it.
 * SH-218 rail 2: a tile the release switched off (`off`) stays in the row, `aria-disabled` and focusable, refuses a press,
 * and the row says so once (line A, create-options-words.ts).
 */
import { useId, type ReactNode } from 'react';
import { TemplateIcon } from '../../brand/template-icons';
import { TEMPLATES, type Template } from './templates';
import { OffLine } from './CreateOptionsLines';

const NONE_OFF = (): boolean => false;

/**
 * SH-251: `art`, the picture way's small box in place of the icon (create/picture/TemplateArt.tsx); absent on the steps,
 * which keep their icon. The tile, its press and its switched-off rule are this row's, the same on both ways.
 */
export function TemplateRow({ current, onPick, templates = TEMPLATES, off = NONE_OFF, art }: { current: string | null; onPick: (template: Template) => void; templates?: readonly Template[]; off?: (template: Template) => boolean; art?: (template: Template) => ReactNode }) {
  const titleId = useId();
  const offId = useId();
  const anyOff = templates.some(off);
  return (
    <section className="sh-v2-templates" aria-labelledby={titleId}>
      <h2 id={titleId} className="sh-newbox-label">Start from a template</h2>
      <ul className="sh-v2-templates__row">
        {templates.map((template) => (
          <li key={template.id}>
            <button type="button" className="sh-v2-template" aria-pressed={current === template.id} data-template={template.id}
              aria-disabled={off(template) ? 'true' : undefined} aria-describedby={off(template) ? offId : undefined} onClick={() => { if (!off(template)) onPick(template); }}>
              <span className="sh-v2-template__icon">{art ? art(template) : <TemplateIcon id={template.id} size={32} decorative />}</span>
              <span className="sh-v2-template__name">{template.name}</span>
              <small className="sh-v2-template__tag">{template.line}</small>
            </button>
          </li>
        ))}
      </ul>
      {anyOff ? <OffLine id={offId} /> : null}
    </section>
  );
}
