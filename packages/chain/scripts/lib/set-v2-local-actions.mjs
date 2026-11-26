/** Completion resolves each box's trading gate independently. Ordinary buys start after its launch window. */
export async function afterSetWindow({ effectiveOpenAt, windowSeconds, mineTo, recipe }) {
  const open = await effectiveOpenAt();
  if (open === 0n) throw new Error('local set trading gate is closed');
  await mineTo(open + await windowSeconds());
  await recipe();
}

/** Buy with the actor's P from the graduated pool, then requote and check its balance at that quote's block. */
export async function prepareFundedSetPick({ prepare, balance, buy }) {
  for (let attempts = 0; ; attempts++) {
    const prepared = await prepare();
    if (await balance(prepared.blockNumber) >= prepared.quote.tokenIn) return prepared;
    if (attempts === 8) throw new Error('local actor balance does not cover fee-inclusive pick after pool buys');
    await buy();
  }
}
