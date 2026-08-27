import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import {
  Button, ErrorState, LoadingState, SectionTitle, Select, TextArea, TextInput, Toggle,
} from '../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../state/providers';
import { childLabel } from '../../lib/names';
import { KindlyError } from '../../lib/types';

interface EditableStep {
  id?: string;
  title: string;
  detail: string;
  pictogramKey: string;
  estimatedSeconds: number | null;
  isOptional: boolean;
  plansChangedNote: string;
}

const emptyStep = (): EditableStep => ({
  title: '', detail: '', pictogramKey: 'i-clock-3',
  estimatedSeconds: null, isOptional: false, plansChangedNote: '',
});

const COLORS = ['yellow', 'coral', 'blue', 'purple', 'mint', 'peach'] as const;

export function RoutineEditorPage({ mode }: { mode: 'new' | 'edit' }) {
  const { routineId = '' } = useParams();
  const backend = useBackend();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { workspace, activeChildId, can } = useWorkspace();
  const { announce } = useAnnouncer();

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const childName = child?.childName ?? '';
  const editable = can('can_edit_routines');

  const query = useQuery({
    queryKey: ['routines', child?.id],
    queryFn: () => backend.listRoutines(child!.id),
    enabled: Boolean(child?.id),
  });

  const existing = query.data?.find((r) => r.id === routineId);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduleLabel, setScheduleLabel] = useState('');
  const [colorKey, setColorKey] = useState<(typeof COLORS)[number]>('yellow');
  const [allowSkip, setAllowSkip] = useState(true);
  const [allowReorder, setAllowReorder] = useState(true);
  const [transitionWarningSeconds, setTransitionWarningSeconds] = useState(60);
  const [steps, setSteps] = useState<EditableStep[]>([emptyStep()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<unknown>(null);

  useEffect(() => {
    if (!existing) return;
    setTitle(existing.title);
    setDescription(existing.description ?? '');
    setScheduleLabel(existing.scheduleLabel ?? '');
    setColorKey(existing.colorKey);
    setAllowSkip(existing.allowSkip);
    setAllowReorder(existing.allowReorder);
    setTransitionWarningSeconds(existing.transitionWarningSeconds);
    setSteps(existing.steps.map((s) => ({
      id: s.id, title: s.title, detail: s.detail ?? '', pictogramKey: s.pictogramKey ?? 'i-clock-3',
      estimatedSeconds: s.estimatedSeconds, isOptional: s.isOptional, plansChangedNote: s.plansChangedNote ?? '',
    })));
  }, [existing]);

  const save = useMutation({
    mutationFn: () => backend.saveRoutine({
      id: mode === 'edit' ? routineId : undefined,
      childId: child!.id,
      title: title.trim(),
      description: description.trim() || null,
      scheduleLabel: scheduleLabel.trim() || null,
      colorKey,
      iconKey: 'i-clock-3',
      allowSkip, allowReorder, transitionWarningSeconds,
      steps: steps.map((s) => ({
        id: s.id,
        title: s.title.trim(),
        detail: s.detail.trim() || null,
        pictogramKey: s.pictogramKey || null,
        estimatedSeconds: s.estimatedSeconds,
        isOptional: s.isOptional,
        plansChangedNote: s.plansChangedNote.trim() || null,
      })),
    }),
    onSuccess: (routine) => {
      setSaveError(null);
      announce('Routine saved.');
      void client.invalidateQueries({ queryKey: ['routines', child?.id] });
      navigate(`/app/routines/${routine.id}`, { replace: true });
    },
    onError: (e) => {
      setSaveError(e);
      announce(e instanceof KindlyError ? e.message : 'That could not be saved.', 'assertive');
    },
  });

  function validateAndSave() {
    const next: Record<string, string> = {};
    if (!title.trim()) next.title = 'Please give this routine a name.';
    steps.forEach((s, i) => { if (!s.title.trim()) next[`step-${i}`] = 'Every step needs a name.'; });
    if (steps.length === 0) next.steps = 'Please add at least one step.';
    setErrors(next);
    if (Object.keys(next).length) {
      announce('There is a problem with the form. Please check the highlighted fields.', 'assertive');
      return;
    }
    save.mutate();
  }

  function move(index: number, delta: number) {
    setSteps((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
    announce(`Step moved to position ${index + delta + 1}.`);
  }

  if (!child) {
    return <div className="content-wrap"><ErrorState error={new KindlyError('CHILD_NOT_FOUND', 'Add a child profile first.')} /></div>;
  }
  if (mode === 'edit' && query.isLoading) return <div className="content-wrap"><LoadingState label="Loading routine" /></div>;
  if (mode === 'edit' && !query.isLoading && !existing) {
    return <div className="content-wrap"><ErrorState error={new KindlyError('ROUTINE_NOT_FOUND', 'That routine could not be found. It may have been deleted.')} /></div>;
  }

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/routines')}>
        <Icon name="i-arrow-left" size={17} /> Back to routines
      </button>

      <SectionTitle
        eyebrow={mode === 'new' ? 'NEW ROUTINE' : 'EDIT ROUTINE'}
        title={mode === 'new' ? 'Build a routine' : title || 'Routine'}
        detail={`For ${childLabel(childName)}. Steps are a shared plan, not a checklist to pass — skipping one is fine.`}
      />

      {saveError ? <ErrorState error={saveError} onRetry={() => setSaveError(null)} /> : null}

      <div className="editor-card">
        <header><h3>About this routine</h3></header>

        <TextInput label="Name" value={title} required disabled={!editable} error={errors.title}
          placeholder="e.g. Morning check-in"
          onChange={(e) => { setTitle(e.target.value); setErrors((p) => ({ ...p, title: '' })); }} />

        <TextArea label="Description" optionalNote="optional" value={description} disabled={!editable}
          placeholder="A gentle sequence of steps to start the day."
          onChange={(e) => setDescription(e.target.value)} />

        <TextInput label="When does this usually happen?" optionalNote="optional" value={scheduleLabel} disabled={!editable}
          placeholder="e.g. Every weekday, 7:30 AM"
          hint="Shown to caregivers. Kindly does not send reminders for this yet."
          onChange={(e) => setScheduleLabel(e.target.value)} />

        <Select label="Colour" value={colorKey} disabled={!editable}
          onChange={(e) => setColorKey(e.target.value as typeof colorKey)}
          options={COLORS.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1) }))}
          hint="Colour is decoration only — every routine also shows its name." />

        <div className="settings-list">
          <Toggle label="Steps can be skipped"
            description="When on, your child sees a “Skip this step” button. Skipping is recorded neutrally."
            checked={allowSkip} onChange={setAllowSkip} disabled={!editable} />
          <Toggle label="Steps can be done in any order"
            description="When on, your child can move between steps freely."
            checked={allowReorder} onChange={setAllowReorder} disabled={!editable} />
        </div>

        <div className="field-block">
          <label htmlFor="transition-warning">Transition warning before the next step</label>
          <input id="transition-warning" type="number" min={0} max={900} step={15}
            value={transitionWarningSeconds} disabled={!editable}
            aria-describedby="transition-warning-help"
            onChange={(e) => setTransitionWarningSeconds(Number(e.target.value))} />
          <small className="field-hint" id="transition-warning-help">
            In seconds. Kindly shows “next is …” for this long. It never moves on by itself.
          </small>
        </div>
      </div>

      <div className="editor-card">
        <header><h3>Steps</h3></header>

        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 16 }}>
          {steps.map((step, index) => (
            <li key={step.id ?? `new-${index}`} className="editor-card" style={{ background: 'var(--background)' }}>
              <header><h3>Step {index + 1}</h3></header>

              <TextInput label="What is this step?" value={step.title} required disabled={!editable}
                error={errors[`step-${index}`]}
                placeholder="e.g. Get dressed"
                onChange={(e) => {
                  const value = e.target.value;
                  setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, title: value } : s)));
                  setErrors((p) => ({ ...p, [`step-${index}`]: '' }));
                }} />

              <TextInput label="A little more detail" optionalNote="optional" value={step.detail} disabled={!editable}
                placeholder="e.g. Your clothes are on the chair."
                onChange={(e) => {
                  const value = e.target.value;
                  setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, detail: value } : s)));
                }} />

              <TextInput label="If plans change, what else could happen?" optionalNote="optional"
                value={step.plansChangedNote} disabled={!editable}
                placeholder="e.g. If today feels hard, we can take breakfast with us."
                hint="Shown when your child chooses “Plans have changed”."
                onChange={(e) => {
                  const value = e.target.value;
                  setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, plansChangedNote: value } : s)));
                }} />

              <div className="settings-list">
                <Toggle label="This step is optional"
                  description="Marked clearly in your child’s view so it never feels required."
                  checked={step.isOptional} disabled={!editable}
                  onChange={(v) => setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, isOptional: v } : s)))} />
              </div>

              {editable ? (
                <div className="row-actions">
                  <Button tone="ghost" icon="i-arrow-left" onClick={() => move(index, -1)} disabled={index === 0}>Move earlier</Button>
                  <Button tone="ghost" icon="i-arrow-right" onClick={() => move(index, 1)} disabled={index === steps.length - 1}>Move later</Button>
                  <Button tone="ghost" icon="i-plus"
                    onClick={() => setSteps((prev) => {
                      const copy = [...prev];
                      copy.splice(index + 1, 0, { ...prev[index]!, id: undefined });
                      return copy;
                    })}>
                    Duplicate
                  </Button>
                  <Button tone="ghost" icon="i-x-circle" disabled={steps.length === 1}
                    onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}>
                    Delete step
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>

        {editable ? (
          <Button tone="secondary" icon="i-plus" onClick={() => setSteps((prev) => [...prev, emptyStep()])}>
            Add a step
          </Button>
        ) : null}
      </div>

      {editable ? (
        <div className="row-actions">
          <Button tone="coral" icon="i-check" onClick={validateAndSave} loading={save.isPending}>
            Save routine
          </Button>
          <Button tone="ghost" onClick={() => navigate('/app/routines')}>Cancel</Button>
        </div>
      ) : (
        <p className="inline-note">
          <Icon name="i-lock" size={16} strokeWidth={2.5} />
          <span>Your role can view routines but not change them.</span>
        </p>
      )}
    </div>
  );
}
