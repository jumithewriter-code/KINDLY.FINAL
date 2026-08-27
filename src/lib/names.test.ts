import { describe, expect, it } from 'vitest';
import {
  caregiverLabel, childLabel, graphemes, initialFrom, isBlank, normalizeName,
  possessive, trustedLabel, validateEmail, validatePassword, validatePersonName, validatePin,
} from './names';

describe('normalizeName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeName('  Rosa   Maria  ')).toBe('Rosa Maria');
  });

  it('collapses non-breaking and ideographic spaces', () => {
    expect(normalizeName('Rosa  Maria')).toBe('Rosa Maria');
    expect(normalizeName('小　明')).toBe('小 明');
  });

  it('treats whitespace-only input as empty', () => {
    for (const value of ['', '   ', '\t\n', ' ', ' ']) {
      expect(normalizeName(value)).toBe('');
      expect(isBlank(value)).toBe(true);
    }
  });

  it('never invents a value for null or undefined', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('initialFrom', () => {
  it.each([
    ['Rosa', 'R'],
    ['léo', 'L'],
    ['Léo', 'L'],
    ["O'Neill", 'O'],
    ['O’Neill', 'O'],
    ['Anne-Marie', 'A'],
    ['小明', '小'],
    ['علي', 'ع'],
    ['Ярослав', 'Я'],
    ['ñoño', 'Ñ'],
    ['  spaced  ', 'S'],
  ])('takes the first meaningful character of %s', (input, expected) => {
    expect(initialFrom(input)).toBe(expected);
  });

  it('keeps a whole emoji grapheme rather than half a surrogate pair', () => {
    expect(initialFrom('🌱 Sam')).toBe('🌱');
    expect(initialFrom('👩🏽‍🦰 Rosa')).toBe('👩🏽‍🦰');
  });

  it('keeps combining marks attached to their base letter', () => {
    // "e" + U+0301 COMBINING ACUTE, rather than the precomposed character.
    const decomposed = 'élodie';
    expect(decomposed.length).toBe(7);              // 7 code units
    expect(graphemes(decomposed)).toHaveLength(6);  // but 6 user-perceived characters
    expect(graphemes(decomposed)[0]).toBe('é');
    // The mark travels with its base letter through upper-casing, and the
    // result is the same character however the name was typed.
    expect(initialFrom(decomposed).normalize('NFC')).toBe('É');
    expect(initialFrom('élodie')).toBe('É');
  });

  it('skips leading punctuation instead of showing a quote mark', () => {
    expect(initialFrom('"Ana"')).toBe('A');
    expect(initialFrom('(Ana)')).toBe('A');
  });

  it('returns an empty string when there is no name, never a placeholder letter', () => {
    expect(initialFrom('')).toBe('');
    expect(initialFrom('   ')).toBe('');
    expect(initialFrom(null)).toBe('');
    expect(initialFrom('!!!')).toBe('');
  });
});

describe('neutral fallback copy', () => {
  it('never invents a person', () => {
    expect(caregiverLabel('')).toBe('your caregiver');
    expect(caregiverLabel(null, { capital: true })).toBe('Your caregiver');
    expect(childLabel('   ')).toBe('your child');
    expect(childLabel(undefined, { capital: true })).toBe('Your child');
    expect(trustedLabel('')).toBe('another trusted caregiver');
  });

  it('uses the real name when there is one', () => {
    expect(caregiverLabel('Rosa')).toBe('Rosa');
    expect(childLabel('小明')).toBe('小明');
    expect(trustedLabel('Grandma Ade', { capital: true })).toBe('Grandma Ade');
  });

  it('does not contain any of the banned placeholder identities', () => {
    const banned = ['jamie', 'alex'];
    const outputs = [
      caregiverLabel(''), caregiverLabel(null, { capital: true }),
      childLabel(''), childLabel(null, { capital: true }),
      trustedLabel(''), trustedLabel(null, { capital: true }),
    ];
    for (const output of outputs) {
      expect(banned.some((name) => output.toLowerCase().includes(name))).toBe(false);
      expect(output.trim().length).toBeGreaterThan(1);
    }
  });
});

describe('possessive', () => {
  it('uses a typographic apostrophe', () => {
    expect(possessive('Rosa')).toBe('Rosa’s');
  });
  it('does not double an s', () => {
    expect(possessive('Charles')).toBe('Charles’');
  });
  it('returns empty for no name', () => {
    expect(possessive('  ')).toBe('');
  });
});

describe('validatePersonName', () => {
  it('rejects empty and whitespace-only required fields with a field-specific message', () => {
    const result = validatePersonName('   ', 'your child’s name');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('your child’s name');
  });

  it('allows an empty optional field', () => {
    const result = validatePersonName('', 'this person’s name', { required: false });
    expect(result).toEqual({ ok: true, value: '' });
  });

  it('accepts international names', () => {
    for (const name of ['Léo', '小明', 'علي', "Mr. O'Neill", 'Anne-Marie', 'Ярослав', '🌱 Sam']) {
      expect(validatePersonName(name, 'a name').ok).toBe(true);
    }
  });

  it('rejects a name made only of punctuation', () => {
    expect(validatePersonName('!!!', 'a name').ok).toBe(false);
  });

  it('counts graphemes, not code units, for the length limit', () => {
    const emoji = '👩🏽‍🦰'.repeat(10); // 10 graphemes, many code units
    expect(validatePersonName(emoji, 'a name', { max: 10 }).ok).toBe(true);
    expect(validatePersonName('👩🏽‍🦰'.repeat(11), 'a name', { max: 10 }).ok).toBe(false);
  });

  it('normalises the returned value', () => {
    const result = validatePersonName('  Rosa   Maria ', 'a name');
    expect(result).toEqual({ ok: true, value: 'Rosa Maria' });
  });
});

describe('validatePin', () => {
  it('requires 4 to 8 digits', () => {
    expect(validatePin('123').ok).toBe(false);
    expect(validatePin('123456789').ok).toBe(false);
    expect(validatePin('7391').ok).toBe(true);
  });
  it('rejects easily guessed codes', () => {
    for (const pin of ['0000', '1111', '1234', '4321']) {
      expect(validatePin(pin).ok).toBe(false);
    }
  });
  it('strips non-digits before checking', () => {
    expect(validatePin('7-3 9 1')).toEqual({ ok: true, value: '7391' });
  });
});

describe('validateEmail and validatePassword', () => {
  it('accepts a normal address and lowercases it', () => {
    expect(validateEmail(' Rosa@Example.Test ')).toEqual({ ok: true, value: 'rosa@example.test' });
  });
  it('rejects an address with no domain', () => {
    expect(validateEmail('rosa@').ok).toBe(false);
  });
  it('requires at least 8 characters for a password', () => {
    expect(validatePassword('short').ok).toBe(false);
    expect(validatePassword('long-enough').ok).toBe(true);
  });
});
