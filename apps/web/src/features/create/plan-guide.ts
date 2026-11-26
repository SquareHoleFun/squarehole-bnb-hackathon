/**
 * SH-AI-PLAN: the words of the plan guide (`/create/plan`, PlanGuidePage.tsx) and of the hidden-art line on the
 * Contents step. All of them are drafts for the founder's edit (docs/evidence/SH-AI-PLAN.md lists every new string).
 * docs/guides/hidden-collection-plan.md, the public format, carries the same prompt and example word for word
 * (plan-guide.test.ts keeps them equal).
 */

/** Where the guide lives on the site. */
export const PLAN_PATH = '/create/plan';

export const PLAN_TITLE = 'Plan a hidden collection';
export const PLAN_LEAD = 'Name your pictures as you like. One plan gives each picture its count and traits. This page picks the numbers.';

/** A plan for the example in the design: two glazes of 44 toads and a cracked one of 8 (Frog Kiln's own words). */
export const PLAN_EXAMPLE = ['file,count,Glaze,Crack', 'bisque.png,44,Bisque,', 'celadon.png,44,Celadon,', 'gold-seam.png,8,Celadon,Gold seam'].join('\n');

/** The plan's rules, one line each (art-plan.ts checks every one of them). */
export const PLAN_RULES: readonly string[] = Object.freeze([
  'file: the picture’s file name. Letters, digits, - and _, then .png, .jpg or .webp.',
  'count: how many items show it. All counts add up to 10 to 10,000.',
  'Then one column per trait: up to 16 traits, 255 values each. An empty cell means no trait.',
  'Plain letters, digits, spaces and simple punctuation. No emoji, accents, " or \\.',
  'No numbers, ids, salts or seeds. This page picks the numbers and makes the secrets.',
]);

export const PLAN_PICTURES = 'Pictures: PNG, JPEG or WebP, up to 1 MB each.';
export const PLAN_AI_TITLE = 'Ask an AI';
/** The prompt to copy (the design's draft, 2026-10-24). The AI never picks a number, id, salt or seed. */
export const PLAN_PROMPT =
  'Help me plan a hidden NFT collection for Square Hole. Never choose item numbers, ids, salts or seeds. Reply with one CSV only. ' +
  'Column 1 `file`: the picture\'s file name (letters, digits, `-` `_`; .png, .jpg or .webp). Column 2 `count`: how many items show it (1 = one of one). ' +
  'Then one column per trait: at most 16 traits, 255 values each. Plain English letters, digits, spaces and simple punctuation only: ' +
  'no emoji, accents, curly quotes, commas, `"` or `\\`. Names up to 64 characters, values up to 128. Empty cell = no trait. ' +
  'Counts add up to 10-10,000. My idea: [describe]';
export const PLAN_NEXT = 'Then add the pictures and the plan together under Art. Keep the reveal file: it is the only record of who got which number.';
export const PLAN_BACK = 'Back to Contents';

/**
 * The Contents step, hidden art: numbered files tell whoever named them the map; a plan does not. One short line, its
 * link to the guide included (the step's 40-word budget, wording-v2.test.tsx: 35 words with it on a hidden draft).
 */
export const HIDDEN_NUMBERED_LINE = 'Numbered files: whoever named them knows which item is which.';
export const HIDDEN_PLANNED_LINE = 'This page picked the numbers at random.';
export const PLAN_LINK = 'Use a plan instead';
/** The art's (i): the plan beside the numbered files. */
export const ART_PLAN_INFO = 'Or pictures with any names and a plan (a CSV of file, count and traits): this page picks the numbers.';
