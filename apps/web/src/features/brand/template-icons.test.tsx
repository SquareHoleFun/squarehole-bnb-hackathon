/** F128 template icons (template-icons.tsx): one per generic recipe and Blank; named images by default, decorative on request, one drawing style. */
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { TEMPLATE_ICONS, TemplateIcon, isTemplateIconId, type TemplateIconId } from './template-icons';

afterEach(cleanup);
const IDS = Object.keys(TEMPLATE_ICONS) as TemplateIconId[];

describe('F128 template icons', () => {
  it('each is an image named after its template, at the size asked for', () => {
    render(<>{IDS.map((id) => <TemplateIcon key={id} id={id} size={32} />)}</>);
    for (const id of IDS) {
      const icon = screen.getByRole('img', { name: TEMPLATE_ICONS[id].name });
      expect(icon.getAttribute('width')).toBe('32'); expect(icon.getAttribute('data-icon')).toBe(id);
    }
    expect(IDS).toEqual(['liquidity', 'burn', 'creator', 'holders', 'collection', 'collection-burn', 'pile', 'alchemist-pile', 'shop', 'blank']);
    expect(screen.getByRole('img', { name: 'Collection that burns' })).toBeTruthy();
  });

  it('beside its name it is decorative: hidden from screen readers; a label can rename it', () => {
    const { container } = render(<><TemplateIcon id="burn" decorative /><TemplateIcon id="blank" label="Start empty" /></>);
    expect(screen.queryByRole('img', { name: 'Burn' })).toBeNull();
    expect(container.querySelector('[data-icon="burn"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('img', { name: 'Start empty' })).toBeTruthy();
  });

  it('one drawing style: a 24-unit grid, a 1.9 stroke in the current colour, round ends, no fill or colour of its own', () => {
    for (const id of IDS) {
      const markup = renderToStaticMarkup(<TemplateIcon id={id} />);
      expect(markup).toContain('viewBox="0 0 24 24"');
      expect(markup).toContain('stroke="currentColor"'); expect(markup).toContain('stroke-width="1.9"');
      expect(markup).toContain('stroke-linecap="round"'); expect(markup).toContain('stroke-linejoin="round"');
      expect(markup.match(/fill="[^"]*"/g)).toEqual(['fill="none"']);
      expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|stroke="(?!currentColor)/i);
      // Everything inside the 24-unit square (the coordinates the paths start from).
      for (const n of (markup.match(/\b[xy]="([\d.]+)"/g) ?? []).map((m) => Number(m.split('"')[1]))) expect(n).toBeLessThanOrEqual(24);
    }
    expect(isTemplateIconId('pile')).toBe(true); expect(isTemplateIconId('gold-priced')).toBe(false); expect(isTemplateIconId('constructor')).toBe(false);
  });
});
