# Deploying KINDLY

The production artifact is built and sitting in `dist/` (3.9 MB, 140 kB gzipped
main chunk). It is a static single-page app: any static host will serve it.

**It has not been deployed.** This machine has no deployment CLI, no git remote
and no Supabase project, so there was nothing to deploy to. Everything below is
what to run once you have both.

> Read [HANDOVER.md](HANDOVER.md) §3 first. Nothing is failing — 180 unit tests
> and 14 end-to-end tests pass — but **none of the Supabase path has ever
> executed**. Step 6's manual checks are not optional.

---

## Do not deploy the memory build

```
VITE_KINDLY_BACKEND=memory   ← demo and tests only, never a live URL
```

That build has no server. Requests are stored in the visitor's own browser and
no caregiver is ever notified, while the child is still shown "Your message
arrived." Ship only a build with `VITE_KINDLY_BACKEND=supabase` and real
credentials.

A build with no credentials is safe but useless: it renders the
"KINDLY is not configured" screen rather than pretending to work.

---

## 1. Create the Supabase project

```bash
npx supabase login
```

```bash
npx supabase link --project-ref <your-project-ref>
```

```bash
npx supabase db push
```

`db push` applies all 13 migrations, including every RLS policy. **Do not run
`supabase db reset` against a hosted project** — it would load `seed.sql`, which
creates demo accounts with published passwords.

If the CLI cannot authenticate on your machine, paste
`supabase/apply-all.sql` into the SQL Editor instead — it is the same 13
migrations concatenated in order. A project that already has the schema from an
earlier run needs only the patch files, in order:
`supabase/patch-01-child-send-request.sql`, then
`supabase/patch-02-mandatory-adult-code.sql`, then
`supabase/patch-03-operator-dashboard.sql`.

Verify RLS landed before going further:

```sql
select tablename, rowsecurity, forcerowsecurity
from pg_tables where schemaname = 'public' order by tablename;
```

Every row must show `t` in both columns. If any shows `f`, stop.

## 2. Configure Auth

In **Authentication → URL Configuration**:

* Site URL: your production origin
* Redirect URLs: add `https://<your-domain>/auth/callback` and
  `https://<your-domain>/auth/reset`

In **Authentication → Providers → Email**: confirm "Confirm email" is on.

### 2b. Custom SMTP — required, not optional

Supabase's built-in email sender is a **testing** service. It is capped at
roughly **2 messages per hour for the whole project**, and on many projects it
refuses to deliver to any address outside your Supabase organisation. Over that
cap it fails silently at the provider, so the symptom is not an error — it is a
caregiver who never receives their invitation.

KINDLY sends mail on paths that matter: account verification, password reset,
and caregiver invitations. A family whose second caregiver never gets their
invitation is a family where a child's request reaches one adult instead of two.
Treat SMTP as part of the safety configuration, not as polish.

**You need a domain you control.** `*.vercel.app` cannot be used — it is on the
Public Suffix List, so you cannot add the DKIM and SPF records a sender needs,
and mail "from" it will be rejected or spam-filed. Any registrar is fine.

1. Create an account with a transactional email provider — Resend, Postmark,
   SendGrid and Brevo all have free tiers well above what a small deployment
   needs. Postmark has the best deliverability for transactional-only sending;
   Resend is the quickest to set up.
2. Add your domain in the provider and publish the DNS records it gives you —
   DKIM, SPF, and a DMARC record. Wait for the provider to report the domain
   verified. Skipping DMARC is the usual reason mail lands in spam.
3. Collect the SMTP credentials. For Resend these are host `smtp.resend.com`,
   port `465`, username `resend`, password = your API key.
4. In **Authentication → Emails → SMTP Settings**, enable custom SMTP and enter
   the host, port, username and password, plus a sender address on your verified
   domain and a sender name. Use a real, monitored address — people reply to
   these, and a reply from a caregiver that reaches nobody is its own failure.
5. In **Authentication → Rate Limits**, raise "Rate limit for sending emails".
   The built-in cap no longer applies once custom SMTP is configured, but the
   setting does not raise itself.
6. In **Authentication → Email Templates**, rewrite the defaults. They arrive in
   Supabase's voice, mention Supabase by name, and read like developer tooling.
   A caregiver being invited to a child's space should recognise what they are
   being asked to join, and a child-safety product should not look like a
   misdirected technical email.

Verify by requesting a password reset for an address that is **not** a member of
your Supabase organisation. That is the case the built-in sender silently
refuses, so it is the one that proves the change took effect.

### 2c. Make yourself an operator

The operator dashboard at `/app/admin` shows counts and timings across every
family — how many children asked for help, how many were answered, how long it
took, and how many ran out of adults and were shown offline help. It shows no
name, no message, and no identifier that could be joined back to a family.

Nobody is an operator until you say so, and the only way to say so is by hand:

```sql
insert into kindly.operators (user_id, note)
select id, 'me' from auth.users where email = 'you@example.com';
```

`kindly.operators` has RLS forced and no policy at all. No application code can
read it, discover who is on it, or write to it, so a caregiver cannot promote
themselves. To remove someone, delete their row.

### 2d. Turn on traffic analytics

The app ships `@vercel/analytics`, mounted in `src/main.tsx` and active only in
a production build — never in `vite dev`, the e2e build, or the single-file
demo. It still needs enabling once on Vercel: your project &rarr; Analytics &rarr;
Enable. Figures then appear in the Vercel dashboard, not inside KINDLY.

It measures traffic and nothing else: URL, referrer, and coarse device and
country. It is cookieless and stores no per-visitor identifier, which is why
KINDLY carries no consent banner &mdash; there is nothing stored to consent to.
It never sees a name, a request, or anything typed into the app.

Nothing in the CSP needs changing: in production the script and its beacon are
both same-origin under `/_vercel/insights/`, already covered by `script-src
'self'` and `connect-src 'self'`.

## 3. Build with real credentials

```bash
cp .env.example .env.local
```

Fill in `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and
`VITE_PUBLIC_SITE_URL` from **Project Settings → API**. Leave
`VITE_KINDLY_BACKEND=supabase`. Then:

```bash
npm run build
```

The anon key is safe in the browser *only* because RLS is forced on every table.
That is why step 1's verification matters.

## 4. Publish `dist/`

Any static host. The app uses real routes, so **every path must fall back to
`index.html`** or a refresh on `/app/requests` will 404.

**Vercel** — add `vercel.json`:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

```bash
npx vercel deploy --prod
```

**Netlify** — add `public/_redirects` containing `/* /index.html 200`:

```bash
npx netlify deploy --prod --dir=dist
```

**Cloudflare Pages**:

```bash
npx wrangler pages deploy dist --project-name kindly
```

## 5. Confirm the scheduled jobs installed

Migration `…001200_scheduled_jobs.sql` installs three `pg_cron` jobs. It
degrades safely: if `pg_cron` is unavailable it warns rather than failing, so
**check that they exist** rather than assuming:

```sql
select jobname, schedule, active from cron.job where jobname like 'kindly-%';
```

Expect three rows — `kindly-escalations` (15 seconds), `kindly-deletions` and
`kindly-retention` (nightly). If they are missing, enable `pg_cron` under
**Database → Extensions** and re-run that migration.

Without them: escalation only runs while a caregiver has the app open, and
deletion requests never complete — an erasure request cannot be honoured.

## 5b. Deploy the story-generation function (optional)

Skip this and the app still works: story generation reports itself unavailable
and the built-in builder produces the draft instead.

```bash
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npx supabase functions deploy generate-story
```

Optionally lock its CORS origin to your site:

```bash
npx supabase secrets set KINDLY_ALLOWED_ORIGIN=https://your-domain
```

The function checks the caller's JWT and their `can_edit_stories` permission
before generating, and returns a draft only — it cannot approve or assign.

## 6. After deploying, check by hand

The automated suite does not cover a live project. At minimum:

1. Create an account; confirm the verification email arrives.
2. Complete onboarding; confirm the family, child and trusted caregiver exist.
3. Open child mode on a second device; send a request.
4. Confirm the first device receives it, and that the child saw "Delivered"
   only after the caregiver's device actually had it.
5. Answer it; confirm the child sees the answer.
6. Refresh both; confirm the state survives.
7. Sign in as an unrelated account and confirm it can see nothing.
7b. On the child device, tap to leave child mode and enter a **wrong** code.
    Confirm it is refused. This is the check that would have passed silently
    before patch 02, because verification failed open when no code was stored.
8. Leave a request unanswered past its escalation window with **no caregiver
   device awake**, and confirm it still escalates. That proves the cron jobs run.

Step 7 is the one that matters most. If it fails, take the deployment down.
