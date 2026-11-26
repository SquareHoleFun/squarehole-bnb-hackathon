/** Shared by the browser audit and its DOM unit tests. Nothing here grants a page-wide text exemption. */
export const FORBIDDEN = /\b(buy|sell|swap)\b/i;

const feeSide = 'fieldset.sh-newbox-side:is(#create-v2-buyers, #create-v2-sellers)';
export const RECIPE_CHOICES = [
  '.sh-v2-templates > .sh-v2-templates__row > li > button.sh-v2-template[data-template]:is([data-template="burn"], [data-template="collection-burn"])[aria-pressed]',
  `${feeSide} > .sh-newbox-chips__row > button[data-fee-choice="burn"][aria-pressed]`,
  `${feeSide} > fieldset.sh-v2-vault > .sh-newbox-chips__row > button[data-inside-policy="2"][aria-pressed]`,
].join(', ');

/** Names still subject to the trading ban. Called with Playwright's accessible-name matches. */
export function outsideRecipeChoices(elements: Element[], selector: string): string[] {
  return elements.filter((element) => !element.matches(selector))
    .map((element) => element.getAttribute('aria-label') ?? element.textContent ?? '');
}

/** Keep the label/attribute audit too, including amount fields whose type is just text. */
export function forbiddenLabelNames(root: Element, selector: string): string[] {
  return [...root.querySelectorAll('label, legend, option, [aria-label], [placeholder], [title], input, select, textarea')]
    .filter((element) => !element.matches(selector))
    .flatMap((element) => [
      element.matches('label, legend, option') ? element.textContent ?? '' : '',
      element.getAttribute('aria-label') ?? '', element.getAttribute('placeholder') ?? '', element.getAttribute('title') ?? '',
      element.matches('input, select, textarea') ? `${element.getAttribute('name') ?? ''} ${element.id}` : '',
    ]).filter((text) => /\b(buy|sell|swap)\b|amount/i.test(text));
}
