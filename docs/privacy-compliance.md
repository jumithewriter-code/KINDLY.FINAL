# Privacy and regulatory considerations

**Nothing here is a compliance claim.** No lawyer, DPO or regulator has reviewed
KINDLY. This document records what was built with which obligation in mind, and
the questions a real review would need to answer.

KINDLY handles data about children, some of it about health and distress. That
places it near the strictest end of most regimes. Treat every item below as open
until someone qualified closes it.

---

## 1. What data exists, and why

| Data | Table | Why it is needed | Sensitivity |
| --- | --- | --- | --- |
| Email, password | `auth.users` (Supabase) | authenticate an adult | standard |
| Caregiver name, pronouns | `caregiver_profiles` | so a child knows who answered | low |
| Child name, pronouns, birth year | `child_profiles` | so the space is theirs | **child data** |
| Safe adult, safe place | `child_profiles` | shown when nobody answers | **safety data** |
| Communication methods | `communication_methods` | how this child communicates | **likely health-adjacent** |
| Sensory preferences | `sensory_preferences` | what helps, what is hard | **likely health-adjacent** |
| Requests, responses, events | `requests`, `request_responses`, `request_events` | the communication itself | **health-adjacent, possibly distress** |
| Feelings and body sensations | `requests` (type `feeling`) | the child telling someone how they feel | **health-adjacent** |
| Routine runs | `routine_runs` | where a routine got to | low |
| Stories and pages | `stories`, `story_pages` | prepared narratives | contains situational detail |
| Media | `media_assets` + private bucket | family photos, pictograms | **may contain images of a child** |
| PIN hash | `caregiver_pins` | adult verification | **credential** |
| Audit | `audit_events` | who did what | metadata only |

The rows marked health-adjacent are the reason a DPIA is likely required in the
EU/UK, not optional.

---

## 2. Data minimisation, as built

* **`request_events.detail` deliberately excludes the child's own words.** It
  carries structured metadata only — status transitions, timings, who was
  assigned. The child's free text lives once, in `requests.custom_message`.
* **`story_progress` stores a page number only.** No comprehension score, no
  completion rate, no time-on-page. This was a design decision, not an omission.
* **Routine runs record what happened, not how well.** No aggregate is derived.
* **`minimalGenerationPayload()`** is the whole contract for anything sent to an
  external generation service: the scenario and the caregiver's own description.
  Not the child's name, not the family's names, not identifiers, not history.
  A unit test asserts the child's name and safety details never appear in it.
* **Audit stores a salted IP hash at most**, never a raw address, never content.

## 3. Storage and access

* Row Level Security is **enabled and forced** on all 23 tables, with
  `REVOKE ALL … FROM anon`. A signed-out visitor can read nothing.
* Access derives from an *active* `family_members` row. Revoking a caregiver
  takes effect on the next statement.
* `caregiver_pins` and `rate_limits` have **no client policy at all**.
* Media lives in a **private** bucket. Every read is a short-lived signed URL
  (300 s). There are no public object URLs.
* `child_sessions.token_hash` is column-revoked from `authenticated`.

## 4. Rights, as built

| Right | Mechanism | State |
| --- | --- | --- |
| Access / portability | `export_family_data()` → complete JSON, downloadable from Settings → Your data | built, tested against the in-process backend |
| Erasure | `request_deletion('account' / 'child' / 'family')` | built; soft-deletes immediately, seven-day grace, then hard delete |
| Rectification | every name and preference is editable in Settings | built |
| Restriction | archive a child, withdraw a story, revoke a caregiver | built |

`kindly.run_pending_deletions()` performs the hard delete once the grace window
closes, scheduled nightly by the `kindly-deletions` cron job. Cascades carry away
preferences, requests, routines, stories and media rows; `kindly.orphaned_media_paths()`
lists storage objects left behind for the bucket sweep.

**Still open:** it has never run against a hosted project, and nothing yet
removes the orphaned storage objects that function identifies — that needs a
scheduled task with storage credentials. Until both are verified, do not tell a
family their data has been destroyed.

---

## 5. Open questions a review must answer

### COPPA (US, under 13)

1. Is the operator "directed to children"? The child-facing mode is, plainly.
2. **Verifiable parental consent** — KINDLY currently has a caregiver create the
   account and the child profile. Is caregiver-creates-account sufficient VPC for
   this data, or is a stronger method required?
3. Direct notice content and placement.
4. Retention: is a seven-day grace window compatible with "delete when no longer
   necessary"?
5. Is the child's free-text message field (`custom_message`) collection of
   personal information from a child? It very likely is.

### GDPR / UK GDPR

1. **Lawful basis.** Consent, or legitimate interests? For health-adjacent data
   about a child, Art. 9 requires a condition — explicit consent is the likely
   route, and KINDLY does not currently capture it as such.
2. **Are sensory and communication preferences "data concerning health"?**
   Arguably yes. This is the single question that most changes the obligations.
3. **DPIA** — almost certainly required (children + large-scale sensitive data).
   Not done.
4. **Age of digital consent** varies 13–16 by member state. Not implemented.
5. **Controller/processor mapping** — the family? the school, if a teacher is the
   trusted caregiver? This is unresolved and matters, because
   `trusted_caregivers` explicitly supports a teacher.
6. **International transfer** — Supabase region choice is a deployment decision
   nobody has made yet.
7. **Retention schedule** — 24 months for audit is asserted here and implemented;
   nothing else has a defined schedule.

### Health / clinical

1. Does anything KINDLY does constitute a medical device under EU MDR or UK
   MHRA rules? The intent is no — it makes no diagnostic or therapeutic claim —
   but "software intended to inform clinical decisions" is a boundary worth
   checking, particularly the bathroom-urgency setting.
2. If a school deploys it, does it enter safeguarding record-keeping duties?
3. The escalation ladder is a safety-adjacent workflow. Who is accountable when
   it does not fire? It is now scheduled server-side, but that schedule has
   never been observed running (limitations-and-safety.md §3b).

### Security

1. The child-mode session limitation (limitations-and-safety.md §3a) should be
   assessed as a data-protection risk, not only a product one.
2. Penetration testing: none done.
3. The RLS policies have not been reviewed by anyone other than their author.
   The `memory.test.ts` authorization tests mirror the intent, but *mirroring the
   author's intent is not an independent check.*

---

## 6. What to do before real families use this

1. Commission a DPIA.
2. Get the "is this health data" question answered.
3. Verify the hard-delete sweep actually runs, and add the storage-object sweep (§4).
4. Fix or accept the child-session limitation, and record the decision.
5. Confirm the escalation schedule actually runs on the deployed project.
6. Independent review of the RLS policies.
7. Usability testing with the people named in
   limitations-and-safety.md §3g.
8. Write the privacy notice and the direct notice, and have both reviewed.

Until 1–4 are done, KINDLY should be treated as a prototype, however finished
the interface looks.
