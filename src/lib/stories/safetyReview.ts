import type { ReviewFlag } from '../types';

/**
 * Automated language review for story content.
 *
 * This runs on every draft — generated or hand-written — before a caregiver can
 * approve it. It is a safety net for the caregiver, not a substitute for them:
 * `block` findings prevent approval until acknowledged, `warn` and `info`
 * findings are highlighted in the editor for a human to judge.
 *
 * It looks for four families of problem:
 *   1. Coercive / compliance-training language ("quiet hands", "good listening")
 *   2. Promises an app cannot keep ("it will not hurt", "everything will be fine")
 *   3. Secrecy or unsafe physical contact instructions
 *   4. Deficit-based or diagnostic framing, idioms, and figurative language
 */

interface Rule {
  id: string;
  severity: ReviewFlag['severity'];
  pattern: RegExp;
  note: string;
}

const RULES: readonly Rule[] = Object.freeze([
  // --- 1. Coercion, compliance, masking -----------------------------------
  {
    id: 'compliance.quiet_hands',
    severity: 'block',
    pattern: /\b(quiet hands|hands (down|still|to yourself)|stop (flapping|rocking|stimming)|no stimming)\b/i,
    note: 'This asks the child to suppress stimming. Stimming is regulation, not misbehaviour. Rewrite to describe what is happening instead.',
  },
  {
    id: 'compliance.eye_contact',
    severity: 'block',
    pattern: /\b((you|i|they) (must|have to|should|will) look at|look (at|into) (me|them|their eyes|the teacher)|look (me|them|him|her) in the eye|make eye contact|eyes on me)\b/i,
    note: 'This requires eye contact. KINDLY never asks a child to make eye contact. Offer showing attention in other ways, or remove.',
  },
  {
    id: 'compliance.obedience',
    severity: 'block',
    pattern: /\b(do (as|what) (you are|you're|i am|i'm|they are) told|must obey|always listen to (grown-?ups|adults)|be a good (boy|girl|child)|good listening|follow the rules or)\b/i,
    note: 'This is obedience-focused. Unquestioning obedience is unsafe to teach. Describe choices instead.',
  },
  {
    id: 'compliance.forced_speech',
    severity: 'block',
    pattern: /(?<!\bnot )\b(you|i|they) (must|have to|need to) (say|speak|answer|talk)\b|\b(use your words|say it out loud|speak up when)\b/i,
    note: 'This requires speech. Offer several communication choices, including not speaking.',
  },
  {
    id: 'compliance.forced_sharing',
    severity: 'warn',
    pattern: /\b(you (must|have to|should) share|sharing is caring|you need to share)\b/i,
    note: 'This makes sharing a requirement. Sharing should be presented as a choice.',
  },
  {
    id: 'compliance.suppress_distress',
    severity: 'block',
    pattern: /\b(calm down|stop crying|don'?t (cry|be upset|get angry|make a fuss)|no meltdowns|keep it together|be brave)\b/i,
    note: 'This asks the child to suppress distress. Describe options for support instead of instructing feelings.',
  },
  {
    id: 'compliance.reward_masking',
    severity: 'warn',
    pattern: /\b(everyone will (like|be proud of) you if|people will think you are (weird|strange|rude) if|act normal|be like (the )?other (kids|children))\b/i,
    note: 'This rewards masking or frames the child as abnormal. Rewrite descriptively.',
  },

  // --- 2. Promises a story cannot keep ------------------------------------
  {
    id: 'promise.painless',
    severity: 'block',
    pattern: /\b(it (will|won'?t) (not )?hurt|there (is|will be) no pain|painless|you will not feel (anything|it))\b/i,
    note: 'This promises no pain. A story must not guarantee how something will feel. Use "I do not know exactly how it will feel."',
  },
  {
    id: 'promise.outcome',
    severity: 'block',
    pattern: /\b(everything will be (fine|okay|alright)|it will (all )?be (fine|okay|easy|fun)|nothing bad will happen|you will (definitely|certainly) (like|enjoy) it)\b/i,
    note: 'This guarantees an outcome. Separate what is known from what may happen.',
  },
  {
    id: 'promise.quiet',
    severity: 'warn',
    pattern: /\b(it will be (quiet|calm)|there will be no (noise|people)|nobody will (touch|bother) you)\b/i,
    note: 'This promises the environment. Describe it as a possibility instead.',
  },
  {
    id: 'promise.plan_returns',
    severity: 'warn',
    pattern: /\b(we will do (it|the plan) (later|tomorrow) instead|the plan will come back|we can always do it another day)\b/i,
    note: 'For an unexpected change, avoid promising the original plan will return unless the caregiver knows it will.',
  },

  // --- 3. Secrecy and unsafe contact --------------------------------------
  {
    id: 'safety.secrecy',
    severity: 'block',
    pattern: /\b(keep (it|this) (a )?secret|do not tell (anyone|mum|mom|dad|your teacher)|don'?t tell anybody|this is our secret)\b/i,
    note: 'A story must never instruct secrecy. Remove this and direct the child to a trusted adult.',
  },
  {
    id: 'safety.physical_contact',
    severity: 'block',
    pattern: /\b(let (them|him|her|the doctor) (touch|hold) you|you (must|have to) (hug|kiss|hold hands|be held)|stay still while (they|he|she))\b/i,
    note: 'This instructs unsafe or non-consensual physical contact. Rewrite so the child can decline or ask for a pause.',
  },
  {
    id: 'safety.go_alone',
    severity: 'warn',
    pattern: /\b(go (with|to) (a )?(stranger|someone you do not know)|leave (with|by yourself) without telling)\b/i,
    note: 'Check this against your family safety plan before approving.',
  },

  // --- 4. Deficit framing, diagnosis, figurative language -------------------
  {
    id: 'language.deficit',
    severity: 'warn',
    pattern: /\b(high[- ]functioning|low[- ]functioning|suffers from|afflicted|severe autism|mild autism|behaviours? of concern|challenging behaviour|non[- ]compliant|deficit)\b/i,
    note: 'Deficit-based or severity language. Describe the situation and the support instead.',
  },
  {
    id: 'language.diagnosis',
    severity: 'warn',
    pattern: /\b(you (have|are) (autistic because|adhd|anxiety disorder|a diagnosis)|because you are autistic you (cannot|can'?t))\b/i,
    note: 'This reads as a diagnosis or explains the child to themselves. KINDLY is not a diagnostic tool.',
  },
  {
    id: 'language.idiom',
    severity: 'info',
    pattern: /\b(piece of cake|break a leg|hold your horses|butterflies in your (tummy|stomach)|bite the bullet|under the weather|cat got your tongue|keep your chin up|in a nutshell|hang in there)\b/i,
    note: 'This is an idiom. Consider replacing it with literal wording.',
  },
  {
    id: 'language.sarcasm_marker',
    severity: 'info',
    pattern: /\b(obviously|of course you|just relax|simply|no big deal|don'?t worry about it)\b/i,
    note: 'This may read as dismissive or vague reassurance. Consider a more specific sentence.',
  },
  {
    id: 'language.mind_reading',
    severity: 'warn',
    pattern: /\b(they (will|are) (thinking|feeling) that|(he|she|they) knows? you are|everyone will think)\b/i,
    note: 'This states another person’s thoughts as fact. Use "may be thinking" or "I cannot know what they are thinking".',
  },
]);

export interface ReviewResult {
  flags: ReviewFlag[];
  /** True when at least one `block` flag is present. */
  hasBlocking: boolean;
  /** True when the story needs a careful adult read before it can be approved. */
  requiresSafetyReview: boolean;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + length + 24);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

/** Reviews a single block of text. */
export function reviewText(text: string, pagePosition?: number): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  for (const rule of RULES) {
    // Rules are authored without /g; create a fresh global copy per pass.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      flags.push({
        rule: rule.id,
        severity: rule.severity,
        note: rule.note,
        excerpt: excerptAround(text, match.index, match[0].length),
        ...(pagePosition != null ? { pagePosition } : {}),
      });
      if (match[0].length === 0) re.lastIndex += 1;
      break; // one finding per rule per page keeps the review list readable
    }
  }
  return flags;
}

export interface ReviewablePage {
  position: number;
  heading?: string | null;
  body: string;
}

/**
 * Reviews a whole story.
 *
 * Beyond the per-page rules this checks two structural requirements:
 *   - the story must offer more than one valid response
 *   - the story must include a way to ask for help, a break, or to leave
 */
export function reviewStory(
  title: string,
  pages: ReviewablePage[],
  opts?: { scenarioNeedsSafetyReview?: boolean },
): ReviewResult {
  const flags: ReviewFlag[] = [...reviewText(title)];

  for (const page of pages) {
    flags.push(...reviewText(`${page.heading ?? ''}\n${page.body}`, page.position));
  }

  const wholeText = pages.map((p) => p.body).join('\n').toLowerCase();

  const choiceMarkers = (wholeText.match(/\bi (can|could|may choose to)\b/g) ?? []).length;
  if (choiceMarkers < 2) {
    flags.push({
      rule: 'structure.single_response',
      severity: 'block',
      note: 'This story offers fewer than two things the child can choose to do. Add more than one valid response.',
    });
  }

  if (!/\b(ask for (help|a break|more time|space)|tell (a|my) (trusted )?(adult|grown-?up)|i can (stop|leave|pause)|i can say stop)\b/.test(wholeText)) {
    flags.push({
      rule: 'structure.no_help_route',
      severity: 'block',
      note: 'This story does not say how to ask for help, more time, or a break. Add at least one way.',
    });
  }

  if (!/\b(may|might|sometimes|i do not know|i don.t know|can be different)\b/.test(wholeText)) {
    flags.push({
      rule: 'structure.no_uncertainty',
      severity: 'warn',
      note: 'This story states everything as certain. Mark what is a possibility rather than a fact.',
    });
  }

  const hasBlocking = flags.some((f) => f.severity === 'block');

  return {
    flags,
    hasBlocking,
    requiresSafetyReview: hasBlocking || Boolean(opts?.scenarioNeedsSafetyReview),
  };
}

export const REVIEW_RULE_COUNT = RULES.length;
