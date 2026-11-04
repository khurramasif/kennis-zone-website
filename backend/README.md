# Kennis Portal backend — deploy notes

Worker code: `worker.js` (this folder). Deployed as a Cloudflare Worker named
`kennis-portal-api` on the account's workers.dev subdomain.

## Cloudflare setup (dashboard)
1. Workers & Pages → Create → Worker → name: `kennis-portal-api` → Deploy the placeholder.
2. Storage → KV → Create namespace: `kennis-jobs`.
3. Worker → Settings → Bindings → Add → KV namespace:
   - Variable name: `JOBS_KV`  → namespace `kennis-jobs`.
4. Worker → Settings → Variables and Secrets → Add secret:
   - Name: `RESEND_API_KEY` → value: the Resend API key (from the Resend task; never commit it).
   - Name: `ADMIN_KEY` → value: a private word Khurram chooses himself in the moment
     (never shared with Pepper). It unlocks the admin applications export.
5. Worker → Edit code → replace all with `worker.js` → Deploy.
6. Test: open `https://kennis-portal-api.<subdomain>.workers.dev/health` → `{"ok":true,...}`.

## Frontend contract (what the Studio prompts wire the site to)
- `GET  {API}/jobs` → merge returned jobs into listings before rendering / link routing.
- `POST {API}/jobs` (JSON) — Post a Job form fields + recipientEmail; returns the new KZ id.
- `POST {API}/apply` (multipart FormData) — jobId, jobTitle, company, applicantName,
  applicantEmail, applicantPhone, coverNote, cv file. Recipient is resolved server-side:
  stored job → its recipientEmail; KZ-101..106 / TALENT-BANK → job@kenniszone.online.
  Every application BCCs khurram@kenniszone.online.
- `POST {API}/contact` (JSON {name, email, message}) → emailed to info@kenniszone.online.
- Jobs auto-publish on POST; a posting whose details ALL match an existing job
  (built-in KZ-100..106 or backend-stored) is rejected with HTTP 409 `duplicate: true`.
- Every successful application is logged (metadata only). Admin-only export:
  `GET {API}/admin/applications.csv?key=<ADMIN_KEY>` downloads an Excel-ready CSV;
  `GET {API}/admin/applications/count?key=<ADMIN_KEY>` returns the total count.

## v5 additions (2026-10-23) — one paste deploys everything incl. v4 Renew
- Renew (from v4): `POST {API}/jobs/bump` {id, email} — owner-email check, max 5/month.
- Poster accounts: anyone may post; EDITING requires a signed-up account whose
  email matches the post's recipientEmail.
  `POST {API}/auth/signup` {name, email, password} → unverified account + 6-digit
  code emailed via Resend · `POST {API}/auth/verify` {email, code} → session token ·
  `POST {API}/auth/resend` · `POST {API}/auth/login` → Bearer token (30 days) ·
  `GET {API}/auth/me` · `GET {API}/jobs/mine` · `PUT {API}/jobs/:id` (owner-only edit;
  recipientEmail immutable; duplicate re-check).
  Passwords: PBKDF2-SHA256 (100k iterations, per-user salt). Accounts in KV `users:all`.
- WhatsApp share cards: the site renders a PNG of the job card and uploads it:
  `POST {API}/jobs/:id/share-image` (PNG body, `X-Poster-Email` must own the post) →
  stored in KV · `GET {API}/jobs/:id/share.png` serves it ·
  `GET {API}/s/:id` is a share landing page with Open Graph tags (card image +
  title + description) that redirects to the live job — pasted links preview
  as the card.
- Admin exports (same ADMIN_KEY): `GET {API}/admin/posts.csv?key=...` (all stored
  posts) and `GET {API}/admin/logins.csv?key=...` (all poster accounts — name,
  email, sign-up date, verified; never password data).

## v6 additions (2026-11-04) — Hermes bot API (one paste deploys everything incl. v5)
Authenticated machine routes for the Hermes WhatsApp pipeline. Auth is a
Worker **secret** named `BOT_API_KEY`, sent as `Authorization: Bearer <key>`;
it is honoured on `/bot/*` routes only (401 without it, 503 while the secret
is unset). Deploy = the usual paste of `worker.js` **plus** adding the
`BOT_API_KEY` secret (Settings → Variables and Secrets) with the same value
that lives on the Hermes server in `/home/ubuntu/.hermes/bot.env`.
- `POST {API}/bot/jobs` — create a job in the portal schema. Accepts
  title (or role), company, location/city, department/industry, salary,
  workMode, experience, applyEmail / applyLink / applyPhone (at least one
  required), description/rawText, lastDateToApply/deadline, and a source
  fingerprint. Server-side dedupe: fingerprint =
  normalized(company)+normalized(title)+normalized(apply contact); a match
  against a live job (posted within ~31 days, or a live built-in listing)
  returns `{ ok: true, deduped: true, existing_id }` and stores nothing.
  Created jobs get `source: "hermes-whatsapp"`, their computed `fingerprint`,
  the source fingerprint, and `recipientEmail` = applyEmail (or the portal
  inbox job@kenniszone.online when the job has no email channel, so portal
  applications still route).
- `GET {API}/bot/jobs` — all stored jobs with postedDate; filters
  `?date=YYYY-MM-DD` (the 14:00 run's "today's posted jobs"), `?source=bot`,
  and `limit`/`offset`.
- `GET {API}/bot/applications` — every logged application as JSON, fields as
  stored (receivedAt, jobId, jobTitle, company, recipientEmail,
  applicantName, applicantEmail, applicantPhone, coverNote, cvFilename,
  emailId); `limit`/`offset`. Metadata only — CV files travel by email and
  are never stored in KV.
- `DELETE {API}/bot/jobs/:id` — remove a stored job (test cleanup).

## Resend
- Domain kenniszone.online must show Verified (DKIM/SPF records added at GoDaddy).
- Free tier: 100 emails/day, 3,000/month — ample for portal volume.
- Sending identity: `Kennis Zone Jobs <job@kenniszone.online>`.
