import type { StoryPerson, StorySectionKey } from '../types';
import { SCENARIO_BY_KEY, SECTION_HEADINGS } from './scenarios';
import { reviewStory, type ReviewResult } from './safetyReview';

/**
 * The KINDLY story builder.
 *
 * This is the non-AI path: a deterministic, auditable builder that turns the
 * caregiver's inputs into a structured draft. It is used
 *   - as the "build it myself" alternative to AI generation,
 *   - as the fallback when generation fails or is unavailable, and
 *   - as the schema the AI path must produce, so both paths are reviewed and
 *     edited in exactly the same way.
 *
 * Every sentence it writes follows the same rules the automated review checks:
 * short, literal, fact separated from possibility, at least two valid
 * responses, always a way to ask for help or leave, and never a promise about
 * how something will feel.
 */

export interface StoryBuilderInput {
  childName: string;
  scenarioKey: string;
  location?: string | null;
  people?: string | null;
  whatUsuallyHappens?: string | null;
  whatMayFeelDifficult?: string | null;
  knownTriggers?: string | null;
  sensoryEnvironment?: string | null;
  communicationMethod?: string | null;
  strengthsAndStrategies?: string | null;
  expectedChanges?: string | null;
  safeAdult?: string | null;
  safePlace?: string | null;
  lengthPages?: number;
  readingLevel?: 'pre_reader' | 'simple' | 'developing' | 'confident';
  person?: StoryPerson;
}

export interface BuiltPage {
  position: number;
  sectionKey: StorySectionKey;
  heading: string | null;
  body: string;
  certainty: 'fact' | 'possibility' | 'choice';
}

export interface BuiltStory {
  title: string;
  pages: BuiltPage[];
  review: ReviewResult;
}

/** First person by default; third person uses the child's own name. */
function voice(person: StoryPerson, childName: string) {
  const name = childName.trim();
  if (person === 'third_person' && name) {
    return { I: name, my: `${name}’s`, me: name, am: 'is', can: 'can', do_not: 'does not' };
  }
  return { I: 'I', my: 'my', me: 'me', am: 'am', can: 'can', do_not: 'do not' };
}

const clean = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();

function sentences(...parts: (string | null | undefined)[]): string {
  return parts
    .map(clean)
    .filter(Boolean)
    .map((s) => (/[.!?…]$/.test(s) ? s : `${s}.`))
    .join(' ');
}

/** Scenario-specific choices. Always at least three, always genuinely optional. */
function choicesFor(key: string, v: ReturnType<typeof voice>, input: StoryBuilderInput): string[] {
  const comm = clean(input.communicationMethod);
  const commLine = comm
    ? `${v.I} ${v.can} use ${comm} to say what ${v.I} ${v.am === 'is' ? 'need' : 'need'}`
    : `${v.I} ${v.can} use words, pictures, a gesture, or ${v.my} device to say what ${v.I} need`;

  const base: Record<string, string[]> = {
    someone_says_no: [
      `${v.I} ${v.can} say "okay" and stop asking`,
      `${v.I} ${v.can} ask if there is a different time`,
      `${v.I} ${v.can} choose something else to do`,
      `${v.I} ${v.can} tell a trusted adult if ${v.I} feel upset about it`,
    ],
    saying_no_boundary: [
      `${v.I} ${v.can} say "no thank you"`,
      `${v.I} ${v.can} show "stop" with ${v.my} hand or ${v.my} device`,
      `${v.I} ${v.can} move away`,
      `${v.I} ${v.can} ask a trusted adult to help ${v.me} say it`,
    ],
    joining_group_activity: [
      `${v.I} ${v.can} watch first for as long as ${v.I} want`,
      `${v.I} ${v.can} stand or sit near the group without joining in`,
      `${v.I} ${v.can} join in one small part`,
      `${v.I} ${v.can} choose not to join today`,
    ],
    unexpected_change: [
      `${v.I} ${v.can} ask what is happening now`,
      `${v.I} ${v.can} ask for more time before the next thing`,
      `${v.I} ${v.can} do the new thing in a smaller way`,
      `${v.I} ${v.can} ask for a break`,
    ],
    doctor_or_dentist: [
      `${v.I} ${v.can} ask what will happen before it happens`,
      `${v.I} ${v.can} show "stop" or "wait" with ${v.my} hand`,
      `${v.I} ${v.can} bring something that helps ${v.my} body feel steadier`,
      `${v.I} ${v.can} ask for a break`,
    ],
    recognising_unsafe_behaviour: [
      `${v.I} ${v.can} move away from what feels unsafe`,
      `${v.I} ${v.can} tell a trusted adult straight away`,
      `${v.I} ${v.can} tell a different trusted adult if the first one is not there`,
      `${v.I} ${v.can} keep telling until someone helps`,
    ],
    getting_help_from_trusted_adult: [
      `${v.I} ${v.can} go to a trusted adult and wait near them`,
      `${v.I} ${v.can} show a picture or a word for help`,
      `${v.I} ${v.can} write or type what happened`,
      `${v.I} ${v.can} ask another trusted adult if the first one is busy`,
    ],
    waiting: [
      `${v.I} ${v.can} ask how long the wait may be`,
      `${v.I} ${v.can} do something with ${v.my} hands while ${v.I} wait`,
      `${v.I} ${v.can} ask to wait somewhere quieter`,
      `${v.I} ${v.can} ask for a break`,
    ],
    losing_a_game: [
      `${v.I} ${v.can} say "good game" if ${v.I} want to`,
      `${v.I} ${v.can} say nothing and walk away`,
      `${v.I} ${v.can} ask to play again another time`,
      `${v.I} ${v.can} take a break before the next game`,
    ],
    conflict_or_misunderstanding: [
      `${v.I} ${v.can} say what ${v.I} thought was happening`,
      `${v.I} ${v.can} ask what the other person thought was happening`,
      `${v.I} ${v.can} ask a trusted adult to help ${v.me} sort it out`,
      `${v.I} ${v.can} take time apart first`,
    ],
    being_interrupted: [
      `${v.I} ${v.can} say "one moment please"`,
      `${v.I} ${v.can} finish ${v.my} sentence and then listen`,
      `${v.I} ${v.can} ask them to come back in a minute`,
      `${v.I} ${v.can} choose to stop what ${v.I} was doing`,
    ],
    asking_for_a_break: [
      `${v.I} ${v.can} say or show "break"`,
      `${v.I} ${v.can} point to a break card`,
      `${v.I} ${v.can} stand up and go to a quieter place`,
      `${v.I} ${v.can} ask a trusted adult to come with ${v.me}`,
    ],
  };

  const chosen = base[key] ?? [
    `${v.I} ${v.can} take ${v.my} time before ${v.I} do anything`,
    `${v.I} ${v.can} ask a question`,
    `${v.I} ${v.can} ask for a break`,
    `${v.I} ${v.can} choose not to take part`,
  ];

  return [...chosen, commLine];
}

export function buildStory(input: StoryBuilderInput): BuiltStory {
  const scenario = SCENARIO_BY_KEY[input.scenarioKey];
  const person = input.person ?? 'first_person';
  const v = voice(person, input.childName);
  const short = input.readingLevel === 'pre_reader' || input.readingLevel === 'simple';

  const location = clean(input.location);
  const people = clean(input.people);
  const usual = clean(input.whatUsuallyHappens);
  const difficult = clean(input.whatMayFeelDifficult);
  const triggers = clean(input.knownTriggers);
  const sensory = clean(input.sensoryEnvironment);
  const strengths = clean(input.strengthsAndStrategies);
  const changes = clean(input.expectedChanges);
  const safeAdult = clean(input.safeAdult);
  const safePlace = clean(input.safePlace);

  const label = scenario?.label ?? 'A social situation';
  const title = location ? `${label} at ${location}` : label;

  const choices = choicesFor(input.scenarioKey, v, input);

  const pages: Omit<BuiltPage, 'position'>[] = [];

  pages.push({
    sectionKey: 'title',
    heading: null,
    body: title,
    certainty: 'fact',
  });

  pages.push({
    sectionKey: 'situation',
    heading: SECTION_HEADINGS.situation,
    body: sentences(
      `This story is about ${label.toLowerCase()}`,
      usual ? `Usually, ${usual.charAt(0).toLowerCase()}${usual.slice(1)}` : null,
      `${v.I} ${v.can} read this story as many times as ${v.I} want`,
    ),
    certainty: 'fact',
  });

  pages.push({
    sectionKey: 'where_when',
    heading: SECTION_HEADINGS.where_when,
    body: sentences(
      location ? `This may happen at ${location}` : 'This may happen in different places',
      'The exact time may be different each time',
    ),
    certainty: 'possibility',
  });

  pages.push({
    sectionKey: 'who',
    heading: SECTION_HEADINGS.who,
    body: sentences(
      people ? `${people} may be there` : 'Other people may be there',
      safeAdult ? `${safeAdult} is a trusted adult ${v.I} ${v.can} go to` : null,
      `${v.I} cannot know what other people are thinking. ${v.I} ${v.can} ask them if ${v.I} want to`,
    ),
    certainty: 'possibility',
  });

  pages.push({
    sectionKey: 'what_you_may_notice',
    heading: SECTION_HEADINGS.what_you_may_notice,
    body: sentences(
      sensory ? `${v.I} may notice ${sensory}` : `${v.I} may notice sounds, lights, or movement around ${v.me}`,
      triggers ? `Some things may be harder for ${v.me}, such as ${triggers}` : null,
      'Noticing these things is not a problem',
    ),
    certainty: 'possibility',
  });

  pages.push({
    sectionKey: 'what_may_change',
    heading: SECTION_HEADINGS.what_may_change,
    body: sentences(
      changes ? `Something may change: ${changes}` : 'Something may change without warning',
      input.scenarioKey === 'unexpected_change'
        ? `${v.I} do not know yet whether the first plan will happen later. Someone ${v.can} tell ${v.me} what is happening now`
        : `${v.I} ${v.can} ask what is happening now`,
      difficult ? `The part that may feel uncertain is: ${difficult}` : null,
    ),
    certainty: 'possibility',
  });

  pages.push({
    sectionKey: 'feelings',
    heading: SECTION_HEADINGS.feelings,
    body: sentences(
      `${v.I} may feel many things. ${v.I} may feel interested, unsure, tired, or something else`,
      `${v.my.charAt(0).toUpperCase()}${v.my.slice(1)} body may feel busy, warm, tight, or still`,
      `All of these are okay. ${v.I} do not have to know the name of the feeling`,
      input.scenarioKey === 'doctor_or_dentist'
        ? `${v.I} do not know exactly how it will feel. Some parts may be uncomfortable`
        : null,
    ),
    certainty: 'possibility',
  });

  pages.push({
    sectionKey: 'choices',
    heading: SECTION_HEADINGS.choices,
    body: sentences(...choices.slice(0, short ? 4 : choices.length)),
    certainty: 'choice',
  });

  pages.push({
    sectionKey: 'sensory_options',
    heading: SECTION_HEADINGS.sensory_options,
    body: sentences(
      strengths ? `Things that have helped before: ${strengths}` : null,
      `${v.I} ${v.can} move ${v.my} body in the way that helps ${v.me}`,
      safePlace ? `${v.I} ${v.can} go to ${safePlace}` : `${v.I} ${v.can} go somewhere quieter`,
      `${v.I} ${v.can} ask for more time`,
    ),
    certainty: 'choice',
  });

  pages.push({
    sectionKey: 'asking_for_help',
    heading: SECTION_HEADINGS.asking_for_help,
    body: sentences(
      `${v.I} ${v.can} ask for help at any time`,
      safeAdult ? `${v.I} ${v.can} tell ${safeAdult}` : `${v.I} ${v.can} tell a trusted adult`,
      `${v.I} ${v.can} ask for a break, and ${v.I} ${v.can} leave if ${v.I} need to`,
      `${v.I} never have to keep anything secret from a trusted adult`,
    ),
    certainty: 'choice',
  });

  pages.push({
    sectionKey: 'afterwards',
    heading: SECTION_HEADINGS.afterwards,
    body: sentences(
      'Afterwards, this will be over',
      `${v.I} ${v.can} tell someone how it went, or ${v.I} ${v.can} say nothing`,
      `${v.I} ${v.can} rest`,
    ),
    certainty: 'possibility',
  });

  pages.push({
    sectionKey: 'ending',
    heading: SECTION_HEADINGS.ending,
    body: sentences(
      `${v.I} do not know exactly how this will go`,
      `${v.I} know some things ${v.I} ${v.can} do`,
      safeAdult ? `${safeAdult} ${v.can} help ${v.me}` : 'A trusted adult can help',
      'This is the end of the story',
    ),
    certainty: 'fact',
  });

  const wanted = Math.max(3, Math.min(input.lengthPages ?? 12, pages.length));
  // Always keep the title, the choices, the help route and the ending.
  const mustKeep = new Set<StorySectionKey>(['title', 'choices', 'asking_for_help', 'ending']);
  let trimmedPages = pages;
  if (wanted < pages.length) {
    const optional = pages.filter((p) => !mustKeep.has(p.sectionKey));
    const dropCount = pages.length - wanted;
    const dropped = new Set(optional.slice(-dropCount).map((p) => p.sectionKey));
    trimmedPages = pages.filter((p) => mustKeep.has(p.sectionKey) || !dropped.has(p.sectionKey));
  }

  const positioned: BuiltPage[] = trimmedPages.map((p, i) => ({ ...p, position: i }));

  const review = reviewStory(title, positioned.map((p) => ({ position: p.position, heading: p.heading, body: p.body })), {
    scenarioNeedsSafetyReview: scenario?.needsCaregiverSafetyReview ?? false,
  });

  return { title, pages: positioned, review };
}

/**
 * The minimum profile information a generation service is allowed to receive.
 *
 * Deliberately excludes: the child's name, the family name, caregiver names,
 * email addresses, identifiers, request history and any free text the child
 * wrote. Only the caregiver's own description of the situation is sent.
 */
export function minimalGenerationPayload(input: StoryBuilderInput): Record<string, unknown> {
  return {
    scenarioKey: input.scenarioKey,
    location: clean(input.location) || null,
    peopleRoles: clean(input.people) || null,
    whatUsuallyHappens: clean(input.whatUsuallyHappens) || null,
    whatMayFeelDifficult: clean(input.whatMayFeelDifficult) || null,
    knownTriggers: clean(input.knownTriggers) || null,
    sensoryEnvironment: clean(input.sensoryEnvironment) || null,
    communicationMethod: clean(input.communicationMethod) || null,
    strengthsAndStrategies: clean(input.strengthsAndStrategies) || null,
    expectedChanges: clean(input.expectedChanges) || null,
    hasSafeAdult: Boolean(clean(input.safeAdult)),
    hasSafePlace: Boolean(clean(input.safePlace)),
    lengthPages: input.lengthPages ?? 12,
    readingLevel: input.readingLevel ?? 'simple',
    person: input.person ?? 'first_person',
  };
}
