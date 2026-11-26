import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORBIDDEN, forbiddenLabelNames, outsideRecipeChoices, RECIPE_CHOICES } from '../../../../e2e/trading-controls';
import { FeesStep } from './FeesStep';
import { DEMO_LISTINGS } from './listings';
import { INSIDE, pickFor } from './recipes';
import { required } from '../../core/v2/test-support/required';
import { TemplateRow } from './TemplateRow';
import { TEMPLATES } from './templates';

const violations = () => [
  ...outsideRecipeChoices(screen.queryAllByRole('button', { name: FORBIDDEN }), RECIPE_CHOICES),
  ...['link', 'radio', 'textbox'].flatMap((role) => screen.queryAllByRole(role, { name: FORBIDDEN }).map((element) => element.textContent ?? element.getAttribute('aria-label'))),
  ...forbiddenLabelNames(document.body, RECIPE_CHOICES),
];
afterEach(cleanup);

describe('SH-194-af2: the trading audit scopes recipe descriptions to their controls', () => {
  it('accepts the real template descriptions; pressing them selects only their recipes', () => {
    const onPick = vi.fn();
    render(<TemplateRow current={null} onPick={onPick} />);
    expect(screen.getAllByRole('button', { name: /Buy back and burn/ })).toHaveLength(2);
    expect(violations()).toEqual([]);
    for (const id of ['burn', 'collection-burn']) {
      const template = TEMPLATES.find((entry) => entry.id === id);
      if (!template) throw new Error(id);
      fireEvent.click(screen.getByRole('button', { name: `${template.name}${template.line}` }));
      expect(onPick).toHaveBeenLastCalledWith(template);
    }
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it.each(['Buy', 'Sell', 'Swap', 'Buy back and burn GOWL'])(
    'rejects a real %s button outside the template row, even with templates on the page', (name) => {
      render(<><TemplateRow current={null} onPick={vi.fn()} /><button>{name}</button></>);
      expect(violations()).toContain(name);
    },
  );

  it('rejects a real trading button added inside the row and a template button copied outside it', () => {
    const view = render(<TemplateRow current={null} onPick={vi.fn()} />);
    const row = required(document.querySelector('.sh-v2-templates__row'));
    const real = document.createElement('button');
    real.textContent = 'Buy';
    row.append(real);
    const template = required(document.querySelector('[data-template="burn"]'));
    view.container.append(template.cloneNode(true));
    expect(violations()).toEqual(['Buy', template.textContent]);
  });

  it('accepts only the marked fee choices in their fee groups; their presses still choose recipes', () => {
    const set = vi.fn();
    const pricing = required(DEMO_LISTINGS[0]);
    render(<FeesStep buyers={pickFor('burn')} sellers={pickFor('items', INSIDE.burn)}
      ctx={{ pricing, listings: [pricing], ticker: 'GOWL' }} collection errorFor={() => null} set={set} />);
    expect(violations()).toEqual([]);
    fireEvent.click(required(screen.getAllByRole('button', { name: 'Buy back and burn GOWL' })[0]));
    expect(set).toHaveBeenLastCalledWith({ buyers: pickFor('burn') });
    fireEvent.click(screen.getByRole('button', { name: 'Buy back and burn GOWL in the vault' }));
    expect(set).toHaveBeenLastCalledWith({ sellers: pickFor('items', INSIDE.burn) });
    expect(set).toHaveBeenCalledTimes(2);
    const group = required(document.querySelector('#create-v2-buyers > .sh-newbox-chips__row'));
    const real = document.createElement('button');
    real.textContent = 'Buy back and burn GOWL';
    group.append(real);
    expect(violations()).toEqual(['Buy back and burn GOWL']);
  });

  it.each([
    <a key="link" href="/trade">Buy back and burn GOWL</a>,
    <input key="radio" type="radio" aria-label="Buy back and burn GOWL" />,
    <label key="label">Trade amount<input /></label>,
    <input key="aria" aria-label="Trade amount" />,
    <input key="placeholder" placeholder="Amount" />,
    <input key="name" name="amount" />,
    <input key="id" id="buy-amount" />,
    <button key="aria-button" aria-label="Buy back and burn GOWL">Continue</button>,
  ])('rejects trading links, radios and text amount fields beside a template (%#)', control => {
    render(<><TemplateRow current={null} onPick={vi.fn()} />{control}</>);
    expect(violations().length).toBeGreaterThan(0);
  });

});
