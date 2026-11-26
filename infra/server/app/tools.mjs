import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const providers = {
  git: ['git', 'Xcode Command Line Tools (git)'],
  pnpm: ['pnpm 10.29.1', 'pnpm 10.29.1'],
  curl: ['curl', 'macOS curl'],
};

export function requireTools(...tools) {
  for (const tool of tools) {
    const found = (process.env.PATH ?? '').split(delimiter).some(directory => {
      try {
        const file = join(directory || '.', tool);
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch { return false; }
    });
    if (!found) {
      const [arch, mac] = providers[tool];
      throw new Error(`missing tool: ${tool}; Arch package: ${arch}; macOS provider: ${mac}; install the listed package/provider`);
    }
  }
}
