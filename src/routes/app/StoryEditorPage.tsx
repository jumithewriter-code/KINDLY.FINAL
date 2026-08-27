import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import {
  Button, Dialog, ErrorState, LoadingState, SectionTitle, Select, TextArea, TextInput,
} from '../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../state/providers';
import { childLabel } from '../../lib/names';
import { formatDateTime } from '../../lib/format';
import { SCENARIOS, SCENARIO_BY_KEY, SECTION_HEADINGS } from '../../lib/stories/scenarios';
import { buildStory, minimalGenerationPayload } from '../../lib/stories/generator';
import { reviewStory } from '../../lib/stories/safetyReview';
import { KindlyError, type ReviewFlag, type StorySectionKey } from '../../lib/types';

interface EditablePage {
  id?: string;
  sectionKey: StorySectionKey;
  heading: string | null;
  body: string;
  certainty: 'fact' | 'possibility' | 'choice';
  pictogramKey: string | null;
  altText: string | null;
}

const SECTION_OPTIONS = (Object.keys(SECTION_HEADINGS) as StorySectionKey[])
  .map((key) => ({ value: key, label: SECTION_HEADINGS[key] }));

/**
 * The story editor.
 *
 * The whole point of this screen is that a caregiver sees, and can change,
 * every sentence before a child ever does. Saving always produces a draft;
 * approving is a separate, deliberate action; and giving it to a child is a
 * third one. Generated text is labelled as a draft everywhere it appears.
 */
export function StoryEditorPage({ mode }: { mode: 'new' | 'edit' }) {
  const { storyId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const backend = useBackend();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { workspace, activeChildId, can } = useWorkspace();
  const { announce } = useAnnouncer();

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const childName = child?.childName ?? '';
  const prefs = child ? workspace?.preferences[child.id] : undefined;
  const communication = child ? (workspace?.communicationMethods[child.id] ?? []) : [];
  const sensory = child ? (workspace?.sensoryPreferences[child.id] ?? []) : [];

  const storyQuery = useQuery({
    queryKey: ['story', storyId],
    queryFn: () => backend.getStory(storyId),
    enabled: mode === 'edit' && Boolean(storyId),
  });

  const versionsQuery = useQuery({
    queryKey: ['story-versions', storyId],
    queryFn: () => backend.listStoryVersions(storyId),
    enabled: mode === 'edit' && Boolean(storyId),
  });

  const [title, setTitle] = useState('');
  const [scenarioKey, setScenarioKey] = useState(searchParams.get('scenario') ?? 'meeting_new_person');
  const [person, setPerson] = useState<'first_person' | 'third_person'>('first_person');
  const [readingLevel, setReadingLevel] = useState<'pre_reader' | 'simple' | 'developing' | 'confident'>('simple');
  const [format, setFormat] = useState<'text' | 'pictogram' | 'photo' | 'audio' | 'mixed'>(
    (searchParams.get('format') as 'text' | 'pictogram' | 'mixed' | null) ?? 'text',
  );
  const [pages, setPages] = useState<EditablePage[]>([]);
  const [inputs, setInputs] = useState({
    location: '', people: '', whatUsuallyHappens: '', whatMayFeelDifficult: '',
    knownTriggers: '', sensoryEnvironment: '', strengthsAndStrategies: '', expectedChanges: '',
    lengthPages: 12,
  });

  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const story = storyQuery.data;
  const editable = can('can_edit_stories');

  // Load an existing story into the editor exactly once.
  useEffect(() => {
    if (!story) return;
    setTitle(story.title);
    setScenarioKey(story.scenarioKey);
    setPerson(story.person);
    setReadingLevel(story.readingLevel);
    setFormat(story.format);
    setPages(story.pages.map((p) => ({
      id: p.id, sectionKey: p.sectionKey, heading: p.heading, body: p.body,
      certainty: p.certainty, pictogramKey: p.pictogramKey, altText: p.altText,
    })));
    const stored = story.inputs as Partial<typeof inputs>;
    setInputs((prev) => ({ ...prev, ...stored }));
  }, [story]);

  // Live review of whatever is currently in the editor.
  const review = useMemo(
    () => reviewStory(title, pages.map((p, i) => ({ position: i, heading: p.heading, body: p.body })), {
      scenarioNeedsSafetyReview: SCENARIO_BY_KEY[scenarioKey]?.needsCaregiverSafetyReview ?? false,
    }),
    [title, pages, scenarioKey],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!child) throw new KindlyError('CHILD_NOT_FOUND', 'Add a child profile first.');
      return backend.saveStoryDraft({
        id: mode === 'edit' ? storyId : undefined,
        childId: child.id,
        title: title.trim(),
        scenarioKey,
        source: story?.source ?? (generatedOnce ? 'generated' : 'manual'),
        format, person, readingLevel,
        inputs,
        pages: pages.map((p) => ({
          id: p.id, sectionKey: p.sectionKey, heading: p.heading, body: p.body,
          certainty: p.certainty, pictogramKey: p.pictogramKey, altText: p.altText,
        })),
        generation: provenance
          ?? (story?.generationModel
            ? { model: story.generationModel, promptVersion: story.generationPromptVersion ?? '', generatedAt: story.generatedAt ?? '' }
            : null),
      });
    },
    onSuccess: (saved) => {
      setSaveError(null);
      setSavedAt(new Date().toISOString());
      announce('Saved as a draft. Nothing has changed for your child yet.');
      void client.invalidateQueries({ queryKey: ['stories', child?.id] });
      if (mode === 'new') navigate(`/app/stories/${saved.id}`, { replace: true });
      else void client.invalidateQueries({ queryKey: ['story', storyId] });
    },
    onError: (e) => {
      setSaveError(e);
      announce(e instanceof KindlyError ? e.message : 'That could not be saved.', 'assertive');
    },
  });

  const approve = useMutation({
    mutationFn: () => backend.approveStory(storyId, true),
    onSuccess: () => {
      setConfirmApprove(false);
      announce('Story approved. You can now give it to your child.');
      void client.invalidateQueries({ queryKey: ['story', storyId] });
      void client.invalidateQueries({ queryKey: ['story-versions', storyId] });
      void client.invalidateQueries({ queryKey: ['stories', child?.id] });
    },
    onError: (e) => { setConfirmApprove(false); setSaveError(e); },
  });

  const assign = useMutation({
    mutationFn: () => backend.assignStory(storyId, child!.id),
    onSuccess: () => {
      announce(`${childLabel(childName, { capital: true })} can now open this story in child mode.`);
      void client.invalidateQueries({ queryKey: ['story', storyId] });
      void client.invalidateQueries({ queryKey: ['stories', child?.id] });
    },
    onError: (e) => setSaveError(e),
  });

  const withdraw = useMutation({
    mutationFn: () => backend.withdrawStory(storyId, child!.id),
    onSuccess: () => {
      announce('That story is no longer available in child mode.');
      void client.invalidateQueries({ queryKey: ['story', storyId] });
      void client.invalidateQueries({ queryKey: ['stories', child?.id] });
    },
  });

  const [generatedOnce, setGeneratedOnce] = useState(false);

  const [generationNote, setGenerationNote] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<{ model: string; promptVersion: string; generatedAt: string } | null>(null);

  /** Falls back to the built-in builder, which is a complete feature. */
  function buildLocally(): void {
    if (!child) return;
      const built = buildStory({
        childName,
        scenarioKey,
        location: inputs.location,
        people: inputs.people,
        whatUsuallyHappens: inputs.whatUsuallyHappens,
        whatMayFeelDifficult: inputs.whatMayFeelDifficult,
        knownTriggers: inputs.knownTriggers,
        sensoryEnvironment: inputs.sensoryEnvironment || sensory.filter((s) => s.kind === 'hard').map((s) => s.label).join(', '),
        communicationMethod: communication.find((c) => c.isPrimary)?.label ?? communication[0]?.label ?? null,
        strengthsAndStrategies: inputs.strengthsAndStrategies || sensory.filter((s) => s.kind === 'helps').map((s) => s.label).join(', '),
        expectedChanges: inputs.expectedChanges,
        safeAdult: child.safeAdult,
        safePlace: child.safePlace,
        lengthPages: inputs.lengthPages,
        readingLevel,
        person,
      });
      setTitle(built.title);
      setPages(built.pages.map((p) => ({
        sectionKey: p.sectionKey, heading: p.heading, body: p.body,
        certainty: p.certainty, pictogramKey: null, altText: null,
      })));
      setGeneratedOnce(true);
      setProvenance({ model: 'kindly-template-builder', promptVersion: TEMPLATE_VERSION, generatedAt: new Date().toISOString() });
      announce(`A draft with ${built.pages.length} pages is ready for you to read and change.`);
  }

  async function generate() {
    if (!child) return;
    setGenerating(true);
    setGenerationError(null);
    setGenerationNote(null);
    try {
      const payload = minimalGenerationPayload({
        childName: '', scenarioKey,
        location: inputs.location, people: inputs.people,
        whatUsuallyHappens: inputs.whatUsuallyHappens,
        whatMayFeelDifficult: inputs.whatMayFeelDifficult,
        knownTriggers: inputs.knownTriggers,
        sensoryEnvironment: inputs.sensoryEnvironment
          || sensory.filter((s) => s.kind === 'hard').map((s) => s.label).join(', '),
        communicationMethod: communication.find((c) => c.isPrimary)?.label ?? communication[0]?.label ?? null,
        strengthsAndStrategies: inputs.strengthsAndStrategies
          || sensory.filter((s) => s.kind === 'helps').map((s) => s.label).join(', '),
        expectedChanges: inputs.expectedChanges,
        safeAdult: child.safeAdult, safePlace: child.safePlace,
        lengthPages: inputs.lengthPages, readingLevel, person,
      });

      const generated = await backend.generateStory(child.id, {
        ...payload,
        scenarioLabel: scenario?.label ?? scenarioKey,
      });

      setTitle(generated.title);
      setPages(generated.pages
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((p) => ({
          sectionKey: p.sectionKey as StorySectionKey,
          heading: p.heading, body: p.body, certainty: p.certainty,
          pictogramKey: null, altText: null,
        })));
      setGeneratedOnce(true);
      setProvenance(generated.provenance);
      announce(`A draft with ${generated.pages.length} pages is ready for you to read and change.`);
    } catch (e) {
      // Every failure mode ends the same way: the caregiver still gets a draft,
      // and is told plainly which one they got.
      const kindly = e instanceof KindlyError ? e : null;
      buildLocally();
      setGenerationNote(
        kindly?.code === 'GENERATION_UNAVAILABLE'
          ? 'The writing assistant is not configured, so KINDLY built this draft from your answers instead.'
          : kindly?.code === 'GENERATION_REFUSED'
            ? 'The writing assistant declined this request, so KINDLY built this draft from your answers instead.'
            : 'The writing assistant could not be reached, so KINDLY built this draft from your answers instead.',
      );
      announce('KINDLY built the draft from your answers. You can edit every sentence.');
    } finally {
      setGenerating(false);
    }
  }

  function updatePage(index: number, patch: Partial<EditablePage>) {
    setPages((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }
  function movePage(index: number, delta: number) {
    setPages((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
    announce(`Page moved to position ${index + delta + 1}.`);
  }
  function duplicatePage(index: number) {
    setPages((prev) => {
      const source = prev[index]!;
      const next = [...prev];
      next.splice(index + 1, 0, { ...source, id: undefined });
      return next;
    });
    announce('Page duplicated.');
  }
  function deletePage(index: number) {
    setPages((prev) => prev.filter((_, i) => i !== index));
    announce('Page removed.');
  }
  function addPage() {
    setPages((prev) => [...prev, {
      sectionKey: 'custom', heading: SECTION_HEADINGS.custom, body: '',
      certainty: 'fact', pictogramKey: null, altText: null,
    }]);
  }

  if (mode === 'edit' && storyQuery.isLoading) return <div className="content-wrap"><LoadingState label="Loading this story" /></div>;
  if (mode === 'edit' && storyQuery.error) return <div className="content-wrap"><ErrorState error={storyQuery.error} onRetry={() => storyQuery.refetch()} /></div>;

  if (!child) {
    return (
      <div className="content-wrap">
        <ErrorState error={new KindlyError('CHILD_NOT_FOUND', 'Add a child profile before writing a story.')} />
      </div>
    );
  }

  const assigned = story?.assignedChildIds.includes(child.id) ?? false;
  const canApprove = can('can_approve_stories');
  const scenario = SCENARIO_BY_KEY[scenarioKey];

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/stories')}>
        <Icon name="i-arrow-left" size={17} /> Back to stories
      </button>

      <SectionTitle
        eyebrow={story ? `VERSION ${story.version} · ${story.status.replace('_', ' ').toUpperCase()}` : 'NEW STORY'}
        title={mode === 'new' ? 'Write a story together' : title || 'Story'}
        detail={`Written for ${childLabel(childName)}. Nothing reaches child mode until you approve it and give it to them.`}
      />

      {saveError ? <ErrorState error={saveError} onRetry={() => setSaveError(null)} /> : null}

      {story?.source === 'generated' ? (
        <p className="inline-note">
          <Icon name="i-sparkles" size={16} strokeWidth={2.5} />
          <span>
            <b>This is a generated draft you can edit.</b> Built with {story.generationModel} (prompt {story.generationPromptVersion})
            {story.generatedAt ? ` on ${formatDateTime(story.generatedAt)}` : ''}. Read every sentence before approving.
          </span>
        </p>
      ) : null}

      {/* ---------------- Inputs ---------------- */}
      <div className="editor-card">
        <header><h3>What is this story about?</h3></header>

        <Select
          label="Situation"
          value={scenarioKey}
          onChange={(e) => setScenarioKey(e.target.value)}
          options={SCENARIOS.map((s) => ({ value: s.key, label: s.label }))}
          hint={scenario?.summary}
          disabled={!editable}
        />

        {scenario?.needsCaregiverSafetyReview ? (
          <p className="inline-note">
            <Icon name="i-shield" size={16} strokeWidth={2.5} />
            <span>
              This situation always needs a careful adult read before approval, because it can touch
              on danger, medical care or safety. Kindly will not let it be approved without your
              explicit confirmation.
            </span>
          </p>
        ) : null}

        <TextInput label="Where does this happen?" value={inputs.location} disabled={!editable}
          placeholder="e.g. the dental clinic on Bridge Street"
          onChange={(e) => setInputs((p) => ({ ...p, location: e.target.value }))} />

        <TextInput label="Who may be there?" value={inputs.people} disabled={!editable}
          placeholder="e.g. the dentist and one nurse"
          hint="Roles rather than full names is usually enough."
          onChange={(e) => setInputs((p) => ({ ...p, people: e.target.value }))} />

        <TextArea label="What usually happens?" value={inputs.whatUsuallyHappens} disabled={!editable}
          onChange={(e) => setInputs((p) => ({ ...p, whatUsuallyHappens: e.target.value }))} />

        <TextArea label="What may feel difficult or uncertain?" value={inputs.whatMayFeelDifficult} disabled={!editable}
          onChange={(e) => setInputs((p) => ({ ...p, whatMayFeelDifficult: e.target.value }))} />

        <TextInput label="Known triggers" optionalNote="optional" value={inputs.knownTriggers} disabled={!editable}
          onChange={(e) => setInputs((p) => ({ ...p, knownTriggers: e.target.value }))} />

        <TextInput label="Sensory environment" optionalNote="optional" value={inputs.sensoryEnvironment} disabled={!editable}
          hint={sensory.length ? `Left blank, Kindly uses this profile: ${sensory.filter((s) => s.kind === 'hard').map((s) => s.label).join(', ') || 'nothing recorded'}.` : undefined}
          onChange={(e) => setInputs((p) => ({ ...p, sensoryEnvironment: e.target.value }))} />

        <TextInput label="Strengths and strategies that already help" optionalNote="optional"
          value={inputs.strengthsAndStrategies} disabled={!editable}
          onChange={(e) => setInputs((p) => ({ ...p, strengthsAndStrategies: e.target.value }))} />

        <TextInput label="Expected changes" optionalNote="optional" value={inputs.expectedChanges} disabled={!editable}
          onChange={(e) => setInputs((p) => ({ ...p, expectedChanges: e.target.value }))} />

        <div className="preference-grid">
          <Select label="Perspective" value={person} disabled={!editable}
            onChange={(e) => setPerson(e.target.value as typeof person)}
            options={[
              { value: 'first_person', label: `First person (“I …”)` },
              { value: 'third_person', label: `Third person (“${childName || 'their name'} …”)` },
            ]} />
          <Select label="Reading level" value={readingLevel} disabled={!editable}
            onChange={(e) => setReadingLevel(e.target.value as typeof readingLevel)}
            options={[
              { value: 'pre_reader', label: 'Pre-reader — very short lines' },
              { value: 'simple', label: 'Simple — short literal sentences' },
              { value: 'developing', label: 'Developing' },
              { value: 'confident', label: 'Confident reader' },
            ]} />
          <Select label="Format" value={format} disabled={!editable}
            onChange={(e) => setFormat(e.target.value as typeof format)}
            options={[
              { value: 'text', label: 'Words only' },
              { value: 'pictogram', label: 'Pictograms with words' },
              { value: 'photo', label: 'Photos with words' },
              { value: 'audio', label: 'Words with audio' },
              { value: 'mixed', label: 'Mixed' },
            ]} />
          <Select label="Length" value={String(inputs.lengthPages)} disabled={!editable}
            onChange={(e) => setInputs((p) => ({ ...p, lengthPages: Number(e.target.value) }))}
            options={[4, 6, 8, 10, 12].map((n) => ({ value: String(n), label: `About ${n} pages` }))} />
        </div>

        {editable ? (
          <div className="row-actions">
            <Button tone="yellow" icon="i-sparkles" onClick={generate} loading={generating} loadingLabel="Building a draft…">
              Build a draft for me
            </Button>
            <Button tone="secondary" icon="i-plus" onClick={addPage}>Write it myself, page by page</Button>
          </div>
        ) : null}

        {generationNote ? (
          <p className="inline-note" role="status">
            <Icon name="i-sparkles" size={16} strokeWidth={2.5} />
            <span>{generationNote}</span>
          </p>
        ) : null}

        {generationError ? (
          <div className="inline-error" role="alert">
            <Icon name="i-alert" size={16} strokeWidth={2.5} />
            <span>{generationError} <Button tone="ghost" icon="i-refresh" onClick={generate}>Try again</Button></span>
          </div>
        ) : null}

        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 800, fontSize: 13 }}>
            What Kindly would send to a generation service
          </summary>
          <pre className="scroll-x" style={{ fontSize: 12, background: 'var(--muted)', padding: 12, borderRadius: 12 }}>
{JSON.stringify(minimalGenerationPayload({
  childName: '', scenarioKey, location: inputs.location, people: inputs.people,
  whatUsuallyHappens: inputs.whatUsuallyHappens, whatMayFeelDifficult: inputs.whatMayFeelDifficult,
  knownTriggers: inputs.knownTriggers, sensoryEnvironment: inputs.sensoryEnvironment,
  strengthsAndStrategies: inputs.strengthsAndStrategies, expectedChanges: inputs.expectedChanges,
  safeAdult: child.safeAdult, safePlace: child.safePlace,
  lengthPages: inputs.lengthPages, readingLevel, person,
}), null, 2)}
          </pre>
          <p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>
            Your child’s name, your family’s names, identifiers, request history and anything your
            child wrote are never included.
          </p>
        </details>
      </div>

      {/* ---------------- Review flags ---------------- */}
      {review.flags.length > 0 ? (
        <div className="editor-card">
          <header>
            <h3>{review.flags.length} thing{review.flags.length === 1 ? '' : 's'} to check</h3>
          </header>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted-foreground)' }}>
            An automated language review looks for coercive, stigmatising, diagnostic or unsafe
            wording, and for promises a story cannot keep. It is a second pair of eyes, not a
            replacement for yours.
          </p>
          <ul className="flag-list">
            {review.flags.map((flag: ReviewFlag, i) => (
              <li key={`${flag.rule}-${i}`} className="flag-item" data-severity={flag.severity}>
                <b>
                  {flag.severity === 'block' ? 'Must change' : flag.severity === 'warn' ? 'Please check' : 'Suggestion'}
                  {flag.pagePosition != null ? ` · page ${flag.pagePosition + 1}` : ''}
                </b>
                <span>{flag.note}</span>
                {flag.excerpt ? <q>{flag.excerpt}</q> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---------------- Title + pages ---------------- */}
      <div className="editor-card">
        <header><h3>The story</h3></header>

        <TextInput label="Title" value={title} required disabled={!editable}
          error={title.trim() ? null : 'Please give the story a title.'}
          onChange={(e) => setTitle(e.target.value)} />

        {pages.length === 0 ? (
          <p className="inline-note">
            <Icon name="i-book-open" size={16} strokeWidth={2.5} />
            <span>No pages yet. Build a draft above, or add pages one at a time.</span>
          </p>
        ) : null}

        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 16 }}>
          {pages.map((page, index) => (
            <li key={page.id ?? `new-${index}`} className="editor-card" style={{ background: 'var(--background)' }}>
              <header>
                <h3>Page {index + 1}</h3>
                <span className="certainty-tag" data-certainty={page.certainty}>
                  {page.certainty === 'fact' ? 'Fact' : page.certainty === 'possibility' ? 'May happen' : 'A choice'}
                </span>
              </header>

              <Select label="Part of the story" value={page.sectionKey} disabled={!editable}
                onChange={(e) => updatePage(index, { sectionKey: e.target.value as StorySectionKey })}
                options={SECTION_OPTIONS} />

              <TextInput label="Heading" optionalNote="optional" value={page.heading ?? ''} disabled={!editable}
                onChange={(e) => updatePage(index, { heading: e.target.value || null })} />

              <TextArea label="What this page says" value={page.body} required disabled={!editable}
                error={page.body.trim() ? null : 'A page cannot be empty.'}
                hint="Short, literal sentences. Say what may happen rather than what will happen."
                onChange={(e) => updatePage(index, { body: e.target.value })} />

              <Select label="Is this a fact, a possibility, or a choice?" value={page.certainty} disabled={!editable}
                onChange={(e) => updatePage(index, { certainty: e.target.value as EditablePage['certainty'] })}
                options={[
                  { value: 'fact', label: 'A fact — this is known' },
                  { value: 'possibility', label: 'A possibility — this may happen' },
                  { value: 'choice', label: 'A choice — something your child can do' },
                ]} />

              {format !== 'text' ? (
                <TextInput label="Describe the picture in words" value={page.altText ?? ''} disabled={!editable}
                  hint="Required so the page still works with a screen reader or read-aloud."
                  onChange={(e) => updatePage(index, { altText: e.target.value || null })} />
              ) : null}

              {editable ? (
                <div className="row-actions">
                  <Button tone="ghost" icon="i-arrow-left" onClick={() => movePage(index, -1)} disabled={index === 0}>
                    Move earlier
                  </Button>
                  <Button tone="ghost" icon="i-arrow-right" onClick={() => movePage(index, 1)} disabled={index === pages.length - 1}>
                    Move later
                  </Button>
                  <Button tone="ghost" icon="i-plus" onClick={() => duplicatePage(index)}>Duplicate</Button>
                  <Button tone="ghost" icon="i-x-circle" onClick={() => deletePage(index)}>Delete page</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>

        {editable ? <Button tone="secondary" icon="i-plus" onClick={addPage}>Add a page</Button> : null}
      </div>

      {/* ---------------- Actions ---------------- */}
      <div className="editor-card">
        <header><h3>What happens next</h3></header>

        <div className="row-actions">
          {editable ? (
            <Button tone="coral" icon="i-check" onClick={() => save.mutate()} loading={save.isPending}
              disabled={!title.trim() || pages.length < 3 || pages.some((p) => !p.body.trim())}>
              Save as a draft
            </Button>
          ) : null}

          <Button tone="secondary" icon="i-book-open" onClick={() => { setPreviewIndex(0); setShowPreview(true); }}
            disabled={pages.length === 0}>
            Preview the way {childLabel(childName)} will see it
          </Button>

          {mode === 'edit' && canApprove ? (
            <Button tone="yellow" icon="i-shield" onClick={() => setConfirmApprove(true)}
              disabled={story?.status === 'approved' || pages.length < 3 || review.hasBlocking}>
              {story?.status === 'approved' ? 'Already approved' : 'Approve this story'}
            </Button>
          ) : null}

          {mode === 'edit' && canApprove && story?.status === 'approved' ? (
            assigned ? (
              <Button tone="ghost" icon="i-x-circle" onClick={() => withdraw.mutate()} loading={withdraw.isPending}>
                Withdraw from child mode
              </Button>
            ) : (
              <Button tone="coral" icon="i-send" onClick={() => assign.mutate()} loading={assign.isPending}>
                Give it to {childLabel(childName)}
              </Button>
            )
          ) : null}
        </div>

        {savedAt ? (
          <p className="inline-note" role="status">
            <Icon name="i-check" size={16} strokeWidth={2.5} />
            <span>Saved as a draft at {formatDateTime(savedAt)}. Your child has not seen this version.</span>
          </p>
        ) : null}

        {review.hasBlocking ? (
          <p className="inline-error">
            <Icon name="i-alert" size={16} strokeWidth={2.5} />
            <span>
              This story cannot be approved yet: some wording must change first. See the list above.
            </span>
          </p>
        ) : null}

        {pages.length > 0 && pages.length < 3 ? (
          <p className="inline-note">
            <Icon name="i-alert" size={16} strokeWidth={2.5} />
            <span>A story needs at least three pages before it can be saved.</span>
          </p>
        ) : null}
      </div>

      {/* ---------------- Version history ---------------- */}
      {mode === 'edit' ? (
        <div className="editor-card">
          <header><h3>Version history</h3></header>
          {versionsQuery.isLoading ? <LoadingState label="Loading history" /> : null}
          {(versionsQuery.data ?? []).length === 0 && !versionsQuery.isLoading ? (
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted-foreground)' }}>
              No approved versions yet. A snapshot is kept each time a story is approved.
            </p>
          ) : null}
          <ul className="escalation-log">
            {(versionsQuery.data ?? []).map((v) => (
              <li key={v.id}>
                <Icon name="i-clock-3" size={15} strokeWidth={2.5} />
                <span>
                  Version {v.version} — {v.changeNote ?? 'saved'}
                  {v.createdByName ? ` by ${v.createdByName}` : ''} on {formatDateTime(v.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---------------- Preview ---------------- */}
      <Dialog
        open={showPreview}
        title={`Preview: ${title || 'Untitled story'}`}
        description={`Shown with ${childLabel(childName)}’s display settings — text size ${Math.round((prefs?.textScale ?? 1) * 100)}%${prefs?.lowStimulation ? ', low stimulation' : ''}${prefs?.highContrast ? ', high contrast' : ''}.`}
        onClose={() => setShowPreview(false)}
        actions={
          <>
            <Button tone="secondary" icon="i-arrow-left" onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))} disabled={previewIndex === 0}>
              Previous page
            </Button>
            <Button tone="secondary" iconAfter="i-arrow-right" onClick={() => setPreviewIndex((i) => Math.min(pages.length - 1, i + 1))} disabled={previewIndex >= pages.length - 1}>
              Next page
            </Button>
            <Button tone="coral" onClick={() => setShowPreview(false)}>Close preview</Button>
          </>
        }
      >
        <div
          className="story-reader-page"
          style={{ fontSize: `${20 * (prefs?.textScale ?? 1)}px` }}
        >
          <p style={{ marginTop: 0, fontSize: '0.7em', color: 'var(--muted-foreground)' }}>
            Page {previewIndex + 1} of {pages.length}
          </p>
          {pages[previewIndex]?.heading ? <h3>{pages[previewIndex]!.heading}</h3> : null}
          <p>{pages[previewIndex]?.body}</p>
        </div>
      </Dialog>

      {/* ---------------- Approve confirmation ---------------- */}
      <Dialog
        open={confirmApprove}
        alert
        title="Approve this story?"
        description={
          `Approving records your name and the time, and keeps a snapshot of this version. ` +
          `It does not send anything to ${childLabel(childName)} — you choose that separately.`
        }
        onClose={() => setConfirmApprove(false)}
        actions={
          <>
            <Button tone="coral" onClick={() => approve.mutate()} loading={approve.isPending}>
              Yes, I have read every page
            </Button>
            <Button tone="secondary" onClick={() => setConfirmApprove(false)}>Not yet</Button>
          </>
        }
      >
        {review.flags.length > 0 ? (
          <p className="inline-note">
            <Icon name="i-alert" size={16} strokeWidth={2.5} />
            <span>
              {review.flags.length} item{review.flags.length === 1 ? '' : 's'} were highlighted for review.
              Approving confirms you have read them.
            </span>
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

const TEMPLATE_VERSION = 'kindly-template-2026-08-26.1';
