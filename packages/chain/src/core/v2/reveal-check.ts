/** Internal assertion shared by the offline reveal readers. */
export function checkReveal(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
