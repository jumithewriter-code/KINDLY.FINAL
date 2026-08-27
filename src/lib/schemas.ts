/**
 * Schema validation for every server request.
 *
 * Every backend method validates its input through one of these schemas before
 * a network call is made, and the same shapes are asserted again by the
 * database (CHECK constraints and the PL/pgSQL functions). Client validation is
 * for helpful messages; the database is what actually enforces the rules.
 */
import { z } from 'zod';
import { normalizeName } from './names';

const trimmed = (max: number) =>
  z.string().transform(normalizeName).pipe(z.string().max(max));

const requiredName = (subject: string, max = 80) =>
  z
    .string({ required_error: `Please enter ${subject}.` })
    .transform(normalizeName)
    .pipe(
      z
        .string()
        .min(1, `Please enter ${subject}. Spaces on their own will not work.`)
        .max(max, `Please use ${max} characters or fewer for ${subject}.`)
        .refine((v) => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(v), {
          message: `Please include at least one letter or number in ${subject}.`,
        }),
    );

export const uuidSchema = z.string().uuid('That identifier is not valid.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Please enter your email address.')
  .email('Please enter an email address in the form name@example.com.');

export const passwordSchema = z
  .string()
  .min(8, 'Please use at least 8 characters.')
  .max(200, 'Please use 200 characters or fewer.');

export const pinSchema = z
  .string()
  .regex(/^\d{4,8}$/, 'Please use between 4 and 8 digits.')
  .refine(
    (v) => !['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123'].includes(v),
    { message: 'Please choose a code that is harder to guess.' },
  );

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------
export const signUpSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Please enter your password.'),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
    confirm: z.string().min(1, 'Please type your new password again.'),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'The two passwords do not match.',
    path: ['confirm'],
  });

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
export const onboardingNamesSchema = z.object({
  caregiverName: requiredName('a name for yourself'),
  childName: requiredName("your child’s name"),
  trustedCaregiverName: trimmed(80).optional().nullable(),
  familyName: trimmed(120).optional().nullable(),
  pin: pinSchema.optional().nullable(),
});

export const communicationPrefsSchema = z.object({
  methods: z
    .array(
      z.object({
        method: z.enum([
          'spoken_words', 'written_words', 'pictograms', 'photos', 'gestures',
          'sign_language', 'aac_device', 'typing', 'yes_no_choices', 'other',
        ]),
        label: requiredName('a name for this way of communicating', 80),
        detail: trimmed(300).optional().nullable(),
        isPrimary: z.boolean().default(false),
      }),
    )
    .max(20, 'Please keep this to 20 or fewer.'),
});

export const sensoryPrefsSchema = z.object({
  items: z
    .array(
      z.object({
        category: z.enum(['sound', 'light', 'touch', 'movement', 'smell', 'taste', 'crowding', 'temperature', 'other']),
        kind: z.enum(['helps', 'hard']),
        label: requiredName('a short description', 120),
        detail: trimmed(300).optional().nullable(),
      }),
    )
    .max(40, 'Please keep this to 40 or fewer.'),
});

export const childPreferencesSchema = z.object({
  textScale: z.number().min(0.9).max(2).default(1),
  highContrast: z.boolean().default(false),
  lowStimulation: z.boolean().default(false),
  symbolSystem: z.enum(['kindly_default', 'photos', 'custom', 'pcs_like', 'arasaac_like', 'text_only']).default('kindly_default'),
  pairTextWithSymbols: z.boolean().default(true),
  soundEnabled: z.boolean().default(false),
  vibrationEnabled: z.boolean().default(false),
  animationEnabled: z.boolean().default(false),
  countdownsVisible: z.boolean().default(false),
  readAloudEnabled: z.boolean().default(false),
  readAloudRate: z.number().min(0.5).max(2).default(1),
  processingTimeSeconds: z.number().int().min(0).max(600).default(10),
  transitionWarnings: z.boolean().default(true),
  escalationDelaySeconds: z.number().int().min(15).max(1800).default(120),
  unavailableDelaySeconds: z.number().int().min(15).max(1800).default(120),
  bathroomUrgency: z.enum(['urgent', 'can_wait']).default('urgent'),
  allowCustomMessage: z.boolean().default(true),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  quietHoursAllowUrgent: z.literal(true).default(true),
});

export const safetySettingsSchema = z.object({
  safeAdult: trimmed(120).optional().nullable(),
  safePlace: trimmed(120).optional().nullable(),
  emergencyInstructions: trimmed(2000).optional().nullable(),
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
export const childProfileSchema = z.object({
  childName: requiredName("your child’s name"),
  pronouns: trimmed(40).optional().nullable(),
  safeAdult: trimmed(120).optional().nullable(),
  safePlace: trimmed(120).optional().nullable(),
  emergencyInstructions: trimmed(2000).optional().nullable(),
});

export const caregiverProfileSchema = z.object({
  caregiverName: requiredName('a name for yourself'),
  pronouns: trimmed(40).optional().nullable(),
  relationshipLabel: trimmed(60).optional().nullable(),
});

export const trustedCaregiverSchema = z.object({
  childId: uuidSchema,
  trustedCaregiverName: requiredName("this person’s name"),
  relationshipLabel: trimmed(60).optional().nullable(),
  contactNote: trimmed(200).optional().nullable(),
  escalationOrder: z.number().int().min(1).max(20).default(1),
  isActive: z.boolean().default(true),
});

export const invitationSchema = z.object({
  email: emailSchema,
  role: z.enum(['caregiver', 'trusted', 'view_only']).default('caregiver'),
  invitedName: trimmed(80).optional().nullable(),
  message: trimmed(500).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
export const createRequestSchema = z.object({
  typeSlug: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'That request type is not valid.'),
  dedupeKey: z.string().min(8).max(64),
  customMessage: trimmed(300).optional().nullable(),
  connectionState: z.enum(['online', 'offline', 'unknown']).default('online'),
  deviceLabel: trimmed(120).optional().nullable(),
});

export const respondSchema = z
  .object({
    requestId: uuidSchema,
    kind: z.enum(['seen', 'coming_now', 'delay', 'other_caregiver', 'safe_adult', 'safe_place']),
    delayMinutes: z.number().int().min(1).max(120).optional().nullable(),
    message: trimmed(200).optional().nullable(),
    urgency: z.enum(['urgent', 'can_wait']),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'delay') {
      if (v.urgency === 'urgent') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['kind'],
          message: 'An urgent request cannot be answered with a delay. Choose an action that happens now.',
        });
      }
      if (v.delayMinutes == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['delayMinutes'], message: 'Please choose how many minutes.' });
      }
    }
  });

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------
export const routineStepSchema = z.object({
  id: z.string().optional(),
  title: requiredName('a name for this step', 100),
  detail: trimmed(300).optional().nullable(),
  pictogramKey: trimmed(60).optional().nullable(),
  photoMediaId: uuidSchema.optional().nullable(),
  audioMediaId: uuidSchema.optional().nullable(),
  estimatedSeconds: z.number().int().min(0).max(7200).optional().nullable(),
  isOptional: z.boolean().default(false),
  plansChangedNote: trimmed(300).optional().nullable(),
});

export const routineSchema = z.object({
  childId: uuidSchema,
  title: requiredName('a name for this routine', 100),
  description: trimmed(500).optional().nullable(),
  iconKey: trimmed(60).optional().nullable(),
  colorKey: z.enum(['coral', 'blue', 'purple', 'yellow', 'mint', 'peach']).default('yellow'),
  scheduleLabel: trimmed(120).optional().nullable(),
  scheduleDays: z.array(z.number().int().min(0).max(6)).max(7).optional().nullable(),
  scheduleTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
  allowReorder: z.boolean().default(true),
  allowSkip: z.boolean().default(true),
  transitionWarningSeconds: z.number().int().min(0).max(900).default(60),
  steps: z.array(routineStepSchema).min(1, 'Please add at least one step.').max(40, 'Please keep this to 40 steps or fewer.'),
});

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------
export const SCENARIO_KEYS = [
  'meeting_new_person', 'joining_group_activity', 'taking_turns', 'asking_to_play',
  'someone_says_no', 'saying_no_boundary', 'asking_for_clarification', 'not_understanding_joke',
  'unexpected_change', 'waiting', 'sharing_when_chosen', 'losing_a_game',
  'conflict_or_misunderstanding', 'being_interrupted', 'doctor_or_dentist', 'going_to_school',
  'noisy_unfamiliar_place', 'talking_to_teacher', 'asking_for_a_break',
  'recognising_unsafe_behaviour', 'getting_help_from_trusted_adult', 'repairing_a_friendship',
] as const;

export const storyGenerationInputSchema = z.object({
  childId: uuidSchema,
  scenarioKey: z.enum(SCENARIO_KEYS),
  location: trimmed(120).optional().nullable(),
  people: trimmed(200).optional().nullable(),
  whatUsuallyHappens: trimmed(600).optional().nullable(),
  whatMayFeelDifficult: trimmed(600).optional().nullable(),
  knownTriggers: trimmed(400).optional().nullable(),
  sensoryEnvironment: trimmed(400).optional().nullable(),
  communicationMethod: trimmed(120).optional().nullable(),
  strengthsAndStrategies: trimmed(400).optional().nullable(),
  expectedChanges: trimmed(400).optional().nullable(),
  safeAdult: trimmed(120).optional().nullable(),
  safePlace: trimmed(120).optional().nullable(),
  lengthPages: z.number().int().min(3).max(20).default(8),
  readingLevel: z.enum(['pre_reader', 'simple', 'developing', 'confident']).default('simple'),
  person: z.enum(['first_person', 'third_person']).default('first_person'),
  format: z.enum(['text', 'pictogram', 'photo', 'audio', 'mixed']).default('text'),
});

export const storyPageEditSchema = z.object({
  id: z.string().optional(),
  sectionKey: z.enum([
    'title', 'situation', 'where_when', 'who', 'what_you_may_notice',
    'what_may_change', 'feelings', 'choices', 'sensory_options',
    'asking_for_help', 'afterwards', 'ending', 'custom',
  ]),
  heading: trimmed(120).optional().nullable(),
  body: z.string().trim().min(1, 'A page cannot be empty.').max(1200, 'Please keep a page to 1200 characters or fewer.'),
  certainty: z.enum(['fact', 'possibility', 'choice']).default('fact'),
  pictogramKey: trimmed(60).optional().nullable(),
  imageMediaId: uuidSchema.optional().nullable(),
  audioMediaId: uuidSchema.optional().nullable(),
  altText: trimmed(300).optional().nullable(),
});

export const storyEditSchema = z.object({
  title: z.string().trim().min(1, 'Please give the story a title.').max(120, 'Please keep the title to 120 characters or fewer.'),
  format: z.enum(['text', 'pictogram', 'photo', 'audio', 'mixed']).default('text'),
  person: z.enum(['first_person', 'third_person']).default('first_person'),
  readingLevel: z.enum(['pre_reader', 'simple', 'developing', 'confident']).default('simple'),
  pages: z.array(storyPageEditSchema).min(3, 'A story needs at least three pages.').max(20),
});

/** The shape a generation service must return. Anything else is rejected. */
export const generatedStorySchema = z.object({
  title: z.string().trim().min(1).max(120),
  pages: z
    .array(
      z.object({
        sectionKey: storyPageEditSchema.shape.sectionKey,
        heading: z.string().trim().max(120).nullable().optional(),
        body: z.string().trim().min(1).max(1200),
        certainty: z.enum(['fact', 'possibility', 'choice']),
      }),
    )
    .min(3)
    .max(20),
  /** At least two acceptable responses must be offered. Asserted below. */
  choices: z.array(z.string().trim().min(1).max(300)).min(2, 'A story must offer more than one valid response.'),
  helpOptions: z.array(z.string().trim().min(1).max(300)).min(1),
});

export const storyFeedbackSchema = z.object({
  storyId: uuidSchema,
  kind: z.enum(['this_is_different', 'i_have_a_question', 'i_need_a_break', 'i_do_not_want_this_story']),
  pagePosition: z.number().int().min(0).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Feelings
// ---------------------------------------------------------------------------
export const feelingMessageSchema = z.object({
  feelingKey: z.string().min(1).max(60),
  intensity: z.enum(['a_little', 'medium', 'a_lot', 'not_sure']).optional().nullable(),
  supportKey: z.string().max(60).optional().nullable(),
  note: trimmed(300).optional().nullable(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export type FieldErrors = Record<string, string>;

/** Flattens a ZodError into `{ fieldName: message }` for inline display. */
export function fieldErrorsFrom(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_form';
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export function parseOrFieldErrors<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; errors: FieldErrors } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: fieldErrorsFrom(result.error) };
}
