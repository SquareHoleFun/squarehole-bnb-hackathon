import { Fragment, type ReactNode } from 'react';
import { TERMS_SECTIONS, type TermsClause, type TermsSection } from './terms';

/** `[COUNSEL: …]`, `[FOUNDER: …]`, `[FOUNDER + COUNSEL …]`, `[ENGINEERING: …]`: open items, never final text. */
const PLACEHOLDER = /(\[(?:COUNSEL|FOUNDER|ENGINEERING)\b[^\]]*\])/;

function withPlaceholders(text: string): ReactNode[] {
  return text.split(PLACEHOLDER).map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="sh-legal__todo">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** One string of the Terms: `**bold**` becomes <strong>, placeholders become <mark>. No other markup exists. */
export function TermsText({ text }: { text: string }) {
  return (
    <>
      {text.split('**').map((part, index) =>
        index % 2 === 1 ? <strong key={index}>{withPlaceholders(part)}</strong> : <Fragment key={index}>{withPlaceholders(part)}</Fragment>,
      )}
    </>
  );
}

function Clause({ clause }: { clause: TermsClause }) {
  return (
    <div className="sh-legal__clause">
      <p>
        {clause.n ? <span className="sh-legal__n">{clause.n}</span> : null}
        {clause.n ? ' ' : null}
        <TermsText text={clause.text} />
      </p>
      {clause.items ? (
        <ul className="sh-legal__items">
          {clause.items.map((item) => (
            <li key={item.text}>
              <TermsText text={item.text} />
              {item.bullets ? (
                <ul className="sh-legal__bullets">
                  {item.bullets.map((bullet) => (
                    <li key={bullet}>
                      <TermsText text={bullet} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * One of the 18 section cards. A plain <section> without a name, so it is not a landmark: 18 named regions would
 * flood landmark navigation, and the h2 headings already give the structure. The id is the Contents anchor.
 */
function Section({ section }: { section: TermsSection }) {
  return (
    <section id={section.id} className="sh-detail-card sh-legal__section">
      <h2 id={`${section.id}-title`} className="sh-detail-card__title">
        {section.n}. {section.title}
      </h2>
      {section.clauses.map((clause, index) => (
        <Clause key={clause.n ?? `${section.id}-${index}`} clause={clause} />
      ))}
    </section>
  );
}

/** The contents list and the 18 sections of the Terms, as on `/about/terms`. */
export function TermsSections({ sections = TERMS_SECTIONS }: { sections?: readonly TermsSection[] }) {
  return (
    <>
      <nav className="sh-detail-card sh-legal__toc" aria-labelledby="terms-contents">
        <h2 id="terms-contents" className="sh-detail-card__title">
          Contents
        </h2>
        <ol>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>
                {section.n}. {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {sections.map((section) => (
        <Section key={section.id} section={section} />
      ))}
    </>
  );
}
