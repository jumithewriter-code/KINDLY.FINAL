import { useState } from 'react';
import { Icon } from './Icon';
import { env } from '../lib/env';

/**
 * The demo notice.
 *
 * KINDLY's whole design rests on telling the truth about whether a message
 * actually reached a person. A build with no server cannot keep that promise,
 * so it must say so where nobody can miss it — inside the product, on every
 * screen, not only in a README.
 *
 * Renders nothing in a real build.
 */
export function DemoNotice() {
  const [expanded, setExpanded] = useState(false);
  if (!env().isDemo) return null;

  return (
    <aside className="demo-notice" aria-label="Demonstration notice">
      <Icon name="i-alert" size={17} strokeWidth={2.5} />
      <p>
        <b>Demonstration build.</b> There is no server: everything you do stays in
        this browser, and a request is <b>not</b> delivered to a real person.
      </p>
      <button
        type="button"
        className="demo-notice-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? 'Hide details' : 'What is real here?'}
      </button>

      {expanded ? (
        <div className="demo-notice-detail">
          <p>
            Every screen, rule and state you see is the real application. The
            request lifecycle, the urgency rules, the caregiver approval step for
            stories and the accessibility behaviour are all genuine.
          </p>
          <p>
            What is replaced is the <b>backend</b>. In production KINDLY runs on
            Supabase with Row Level Security on every table, and “Delivered” means
            the server stored the request <i>and</i> routed it to an adult who can
            answer. Here that server is emulated in the page, so nobody is
            notified and nothing leaves this browser.
          </p>
          <p>
            Clearing this site’s data resets the demo completely. Please do not
            enter real personal information.
          </p>
        </div>
      ) : null}
    </aside>
  );
}
