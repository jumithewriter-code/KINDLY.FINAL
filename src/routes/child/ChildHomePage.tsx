import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { useChildSession } from '../../state/providers';
import { useBackend } from '../../state/providers';
import { childLabel } from '../../lib/names';
import { STATUS_META, isLive } from '../../lib/requests/stateMachine';

/**
 * The child's home.
 *
 * Four large, well-separated cards with a symbol AND words on every one.
 * Placement never changes between visits. Nothing counts down, plays a sound or
 * moves unless this child's profile turns it on.
 */
export function ChildHomePage() {
  const navigate = useNavigate();
  const backend = useBackend();
  const { token, space } = useChildSession();

  const requestsQuery = useQuery({
    queryKey: ['child-requests', token],
    queryFn: () => backend.childGetRequests(token!),
    enabled: Boolean(token),
    refetchInterval: 5000,
  });

  const active = (requestsQuery.data ?? []).find((b) => isLive(b.request.status));
  const childName = space?.child.childName ?? '';

  // Drawn from the icon sprite rather than typed as Unicode symbols: characters
  // like U+2600 and U+25D2 are missing from common system fonts, where they
  // render as blank boxes, and present at wildly different sizes where they are
  // not. A child-facing card cannot depend on which font a device happens to
  // ship. Every card still carries its words — the symbol never stands alone.
  const CARDS = [
    { key: 'day', className: 'child-card yellow-card', icon: 'i-clock-3', title: 'My day', detail: 'See what is next', to: '/child/day' },
    { key: 'stories', className: 'child-card blue-card', icon: 'i-book-open', title: 'My stories', detail: 'Read together', to: '/child/stories' },
    { key: 'help', className: 'child-card coral-card', icon: 'i-heart', title: 'I need help', detail: 'Ask for what you need', to: '/child/help' },
    { key: 'feel', className: 'child-card lavender-card', icon: 'i-message-circle', title: 'How I feel', detail: 'Share my feelings', to: '/child/feelings' },
  ];

  return (
    <div className="child-home">
      <div className="child-greeting">
        <span className="eyebrow">{new Date().toLocaleDateString([], { weekday: 'long' }).toUpperCase()}</span>
        <h1>Hi {childName || 'there'}!</h1>
        <p>What would you like to do?</p>
      </div>

      <nav className="child-cards" aria-label="Choose what to do">
        {CARDS.map((card) => (
          <button key={card.key} className={card.className} onClick={() => navigate(card.to)}>
            <span aria-hidden="true"><Icon name={card.icon} size={38} strokeWidth={2.25} /></span>
            <b>{card.title}</b>
            <small>{card.detail}</small>
          </button>
        ))}
      </nav>

      {active ? (
        <button className="child-active-strip" onClick={() => navigate(`/child/request/${active.request.id}`)}>
          <span className="pictogram" aria-hidden="true">
            <Icon name={active.request.pictogramKey ?? 'i-message-circle'} size={26} strokeWidth={2.5} />
          </span>
          <div>
            <b>Your message: {active.request.childFacingLabel}</b>
            <small>{STATUS_META[active.request.status].text}</small>
          </div>
          <Icon name="i-arrow-right" size={18} />
        </button>
      ) : null}

      <div className="child-footer">
        <span>Take your time. {childLabel(childName, { capital: true })} can stop at any point.</span>
        <button className="skip-button" onClick={() => navigate('/child/offline-help')}>
          Help <Icon name="i-help" size={16} />
        </button>
      </div>
    </div>
  );
}
