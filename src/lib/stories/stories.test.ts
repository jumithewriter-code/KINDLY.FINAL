import { describe, expect, it } from 'vitest';
import { buildStory, minimalGenerationPayload } from './generator';
import { reviewStory, reviewText } from './safetyReview';
import { SCENARIOS, SCENARIO_BY_KEY } from './scenarios';
import { generatedStorySchema } from '../schemas';

const BASE = {
  childName: 'Léo',
  location: 'the school hall',
  people: 'two children I know and one teacher',
  safeAdult: 'Mr O’Neill',
  safePlace: 'the quiet corner',
  communicationMethod: 'my AAC device',
};

const bodyOf = (pages: { body: string }[]) => pages.map((p) => p.body).join(' ').toLowerCase();

describe('the scenario catalogue', () => {
  it('covers every scenario the product promises', () => {
    expect(SCENARIOS.length).toBe(22);
    for (const key of [
      'meeting_new_person', 'joining_group_activity', 'taking_turns', 'asking_to_play',
      'someone_says_no', 'saying_no_boundary', 'asking_for_clarification', 'not_understanding_joke',
      'unexpected_change', 'waiting', 'sharing_when_chosen', 'losing_a_game',
      'conflict_or_misunderstanding', 'being_interrupted', 'doctor_or_dentist', 'going_to_school',
      'noisy_unfamiliar_place', 'talking_to_teacher', 'asking_for_a_break',
      'recognising_unsafe_behaviour', 'getting_help_from_trusted_adult', 'repairing_a_friendship',
    ]) {
      expect(SCENARIO_BY_KEY[key], key).toBeDefined();
    }
  });

  it('flags the situations that always need a careful adult read', () => {
    expect(SCENARIO_BY_KEY.doctor_or_dentist!.needsCaregiverSafetyReview).toBe(true);
    expect(SCENARIO_BY_KEY.recognising_unsafe_behaviour!.needsCaregiverSafetyReview).toBe(true);
    expect(SCENARIO_BY_KEY.getting_help_from_trusted_adult!.needsCaregiverSafetyReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ten social-story acceptance tests, in order.
// ---------------------------------------------------------------------------

describe('social-story acceptance tests', () => {
  it('1. "Someone says no" produces respectful choices that accept the boundary', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'someone_says_no' });
    const text = bodyOf(story.pages);
    expect(text).toContain('okay');
    expect(text).toContain('stop asking');
    expect(text).not.toMatch(/ask again until|keep asking until they say yes|persuade/);
  });

  it('2. "Joining a group" never requires eye contact, speech or participation', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'joining_group_activity' });
    const text = bodyOf(story.pages);
    expect(text).toContain('watch first');
    expect(text).toContain('choose not to join');
    expect(text).not.toMatch(/look them in the eye|make eye contact|you must (say|speak|join)/);
    expect(story.review.flags.filter((f) => f.rule.startsWith('compliance.'))).toHaveLength(0);
  });

  it('3. "Unexpected change" does not promise the original plan will return', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'unexpected_change' });
    const text = bodyOf(story.pages);
    expect(text).toContain('i do not know yet whether the first plan will happen later');
    expect(text).not.toMatch(/the plan will come back|we will definitely do it (later|tomorrow)/);
  });

  it('4. "Doctor visit" does not guarantee a procedure will be painless', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'doctor_or_dentist' });
    const text = bodyOf(story.pages);
    expect(text).toContain('i do not know exactly how it will feel');
    expect(text).not.toMatch(/it (will not|won.t) hurt|painless|there is no pain/);
    expect(story.review.requiresSafetyReview).toBe(true);
  });

  it('5. "Feeling unsafe" points at configured trusted help and never encourages secrecy', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'recognising_unsafe_behaviour' });
    const text = bodyOf(story.pages);
    expect(text).toContain('trusted adult');
    expect(text).toContain('mr o’neill');
    expect(text).toContain('never have to keep anything secret');
    expect(text).not.toMatch(/keep it a secret|do not tell/);
    expect(story.review.flags.filter((f) => f.rule === 'safety.secrecy')).toHaveLength(0);
  });

  it('6. every generated story offers more than one valid response', () => {
    for (const scenario of SCENARIOS) {
      const story = buildStory({ ...BASE, scenarioKey: scenario.key });
      const choices = (bodyOf(story.pages).match(/\bi can\b/g) ?? []).length;
      expect(choices, scenario.key).toBeGreaterThanOrEqual(2);
      expect(
        story.review.flags.some((f) => f.rule === 'structure.single_response'),
        scenario.key,
      ).toBe(false);
    }
  });

  it('7. every story tells the child how to ask for a break or stop', () => {
    for (const scenario of SCENARIOS) {
      const story = buildStory({ ...BASE, scenarioKey: scenario.key });
      expect(bodyOf(story.pages), scenario.key).toContain('ask for a break');
      expect(
        story.review.flags.some((f) => f.rule === 'structure.no_help_route'),
        scenario.key,
      ).toBe(false);
    }
  });

  it('9. the story reflects the scenario, people, location, communication mode and safety plan', () => {
    const story = buildStory({
      ...BASE,
      scenarioKey: 'noisy_unfamiliar_place',
      sensoryEnvironment: 'a loud fan and bright strip lights',
      knownTriggers: 'hand dryers',
      expectedChanges: 'the room may be changed at short notice',
    });
    const text = bodyOf(story.pages);
    expect(story.title).toContain('the school hall');
    expect(text).toContain('two children i know and one teacher');
    expect(text).toContain('a loud fan and bright strip lights');
    expect(text).toContain('hand dryers');
    expect(text).toContain('the room may be changed at short notice');
    expect(text).toContain('my aac device');
    expect(text).toContain('the quiet corner');
  });

  it('10. every generated story is structurally valid and remains editable', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'waiting' });
    expect(story.pages.length).toBeGreaterThanOrEqual(3);
    story.pages.forEach((page, index) => {
      expect(page.position).toBe(index);
      expect(page.body.trim().length).toBeGreaterThan(0);
      expect(['fact', 'possibility', 'choice']).toContain(page.certainty);
    });
    // The same shape a generation service must return.
    const parsed = generatedStorySchema.safeParse({
      title: story.title,
      pages: story.pages.map((p) => ({
        sectionKey: p.sectionKey, heading: p.heading, body: p.body, certainty: p.certainty,
      })),
      choices: ['I can wait here', 'I can ask for a break'],
      helpOptions: ['I can tell a trusted adult'],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('structural guarantees', () => {
  it('separates facts from possibilities', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'going_to_school' });
    const kinds = new Set(story.pages.map((p) => p.certainty));
    expect(kinds.has('fact')).toBe(true);
    expect(kinds.has('possibility')).toBe(true);
    expect(kinds.has('choice')).toBe(true);
  });

  it('keeps the title, choices, help route and ending even at the shortest length', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'taking_turns', lengthPages: 3 });
    const sections = story.pages.map((p) => p.sectionKey);
    expect(sections).toContain('title');
    expect(sections).toContain('choices');
    expect(sections).toContain('asking_for_help');
    expect(sections).toContain('ending');
  });

  it('does not claim to know what other people are thinking', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'conflict_or_misunderstanding' });
    expect(bodyOf(story.pages)).toContain('cannot know what other people are thinking');
  });

  it('writes in third person using the child’s own name when asked', () => {
    const story = buildStory({ ...BASE, scenarioKey: 'waiting', person: 'third_person' });
    expect(bodyOf(story.pages)).toContain('léo can');
  });

  it('passes its own automated language review with no blocking findings', () => {
    for (const scenario of SCENARIOS) {
      const story = buildStory({ ...BASE, scenarioKey: scenario.key });
      const blocking = story.review.flags.filter((f) => f.severity === 'block');
      expect(blocking.map((f) => f.rule), scenario.key).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The automated language review itself
// ---------------------------------------------------------------------------

describe('automated language review', () => {
  it.each([
    ['quiet hands please', 'compliance.quiet_hands'],
    ['I will look them in the eye', 'compliance.eye_contact'],
    ['I must do as I am told', 'compliance.obedience'],
    ['I have to say hello out loud', 'compliance.forced_speech'],
    ['I need to calm down', 'compliance.suppress_distress'],
    ['It will not hurt at all', 'promise.painless'],
    ['Everything will be fine', 'promise.outcome'],
    ['Keep it a secret', 'safety.secrecy'],
    ['I must let them touch you', 'safety.physical_contact'],
  ])('flags %s as %s', (text, rule) => {
    const flags = reviewText(text);
    expect(flags.map((f) => f.rule)).toContain(rule);
    expect(flags.find((f) => f.rule === rule)!.severity).toBe('block');
  });

  it('warns about deficit language and idioms without blocking them', () => {
    expect(reviewText('He is high-functioning').find((f) => f.rule === 'language.deficit')?.severity).toBe('warn');
    expect(reviewText('It will be a piece of cake').find((f) => f.rule === 'language.idiom')?.severity).toBe('info');
  });

  it('blocks a story that offers only one thing to do', () => {
    const result = reviewStory('A visit', [
      { position: 0, body: 'I will go to the shop. I can ask for a break.' },
      { position: 1, body: 'The shop may be busy.' },
      { position: 2, body: 'Then we go home.' },
    ]);
    expect(result.hasBlocking).toBe(true);
    expect(result.flags.map((f) => f.rule)).toContain('structure.single_response');
  });

  it('blocks a story with no way to ask for help', () => {
    const result = reviewStory('A visit', [
      { position: 0, body: 'I can look at the books. I can sit down.' },
      { position: 1, body: 'The shop may be busy.' },
      { position: 2, body: 'Then we go home.' },
    ]);
    expect(result.flags.map((f) => f.rule)).toContain('structure.no_help_route');
  });

  it('records which page a finding came from', () => {
    const result = reviewStory('A visit', [
      { position: 0, body: 'I can wait. I can ask for a break.' },
      { position: 1, body: 'Quiet hands.' },
      { position: 2, body: 'I can go home.' },
    ]);
    const flag = result.flags.find((f) => f.rule === 'compliance.quiet_hands');
    expect(flag?.pagePosition).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Data minimisation
// ---------------------------------------------------------------------------

describe('minimalGenerationPayload', () => {
  it('never includes the child’s name, safe adult or safe place', () => {
    const payload = minimalGenerationPayload({ ...BASE, scenarioKey: 'waiting' });
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('Léo');
    expect(serialised).not.toContain('Mr O’Neill');
    expect(serialised).not.toContain('the quiet corner');
    expect(payload.hasSafeAdult).toBe(true);
    expect(payload.hasSafePlace).toBe(true);
  });

  it('does include the caregiver’s own description of the situation', () => {
    const payload = minimalGenerationPayload({
      ...BASE, scenarioKey: 'waiting', whatUsuallyHappens: 'we queue at the desk',
    });
    expect(payload.whatUsuallyHappens).toBe('we queue at the desk');
    expect(payload.scenarioKey).toBe('waiting');
  });
});
