import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Icon } from '../../../components/Icon';
import { Button, ErrorState, SectionTitle, Select, TextInput, Toggle } from '../../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../../state/providers';
import { childLabel } from '../../../lib/names';
import type { ChildPreferences, CommunicationMethod, SensoryPreference } from '../../../lib/types';

const METHOD_OPTIONS: { value: CommunicationMethod['method']; label: string }[] = [
  { value: 'spoken_words', label: 'Spoken words' },
  { value: 'written_words', label: 'Written words' },
  { value: 'pictograms', label: 'Pictures or symbols' },
  { value: 'photos', label: 'Photos' },
  { value: 'gestures', label: 'Gestures' },
  { value: 'sign_language', label: 'Sign language' },
  { value: 'aac_device', label: 'AAC device or app' },
  { value: 'typing', label: 'Typing' },
  { value: 'yes_no_choices', label: 'Yes / no choices' },
  { value: 'other', label: 'Something else' },
];

const CATEGORY_OPTIONS: { value: SensoryPreference['category']; label: string }[] = [
  { value: 'sound', label: 'Sound' }, { value: 'light', label: 'Light' },
  { value: 'touch', label: 'Touch' }, { value: 'movement', label: 'Movement' },
  { value: 'smell', label: 'Smell' }, { value: 'taste', label: 'Taste' },
  { value: 'crowding', label: 'Crowding' }, { value: 'temperature', label: 'Temperature' },
  { value: 'other', label: 'Something else' },
];

export function PreferencesSettingsPage() {
  const backend = useBackend();
  const navigate = useNavigate();
  const { workspace, activeChildId, setActiveChildId, refetch } = useWorkspace();
  const { announce } = useAnnouncer();

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const stored = child ? workspace?.preferences[child.id] : undefined;

  const [prefs, setPrefs] = useState<Partial<ChildPreferences>>({});
  const [methods, setMethods] = useState<Omit<CommunicationMethod, 'id' | 'childId'>[]>([]);
  const [sensory, setSensory] = useState<Omit<SensoryPreference, 'id' | 'childId'>[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (stored) setPrefs(stored);
    if (child) {
      setMethods((workspace?.communicationMethods[child.id] ?? []).map(({ id: _id, childId: _c, ...rest }) => rest));
      setSensory((workspace?.sensoryPreferences[child.id] ?? []).map(({ id: _id, childId: _c, ...rest }) => rest));
    }
  }, [stored, child, workspace]);

  const save = useMutation({
    mutationFn: async () => {
      if (!child) return;
      await backend.updateChildPreferences(child.id, { ...prefs, familyId: child.familyId });
      await backend.setCommunicationMethods(child.id, methods);
      await backend.setSensoryPreferences(child.id, sensory);
    },
    onSuccess: () => {
      setFailure(null);
      setSavedAt(new Date().toISOString());
      announce('Preferences saved. Child mode will use them straight away.');
      refetch();
    },
    onError: (e) => setFailure(e),
  });

  if (!child) {
    return <div className="content-wrap"><ErrorState error={new Error('Add a child profile first.')} /></div>;
  }

  const set = (patch: Partial<ChildPreferences>) => setPrefs((p) => ({ ...p, ...patch }));

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/settings')}>
        <Icon name="i-arrow-left" size={17} /> Back to settings
      </button>

      <SectionTitle
        eyebrow="PREFERENCES"
        title={`How Kindly works for ${childLabel(child.childName)}`}
        detail="These are one child’s preferences, not a description of autism. Change them whenever they stop fitting."
      />

      {workspace!.children.length > 1 ? (
        <div className="chip-wrap" style={{ marginBottom: 18 }}>
          {workspace!.children.map((c) => (
            <button key={c.id} type="button" className={c.id === child.id ? 'choice selected' : 'choice'}
              aria-pressed={c.id === child.id} onClick={() => setActiveChildId(c.id)}>
              {c.childName}
            </button>
          ))}
        </div>
      ) : null}

      {failure ? <ErrorState error={failure} onRetry={() => setFailure(null)} /> : null}

      {/* ---- Communication ---- */}
      <div className="editor-card">
        <header><h3>Ways to communicate</h3></header>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted-foreground)' }}>
          Kindly supports whichever of these your child uses. It never requires speech or reading.
        </p>
        {methods.map((m, index) => (
          <div className="editor-card" key={index} style={{ background: 'var(--background)' }}>
            <Select label="Kind" value={m.method}
              onChange={(e) => setMethods((prev) => prev.map((x, i) => (i === index ? { ...x, method: e.target.value as CommunicationMethod['method'] } : x)))}
              options={METHOD_OPTIONS} />
            <TextInput label="What your child calls it" value={m.label}
              onChange={(e) => setMethods((prev) => prev.map((x, i) => (i === index ? { ...x, label: e.target.value } : x)))} />
            <div className="settings-list">
              <Toggle label="This is their main way" description="Used first in stories and requests."
                checked={m.isPrimary}
                onChange={(v) => setMethods((prev) => prev.map((x, i) => ({ ...x, isPrimary: i === index ? v : v ? false : x.isPrimary })))} />
            </div>
            <Button tone="ghost" icon="i-x-circle" onClick={() => setMethods((prev) => prev.filter((_, i) => i !== index))}>
              Remove
            </Button>
          </div>
        ))}
        <Button tone="secondary" icon="i-plus"
          onClick={() => setMethods((prev) => [...prev, { method: 'pictograms', label: 'Pictures', detail: null, isPrimary: prev.length === 0, sortOrder: prev.length }])}>
          Add a way to communicate
        </Button>
      </div>

      {/* ---- Sensory ---- */}
      <div className="editor-card">
        <header><h3>Sensory notes</h3></header>
        {sensory.map((s, index) => (
          <div className="editor-card" key={index} style={{ background: 'var(--background)' }}>
            <Select label="Is this something that helps, or something that is hard?" value={s.kind}
              onChange={(e) => setSensory((prev) => prev.map((x, i) => (i === index ? { ...x, kind: e.target.value as 'helps' | 'hard' } : x)))}
              options={[{ value: 'helps', label: 'Helps' }, { value: 'hard', label: 'Often hard' }]} />
            <Select label="Category" value={s.category}
              onChange={(e) => setSensory((prev) => prev.map((x, i) => (i === index ? { ...x, category: e.target.value as SensoryPreference['category'] } : x)))}
              options={CATEGORY_OPTIONS} />
            <TextInput label="Describe it" value={s.label}
              onChange={(e) => setSensory((prev) => prev.map((x, i) => (i === index ? { ...x, label: e.target.value } : x)))} />
            <Button tone="ghost" icon="i-x-circle" onClick={() => setSensory((prev) => prev.filter((_, i) => i !== index))}>
              Remove
            </Button>
          </div>
        ))}
        <Button tone="secondary" icon="i-plus"
          onClick={() => setSensory((prev) => [...prev, { category: 'sound', kind: 'helps', label: '', detail: null, sortOrder: prev.length }])}>
          Add a sensory note
        </Button>
      </div>

      {/* ---- Display, sound, motion ---- */}
      <div className="editor-card">
        <header><h3>Display, sound and movement</h3></header>

        <Select label="Familiar symbol system" value={prefs.symbolSystem ?? 'kindly_default'}
          onChange={(e) => set({ symbolSystem: e.target.value as ChildPreferences['symbolSystem'] })}
          options={[
            { value: 'kindly_default', label: 'Kindly’s own symbols' },
            { value: 'photos', label: 'Family-approved photos' },
            { value: 'custom', label: 'Our own pictogram set' },
            { value: 'pcs_like', label: 'A symbol set like PCS' },
            { value: 'arasaac_like', label: 'A symbol set like ARASAAC' },
            { value: 'text_only', label: 'Words only' },
          ]} />

        <div className="field-block">
          <label htmlFor="pref-text-scale">Text size</label>
          <input id="pref-text-scale" type="range" min={0.9} max={2} step={0.1}
            value={prefs.textScale ?? 1}
            aria-valuetext={`${Math.round((prefs.textScale ?? 1) * 100)} percent`}
            aria-describedby="pref-text-scale-help"
            onChange={(e) => set({ textScale: Number(e.target.value) })} />
          <small className="field-hint" id="pref-text-scale-help">
            {Math.round((prefs.textScale ?? 1) * 100)}% of normal size.
          </small>
        </div>

        <div className="settings-list">
          <Toggle label="Pair every symbol with words"
            description="Recommended. Meaning is never carried by a picture alone."
            checked={prefs.pairTextWithSymbols ?? true} onChange={(v) => set({ pairTextWithSymbols: v })} />
          <Toggle label="Higher contrast" checked={prefs.highContrast ?? false} onChange={(v) => set({ highContrast: v })} />
          <Toggle label="Low-stimulation mode" description="Fewer colours, no decorative pictures."
            checked={prefs.lowStimulation ?? false} onChange={(v) => set({ lowStimulation: v })} />
          <Toggle label="Read aloud" description="Adds a read-aloud button to stories and request screens."
            checked={prefs.readAloudEnabled ?? false} onChange={(v) => set({ readAloudEnabled: v })} />
          <Toggle label="Sound" description="Kindly never plays an unexpected sound."
            checked={prefs.soundEnabled ?? false} onChange={(v) => set({ soundEnabled: v })} />
          <Toggle label="Vibration" checked={prefs.vibrationEnabled ?? false} onChange={(v) => set({ vibrationEnabled: v })} />
          <Toggle label="Movement and animation"
            description="Your device’s reduced-motion setting always wins over this."
            checked={prefs.animationEnabled ?? false} onChange={(v) => set({ animationEnabled: v })} />
          <Toggle label="Show countdown numbers"
            description="When off, a wait shows a calm progress bar instead of a clock."
            checked={prefs.countdownsVisible ?? false} onChange={(v) => set({ countdownsVisible: v })} />
          <Toggle label="Allow a written message with a request"
            checked={prefs.allowCustomMessage ?? true} onChange={(v) => set({ allowCustomMessage: v })} />
        </div>

        <div className="field-block">
          <label htmlFor="pref-processing">Processing time</label>
          <input id="pref-processing" type="number" min={0} max={600}
            value={prefs.processingTimeSeconds ?? 10}
            aria-describedby="pref-processing-help"
            onChange={(e) => set({ processingTimeSeconds: Number(e.target.value) })} />
          <small className="field-hint" id="pref-processing-help">
            Seconds Kindly waits before a transition warning finishes. It never advances a step by itself.
          </small>
        </div>
      </div>

      <div className="row-actions">
        <Button tone="coral" icon="i-check" onClick={() => save.mutate()} loading={save.isPending}>Save preferences</Button>
        <Button tone="ghost" onClick={() => navigate('/app/settings')}>Back</Button>
      </div>

      {savedAt ? (
        <p className="inline-note" role="status" style={{ marginTop: 14 }}>
          <Icon name="i-check" size={16} strokeWidth={2.5} />
          <span>Saved at {new Date(savedAt).toLocaleTimeString()}.</span>
        </p>
      ) : null}
    </div>
  );
}
