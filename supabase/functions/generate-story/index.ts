/**
 * generate-story — drafts a social narrative with Claude.
 *
 * This runs on the server for two reasons: the API key must never reach a
 * browser, and the caller's right to write stories for this child has to be
 * checked against the database rather than trusted.
 *
 * What it will not do:
 *   - it never returns an approved story. The result is always a draft, and the
 *     caller writes it through saveStoryDraft() like any hand-written one;
 *   - it never receives the child's name, the family's names, identifiers, or
 *     anything the child wrote. The client sends minimalGenerationPayload();
 *   - it never returns text that failed the safety review as if it were fine —
 *     the flags travel with the draft.
 *
 * Deploy:  supabase functions deploy generate-story
 * Secrets: supabase secrets set ANTHROPIC_API_KEY=...
 */
import Anthropic from 'npm:@anthropic-ai/sdk@^0.68.0';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@^0.68.0/helpers/zod';
import { z } from 'npm:zod@^3.23.8';
import { createClient } from 'npm:@supabase/supabase-js@^2.45.4';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt, type GenerationInput } from './prompt.ts';

const MODEL = Deno.env.get('KINDLY_STORY_MODEL') ?? 'claude-opus-5';

const SECTION_KEYS = [
  'title', 'situation', 'where_when', 'who', 'what_you_may_notice',
  'what_may_change', 'feelings', 'choices', 'sensory_options',
  'asking_for_help', 'afterwards', 'ending',
] as const;

/** The shape Claude must return. Anything else is rejected, not repaired. */
const StorySchema = z.object({
  title: z.string().min(1).max(120),
  pages: z
    .array(
      z.object({
        sectionKey: z.enum(SECTION_KEYS),
        heading: z.string().max(120).nullable(),
        body: z.string().min(1).max(1200),
        certainty: z.enum(['fact', 'possibility', 'choice']),
      }),
    )
    .min(3)
    .max(20),
});

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('KINDLY_ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const fail = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status);

const RequestSchema = z.object({
  childId: z.string().uuid(),
  input: z.object({
    scenarioKey: z.string().min(1).max(60),
    scenarioLabel: z.string().min(1).max(120),
    location: z.string().max(120).nullable().optional(),
    peopleRoles: z.string().max(200).nullable().optional(),
    whatUsuallyHappens: z.string().max(600).nullable().optional(),
    whatMayFeelDifficult: z.string().max(600).nullable().optional(),
    knownTriggers: z.string().max(400).nullable().optional(),
    sensoryEnvironment: z.string().max(400).nullable().optional(),
    communicationMethod: z.string().max(120).nullable().optional(),
    strengthsAndStrategies: z.string().max(400).nullable().optional(),
    expectedChanges: z.string().max(400).nullable().optional(),
    hasSafeAdult: z.boolean(),
    hasSafePlace: z.boolean(),
    lengthPages: z.number().int().min(3).max(20),
    readingLevel: z.enum(['pre_reader', 'simple', 'developing', 'confident']),
    person: z.enum(['first_person', 'third_person']),
  }),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'Use POST.', 405);

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    // Say so plainly. The client falls back to the built-in story builder,
    // which is a complete feature rather than a degraded one.
    return fail('GENERATION_UNAVAILABLE', 'Story generation is not configured. You can still write the story yourself.', 503);
  }

  const authorization = req.headers.get('Authorization');
  if (!authorization) return fail('NOT_AUTHENTICATED', 'Please sign in to continue.', 401);

  // --- who is asking, and may they write stories for this child? -----------
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authorization } } },
  );

  let body: z.infer<typeof RequestSchema>;
  try {
    body = RequestSchema.parse(await req.json());
  } catch {
    return fail('INVALID_REQUEST', 'That request was not valid.', 400);
  }

  const { data: child, error: childError } = await supabase
    .from('child_profiles')
    .select('id, family_id')
    .eq('id', body.childId)
    .maybeSingle();

  // RLS already limits this to the caller's own families, so "not found" and
  // "not yours" are indistinguishable here — which is what we want.
  if (childError || !child) {
    return fail('NOT_PERMITTED', 'You do not have access to that child profile.', 403);
  }

  const { data: member } = await supabase
    .from('family_members')
    .select('can_edit_stories')
    .eq('family_id', child.family_id)
    .is('revoked_at', null)
    .maybeSingle();

  if (!member?.can_edit_stories) {
    return fail('NOT_PERMITTED', 'Your role does not allow writing stories.', 403);
  }

  // --- generate -------------------------------------------------------------
  const client = new Anthropic({ apiKey });
  const generatedAt = new Date().toISOString();

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // This is careful writing under a long list of constraints, so let the
      // model think about it.
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(body.input as GenerationInput) }],
      output_config: { format: zodOutputFormat(StorySchema, 'social_story') },
    });

    // A safety classifier may decline. That is not an error to hide: the client
    // falls back to the built-in builder and tells the caregiver why.
    if (response.stop_reason === 'refusal') {
      return fail(
        'GENERATION_REFUSED',
        'The writing assistant declined this request. You can write the story yourself instead.',
        422,
      );
    }

    const story = response.parsed_output;
    if (!story) {
      return fail('GENERATION_INVALID', 'The draft came back in a shape KINDLY could not use. Please try again.', 502);
    }

    return json({
      title: story.title,
      pages: story.pages.map((page, position) => ({ ...page, position })),
      provenance: {
        model: response.model ?? MODEL,
        promptVersion: PROMPT_VERSION,
        generatedAt,
        usage: {
          inputTokens: response.usage?.input_tokens ?? null,
          outputTokens: response.usage?.output_tokens ?? null,
        },
      },
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 429) {
      return fail('RATE_LIMITED', 'The writing assistant is busy. Please try again in a moment.', 429);
    }
    console.error('generate-story failed', { status, name: (error as Error).name });
    return fail('GENERATION_FAILED', 'The draft could not be written. You can still write the story yourself.', 502);
  }
});
