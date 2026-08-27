# Accessibility test report

Target: **WCAG 2.2 AA**. Automated coverage only — see §5 for what that does
not tell you.

| | |
| --- | --- |
| Date | 26 August 2026 |
| Build | `dist/` at commit-less working tree |
| Tools | axe-core 4.13 via `@axe-core/playwright`; jest-axe in jsdom |
| Browser | Chromium (system Chrome, headed-capable) |
| Result | **13/13 end-to-end passing; 180/180 unit and component tests passing** |

---

## 1. What was tested

**Every reachable route**, in a real browser, at WCAG tags
`wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`:

Signed out — `/auth/sign-in`, `/auth/create-account`, `/auth/forgot-password`,
an unknown path (404).

Caregiver — `/app`, `/app/stories`, `/app/stories/new`, `/app/requests`,
`/app/routines`, `/app/routines/new`, `/app/profile`, `/app/settings` and all
six settings subpages.

Child — `/child`, `/child/help`, `/child/feelings`, `/child/stories`,
`/child/day`, `/child/offline-help`.

Plus, as explicit assertions rather than axe rules:

* every interactive target ≥ 44×44 CSS px (2.5.8), with the documented
  inline-link exemption
* keyboard traversal of 40 stops with a visible focus indicator on each (2.4.7)
* no horizontal scrolling at 200% zoom on a 640×512 viewport (1.4.10)
* status communicated in words, not colour alone (1.4.1)
* mobile layout at Pixel 7, including child-mode target sizes

Files: `e2e/accessibility.spec.ts`, `e2e/responsive.spec.ts`,
`src/test/accessibility.test.tsx`.

---

## 2. Defects found and fixed

The palette inherited from the design stylesheet did not meet 1.4.3. Thirteen
distinct failures were measured and corrected. Hue and warmth were preserved;
only lightness moved. `kindly.css` was left untouched — every correction is an
override in `src/styles/app.css` §12, with the measurements in a comment.

| Element | Before | After | Ratio |
| --- | --- | --- | --- |
| `--muted-foreground` on white | `#80786e` 4.34 | `#6a6055` | 6.15 |
| `.eyebrow` on cream | `#a39a8e` 2.77 | `#6a6055` | 5.82 |
| White text on `--coral` | `#f56a50` 2.97 | `#c93f24` | 4.98 |
| `.text-button` | `#b36c2b` 4.12 | `#95571f` | 5.74 |
| `.auth-art` text on `--primary` | `#8a691b` 2.96 | `#332a06` | 8.29 |
| `.auth-art .eyebrow` on `--primary` | `#a39a8e` 1.61 | `#332a06` | 8.29 |
| `.date-label` | `#a39a8e` 2.62 | `#6a6055` | 5.82 |
| `.skip-button` | `#8d8378` 3.52 | `#6a6055` | 5.82 |
| `.back-link` | `#8d8378` 3.52 | `#6a6055` | 5.82 |
| `.nav-item.active` | `#9d6e00` 3.99 | `#755200` | 6.29 |
| `.welcome-card` text on `#fbbb18` | `#6a6055` 3.57 | `#332a06` | 8.29 |
| `.yellow-card` / `.help-card.yellow` small on `#ffca26` | `#6e6963` 3.55 | `#4a4133` | 6.55 |
| `.coral-card` / `.help-card` small on `#ffd9ca` | `#6e6963` 4.14 | `#5a5148` | 5.93 |

The coral moved furthest. White text on the original `#f56a50` cannot reach
4.5:1 at any weight, so either the fill or the text colour had to change; the
fill was darkened to keep the design's white-on-coral button.

**No other violations remain.** All routes return zero axe violations.

---

## 3. How each requirement is met

| Requirement | How |
| --- | --- |
| Text contrast (1.4.3) | §2 above; zero axe violations |
| Non-text contrast (1.4.11) | focus ring `#c93f24` 3px, status pills carry a bordered shape |
| Target size (2.5.8) | `button, a.button, [role=button], input, select { min-height/width: 44px }`; asserted in e2e |
| Focus visible (2.4.7) | `:focus-visible { outline: 3px solid var(--ring); outline-offset: 3px }`; asserted per tab stop |
| Focus order (2.4.3) | DOM order matches visual order; skip link is the first stop |
| Labels and instructions (3.3.2) | every input built through `Field`, which wires `label`/`aria-describedby` |
| Error identification (3.3.1) | errors render in `role="alert"` and become the input's `aria-describedby`; `aria-invalid` set. Asserted in `accessibility.test.tsx` |
| Status messages (4.1.3) | one polite and one assertive live region in `AnnouncerProvider`; announced once per change, de-duplicated within 1.5 s |
| Dialogs (2.4.3, 2.1.2) | `Dialog` traps Tab, closes on Escape, restores focus to the opener. Asserted |
| Reflow (1.4.10) | no horizontal scroll at 200%; wide content scrolls inside `.scroll-x` |
| Use of colour (1.4.1) | every status pill = icon + words; every request card shows "Urgent"/"Can wait" in text. Asserted |
| Motion (2.3.3) | animation off by default per child; OS `prefers-reduced-motion` always overrides the profile |
| Zoom / text size | per-child text scale 90–200% applied as a root custom property |
| Images (1.1.1) | `media_assets.alt_text` is `NOT NULL`; the story editor requires it whenever the format is not text-only |
| Language (3.1.1) | `<html lang="en">` |
| Page titles (2.4.2) | set per document |

---

## 4. Autistic-community design choices with accessibility effect

* Low-stimulation mode removes decorative art and shadows and flattens tints.
* High-contrast mode is a separate, stronger palette than the base corrections.
* Read-aloud is available on request screens and story pages when enabled.
* Countdowns are optional; when off, a wait shows a progress bar with words and
  an `aria-valuetext` in plain language rather than a clock.
* Every symbol is paired with words. `pairTextWithSymbols` defaults on and the
  UI never relies on a pictogram alone.

---

## 5. What this report does **not** cover

Automated testing finds a minority of real accessibility problems. Specifically
untested:

* **Any real screen reader.** No NVDA, JAWS, VoiceOver or TalkBack run has
  happened. axe checks names and roles exist; it does not tell you whether the
  experience makes sense.
* **Switch access and AAC devices**, despite the product being built for AAC
  users.
* **Voice control.**
* **Braille displays.**
* **Cognitive load** — no measure of whether the copy is actually
  understandable to the children it is for.
* **Testing with autistic people.** None. See limitations-and-safety.md §3g.
  The neurodiversity-affirming choices here are applied from published
  principles, not validated with the people they affect.

A WCAG AA pass from axe is a floor, not a finding of accessibility. The next
step is testing with real assistive technology and real users, and this report
should not be cited as evidence of accessibility until that has happened.
