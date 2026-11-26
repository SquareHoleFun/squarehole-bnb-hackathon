import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type TestInfo } from '@playwright/test';
import { installUntouchableWallet, overflow, walletTouches } from './box-helpers';

// SH-APP8: the two Load settings lines that name a hidden kit's plan file keep "-plan.json" in plain ASCII, so
// find-in-page and copy/paste see the name as typed, and keep it whole with markup: at every width from 320 to 390 px
// the name never breaks after its hyphen, while the line itself wraps. Frog Kiln's public plan file alone, then its
// public template alone; nothing loads and no wallet is touched. SH_EVIDENCE_SCREENSHOTS=1 writes the pictures to
// docs/evidence/SH-APP8-TRIGGER-WORDS/ (or SH_EVIDENCE_DIR).
const kitFile = (name: string) => fileURLToPath(new URL(`../../../examples/boxes/frog-kiln/settings/${name}`, import.meta.url));
const NAME = '-plan.json';
const LINES = [
  { pick: 'a plan file alone', file: 'frog-kiln-plan.json', words: 'Pick one settings file, or one template with its -plan.json.', picture: 'pick-one' },
  { pick: 'a template alone', file: 'frog-kiln-boxspec-v2.json', words: 'This hidden setup is a template: load its -plan.json file with it.', picture: 'template-needs-plan' },
] as const;

/** On how many lines the characters of `part` lie inside `line`, whatever elements hold them (1: all on one line). */
const linesOf = (line: Locator, part: string): Promise<number> => line.evaluate((root, wanted) => {
  const nodes: { node: Text; from: number }[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) { nodes.push({ node, from: text.length }); text += node.data; }
  const at = text.indexOf(wanted);
  if (at < 0) return -1;
  const tops: number[] = [];
  for (const { node, from } of nodes) {
    for (let i = Math.max(at, from); i < Math.min(at + wanted.length, from + node.data.length); i += 1) {
      const range = document.createRange();
      range.setStart(node, i - from);
      range.setEnd(node, i - from + 1);
      for (const rect of range.getClientRects()) if (rect.width > 0) tops.push(rect.top);
    }
  }
  // The characters of one line share its top (within a pixel or two); the next line starts a line height lower.
  return tops.sort((a, b) => a - b).filter((top, i, all) => i === 0 || top - (all[i - 1] ?? top) > 2).length;
}, part);

async function shot(line: Locator, info: TestInfo, name: string) {
  const path = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? fileURLToPath(new URL(`../../../docs/evidence/${process.env.SH_EVIDENCE_DIR ?? 'SH-APP8-TRIGGER-WORDS'}/${name}.png`, import.meta.url)) : info.outputPath(`${name}.png`);
  await line.screenshot({ path });
}

test.beforeEach(async ({ page }) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

for (const line of LINES) {
  test(`SH-APP8 Load settings, ${line.pick}: "-plan.json" stays whole at every width from 320 to 390 px, in plain ASCII`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/create/v2-basics');
    await page.locator('#create-load-settings').setInputFiles(kitFile(line.file));
    const problem = page.locator('[data-load-problem]');
    await expect(problem).toHaveText(`! ${line.words}`);
    // Byte for byte, with the plain hyphen: what find-in-page matches and copy/paste gives.
    expect(await problem.textContent()).toBe(`! ${line.words}`);
    expect(line.words).toMatch(/^[\x20-\x7e]+$/);
    const name = problem.locator('.sh-v2-load__name');
    await expect(name).toHaveText(NAME);
    await expect(name).toHaveCSS('white-space', 'nowrap');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const wraps: number[] = [];
    for (let width = 320; width <= 390; width += 1) {
      await page.setViewportSize({ width, height: 844 });
      expect(await linesOf(problem, NAME), `"${NAME}" at ${width} px`).toBe(1);
      if ((await linesOf(problem, line.words)) > 1) wraps.push(width);
      expect(await overflow(page), `${width} px`).toBeLessThanOrEqual(0);
    }
    // The line itself wraps on these widths, so the name's single line is the markup's doing, not room to spare.
    expect(wraps.length, 'widths at which the line wraps').toBeGreaterThan(0);
    if (info.project.name === 'mobile') {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await shot(problem, info, `${line.picture}-phone-${width}`);
      }
    } else {
      await page.setViewportSize({ width: 1440, height: 900 });
      expect(await linesOf(problem, NAME)).toBe(1);
      await shot(problem, info, `${line.picture}-desktop`);
    }
    await expect(page.locator('[data-loaded-setup]')).toHaveCount(0);
    expect(await walletTouches(page)).toEqual([]);
  });
}
