import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Meaning must never depend on which fonts a device happens to ship.
 *
 * The original design used decorative Unicode pictographs as icons — U+2600
 * BLACK SUN WITH RAYS, U+2726 BLACK FOUR POINTED STAR, U+25D2 CIRCLE WITH LOWER
 * HALF BLACK, and others. On a machine whose fonts lack them they render as
 * blank "tofu" boxes; on one that has them they render as solid black shapes at
 * whatever size that font chose, so cards came out uneven. Either way a child
 * looking at "I need help" saw a black box.
 *
 * Every one of them is now drawn from the SVG sprite, at an explicit size, in
 * currentColor. This test stops them coming back.
 *
 * Emoji are deliberately NOT forbidden: a caregiver may legitimately put one in
 * a name, and names.ts documents that. The rule is about UI chrome, not content.
 */

// Punctuation the copy genuinely uses: curly quotes, dashes, ellipsis,
// middle dot, non-breaking space.
const ALLOWED = new Set([
  '‘', '’', '“', '”',
  '–', '—', '…', '·', ' ',
]);

// General Punctuation through Miscellaneous Symbols and Arrows — where the
// dingbats, arrows, geometric shapes and weather pictographs live.
const RANGE_START = 0x2000;
const RANGE_END = 0x2bff;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!full.endsWith('.tsx') && !full.endsWith('.ts')) return [];
    if (full.includes('.test.')) return [];
    return [full];
  });
}

describe('meaning never depends on a font', () => {
  it('renders no decorative Unicode pictographs anywhere in the UI', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const ch of line) {
          const code = ch.codePointAt(0)!;
          if (code >= RANGE_START && code <= RANGE_END && !ALLOWED.has(ch)) {
            const where = file.slice(file.lastIndexOf('src'));
            offenders.push(`${where}:${index + 1} U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
          }
        }
      });
    }

    expect(
      offenders,
      `Use an <Icon> from the sprite instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
