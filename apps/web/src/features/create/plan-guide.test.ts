/**
 * SH-AI-PLAN: docs/guides/hidden-collection-plan.md is the public format, and the page's guide (`/create/plan`) its
 * short version. The prompt and the example are the same word for word, and the doc's table of lines is the page's
 * own (art-plan.ts PLAN_WORDS, art-files.ts): an edit to either fails here until both say the same.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLAN_WORDS, parsePlan } from './art-plan';
import { PLAN_EXAMPLE, PLAN_PROMPT, PLAN_RULES } from './plan-guide';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const doc = readFileSync(resolve(ROOT, 'docs/guides/hidden-collection-plan.md'), 'utf8');

describe('the plan guide and its public doc', () => {
  it('carry the same prompt and example, word for word; the prompt keeps the AI away from numbers and secrets', () => {
    expect(doc).toContain(`\`\`\`text\n${PLAN_PROMPT}\n\`\`\``);
    expect(doc).toContain(`\`\`\`csv\n${PLAN_EXAMPLE}\n\`\`\``);
    expect(PLAN_PROMPT).toContain('Never choose item numbers, ids, salts or seeds.');
    expect(doc).toContain('**Never a number, an id, a salt or a seed.**');
    expect(doc).toMatch(/^> \*\*Draft for the founder's edit\*\*/m);
    // The example is a plan the page reads as it is (96 items: under the 10 minimum it would not be).
    expect(parsePlan(PLAN_EXAMPLE).issues).toEqual([]);
    expect(PLAN_RULES).toHaveLength(5);
  });

  it('lists the page’s own lines', () => {
    const lines = [
      PLAN_WORDS.header,
      PLAN_WORDS.numbers,
      PLAN_WORDS.secret,
      PLAN_WORDS.character('Row 4, Glaze', 'Gold ✨'),
      PLAN_WORDS.tooLong('Row 1, column 3', 64),
      PLAN_WORDS.tooLong('Row 4, Glaze', 128),
      PLAN_WORDS.noName('Row 1, column 4'),
      PLAN_WORDS.repeatedTrait('Row 1, column 4', 'Glaze', 3),
      PLAN_WORDS.tooManyTraits(17),
      PLAN_WORDS.tooManyValues('Glaze', 256),
      PLAN_WORDS.cells(12, 3, 4),
      PLAN_WORDS.fileName(3),
      PLAN_WORDS.repeatedFile(6, 'bisque.png', 2),
      PLAN_WORDS.count(7),
      PLAN_WORDS.total(8),
      PLAN_WORDS.noRows,
      PLAN_WORDS.openQuote(2),
      PLAN_WORDS.noPicture(5, 'ember.png'),
      PLAN_WORDS.notInPlan('logo.png'),
      PLAN_WORDS.sameName(2, 'bisque.png'),
      PLAN_WORDS.planAndTraits,
      PLAN_WORDS.twoPlans(2),
      PLAN_WORDS.tooLarge('plan.csv'),
      PLAN_WORDS.noRandom,
      'gold.png is 1.4 MB. Max 1 MB. Save it as WebP or JPEG.',
    ];
    for (const line of lines) expect(doc, line).toContain(line);
  });
});
