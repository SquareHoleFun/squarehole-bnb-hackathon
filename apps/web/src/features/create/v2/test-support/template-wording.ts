/**
 * For the wording audits (F23): the template names they except from the rule. None since founder R47J (SH-V21-FE14): the
 * creator's and the holders' templates are named by where the fees go, "To the creator" and "To holders", and The
 * Alchemist's template is "Alchemist coin pile" (ALCH-TEMPLATE fix round 1, in place of "Growing coin pile"), so every
 * text is checked as it is. The audits keep this one place in case a later name needs an exception.
 */
export const EXCEPTED_TEMPLATE_NAMES: readonly string[] = Object.freeze([]);

/** A text as the audits read it: each excepted name left out (none now), every other word unchanged. */
export function withoutTemplateNames(text: string): string {
  return EXCEPTED_TEMPLATE_NAMES.reduce((rest, name) => rest.split(name).join(''), text);
}
