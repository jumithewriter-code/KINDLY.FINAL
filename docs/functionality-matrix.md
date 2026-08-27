# Functionality matrix

Every visible, interactive control in KINDLY and what it actually does.

The rule this table enforces: **nothing that looks interactive is inert.** Where
something is not built, it renders as non-interactive content via the
`ComingLater` component, which says so in words and cannot be clicked.

Legend — **Server**: the backend call made. **Guard**: what stops it being
misused.

---

## Authentication — `/auth/*`

| Control | Screen | Does | Server | Guard |
| --- | --- | --- | --- | --- |
| Email, Password | sign-in / create | validated on submit | — | zod; inline error tied to field |
| Create my space | create-account | creates account, goes to onboarding or check-email | `signUp` | duplicate email named on the field |
| Sign in | sign-in | signs in, returns to intended route | `signIn` | identical message for wrong password and unknown account |
| Already have an account? / New here? | both | switches route | — | — |
| I have forgotten my password | both | → `/auth/forgot-password` | — | — |
| Send a reset link | forgot | sends email | `sendPasswordReset` | always succeeds; never reveals whether the address exists |
| Save my new password | reset | sets password, → `/app` | `updatePassword` | zod; confirm-match |
| Send the email again | check-email | resends verification | `resendVerificationEmail` | disabled with no address |
| Accept and join | `/invite/:token` | joins the family | `acceptInvitation` | token hash + email must match; expiry checked |
| Sign in to accept | `/invite/:token` | sign-in, preserving the invite | — | — |

## Onboarding — `/onboarding/:step`

| Control | Does | Server |
| --- | --- | --- |
| Your preferred name / child's name / trusted caregiver | validated, whitespace-only rejected | — |
| Ask for a grown-up code (toggle) | shows/hides the PIN field | — |
| Grown-up code | 4–8 digits, guessable codes rejected | — |
| Continue (step 1) | creates family, child, membership, default escalation ladder, PIN | `bootstrapFamily`, `setCaregiverPin` |
| Communication options | multi-select | saved on Finish |
| Things that help / are hard | multi-select | saved on Finish |
| Familiar symbols | single-select | saved on Finish |
| Text size slider | 90–200%, live `aria-valuetext` | saved on Finish |
| Higher contrast / low-stimulation / read aloud / sound / vibration / motion / countdowns | toggles, all default **off** | saved on Finish |
| Processing time | seconds before a transition warning ends | saved on Finish |
| Safe adult / safe place | free text, shown to the child when nobody answers | `updateChild` |
| Bathroom urgency | urgent (default) or can-wait | `updateChildPreferences` |
| Ask another caregiver after | escalation delay in seconds | `updateChildPreferences` |
| Turn on notifications | requests browser permission | — |
| Finish setup | writes everything, marks onboarding complete | `setCommunicationMethods`, `setSensoryPreferences`, `updateChildPreferences`, `updateChild`, `saveOnboardingDraft` |
| Previous | back a panel, answers kept | — |
| Go to my space | → `/app` | — |

Progress is saved to `caregiver_profiles.onboarding_data` after each panel, so a
caregiver can stop and resume on another device.

## Caregiver shell — every screen

| Control | Does | Server |
| --- | --- | --- |
| Brand / sidebar nav ×5 | routes to Home, Stories, Requests, Routines, Profile | — |
| Requests badge | appears only while a request is live | — |
| Settings (sidebar foot) | → `/app/settings` | — |
| Profile switcher (avatar + name) | → `/app/profile` | — |
| Notification bell | opens the popover; marks all read on open | `markNotificationsRead` |
| A notification entry | marks that one read and navigates to its target | `markNotificationsRead` |
| Close (popover) | closes; Escape and outside-click also close | — |
| Caregiver avatar (top right) | → `/app/profile` | — |
| Active-request banner | shows child, urgency, sent time, holder, status | — |
| Open (banner) | → that request | — |
| Offline banner | appears on `offline`; states KINDLY will not claim delivery | — |
| Email-unconfirmed notice | non-blocking; explains the consequence | — |

## Home — `/app`

| Control | Does |
| --- | --- |
| Journey steps | non-interactive progress indicator (an `<ol>`, not buttons) |
| Open *child*'s view | starts a scoped child session → `/child` |
| Up next → a routine | → that routine's editor |
| More options (Up next) | → `/app/routines` |
| Build a routine (empty state) | → `/app/routines/new` |
| Toolkit: Prepare for a situation | → `/app/stories/new` |
| Toolkit: Practice communication | → child mode |
| Toolkit: Build a routine | → `/app/routines` |
| See all | → `/app/stories` |
| Situation / familiarity / format chips | select; carried into the story builder as query params |
| Something else + free text | carried into the builder |
| Start a story draft | → `/app/stories/new?scenario=…` |
| View requests | → `/app/requests` |
| Recent request card | → that request |

## Requests — `/app/requests`, `/app/requests/:id`

| Control | Does | Guard |
| --- | --- | --- |
| A request row | → detail | — |
| Back to requests | → list | — |
| Lifecycle strip | Review → Sending → Delivered → Acknowledged → Resolved, marking the stopping point on failure | — |
| Meta grid | child, urgency, sent, delivered, acknowledged, assignee, response, attempts, connection, id | — |
| Escalation log | every reassignment with reason, target and time | — |
| Full history (details) | every audit event | — |
| I have seen this | records `seen` | assigned to you; delivered |
| I'm coming now | records `coming_now` | as above |
| In N minutes + selector | records `delay` | **never rendered for urgent**; refused by function and trigger |
| Go to *safe adult* / *safe place* | records that action | only when configured |
| *Trusted* is coming | reassigns to the trusted caregiver | one must exist |
| Escalate to *trusted* | escalates now | valid transition + trusted exists |
| I will take this back | claims the request | `can_answer_requests` |
| Mark resolved | resolves | urgent → confirmation dialog first |
| Cancel this request | cancels | confirmation dialog explaining the effect |
| Short note for *child* | attached to the next answer | ≤200 chars |
| Yes, it is resolved / Not yet | confirms or dismisses | `alertdialog`, focus-trapped |

Server: `respondToRequest`, `claimRequest`, `escalateRequest`, `resolveRequest`,
`cancelRequestAsCaregiver`. All refuse a caller who is not the assignee.

## Stories — `/app/stories`, `/app/stories/new`, `/app/stories/:id`

| Control | Does | Guard |
| --- | --- | --- |
| Start a new story | → builder | `can_edit_stories` |
| Featured story → Open | → editor | — |
| Edit / Read | → editor | label reflects permission |
| Give to *child* | makes it available in child mode | **approved only** |
| Withdraw from child mode | removes it immediately | — |
| Duplicate | copies as a new draft | — |
| Archive / Restore | toggles archived | — |
| Delete | deletes | confirmation naming the effect |
| Situation, location, people, what usually happens, what may feel difficult, triggers, sensory, strengths, expected changes | generation inputs | — |
| Perspective / reading level / format / length | shape the draft | — |
| Build a draft for me | generates a structured draft | template builder |
| Write it myself, page by page | adds an empty page | — |
| What KINDLY would send (details) | shows the exact minimal payload | — |
| Review flags list | every finding with severity, page and excerpt | — |
| Page: section, heading, body, certainty, alt text | editable per page | alt text required for non-text formats |
| Move earlier / later / Duplicate / Delete page | reorder and edit | — |
| Add a page | appends | — |
| Save as a draft | saves; **always as a draft** | ≥3 pages, all non-empty |
| Preview as *child* sees it | opens in the child's display settings | — |
| Previous / Next page (preview) | pages through | — |
| Approve this story | approves, snapshots a version, records who and when | disabled while a `block` flag stands; confirmation dialog |
| Version history | every approved snapshot with author and note | — |

## Routines — `/app/routines`, `/app/routines/:id`

| Control | Does | Guard |
| --- | --- | --- |
| Add a routine | → new | `can_edit_routines` |
| Edit / View | → editor | label reflects permission |
| Earlier / Later | reorders | `reorderRoutines` |
| Duplicate / Archive / Restore | as named | — |
| Delete | deletes | confirmation naming the effect |
| Name, description, schedule label, colour | edit | colour is decoration only; the name is always shown |
| Steps can be skipped / any order | behaviour toggles | — |
| Transition warning seconds | how long "next is…" shows | never auto-advances |
| Step: title, detail, plans-changed note, optional | edit | title required |
| Move earlier / later / Duplicate / Delete step | reorder and edit | last step cannot be deleted |
| Save routine | saves | validation with inline errors |

## Profile — `/app/profile`

| Control | Does |
| --- | --- |
| Child chips (multi-child) | switches the active child |
| Edit profile | dialog: child name, pronouns |
| Change preferences | → `/app/settings/preferences` |
| Safe adult and safe place | → `/app/settings/safety` |
| Change name (caregiver) | dialog: caregiver name, relationship. Notes that past answers keep the name the child saw |
| Manage (a trusted caregiver) | → `/app/settings/caregivers` |
| Manage caregivers | → `/app/settings/caregivers` |

## Settings — `/app/settings/*`

| Screen | Controls |
| --- | --- |
| Index | six rows, each → its subpage; names summary → profile; Sign out (confirmation dialog explaining child sessions end) |
| Children | list; Edit; Archive/Restore; Delete (typed confirmation); Add a child (dialog) |
| Caregivers | per-member role selector and Remove access (dialog explaining reassignment); Create an invitation (dialog returning a one-time link); Withdraw invitation; trusted caregivers add/edit/remove with escalation order |
| Preferences | communication methods add/edit/remove/primary; sensory notes add/edit/remove; symbol system; text size; seven display and motion toggles; processing time; Save |
| Safety | safe adult, safe place, emergency instructions; bathroom urgency; escalation ladder add/edit/remove per step; grown-up code toggle and reset; Save |
| Notifications | permission state and request button; quiet hours start/end; urgent-always-through shown locked on; Save |
| Data | Download my data; Delete child profile (typed confirmation); Delete my account (type DELETE); an explanation of what happens after deletion |

## Child mode — `/child/*`

| Control | Screen | Does | Guard |
| --- | --- | --- | --- |
| Adult View | all | → PIN gate | — |
| My day / My stories / I need help / How I feel | home | route | symbol **and** words on every card |
| Active request strip | home | → that request | only while live |
| Help | home | → offline help | always reachable |
| Back | help, feelings, stories, day | → previous screen | — |
| A request card | help | creates the request, → confirmation | idempotency key; open duplicate returns the same request |
| Find a grown-up now | help | → offline help | — |
| Send request | request | sends | only path to "Delivered" |
| Change request | request | cancels and returns to the list | — |
| I changed my mind | request | cancels; caregiver told if delivered | — |
| Thank you, all done | request | resolves | — |
| I do not need help now | request | cancels | — |
| Back to my day | request | → home; the request stays live | — |
| Try again | request | retries | after failure or unavailable |
| Read this to me | request, story | speaks the text | only when read-aloud is on |
| Timer / progress bar | request | counts down, or shows a wordy bar | numbers only if countdowns are on |
| Feeling cards (8 feelings, 5 body, 2 unsure) | feelings | selects | "I don't know" is a first-class choice |
| Intensity ×4 | feelings | optional | can be deselected |
| Would something help ×4 | feelings | optional | — |
| Add your own words | feelings | optional note | only if the profile allows |
| Send this | feelings | creates and sends | shares the request lifecycle |
| Change my answer | feelings | clears the selection | — |
| Not now, back to my day | feelings | → home | — |
| A story | stories | → reader | approved **and** assigned only |
| Previous / Next page | reader | pages, saves position | never forces completion |
| Stop and go back to my day | reader | → home | — |
| This is different / I have a question / I need a break / I do not want this story | reader | asks to confirm first | sent only after explicit yes |
| Yes, send it / No, do not send it | reader | confirms or cancels | states exactly what the adult will see |
| A routine | day | → runner | — |
| Start / Start again | runner | starts or resumes | — |
| Done | runner | marks the step done | — |
| Skip this step | runner | marks skipped, neutrally | only if the routine allows |
| Pause | runner | pauses; nothing lost | — |
| Plans have changed | runner | shows the alternative, offers to mark it changed | first-class outcome |
| Stop for now | runner | abandons without penalty | — |
| Do it again | runner | restarts | no score anywhere |
| Digits 0–9 / Clear / Delete | PIN gate | enters the code | server-verified; lockout after 5 |
| I need help now | PIN gate | → offline help | **never needs the code** |
| Back to my day | PIN gate | → home | never needs the code |

## Non-interactive by design

These look like content and are not clickable: the journey step indicator, the
lifecycle strip, status pills, preference tags, the escalation log, and the
"Made for more good days" sidebar note. The `ComingLater` component exists for
anything genuinely unbuilt; **it is not currently used anywhere**, because every
destination in the product is implemented.
