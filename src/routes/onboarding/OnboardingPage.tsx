import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button, ErrorState, TextInput, Toggle } from '../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../state/providers';
import { drafts } from '../../lib/devicePrefs';
import { childLabel, validatePersonName, validatePin } from '../../lib/names';
import { KindlyError, type Urgency } from '../../lib/types';

/**
 * Onboarding.
 *
 * Six panels grouped into the three phases the design shows in the sidebar.
 * Progress is saved to the server after every panel (caregiver_profiles
 * .onboarding_data), so a caregiver can stop, change device and come back. The
 * local draft is a convenience only — it is cleared as soon as the server has
 * the answer.
 *
 * Nothing here claims the data is private beyond what is actually true: the
 * copy says who can see it, and links to the settings where it can be changed.
 */

const PANELS = ['names', 'communication', 'sensory', 'display', 'safety', 'notifications', 'done'] as const;
type Panel = (typeof PANELS)[number];

const PHASE_OF: Record<Panel, 0 | 1 | 2> = {
  names: 0, communication: 1, sensory: 1, display: 1, safety: 1, notifications: 1, done: 2,
};

const COMMUNICATION_CHOICES = [
  { method: 'spoken_words', label: 'Spoken words' },
  { method: 'written_words', label: 'Written words' },
  { method: 'pictograms', label: 'Pictures or symbols' },
  { method: 'photos', label: 'Photos of familiar things' },
  { method: 'gestures', label: 'Gestures and pointing' },
  { method: 'sign_language', label: 'Sign language' },
  { method: 'aac_device', label: 'An AAC device or app' },
  { method: 'typing', label: 'Typing' },
  { method: 'yes_no_choices', label: 'Yes / no choices' },
] as const;

const SENSORY_HELPS = [
  { category: 'sound', label: 'Quiet spaces' },
  { category: 'touch', label: 'Deep pressure' },
  { category: 'other', label: 'Extra processing time' },
  { category: 'light', label: 'Dim light' },
  { category: 'movement', label: 'Movement breaks' },
  { category: 'sound', label: 'Headphones' },
] as const;

const SENSORY_HARD = [
  { category: 'sound', label: 'Sudden loud noises' },
  { category: 'crowding', label: 'Busy, crowded places' },
  { category: 'light', label: 'Bright or flickering light' },
  { category: 'touch', label: 'Unexpected touch' },
  { category: 'smell', label: 'Strong smells' },
] as const;

interface DraftState {
  caregiverName: string;
  childName: string;
  trustedCaregiverName: string;
  pin: string;
  communication: string[];
  otherCommunication: string;
  sensoryHelps: string[];
  sensoryHard: string[];
  otherSensory: string;
  symbolSystem: 'kindly_default' | 'photos' | 'custom' | 'text_only';
  textScale: number;
  highContrast: boolean;
  lowStimulation: boolean;
  readAloudEnabled: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  animationEnabled: boolean;
  countdownsVisible: boolean;
  processingTimeSeconds: number;
  safeAdult: string;
  safePlace: string;
  bathroomUrgency: Urgency;
  escalationDelaySeconds: number;
  notificationsRequested: boolean;
}

const EMPTY: DraftState = {
  caregiverName: '', childName: '', trustedCaregiverName: '', pin: '',
  communication: [], otherCommunication: '', sensoryHelps: [], sensoryHard: [], otherSensory: '',
  symbolSystem: 'kindly_default', textScale: 1, highContrast: false, lowStimulation: false,
  readAloudEnabled: false, soundEnabled: false, vibrationEnabled: false, animationEnabled: false,
  countdownsVisible: false, processingTimeSeconds: 10,
  safeAdult: '', safePlace: '', bathroomUrgency: 'urgent', escalationDelaySeconds: 120,
  notificationsRequested: false,
};

export function OnboardingPage() {
  const backend = useBackend();
  const navigate = useNavigate();
  const params = useParams();
  const { workspace, refetch, activeChildId } = useWorkspace();
  const { announce } = useAnnouncer();

  const panel = (PANELS.includes(params.step as Panel) ? params.step : 'names') as Panel;
  const phase = PHASE_OF[panel];

  const [state, setState] = useState<DraftState>(() => ({
    ...EMPTY,
    ...(drafts.get<Partial<DraftState>>('draft:onboarding') ?? {}),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  // Resume from what the server already knows.
  useEffect(() => {
    if (!workspace?.caregiver) return;
    setState((prev) => ({
      ...prev,
      ...(workspace.caregiver!.onboardingData as Partial<DraftState>),
      caregiverName: prev.caregiverName || workspace.caregiver!.caregiverName,
    }));
  }, [workspace?.caregiver]);

  const patch = (next: Partial<DraftState>) => {
    setState((prev) => {
      const merged = { ...prev, ...next };
      drafts.set('draft:onboarding', merged);
      return merged;
    });
  };

  const childId = activeChildId ?? workspace?.children[0]?.id ?? null;
  const childDisplay = childLabel(state.childName || workspace?.children[0]?.childName);

  const goTo = (next: Panel) => navigate(`/onboarding/${next}`);

  async function saveDraftToServer(stage: 'names' | 'preferences' | 'safety' | 'notifications') {
    try {
      await backend.saveOnboardingDraft(stage, state as unknown as Record<string, unknown>);
    } catch {
      // Saving progress is best-effort; the panel still advances and the local
      // draft still holds the answers. We never pretend it saved when it did not.
      announce('Your progress could not be saved to the server yet. It is safe on this device.', 'polite');
    }
  }

  async function submitNames() {
    const caregiver = validatePersonName(state.caregiverName, 'a name for yourself');
    const child = validatePersonName(state.childName, 'your child’s name');
    const trusted = validatePersonName(state.trustedCaregiverName, 'this person’s name', { required: false });
    const pin = validatePin(state.pin);

    const next: Record<string, string> = {};
    if (!caregiver.ok) next.caregiverName = caregiver.message;
    if (!child.ok) next.childName = child.message;
    if (!trusted.ok) next.trustedCaregiverName = trusted.message;
    if (!pin.ok) next.pin = pin.message;
    if (Object.keys(next).length) {
      setErrors(next);
      announce('There is a problem with the form. Please check the highlighted fields.', 'assertive');
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      if (!workspace?.activeFamilyId) {
        await backend.bootstrapFamily({
          caregiverName: caregiver.ok ? caregiver.value : '',
          childName: child.ok ? child.value : '',
          trustedCaregiverName: trusted.ok && trusted.value ? trusted.value : null,
          pin: pin.ok ? pin.value : null,
        });
      } else {
        await backend.updateCaregiverProfile({ caregiverName: caregiver.ok ? caregiver.value : '' });
        if (childId) await backend.updateChild(childId, { childName: child.ok ? child.value : '' });
        if (pin.ok && pin.value) {
          await backend.setCaregiverPin(workspace.activeFamilyId, pin.value);
        }
      }
      await saveDraftToServer('names');
      refetch();
      setErrors({});
      goTo('communication');
    } catch (error) {
      setFailure(error);
      announce(error instanceof KindlyError ? error.message : 'That could not be saved.', 'assertive');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setFailure(null);
    try {
      const fresh = await backend.loadWorkspace(workspace?.activeFamilyId ?? null);
      const targetChild = fresh.children[0];
      if (!targetChild) throw new KindlyError('CHILD_NOT_FOUND', 'Your child profile could not be found. Please go back and check the name.');

      await backend.setCommunicationMethods(
        targetChild.id,
        [
          ...state.communication.map((method, i) => ({
            method: method as never,
            label: COMMUNICATION_CHOICES.find((c) => c.method === method)?.label ?? method,
            detail: null, isPrimary: i === 0, sortOrder: i,
          })),
          ...(state.otherCommunication.trim()
            ? [{ method: 'other' as const, label: state.otherCommunication.trim(), detail: null, isPrimary: false, sortOrder: 99 }]
            : []),
        ],
      );

      await backend.setSensoryPreferences(targetChild.id, [
        ...state.sensoryHelps.map((label, i) => ({
          category: (SENSORY_HELPS.find((s) => s.label === label)?.category ?? 'other') as never,
          kind: 'helps' as const, label, detail: null, sortOrder: i,
        })),
        ...state.sensoryHard.map((label, i) => ({
          category: (SENSORY_HARD.find((s) => s.label === label)?.category ?? 'other') as never,
          kind: 'hard' as const, label, detail: null, sortOrder: 50 + i,
        })),
        ...(state.otherSensory.trim()
          ? [{ category: 'other' as const, kind: 'helps' as const, label: state.otherSensory.trim(), detail: null, sortOrder: 99 }]
          : []),
      ]);

      await backend.updateChildPreferences(targetChild.id, {
        familyId: targetChild.familyId,
        symbolSystem: state.symbolSystem,
        textScale: state.textScale,
        highContrast: state.highContrast,
        lowStimulation: state.lowStimulation,
        readAloudEnabled: state.readAloudEnabled,
        soundEnabled: state.soundEnabled,
        vibrationEnabled: state.vibrationEnabled,
        animationEnabled: state.animationEnabled,
        countdownsVisible: state.countdownsVisible,
        processingTimeSeconds: state.processingTimeSeconds,
        bathroomUrgency: state.bathroomUrgency,
        escalationDelaySeconds: state.escalationDelaySeconds,
      });

      await backend.updateChild(targetChild.id, {
        safeAdult: state.safeAdult.trim() || null,
        safePlace: state.safePlace.trim() || null,
      });

      await backend.saveOnboardingDraft('complete', {});
      drafts.clear('draft:onboarding');
      refetch();
      goTo('done');
      announce('Setup is complete.');
    } catch (error) {
      setFailure(error);
      announce(error instanceof KindlyError ? error.message : 'That could not be saved.', 'assertive');
    } finally {
      setBusy(false);
    }
  }

  async function requestNotificationPermission() {
    if (typeof Notification === 'undefined') {
      patch({ notificationsRequested: true });
      announce('This browser cannot show notifications. Kindly will still show requests inside the app.');
      return;
    }
    const result = await Notification.requestPermission();
    patch({ notificationsRequested: true });
    announce(result === 'granted'
      ? 'Notifications are on.'
      : 'Notifications are off. Urgent requests will still appear inside Kindly and will still escalate.');
  }

  const stepLabel = useMemo(() => {
    const index = PANELS.indexOf(panel);
    return `Step ${Math.min(index + 1, PANELS.length)} of ${PANELS.length}`;
  }, [panel]);

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <main className="onboarding-page" id="main-content">
      <header className="onboarding-top">
        <span className="onboarding-brand">
          <span className="brand-mark"><Icon name="i-heart" size={19} fill="currentColor" stroke="none" /></span> Kindly
        </span>
        <span className="onboarding-progress" role="status">{stepLabel}</span>
      </header>

      <div className="onboarding-layout">
        <aside className="onboarding-aside">
          <div className="onboarding-sun"><Icon name="i-sparkles" size={24} /></div>
          <span className="eyebrow">A SOFTER START</span>
          <h1>Let’s make more good days.</h1>
          <p>Kindly helps you prepare, communicate, and connect in ways that feel right for your family.</p>
          <ol className="onboarding-steps" aria-label="Onboarding progress">
            {[
              { title: 'Let us get to know you both', detail: 'Your name and your child’s name help Kindly feel more personal.' },
              { title: 'Choose what helps', detail: 'Pick the supports that make everyday moments easier.' },
              { title: 'You are ready', detail: 'We will use this to shape stories, routines, and requests.' },
            ].map((step, index) => (
              <li
                key={step.title}
                className={`onboarding-step ${phase === index ? 'current' : phase > index ? 'done' : ''}`}
                aria-current={phase === index ? 'step' : undefined}
              >
                <span>{phase > index ? <Icon name="i-check" size={15} strokeWidth={2.5} /> : index + 1}</span>
                <div><b>{step.title}</b><small>{step.detail}</small></div>
              </li>
            ))}
          </ol>
        </aside>

        <section className="onboarding-card" aria-labelledby="onboarding-title">
          {failure ? <ErrorState error={failure} onRetry={() => setFailure(null)} /> : null}

          {panel === 'names' ? (
            <div className="onboarding-form">
              <span className="eyebrow">FIRST, A LITTLE ABOUT YOU BOTH</span>
              <h2 id="onboarding-title">Who is here today?</h2>
              <p className="onboarding-copy">
                Your name lets your child see who is helping. Your child’s name makes this space feel
                like theirs. You can change either one later in Settings.
              </p>

              <TextInput
                label="Your preferred name"
                value={state.caregiverName}
                required
                autoComplete="off"
                placeholder="e.g. Mum, Priya, Mr. O’Neill"
                hint="This is what your child will see when you answer a request."
                error={errors.caregiverName}
                onChange={(e) => { patch({ caregiverName: e.target.value }); setErrors((p) => ({ ...p, caregiverName: '' })); }}
              />

              <TextInput
                label="Your child’s name"
                value={state.childName}
                required
                autoComplete="off"
                placeholder="e.g. Ana, Léo, 小明"
                hint="The name your child likes to be called."
                error={errors.childName}
                onChange={(e) => { patch({ childName: e.target.value }); setErrors((p) => ({ ...p, childName: '' })); }}
              />

              <TextInput
                label="Another trusted caregiver"
                optionalNote="optional"
                value={state.trustedCaregiverName}
                autoComplete="off"
                placeholder="e.g. Grandma, Mr. O’Neill"
                hint="If you cannot answer a request in time, Kindly asks this person instead."
                error={errors.trustedCaregiverName}
                onChange={(e) => { patch({ trustedCaregiverName: e.target.value }); setErrors((p) => ({ ...p, trustedCaregiverName: '' })); }}
              />

              <TextInput
                label="Grown-up code"
                value={state.pin}
                required
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                placeholder="4 to 8 digits"
                hint="Digits that unlock the caregiver view when you leave child mode. Your child can still ask for urgent help without it, and offline help is always reachable."
                error={errors.pin}
                onChange={(e) => { patch({ pin: e.target.value.replace(/\D/g, '').slice(0, 8) }); setErrors((p) => ({ ...p, pin: '' })); }}
              />

              <p className="onboarding-note">
                <Icon name="i-heart" size={17} fill="currentColor" stroke="none" />
                <span>
                  These names are stored in your family space and are visible to the caregivers you
                  invite. Nobody outside your family can see them.
                </span>
              </p>

              <div className="onboarding-actions">
                <span />
                <Button tone="coral" onClick={submitNames} loading={busy} loadingLabel="Saving…" iconAfter="i-arrow-right">
                  Continue
                </Button>
              </div>
            </div>
          ) : null}

          {panel === 'communication' ? (
            <div className="onboarding-form">
              <span className="eyebrow">WHAT HELPS MOST</span>
              <h2 id="onboarding-title">How does {childDisplay} like to communicate?</h2>
              <p className="onboarding-copy">
                Choose as many as you like. Kindly supports communication — it never asks a child to speak.
              </p>
              <div className="onboarding-options">
                {COMMUNICATION_CHOICES.map((choice) => {
                  const on = state.communication.includes(choice.method);
                  return (
                    <button
                      key={choice.method}
                      type="button"
                      className={on ? 'onboarding-option selected' : 'onboarding-option'}
                      aria-pressed={on}
                      onClick={() => patch({ communication: toggleIn(state.communication, choice.method) })}
                    >
                      <span>{on ? <Icon name="i-check" size={15} strokeWidth={2.5} /> : null}</span>
                      <b>{choice.label}</b>
                    </button>
                  );
                })}
              </div>
              <TextInput
                label="Another way that helps"
                optionalNote="optional"
                value={state.otherCommunication}
                placeholder="e.g. A picture book we made together"
                hint="Describe it in your own words. It will show with the others."
                onChange={(e) => patch({ otherCommunication: e.target.value })}
              />
              <div className="onboarding-actions">
                <Button className="onboarding-back" tone="ghost" icon="i-arrow-left" onClick={() => goTo('names')}>Previous</Button>
                <Button tone="coral" iconAfter="i-arrow-right" onClick={() => { void saveDraftToServer('preferences'); goTo('sensory'); }}>Continue</Button>
              </div>
            </div>
          ) : null}

          {panel === 'sensory' ? (
            <div className="onboarding-form">
              <span className="eyebrow">WHAT HELPS MOST</span>
              <h2 id="onboarding-title">What helps {childDisplay} feel steadier?</h2>
              <p className="onboarding-copy">
                There is no perfect answer, and none of this is a diagnosis. Start with what feels
                useful today — you can change it whenever you like.
              </p>

              <h3 style={{ fontSize: 15, margin: '4px 0 0' }}>Things that help</h3>
              <div className="onboarding-options">
                {SENSORY_HELPS.map((item) => {
                  const on = state.sensoryHelps.includes(item.label);
                  return (
                    <button
                      key={item.label}
                      type="button"
                      className={on ? 'onboarding-option selected' : 'onboarding-option'}
                      aria-pressed={on}
                      onClick={() => patch({ sensoryHelps: toggleIn(state.sensoryHelps, item.label) })}
                    >
                      <span>{on ? <Icon name="i-check" size={15} strokeWidth={2.5} /> : null}</span>
                      <b>{item.label}</b>
                    </button>
                  );
                })}
              </div>

              <h3 style={{ fontSize: 15, margin: '12px 0 0' }}>Things that are often hard</h3>
              <div className="onboarding-options">
                {SENSORY_HARD.map((item) => {
                  const on = state.sensoryHard.includes(item.label);
                  return (
                    <button
                      key={item.label}
                      type="button"
                      className={on ? 'onboarding-option selected' : 'onboarding-option'}
                      aria-pressed={on}
                      onClick={() => patch({ sensoryHard: toggleIn(state.sensoryHard, item.label) })}
                    >
                      <span>{on ? <Icon name="i-check" size={15} strokeWidth={2.5} /> : null}</span>
                      <b>{item.label}</b>
                    </button>
                  );
                })}
              </div>

              <TextInput
                label="Something else that helps"
                optionalNote="optional"
                value={state.otherSensory}
                placeholder="e.g. Noise-cancelling headphones"
                onChange={(e) => patch({ otherSensory: e.target.value })}
              />

              <div className="onboarding-actions">
                <Button className="onboarding-back" tone="ghost" icon="i-arrow-left" onClick={() => goTo('communication')}>Previous</Button>
                <Button tone="coral" iconAfter="i-arrow-right" onClick={() => { void saveDraftToServer('preferences'); goTo('display'); }}>Continue</Button>
              </div>
            </div>
          ) : null}

          {panel === 'display' ? (
            <div className="onboarding-form">
              <span className="eyebrow">HOW KINDLY SHOULD LOOK AND FEEL</span>
              <h2 id="onboarding-title">Text, symbols, sound and movement.</h2>
              <p className="onboarding-copy">
                Everything below starts switched off. Nothing will make a sound, vibrate, animate or
                count down unless you turn it on here.
              </p>

              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="eyebrow" style={{ marginBottom: 8 }}>FAMILIAR SYMBOLS</legend>
                <div className="format-list">
                  {[
                    { value: 'kindly_default', label: 'Kindly’s own symbols', detail: 'Simple line drawings that come with the app' },
                    { value: 'photos', label: 'Photos we choose', detail: 'Family-approved photographs you upload' },
                    { value: 'custom', label: 'Our own pictogram set', detail: 'Upload the symbols your child already knows' },
                    { value: 'text_only', label: 'Words only', detail: 'No symbols, just short written labels' },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={state.symbolSystem === option.value ? 'format selected' : 'format'}
                      aria-pressed={state.symbolSystem === option.value}
                      onClick={() => patch({ symbolSystem: option.value as DraftState['symbolSystem'] })}
                    >
                      <span className="radio" aria-hidden="true" />
                      {option.label}
                      <small>{option.detail}</small>
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="field-block">
                <label htmlFor="text-scale">Text size</label>
                <input
                  id="text-scale"
                  type="range"
                  min={0.9}
                  max={2}
                  step={0.1}
                  value={state.textScale}
                  aria-describedby="text-scale-help"
                  aria-valuetext={`${Math.round(state.textScale * 100)} percent`}
                  onChange={(e) => patch({ textScale: Number(e.target.value) })}
                />
                <small className="field-hint" id="text-scale-help">
                  Currently {Math.round(state.textScale * 100)}% of the normal size.
                </small>
              </div>

              <div className="settings-list">
                <Toggle label="Higher contrast" description="Stronger text and border colours." checked={state.highContrast} onChange={(v) => patch({ highContrast: v })} />
                <Toggle label="Low-stimulation mode" description="Fewer colours, no decorative pictures, no shadows." checked={state.lowStimulation} onChange={(v) => patch({ lowStimulation: v })} />
                <Toggle label="Read aloud" description="Adds a read-aloud button to stories and requests." checked={state.readAloudEnabled} onChange={(v) => patch({ readAloudEnabled: v })} />
                <Toggle label="Sound" description="Off by default. Kindly never plays an unexpected sound." checked={state.soundEnabled} onChange={(v) => patch({ soundEnabled: v })} />
                <Toggle label="Vibration" description="Off by default." checked={state.vibrationEnabled} onChange={(v) => patch({ vibrationEnabled: v })} />
                <Toggle label="Movement and animation" description="Off by default. Your device’s reduced-motion setting always wins." checked={state.animationEnabled} onChange={(v) => patch({ animationEnabled: v })} />
                <Toggle label="Show countdowns" description="When off, a wait shows a calm progress bar with no numbers." checked={state.countdownsVisible} onChange={(v) => patch({ countdownsVisible: v })} />
              </div>

              <div className="field-block">
                <label htmlFor="processing-time">Processing time before a transition warning ends</label>
                <input
                  id="processing-time"
                  type="number"
                  min={0}
                  max={600}
                  value={state.processingTimeSeconds}
                  aria-describedby="processing-time-help"
                  onChange={(e) => patch({ processingTimeSeconds: Number(e.target.value) })}
                />
                <small className="field-hint" id="processing-time-help">
                  In seconds. Kindly waits at least this long before moving on, and never forces a step.
                </small>
              </div>

              <div className="onboarding-actions">
                <Button className="onboarding-back" tone="ghost" icon="i-arrow-left" onClick={() => goTo('sensory')}>Previous</Button>
                <Button tone="coral" iconAfter="i-arrow-right" onClick={() => { void saveDraftToServer('preferences'); goTo('safety'); }}>Continue</Button>
              </div>
            </div>
          ) : null}

          {panel === 'safety' ? (
            <div className="onboarding-form">
              <span className="eyebrow">IF NOBODY CAN ANSWER</span>
              <h2 id="onboarding-title">Who and where is safe?</h2>
              <p className="onboarding-copy">
                If no caregiver answers in time, Kindly shows your child these two things instead of
                leaving them waiting. Kindly is not an emergency service and will never contact
                emergency services for you.
              </p>

              <TextInput
                label="A safe adult near your child"
                value={state.safeAdult}
                placeholder="e.g. your teacher, Mr. O’Neill"
                hint="Written the way your child would be told it out loud."
                onChange={(e) => patch({ safeAdult: e.target.value })}
              />
              <TextInput
                label="A safe place your child can go"
                value={state.safePlace}
                placeholder="e.g. the quiet corner in the library"
                hint="Somewhere your child can get to on their own."
                onChange={(e) => patch({ safePlace: e.target.value })}
              />

              <fieldset style={{ border: 0, padding: 0, margin: '8px 0 0' }}>
                <legend className="eyebrow" style={{ marginBottom: 8 }}>BATHROOM REQUESTS</legend>
                <p className="onboarding-copy" style={{ marginTop: 0 }}>
                  Kindly does not assume a bathroom request can safely wait. Choose what is right for
                  your child, with their clinicians if that applies.
                </p>
                <div className="format-list">
                  {[
                    { value: 'urgent', label: 'Treat as urgent', detail: 'No “in 5 minutes” answer is offered' },
                    { value: 'can_wait', label: 'Can wait a little', detail: 'A short delay may be offered' },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={state.bathroomUrgency === option.value ? 'format selected' : 'format'}
                      aria-pressed={state.bathroomUrgency === option.value}
                      onClick={() => patch({ bathroomUrgency: option.value as Urgency })}
                    >
                      <span className="radio" aria-hidden="true" />
                      {option.label}
                      <small>{option.detail}</small>
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="field-block">
                <label htmlFor="escalation-delay">Ask another trusted caregiver after</label>
                <input
                  id="escalation-delay"
                  type="number"
                  min={15}
                  max={1800}
                  step={15}
                  value={state.escalationDelaySeconds}
                  aria-describedby="escalation-delay-help"
                  onChange={(e) => patch({ escalationDelaySeconds: Number(e.target.value) })}
                />
                <small className="field-hint" id="escalation-delay-help">
                  In seconds, measured from delivery. If nobody answers at all, Kindly shows your
                  child the safe adult and safe place above.
                </small>
              </div>

              <div className="onboarding-actions">
                <Button className="onboarding-back" tone="ghost" icon="i-arrow-left" onClick={() => goTo('display')}>Previous</Button>
                <Button tone="coral" iconAfter="i-arrow-right" onClick={() => { void saveDraftToServer('safety'); goTo('notifications'); }}>Continue</Button>
              </div>
            </div>
          ) : null}

          {panel === 'notifications' ? (
            <div className="onboarding-form">
              <span className="eyebrow">STAYING REACHABLE</span>
              <h2 id="onboarding-title">How should Kindly reach you?</h2>
              <p className="onboarding-copy">
                Requests always appear inside Kindly. A device notification is an extra, not the only
                path — an urgent request never depends on one arriving.
              </p>

              <p className="inline-note">
                <Icon name="i-bell" size={16} strokeWidth={2.5} />
                <span>
                  {typeof Notification === 'undefined'
                    ? 'This browser cannot show notifications. Kindly will show requests in the app.'
                    : Notification.permission === 'granted'
                      ? 'Notifications are on for this device.'
                      : Notification.permission === 'denied'
                        ? 'This device has blocked notifications. You can change that in your browser settings. Requests will still appear inside Kindly.'
                        : 'Kindly has not asked for notification permission yet.'}
                </span>
              </p>

              <Button
                tone="secondary"
                icon="i-bell"
                onClick={requestNotificationPermission}
                disabled={typeof Notification !== 'undefined' && Notification.permission !== 'default'}
              >
                Turn on notifications for this device
              </Button>

              <div className="onboarding-actions">
                <Button className="onboarding-back" tone="ghost" icon="i-arrow-left" onClick={() => goTo('safety')}>Previous</Button>
                <Button tone="coral" onClick={finish} loading={busy} loadingLabel="Saving…" iconAfter="i-arrow-right">
                  Finish setup
                </Button>
              </div>
            </div>
          ) : null}

          {panel === 'done' ? (
            <div className="onboarding-form onboarding-complete">
              <div className="onboarding-completion-badge">
                <span className="onboarding-check"><Icon name="i-check" size={22} strokeWidth={2.5} /></span>
                <span>YOU’RE ALL SET</span>
              </div>
              <h2 id="onboarding-title">
                Welcome to your Kindly space{state.caregiverName ? `, ${state.caregiverName.trim()}` : ''}.
              </h2>
              <p className="onboarding-copy">
                We will start with what you chose and learn what helps {childDisplay} along the way.
                Everything here can be changed in Settings.
              </p>
              <Button tone="coral" className="onboarding-complete-cta" iconAfter="i-arrow-right" onClick={() => navigate('/app')}>
                Go to my space
              </Button>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
