/**
 * SH-287: the creator's three parts as form fields (whole percent), with one sentence each where `withSays`. The
 * Four.meme screen's (its words are that rail's); the Flap screen draws the same fields inline (FlapCreate.tsx).
 */
import { rulesRefusals, type RulesField, type RulesForm } from '../lib/rules';
import { BUY_BACK_SAYS, FINAL_SAYS } from './RulesPanel';

export interface RulesFieldsProps {
  form: RulesForm;
  onChange: (f: RulesForm) => void;
  disabled: boolean;
  withSays: boolean;
  /** What the parts share, as the heading says it: "The token's tax goes to". */
  heading: string;
}

const FIELDS: { key: RulesField; label: string; says: string }[] = [
  { key: 'creator', label: 'Creator', says: 'Paid to your address at every share-out.' },
  { key: 'pile', label: 'Pile', says: 'Added to the pile that holders redeem from.' },
  {
    key: 'burn',
    label: 'Buy back and burn',
    says: BUY_BACK_SAYS.four,
  },
];

export function RulesFields({ form, onChange, disabled, withSays, heading }: RulesFieldsProps) {
  const refused = rulesRefusals(form);
  const line = (['creator', 'pile', 'burn'] as const).map((k) => refused[k]).find(Boolean);
  return (
    <div className="rules-fields" data-testid="rules-fields">
      <p className="field-label">{heading}</p>
      {FIELDS.map((r) => (
        <div key={r.key} className="field">
          <label className="field-label" htmlFor={`rules-${r.key}`}>
            {r.label}
            <span className="muted">%</span>
          </label>
          <input
            id={`rules-${r.key}`}
            value={form[r.key]}
            inputMode="numeric"
            aria-invalid={Boolean(refused[r.key])}
            disabled={disabled}
            onChange={(e) => onChange({ ...form, [r.key]: e.target.value })}
            data-testid={`rules-${r.key}`}
          />
          {withSays ? <span className="sh-lp-says small">{r.says}</span> : null}
        </div>
      ))}
      {line ? (
        <p className="refusal" data-testid="rules-refusal">
          {line}
        </p>
      ) : null}
      <p className="sh-lp-says small">
        A part that cannot be paid now stays owed and is tried again at the next share-out. {FINAL_SAYS.four}
      </p>
    </div>
  );
}
