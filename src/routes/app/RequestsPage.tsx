import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, LoadingState, SectionTitle, StatusPill } from '../../components/ui';
import { useBackend, useWorkspace } from '../../state/providers';
import { childLabel, initialFrom } from '../../lib/names';
import { formatTime } from '../../lib/format';
import { STATUS_META, isOpen } from '../../lib/requests/stateMachine';

export function RequestsPage() {
  const backend = useBackend();
  const navigate = useNavigate();
  const { workspace, activeFamilyId } = useWorkspace();

  const query = useQuery({
    queryKey: ['requests', activeFamilyId],
    queryFn: () => backend.listRequests(activeFamilyId!),
    enabled: Boolean(activeFamilyId),
  });

  const nameOf = (childId: string) =>
    workspace?.children.find((c) => c.id === childId)?.childName ?? '';

  const bundles = query.data ?? [];
  const open = bundles.filter((b) => isOpen(b.request.status));
  const closed = bundles.filter((b) => !isOpen(b.request.status));

  return (
    <div className="content-wrap">
      <SectionTitle
        eyebrow="STAY CONNECTED"
        title="Requests"
        detail={`A calm place to notice what ${workspace?.children.length === 1
          ? childLabel(workspace.children[0]!.childName)
          : 'your children are'} communicating.`}
      />

      {query.isLoading ? <LoadingState label="Loading requests" /> : null}
      {query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}

      {!query.isLoading && !query.error && bundles.length === 0 ? (
        <div className="blank-state">
          <div className="blank-icon" aria-hidden="true"><Icon name="i-message-circle" size={25} /></div>
          <h3>All quiet for now</h3>
          <p>New requests will appear here the moment they are delivered.</p>
        </div>
      ) : null}

      {open.length > 0 ? (
        <>
          <h3 style={{ fontSize: 15, margin: '18px 0 10px' }}>Needs attention</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {open.map((b) => (
              <RequestRow
                key={b.request.id}
                childName={nameOf(b.request.childId)}
                bundle={b}
                onOpen={() => navigate(`/app/requests/${b.request.id}`)}
              />
            ))}
          </div>
        </>
      ) : null}

      {closed.length > 0 ? (
        <>
          <h3 style={{ fontSize: 15, margin: '26px 0 10px' }}>Finished</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {closed.slice(0, 20).map((b) => (
              <RequestRow
                key={b.request.id}
                childName={nameOf(b.request.childId)}
                bundle={b}
                onOpen={() => navigate(`/app/requests/${b.request.id}`)}
              />
            ))}
          </div>
        </>
      ) : null}

      {!query.isLoading && bundles.length > 0 && open.length === 0 ? (
        <div style={{ marginTop: 20 }}>
          <EmptyState title="Nothing is waiting" detail="Everything that came in has been answered or finished." />
        </div>
      ) : null}
    </div>
  );
}

function RequestRow({
  bundle, childName, onOpen,
}: {
  bundle: { request: import('../../lib/types').HelpRequest; response: import('../../lib/types').RequestResponse | null };
  childName: string;
  onOpen: () => void;
}) {
  const meta = STATUS_META[bundle.request.status];
  return (
    <button className="request-card" style={{ width: '100%', textAlign: 'left' }} onClick={onOpen}>
      <Avatar initial={initialFrom(childName)} label={childLabel(childName, { capital: true })} className="request-avatar" />
      <div>
        <b>{childLabel(childName, { capital: true })}: {bundle.request.childFacingLabel}</b>
        <p>
          {bundle.request.urgency === 'urgent' ? 'Urgent' : 'Can wait'}
          {' · '}{formatTime(bundle.request.sendingStartedAt ?? bundle.request.createdAt)}
          {bundle.response ? ` · Answered by ${bundle.response.responderName}` : ''}
        </p>
      </div>
      <StatusPill tone={meta.tone} icon={meta.icon} text={meta.text} />
    </button>
  );
}
