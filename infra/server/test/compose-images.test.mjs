import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// buildx bake refuses two build targets that export the same image tag ("already exists"; stack ship 12, 2026-10-31).
// A service that reuses another service's image names it with pull_policy never and has no build section.
it('builds each image tag in compose.yaml from one service only', () => {
  const compose = readFileSync('infra/server/compose.yaml', 'utf8');
  const rest = compose.slice(compose.indexOf('\nservices:\n'));
  const services = rest.slice(0, rest.search(/\n(networks|volumes|configs|secrets):\n/));
  const blocks = services.split(/\n(?= {2}[a-z][a-z-]*:\n)/).filter(b => /^ {2}[a-z][a-z-]*:\n/.test(b));
  const built = new Map();
  for (const block of blocks) {
    const name = block.match(/^ {2}([a-z][a-z-]*):/)[1];
    const image = block.match(/^ {4}image: (.+)$/m)?.[1];
    if (!/^ {4}build:/m.test(block)) {
      if (image?.startsWith('squarehole-')) expect(block, name).toContain('pull_policy: never');
      continue;
    }
    expect(built.get(image), `${name} builds ${image} again`).toBeUndefined();
    built.set(image, name);
  }
  expect(blocks.length).toBeGreaterThan(10);
  expect(built.get('squarehole-keeper:${SH_RELEASE:?SH_RELEASE is written to .env by install.sh}')).toBe('keeper');
});
