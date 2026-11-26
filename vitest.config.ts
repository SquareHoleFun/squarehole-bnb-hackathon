import { defineConfig } from 'vitest/config';

// Each workspace member owns its own test environment (node for packages, jsdom for the web app).
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/web', 'apps/landing'],
  },
});
