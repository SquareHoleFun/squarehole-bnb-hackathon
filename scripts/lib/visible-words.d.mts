// Types for visible-words.mjs (used from the TypeScript browser suites).
export interface VisibleWord {
  readonly token: string;
  readonly inViewport: boolean;
  readonly inMain: boolean;
}

export interface WordCount {
  readonly words: number;
  readonly numbers: number;
}

export interface WordSummary {
  readonly viewport: WordCount;
  readonly viewportMain: WordCount;
  readonly page: WordCount;
  readonly pageMain: WordCount;
}

/** Runs in the page (pass it to page.evaluate). */
export function collectWords(): { words: VisibleWord[]; lines: string[] };
export function summarise(words: readonly VisibleWord[]): WordSummary;
export function isWord(token: string): boolean;
export function isNumber(token: string): boolean;
