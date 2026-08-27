# Seed and demo data

`supabase/seed.sql` runs automatically on `supabase db reset`. **Local
development only.**

> **Never run `supabase db reset` against a hosted project.** It would create
> accounts whose passwords are published in this repository. Use
> `supabase db push`, which applies migrations without the seed.

---

## What it creates

A family entered exactly the way a real one would be — nothing writes past the
constraints or the normalisation functions.

**Two caregivers**

| Email | Password | Role |
| --- | --- | --- |
| `rosa@example.test` | `kindly-demo-1` | owner |
| `marcus@example.test` | `kindly-demo-1` | caregiver |

Family: "Rosa and Marcus". Grown-up code: **7391**.

**Two children, deliberately different**

| | Léo | 小明 |
| --- | --- | --- |
| Pronouns | he/him | they/them |
| Symbols | Kindly's own | photos |
| Low stimulation | off | **on** |
| Countdowns | **on** | off |
| Processing time | 10 s | 30 s |
| Bathroom urgency | **urgent** | can wait |
| Communication | words, pictures, gestures | **AAC device**, photos |
| Safe adult | "your teacher, Mr O'Neill" | "the school office" |
| Safe place | "the quiet corner in the library" | "the reading tent" |

The two profiles differ on every axis that changes behaviour, so a demo shows
that preferences are genuinely per child rather than global.

**Trusted caregivers** — Marcus (an existing user) and "Grandma Ade" (a named
person with no account), proving both paths.

**Escalation ladders** — Léo has separate urgent (45 s → 90 s → 150 s) and
can-wait (180 s → 420 s) ladders; 小明 has one ladder for both. Every ladder ends
in `show_offline_help`.

**Four routines**, one with three steps carrying "plans changed" alternatives.

**Two stories** — one approved and assigned to Léo ("Going to the dentist on
Thursday", eight pages, with a version snapshot), and one draft that still needs
review ("When someone says no"). The approved one demonstrates the rules the
story pipeline enforces: it separates fact from possibility, offers several
choices, says *"I do not know exactly how it will feel"* rather than promising
comfort, and never asks for eye contact or speech.

## Why these names

They are demo data, entered through the same fields a family would use. **No
name appears anywhere in the application code.** Every displayed name is read
from `caregiver_profiles.caregiver_name`, `child_profiles.child_name` or
`trusted_caregivers.trusted_caregiver_name`, and when a name is genuinely
unknown the product says "your caregiver" or "your child".

The set was chosen to exercise the name handling that the unit tests cover:
an accented Latin name (Léo), a non-Latin script (小明), and an apostrophe
inside a safe-adult string (Mr O'Neill).

## Demo without Supabase

The in-process backend has no seed. Create an account and work through
onboarding — it takes about a minute and exercises the real code paths:

```bash
VITE_KINDLY_BACKEND=memory npm run dev
```

Clearing site data resets it completely.
