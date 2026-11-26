import { useId } from 'react';
import { ACCOUNT_SCENARIOS, isAccountScenario, type AccountScenario } from '../accounts';
import { DemoScenarioPicker } from '../tx';

const ACCOUNT_SCENARIO_LABELS: Readonly<Record<AccountScenario, string>> = Object.freeze({
  default: 'Normal',
  conversion_fails: 'Conversion route unavailable (emergency settlement)',
  unavailable: 'Account data unavailable',
  loading: 'Account data never finishes loading',
});

interface DemoControlsProps {
  readonly scenario: AccountScenario;
  readonly onScenarioChange: (scenario: AccountScenario) => void;
}

/**
 * Tester controls for the demo (D07): which mock account data the page reads (`?scenario=`) and which scripted outcome
 * the next claim request follows. Clearly outside the product: no real control changes data or transactions.
 */
export function DemoControls({ scenario, onScenarioChange }: DemoControlsProps) {
  const headingId = useId();
  const selectId = useId();
  return (
    <section className="sh-demo-controls" aria-labelledby={headingId}>
      <h2 id={headingId} className="sh-demo-controls__title">
        Scenarios
      </h2>
      <div className="sh-demo-controls__grid">
        <div className="sh-tx__scenario sh-demo-controls__field">
          <label htmlFor={selectId}>Account data</label>
          <select
            id={selectId}
            value={scenario}
            aria-describedby={`${selectId}-hint`}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (isAccountScenario(value)) onScenarioChange(value);
            }}
          >
            {ACCOUNT_SCENARIOS.map((name) => (
              <option key={name} value={name}>
                {ACCOUNT_SCENARIO_LABELS[name]}
              </option>
            ))}
          </select>
          <p id={`${selectId}-hint`} className="sh-tx__scenario-hint">
            Kept in the link as <code>?scenario=</code>.
          </p>
        </div>
        <DemoScenarioPicker className="sh-demo-controls__field" />
      </div>
    </section>
  );
}
