import type { StorySectionKey } from '../types';

/**
 * The social-scenario catalogue.
 *
 * Every entry is described neutrally. A scenario is a situation the child may
 * meet, never a behaviour to correct. `needsCaregiverSafetyReview` marks the
 * situations that always require a careful adult read before approval, because
 * they touch on danger, medical care, self-harm, violence or abuse.
 */
export interface Scenario {
  key: string;
  label: string;
  /** One neutral sentence a caregiver sees when choosing. */
  summary: string;
  needsCaregiverSafetyReview: boolean;
  /** Section order used when building this scenario's draft. */
  sections: StorySectionKey[];
  /** Scenario-specific prompts shown to the caregiver in the input form. */
  prompts: { field: string; label: string; hint: string }[];
}

const CORE_SECTIONS: StorySectionKey[] = [
  'title',
  'situation',
  'where_when',
  'who',
  'what_you_may_notice',
  'what_may_change',
  'feelings',
  'choices',
  'sensory_options',
  'asking_for_help',
  'afterwards',
  'ending',
];

function scenario(
  key: string,
  label: string,
  summary: string,
  opts?: { safety?: boolean; prompts?: Scenario['prompts'] },
): Scenario {
  return {
    key,
    label,
    summary,
    needsCaregiverSafetyReview: opts?.safety ?? false,
    sections: CORE_SECTIONS,
    prompts: opts?.prompts ?? [],
  };
}

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  scenario('meeting_new_person', 'Meeting a new person',
    'A first meeting with someone the child has not met before.'),
  scenario('joining_group_activity', 'Joining a group activity',
    'Coming into an activity that has already started, or joining a group.'),
  scenario('taking_turns', 'Taking turns',
    'Sharing time or equipment with other people.'),
  scenario('asking_to_play', 'Asking to play',
    'Asking other people if the child can join in.'),
  scenario('someone_says_no', 'Someone says no',
    'Another person declines. The story describes accepting their answer.'),
  scenario('saying_no_boundary', 'Saying no, or setting a boundary',
    'The child declines something, or asks for space.'),
  scenario('asking_for_clarification', 'Asking for clarification',
    'Asking someone to repeat, slow down, or explain differently.'),
  scenario('not_understanding_joke', 'Not understanding a joke',
    'Someone says something the child does not find clear or funny.'),
  scenario('unexpected_change', 'An unexpected change',
    'A plan changes. The story does not promise the original plan will return.'),
  scenario('waiting', 'Waiting',
    'A wait of unknown or known length.'),
  scenario('sharing_when_chosen', 'Sharing when the child chooses to',
    'Sharing is presented as a choice, never as a requirement.'),
  scenario('losing_a_game', 'Losing a game',
    'A game ends with a different result than the child wanted.'),
  scenario('conflict_or_misunderstanding', 'Conflict or misunderstanding',
    'Two people understood something differently.'),
  scenario('being_interrupted', 'Being interrupted',
    'Someone speaks or acts while the child is in the middle of something.'),
  scenario('doctor_or_dentist', 'Visiting a doctor or dentist',
    'A medical or dental appointment.', { safety: true }),
  scenario('going_to_school', 'Going to school',
    'A school day, or returning after a break.'),
  scenario('noisy_unfamiliar_place', 'Entering a noisy or unfamiliar place',
    'A place with more sound, light or people than usual.'),
  scenario('talking_to_teacher', 'Talking to a teacher',
    'Speaking with, or communicating with, a teacher.'),
  scenario('asking_for_a_break', 'Asking for a break',
    'Asking to stop, pause, or step away.'),
  scenario('recognising_unsafe_behaviour', 'Recognising unsafe behaviour',
    'Noticing that something is not safe and telling a trusted adult.', { safety: true }),
  scenario('getting_help_from_trusted_adult', 'Getting help from a trusted adult',
    'Finding and telling a trusted adult.', { safety: true }),
  scenario('repairing_a_friendship', 'Repairing a friendship after a disagreement',
    'What can happen after a disagreement, without guaranteeing the outcome.'),
]);

export const SCENARIO_BY_KEY: Readonly<Record<string, Scenario>> = Object.freeze(
  Object.fromEntries(SCENARIOS.map((s) => [s.key, s])),
);

export const SECTION_HEADINGS: Readonly<Record<StorySectionKey, string>> = Object.freeze({
  title: 'Title',
  situation: 'What this is about',
  where_when: 'Where and when this may happen',
  who: 'Who may be there',
  what_you_may_notice: 'What I may notice',
  what_may_change: 'What may change or feel uncertain',
  feelings: 'Feelings and body sensations I may have',
  choices: 'Things I can choose to do',
  sensory_options: 'Things that may help my body feel steadier',
  asking_for_help: 'How I can ask for help or leave',
  afterwards: 'What may happen afterwards',
  ending: 'The ending',
  custom: 'Another page',
});
