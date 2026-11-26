import { markLocalFailure } from '../../../../packages/chain/scripts/lib/core-v2-local-failure.mjs';

/** These callbacks run before webServer teardown; onEnd is too late to preserve Anvil. */
export default class LocalFailureReporter {
  onTestEnd(test, result) {
    if (result.status !== 'skipped' && result.status !== test.expectedStatus) {
      markLocalFailure(`${result.status}: ${test.titlePath().join(' > ')}`);
    }
  }

  onError(error) { markLocalFailure(error.message ?? 'Playwright runner error'); }
}
