import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { withinLimit } from './one-press';
import { confirmLabel, NOT_ON_LIST_LINE, raiseEndLine, STAGE_LINES, TRADE_LINES, tradeLine } from './trade-words';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN = resolve(HERE, '../../../../../packages/chain/src/trade-sepolia');

const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** Every string literal under `node` that is a value, not one side of a comparison (`change === 'chain'`). */
function literals(node: ts.Node, out: string[] = []): string[] {
  const compared = node.parent !== undefined && ts.isBinaryExpression(node.parent) && COMPARISONS.has(node.parent.operatorToken.kind);
  if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !compared) out.push(node.text);
  ts.forEachChild(node, (child) => { literals(child, out); });
  return out;
}

/**
 * The reasons a file can hand the box, read from its syntax: the reason argument of every `requireTrade(...)`, every
 * `reason:` property, the values of an object named `reasons` (revert.ts), the argument of every `setLine(...)`, what
 * is assigned to a `note` (the send engine's line once a send settles), and a string returned by a function whose name
 * says it returns a reason.
 */
function reasonsIn(path: string): Set<string> {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'requireTrade' && node.arguments[1]) literals(node.arguments[1]).forEach((text) => found.add(text));
      if (name === 'setLine' && node.arguments[0]) literals(node.arguments[0]).forEach((text) => found.add(text));
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'reason') literals(node.initializer).forEach((text) => found.add(text));
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === 'note') literals(node.right).forEach((text) => found.add(text));
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'reasons' && node.initializer) {
      let value: ts.Expression = node.initializer;
      while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isObjectLiteralExpression(value)) for (const property of value.properties) if (ts.isPropertyAssignment(property)) literals(property.initializer).forEach((text) => found.add(text));
    }
    if (ts.isFunctionDeclaration(node) && node.name && /revert|reason/i.test(node.name.text)) {
      const scan = (inner: ts.Node): void => { if (ts.isReturnStatement(inner) && inner.expression) literals(inner.expression).forEach((text) => found.add(text)); ts.forEachChild(inner, scan); };
      scan(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const snake = (text: string) => /^[a-z]+(?:_[a-z]+)*$/.test(text);

describe('SH-194-af2: the raise-end line describes only the current quote', () => {
  it('quotes the spend without promising a remainder', () => {
    const line = raiseEndLine(1_970_000n, 6, 'tUSDC');
    expect(line).toBe('Quote: about 1.97 tUSDC fills the raise; the box can graduate.');
    expect(line).not.toMatch(/at least|stays with you|remains|This buy fills/);
    expect(line.length).toBeLessThanOrEqual('This buy fills the raise: 1.97 tUSDC goes in, the box can graduate.'.length);
  });

  it('formats large and tiny bigint spends without promising the unspent amount', () => {
    expect(raiseEndLine(9_007_199_254_740_993_001n, 18, 'tETH')).toBe('Quote: about 9 tETH fills the raise; the box can graduate.');
    expect(raiseEndLine(1n, 18, 'tETH')).toBe('Quote: about 0.000000000000000001 tETH fills the raise; the box can graduate.');
    expect(raiseEndLine(5_000_000n, 6, 'tUSDC')).toBe('Quote: about 5 tUSDC fills the raise; the box can graduate.');
  });

  it('does not promise the old remainder when an intervening sale increases the accepted spend', () => {
    // Synthetic window quotes: the existing guard binds output, not the display-only closing spend.
    const shown = { amountIn: 5_000_000n, expectedInput: null, expectedOutput: 100n, raiseEnd: { input: 1_970_000n } };
    const afterSale = { ...shown, expectedOutput: 150n, raiseEnd: { input: 2_970_000n } };
    expect(withinLimit(shown, afterSale, 200n)).toBe(true);
    expect(afterSale.amountIn - afterSale.raiseEnd.input).toBeLessThan(shown.amountIn - shown.raiseEnd.input);
    expect(raiseEndLine(shown.raiseEnd.input, 6, 'tUSDC')).toBe('Quote: about 1.97 tUSDC fills the raise; the box can graduate.');
    expect(raiseEndLine(afterSale.raiseEnd.input, 6, 'tUSDC')).toBe('Quote: about 2.97 tUSDC fills the raise; the box can graduate.');
  });
});

describe('every reason a trade can stop for has one short line', () => {
  it('reads the trade calls’ reasons from their sources, and finds the ones the plan and the reverts name', () => {
    const chain = new Set(['trade.ts', 'guard.ts', 'submit.ts', 'revert.ts', 'coins.ts', 'coin-guard.ts', 'coin-deployment.ts'].flatMap((name) => [...reasonsIn(join(CHAIN, name))]));
    // A few the review names, as the scan's own control: if one goes missing the scan is broken, not the box.
    for (const expected of ['price_limit_already_exceeded', 'price_limit_out_of_bounds', 'unregistered_box', 'pool_simulation_mismatch',
      'trade_already_submitted', 'upcoming', 'curve_closed', 'failed', 'unknown_phase', 'read_or_simulation_failed', 'stale_read',
      'buy_through_launch_router', 'window_closed', 'insufficient_output', 'below_curve_floor', 'unknown_revert',
      // The coin calls' (SH-ALPHA-COIN-CALLS, for the test-coin page).
      'not_admitted', 'cooldown_active', 'daily_cap_reached', 'deployment_predicted', 'pair_not_allowed', 'coin_already_submitted', 'insufficient_allowance']) {
      expect(chain, expected).toContain(expected);
    }
    const missing = [...chain].filter((reason) => snake(reason) && !Object.hasOwn(TRADE_LINES, reason));
    expect(missing).toEqual([]);
  });

  it('covers the box’s own reasons (the wallet, a receipt, a balance, the amount)', () => {
    // faucet-due.ts holds the faucet's wait reasons, moved from TestCoinPage.tsx; setup-run.ts is "Set me up" (F166).
    const box = new Set(['TradeBox.tsx', 'trade-run.ts', 'trade-target.ts', 'use-sends.ts', 'TestCoinPage.tsx', 'coin-target.ts', 'faucet-due.ts', 'setup-run.ts'].flatMap((name) => [...reasonsIn(join(HERE, name))]));
    for (const expected of ['wallet_rejected', 'wallet_chain', 'wallet_account', 'wallet_error', 'rpc_failed', 'receipt_timeout', 'balance_low', 'deployment_required', 'chain_not_allowed',
      'earlier_send', 'asking', 'replaced', 'sent_unseen', 'not_sent',
      // The test-coin page's (SH-ALPHA-TEST-COINS).
      'deployment_predicted', 'source_unavailable', 'invalid_deployment', 'not_admitted', 'daily_cap_reached']) {
      expect(box, expected).toContain(expected);
    }
    expect([...box].filter((reason) => snake(reason) && !Object.hasOwn(TRADE_LINES, reason))).toEqual([]);
  });

  it('each line is one short sentence, with no code, dash or Demo word in it', () => {
    for (const [reason, text] of [...Object.entries(TRADE_LINES), ...Object.entries(STAGE_LINES)]) {
      expect(text.length, reason).toBeLessThanOrEqual(60);
      expect(text, reason).toMatch(/[.]$/);
      expect(text, reason).not.toMatch(/_|\u2014|\bdemo\b/i);
    }
  });

  it('a wallet the faucet does not admit gets the one line, from its one constant: the fact only, the Claim card carries the call (XR-ALPHA-SITE af2)', () => {
    expect(tradeLine('not_admitted')).toBe(NOT_ON_LIST_LINE);
    expect(NOT_ON_LIST_LINE).toBe('This wallet is not on the alpha list.');
    // A tester who claimed with another wallet reads it too: no call to sign in or claim here.
    expect(NOT_ON_LIST_LINE).not.toMatch(/sign in|claim/i);
    // The sign-in is X's through Privy now (F161 (4)): no line names the earlier ideas, Access, email, invites or codes.
    for (const text of Object.values(TRADE_LINES)) expect(text).not.toMatch(/access|e-?mail|invite|one-time|code\b/i);
    // No trade line names the claim: the Claim card carries that call (XR-ALPHA-SITE af2).
    expect(Object.entries(TRADE_LINES).filter(([, text]) => /claim/i.test(text)).map(([reason]) => reason)).toEqual([]);
  });

  it('a send waits on the wallet’s window, or on the made wallet’s own press with no window (F161 (4))', () => {
    expect(confirmLabel(false)).toBe('Confirm in your wallet…');
    expect(confirmLabel(true)).toBe('Signing…');
  });

  it('an unknown reason gets one generic line, never its code', () => {
    expect(tradeLine('something_new')).toBe('Not possible right now.');
    expect(tradeLine('toString')).toBe('Not possible right now.');
    expect(tradeLine('insufficient_output')).toBe('Price moved: below your minimum.');
  });
});
