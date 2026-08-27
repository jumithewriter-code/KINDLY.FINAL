import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { useChildSession } from '../../state/providers';

/**
 * Offline help.
 *
 * Always reachable, including from the adult-check screen and from a failed
 * request. It never depends on the network, and it never claims Kindly is
 * calling anybody.
 */
export function ChildOfflineHelpPage() {
  const navigate = useNavigate();
  const { space } = useChildSession();

  const safeAdult = space?.child.safeAdult;
  const safePlace = space?.child.safePlace;
  const emergency = space?.child.emergencyInstructions;

  const steps = [
    { icon: 'i-users', text: safeAdult ? `Go to ${safeAdult}.` : 'Go to a grown-up you know.' },
    { icon: 'i-pin', text: safePlace ? `Or go to ${safePlace}.` : 'Or go somewhere you feel safe.' },
    { icon: 'i-shield', text: 'If you are not safe, tell any grown-up near you.' },
  ];

  return (
    <div className="sent-screen">
      <div className="req-hero urgent" aria-hidden="true">
        <Icon name="i-shield" size={42} strokeWidth={2.5} />
      </div>
      <span className="eyebrow">HELP RIGHT NOW</span>
      <h1>Find a grown-up near you.</h1>
      <p>You do not have to wait for the app. Do one of these.</p>

      <ul className="offline-steps">
        {steps.map((step) => (
          <li key={step.text}>
            <Icon name={step.icon} size={19} strokeWidth={2.5} />
            <span>{step.text}</span>
          </li>
        ))}
      </ul>

      {emergency ? (
        <p className="inline-note" style={{ textAlign: 'left', maxWidth: 520, margin: '0 auto' }}>
          <Icon name="i-alert" size={16} strokeWidth={2.5} />
          <span>{emergency}</span>
        </p>
      ) : null}

      <p style={{ fontSize: 13, color: 'var(--muted-foreground)', maxWidth: 520, margin: '16px auto 0' }}>
        Kindly cannot call anyone for you. If someone is hurt or in danger, a grown-up should call
        the local emergency number.
      </p>

      <div className="big-actions">
        <Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/child')}>Back to my day</Button>
      </div>
    </div>
  );
}
