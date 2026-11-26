import { afterEach, expect, it, vi } from 'vitest';
const marker = 'UNTRUSTED_ARCHIVE_TEXT';
vi.mock('../src/set', () => ({ loadProcessConfig: () => { throw new Error('UNTRUSTED_ARCHIVE_TEXT'); } }));
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });
it('the actual CLI top-level failure logs fixed text and a class, never the thrown message', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../src/main');
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  const lines = JSON.stringify(error.mock.calls);
  expect(lines).toContain('keeper failed'); expect(lines).toContain('Error'); expect(lines).not.toContain(marker);
  expect(process.exitCode).toBe(1);
});
