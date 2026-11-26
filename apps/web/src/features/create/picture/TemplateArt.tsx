/**
 * SH-251: a template's small picture, for the steps' own template row on the picture way (TemplateRow `art`): the same
 * box as the big picture, small, with the recipe's icon over its hole (box-picture/mini.ts). Decorative: the tile's name
 * says what it is.
 */
import { TemplateIcon } from '../../brand/template-icons';
import { MINI } from '../../box-picture/mini';
import type { Template } from '../v2/templates';

export function TemplateArt({ template }: { template: Template }) {
  return (
    <span className="sh-pic-mini__art" aria-hidden="true">
      <svg className="sh-pic-mini__box" viewBox={`0 0 ${MINI.width} ${MINI.height}`} focusable="false">
        <ellipse cx={MINI.shadow.cx} cy={MINI.shadow.cy} rx={MINI.shadow.rx} ry={MINI.shadow.ry} className="sh-pic-shadow" />
        <path d={MINI.top} className="sh-pic-mini__top" />
        <path d={MINI.front} className="sh-pic-mini__front" />
        <path d={MINI.hole} className="sh-pic-mini__hole" />
      </svg>
      <span className="sh-pic-mini__icon"><TemplateIcon id={template.id} size={16} decorative /></span>
    </span>
  );
}
