import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Icon } from '../../../components/Icon';
import { Button, ErrorState, SectionTitle, Select, TextArea, TextInput } from '../../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../../state/providers';
import { childLabel, validatePin } from '../../../lib/names';
import type { EscalationRule, Urgency } from '../../../lib/types';

/**
 * Safety and escalation.
 *
 * Two rules are enforced here rather than left to a caregiver's judgement:
 *   - the escalation ladder always ends with offline help, so a child is never
 *     left waiting with nothing to do;
 *   - urgent requests always break quiet hours.
 */
export function SafetySettingsPage() {
  const backend = useBackend();
  const navigate = useNavigate();
  const { workspace, activeChildId, activeFamilyId, refetch, can } = useWorkspace();
  const { announce } = useAnnouncer();

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const prefs = child ? workspace?.preferences[child.id] : undefined;
  const trusted = child ? (workspace?.trustedCaregivers[child.id] ?? []) : [];
  const manage = can('can_manage_safety');

  const [safeAdult, setSafeAdult] = useState('');
  const [safePlace, setSafePlace] = useState('');
  const [emergency, setEmergency] = useState('');
  const [bathroomUrgency, setBathroomUrgency] = useState<Urgency>('urgent');
  const [rules, setRules] = useState<Omit<EscalationRule, 'id' | 'childId'>[]>([]);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!child) return;
    setSafeAdult(child.safeAdult ?? '');
    setSafePlace(child.safePlace ?? '');
    setEmergency(child.emergencyInstructions ?? '');
    setBathroomUrgency(prefs?.bathroomUrgency ?? 'urgent');
    const existing = (workspace?.escalationRules[child.id] ?? []).map(({ id: _id, childId: _c, ...rest }) => rest);
    setRules(existing.length ? existing : [
      { appliesToUrgency: null, stepOrder: 1, action: 'notify_trusted', trustedCaregiverId: null, afterSeconds: 120, isActive: true },
      { appliesToUrgency: null, stepOrder: 2, action: 'show_offline_help', trustedCaregiverId: null, afterSeconds: 300, isActive: true },
    ]);
  }, [child, prefs, workspace]);

  const save = useMutation({
    mutationFn: async () => {
      if (!child) return;
      await backend.updateChild(child.id, {
        safeAdult: safeAdult.trim() || null,
        safePlace: safePlace.trim() || null,
        emergencyInstructions: emergency.trim() || null,
      });
      await backend.updateChildPreferences(child.id, { familyId: child.familyId, bathroomUrgency });

      // Guarantee the ladder ends with offline help.
      const ordered = [...rules]
        .sort((a, b) => a.afterSeconds - b.afterSeconds)
        .map((r, i) => ({ ...r, stepOrder: i + 1 }));
      if (!ordered.some((r) => r.action === 'show_offline_help')) {
        ordered.push({
          appliesToUrgency: null, stepOrder: ordered.length + 1, action: 'show_offline_help',
          trustedCaregiverId: null,
          afterSeconds: Math.min(1800, (ordered[ordered.length - 1]?.afterSeconds ?? 120) + 120),
          isActive: true,
        });
      }
      await backend.saveEscalationRules(child.id, ordered);

      if (pin) await backend.setCaregiverPin(activeFamilyId!, pin);
    },
    onSuccess: () => {
      setFailure(null);
      setPin('');
      setSavedAt(new Date().toISOString());
      announce('Safety settings saved.');
      refetch();
    },
    onError: (e) => setFailure(e),
  });

  if (!child) return <div className="content-wrap"><ErrorState error={new Error('Add a child profile first.')} /></div>;

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/settings')}>
        <Icon name="i-arrow-left" size={17} /> Back to settings
      </button>

      <SectionTitle
        eyebrow="SAFETY"
        title={`If nobody can answer ${childLabel(child.childName)}`}
        detail="Kindly is not an emergency service and will never contact emergency services for you. These settings decide what your child is shown instead of an empty wait."
      />

      {failure ? <ErrorState error={failure} onRetry={() => setFailure(null)} /> : null}

      <div className="editor-card">
        <header><h3>Safe adult and safe place</h3></header>
        <TextInput label="A safe adult near your child" value={safeAdult} disabled={!manage}
          placeholder="e.g. your teacher, Mr. O’Neill"
          hint="Written the way your child would hear it said out loud."
          onChange={(e) => setSafeAdult(e.target.value)} />
        <TextInput label="A safe place your child can get to" value={safePlace} disabled={!manage}
          placeholder="e.g. the quiet corner in the library"
          onChange={(e) => setSafePlace(e.target.value)} />
        <TextArea label="Your family’s emergency instructions" optionalNote="optional" value={emergency} disabled={!manage}
          hint="Shown to caregivers on an urgent request. Kindly never acts on this by itself."
          placeholder="e.g. If Léo cannot breathe easily, use the blue inhaler and call 999."
          onChange={(e) => setEmergency(e.target.value)} />
      </div>

      <div className="editor-card">
        <header><h3>Bathroom requests</h3></header>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted-foreground)' }}>
          Kindly does not assume a bathroom request can safely wait. Decide this with your child and,
          where it applies, their clinicians. When it is urgent, no delayed answer is ever offered.
        </p>
        <Select label="How should a bathroom request be treated?" value={bathroomUrgency} disabled={!manage}
          onChange={(e) => setBathroomUrgency(e.target.value as Urgency)}
          options={[
            { value: 'urgent', label: 'Urgent — answer now, no delay offered' },
            { value: 'can_wait', label: 'Can wait a little — a short delay may be offered' },
          ]} />
      </div>

      <div className="editor-card">
        <header><h3>Escalation ladder</h3></header>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted-foreground)' }}>
          Measured from the moment a request is delivered. Kindly always adds a final step that shows
          the safe adult and safe place, so your child is never left waiting indefinitely.
        </p>

        {rules.map((rule, index) => (
          <div className="editor-card" key={index} style={{ background: 'var(--background)' }}>
            <header><h3>Step {index + 1}</h3></header>
            <Select label="What should happen?" value={rule.action} disabled={!manage}
              onChange={(e) => setRules((prev) => prev.map((r, i) => (i === index ? { ...r, action: e.target.value as EscalationRule['action'] } : r)))}
              options={[
                { value: 'notify_assigned', label: 'Remind the assigned caregiver' },
                { value: 'notify_trusted', label: 'Ask a trusted caregiver' },
                { value: 'notify_all_caregivers', label: 'Ask everyone who can answer' },
                { value: 'show_offline_help', label: 'Show the safe adult and safe place' },
              ]} />

            {rule.action === 'notify_trusted' && trusted.length > 0 ? (
              <Select label="Which trusted caregiver?" value={rule.trustedCaregiverId ?? ''} disabled={!manage}
                onChange={(e) => setRules((prev) => prev.map((r, i) => (i === index ? { ...r, trustedCaregiverId: e.target.value || null } : r)))}
                options={[{ value: '', label: 'Whoever is first in the list' }, ...trusted.map((t) => ({ value: t.id, label: t.trustedCaregiverName }))]} />
            ) : null}

            <Select label="Applies to" value={rule.appliesToUrgency ?? ''} disabled={!manage}
              onChange={(e) => setRules((prev) => prev.map((r, i) => (i === index ? { ...r, appliesToUrgency: (e.target.value || null) as Urgency | null } : r)))}
              options={[
                { value: '', label: 'All requests' },
                { value: 'urgent', label: 'Urgent requests only' },
                { value: 'can_wait', label: 'Requests that can wait' },
              ]} />

            <div className="field-block">
              <label htmlFor={`rule-after-${index}`}>After this many seconds</label>
              <input id={`rule-after-${index}`} type="number" min={10} max={3600} step={10}
                value={rule.afterSeconds} disabled={!manage}
                onChange={(e) => setRules((prev) => prev.map((r, i) => (i === index ? { ...r, afterSeconds: Number(e.target.value) } : r)))} />
            </div>

            {manage ? (
              <Button tone="ghost" icon="i-x-circle" disabled={rules.length === 1}
                onClick={() => setRules((prev) => prev.filter((_, i) => i !== index))}>
                Remove this step
              </Button>
            ) : null}
          </div>
        ))}

        {manage ? (
          <Button tone="secondary" icon="i-plus"
            onClick={() => setRules((prev) => [...prev, {
              appliesToUrgency: null, stepOrder: prev.length + 1, action: 'notify_all_caregivers',
              trustedCaregiverId: null, afterSeconds: (prev[prev.length - 1]?.afterSeconds ?? 60) + 60, isActive: true,
            }])}>
            Add a step
          </Button>
        ) : null}
      </div>

      <div className="editor-card">
        <header><h3>Grown-up code</h3></header>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted-foreground)' }}>
          Asked for when someone leaves child mode. Your child can always ask for urgent help without
          it, and the offline help screen is always reachable.
        </p>
        <p className="inline-note">
          <Icon name="i-lock" size={16} strokeWidth={2.5} />
          <span>
            The code is always required. A family space holds your child’s private
            messages, so KINDLY does not offer a way to leave the caregiver view
            unlocked.
          </span>
        </p>
        <TextInput label="Set a new code" value={pin} inputMode="numeric" maxLength={8} disabled={!manage}
            placeholder="4 to 8 digits" error={pinError}
            hint={workspace?.adultVerification.isConfigured
              ? 'Leave blank to keep the current code. Kindly never shows an existing code.'
              : 'No code is set yet.'}
          onChange={(e) => { setPin(e.target.value.replace(/\D/g, '').slice(0, 8)); setPinError(null); }} />
      </div>

      {manage ? (
        <div className="row-actions">
          <Button
            tone="coral"
            icon="i-check"
            loading={save.isPending}
            onClick={() => {
              if (pin) {
                const result = validatePin(pin);
                if (!result.ok) { setPinError(result.message); return; }
              }
              save.mutate();
            }}
          >
            Save safety settings
          </Button>
          <Button tone="ghost" onClick={() => navigate('/app/settings')}>Back</Button>
        </div>
      ) : (
        <p className="inline-note">
          <Icon name="i-lock" size={16} strokeWidth={2.5} />
          <span>Your role can see safety settings but not change them.</span>
        </p>
      )}

      {savedAt ? (
        <p className="inline-note" role="status" style={{ marginTop: 14 }}>
          <Icon name="i-check" size={16} strokeWidth={2.5} />
          <span>Saved at {new Date(savedAt).toLocaleTimeString()}.</span>
        </p>
      ) : null}
    </div>
  );
}
