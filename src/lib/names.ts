/**
 * Name handling for KINDLY.
 *
 * Three separate identities exist in this product and they are never derived
 * from one another:
 *   - caregiverName        (the adult using the caregiver view)
 *   - childName            (the child this space is for)
 *   - trustedCaregiverName (an escalation contact the child knows)
 *
 * There are no placeholder people anywhere. When a name is genuinely unknown we
 * fall back to neutral, honest copy ("your caregiver", "your child") — never to
 * an invented first name or a bare initial.
 */

/** The single, canonical normalisation. Mirrors kindly.normalize_name() in SQL. */
export function normalizeName(input: string | null | undefined): string {
  if (input == null) return '';
  // \s in JS does not cover every Unicode space; \p{White_Space} does.
  return String(input).replace(/[\p{White_Space}]+/gu, ' ').trim();
}

export function isBlank(input: string | null | undefined): boolean {
  return normalizeName(input).length === 0;
}

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Splits into user-perceived characters, so emoji and combining marks survive. */
export function graphemes(value: string): string[] {
  if (!value) return [];
  if (segmenter) return Array.from(segmenter.segment(value), (s) => s.segment);
  return Array.from(value);
}

/**
 * The initial shown in an avatar.
 *
 * Handles: leading punctuation, apostrophes ("O'Neill" -> O), hyphens
 * ("Anne-Marie" -> A), accents ("Léo" -> L), non-Latin scripts ("小明" -> 小),
 * scripts without case ("علي" -> ع), and emoji ("🌱 Sam" -> 🌱).
 *
 * Returns '' when there is no name — callers must render a neutral fallback
 * rather than a made-up letter.
 */
export function initialFrom(name: string | null | undefined): string {
  const clean = normalizeName(name);
  if (!clean) return '';
  for (const g of graphemes(clean)) {
    // Skip pure punctuation/symbols that carry no identity (quotes, brackets).
    if (/^[\p{P}\p{Z}\p{C}]+$/u.test(g)) continue;
    return g.toLocaleUpperCase();
  }
  return '';
}

/**
 * Possessive form. English-only by design and only used in English copy; the
 * apostrophe is the typographic one so it renders correctly in the UI font.
 */
export function possessive(name: string): string {
  const clean = normalizeName(name);
  if (!clean) return '';
  return /[sS]$/.test(clean) ? `${clean}’` : `${clean}’s`;
}

/** A caregiver's display name, or honest neutral copy. */
export function caregiverLabel(name: string | null | undefined, opts?: { capital?: boolean }): string {
  const clean = normalizeName(name);
  if (clean) return clean;
  return opts?.capital ? 'Your caregiver' : 'your caregiver';
}

/** A child's display name, or honest neutral copy. */
export function childLabel(name: string | null | undefined, opts?: { capital?: boolean }): string {
  const clean = normalizeName(name);
  if (clean) return clean;
  return opts?.capital ? 'Your child' : 'your child';
}

export function trustedLabel(name: string | null | undefined, opts?: { capital?: boolean }): string {
  const clean = normalizeName(name);
  if (clean) return clean;
  return opts?.capital ? 'Another trusted caregiver' : 'another trusted caregiver';
}

export type NameValidationResult = { ok: true; value: string } | { ok: false; message: string };

/**
 * Validates a person's name field.
 *
 * `subject` is used to build an error message that names the field, e.g.
 * "Please enter your child's name." Errors are full sentences because they are
 * read aloud by screen readers and shown next to the input.
 */
export function validatePersonName(
  raw: string | null | undefined,
  subject: string,
  opts?: { required?: boolean; max?: number },
): NameValidationResult {
  const required = opts?.required ?? true;
  const max = opts?.max ?? 80;
  const value = normalizeName(raw);

  if (!value) {
    if (!required) return { ok: true, value: '' };
    return { ok: false, message: `Please enter ${subject}. Spaces on their own will not work.` };
  }
  if (graphemes(value).length > max) {
    return { ok: false, message: `Please use ${max} characters or fewer for ${subject}.` };
  }
  // Reject strings made only of punctuation or symbols — they cannot be read out.
  if (!/[\p{L}\p{N}\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(value)) {
    return { ok: false, message: `Please include at least one letter or number in ${subject}.` };
  }
  return { ok: true, value };
}

export function validatePin(raw: string | null | undefined): NameValidationResult {
  const value = String(raw ?? '').replace(/\D/g, '');
  if (value.length < 4) return { ok: false, message: 'Please choose a code of at least 4 digits.' };
  if (value.length > 8) return { ok: false, message: 'Please choose a code of 8 digits or fewer.' };
  const easy = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123']);
  if (easy.has(value)) {
    return { ok: false, message: 'Please choose a code that is harder to guess. Avoid 1234 and repeated digits.' };
  }
  return { ok: true, value };
}

export function validateEmail(raw: string | null | undefined): NameValidationResult {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, message: 'Please enter your email address.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    return { ok: false, message: 'Please enter an email address in the form name@example.com.' };
  }
  return { ok: true, value: value.toLowerCase() };
}

export function validatePassword(raw: string | null | undefined): NameValidationResult {
  const value = String(raw ?? '');
  if (!value) return { ok: false, message: 'Please enter a password.' };
  if (value.length < 8) return { ok: false, message: 'Please use at least 8 characters.' };
  if (value.length > 200) return { ok: false, message: 'Please use 200 characters or fewer.' };
  return { ok: true, value };
}
