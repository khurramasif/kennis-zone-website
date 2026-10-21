// Kennis Zone job portal backend — Cloudflare Worker (v4)
// Bindings / secrets:
//   JOBS_KV        (KV namespace)  — posted jobs + application log
//   RESEND_API_KEY (secret)        — Resend API key
//   ADMIN_KEY      (secret)        — Khurram's private key for the admin Excel export
// Routes:
//   GET  /health                          -> { ok: true }
//   GET  /jobs                            -> { ok: true, jobs: [...] }  (newest first)
//   POST /jobs                            -> JSON job posting; auto-publishes; exact
//                                          duplicates (ALL details matching) rejected
//   POST /jobs/bump                       -> { id, email } renews a post (owner email
//                                          must match), max 5 renewals per month
//   POST /apply                           -> multipart application; emails the poster,
//                                          BCCs the owner, and logs the application
//   POST /contact                         -> JSON { name, email, message } -> info@
//   GET  /admin/applications.csv?key=...  -> Excel-ready CSV of ALL applications (admin only)
//   GET  /admin/applications/count?key=.. -> { ok: true, count }

const ALLOWED_ORIGINS = [
  'https://www.kenniszone.online',
  'https://kenniszone.online',
];
const FROM = 'Kennis Zone Jobs <job@kenniszone.online>';
const BCC = 'khurram@kenniszone.online';
const SELF_INBOX = 'job@kenniszone.online';
const CONTACT_INBOX = 'info@kenniszone.online';
const MAX_CV_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_CV_EXT = ['pdf', 'doc', 'docx'];

// Jobs built into the website itself — included in duplicate checks so a
// built-in listing can never be re-posted as a duplicate.
const SEEDED_JOBS = [
  { id: 'KZ-101', title: 'Admin & HR Assistant Manager', company: 'Premier MNC Logistics Group', city: 'Lahore', salary: 'PKR 160,000 – 210,000 / mo', experience: 'Management', industry: 'Corporate HR & People', recipientEmail: 'job@kenniszone.online', workMode: 'On-Site • Gulberg, Lahore', lastDateToApply: '2026-11-15', summary: 'Lead end-to-end employee lifecycle, biometric attendance reconciliation, statutory EOBI/Social Security compliance, and branch administration for a 250+ headcount regional office.' },
  { id: 'KZ-102', title: 'Senior Investment Advisor (Real Estate)', company: 'Apex Sovereign Developments', city: 'Lahore', salary: 'PKR 120,000 – 150,000 + High Commission', experience: 'Mid-Senior', industry: 'Real Estate & Investment', recipientEmail: 'job@kenniszone.online', workMode: 'On-Site • DHA Phase 6, Lahore', lastDateToApply: '2026-11-10', summary: 'Manage HNW and overseas Pakistani investor portfolios for commercial high-rise projects. Uncapped commission structure with corporate-provided warm leads.' },
  { id: 'KZ-103', title: 'HR Officer (Talent & Onboarding)', company: 'NextGen FinTech Solutions', city: 'Karachi', salary: 'PKR 85,000 – 115,000 / mo', experience: 'Fresher / Entry', industry: 'Corporate HR & People', recipientEmail: 'job@kenniszone.online', workMode: 'Hybrid • Shahrah-e-Faisal, Karachi', lastDateToApply: '2026-11-05', summary: 'Ideal for sharp BBA/MBA HR graduates or 1-year experienced professionals. Coordinate technical interviews, issue automated appointment letters, and drive onboarding.' },
  { id: 'KZ-104', title: 'AI Automation & Python Workflow Engineer', company: 'Kennis Enterprise Tech Partner', city: 'Lahore', salary: 'PKR 220,000 – 320,000 / mo', experience: 'Mid-Senior', industry: 'Telecom, AI & IT', recipientEmail: 'job@kenniszone.online', workMode: 'Hybrid • Johar Town, Lahore', lastDateToApply: '2026-11-18', summary: 'Design and deploy custom AI agents, automated document workflows, and API integrations for corporate clients across Pakistan.' },
  { id: 'KZ-105', title: 'Regional Territory Sales Manager (FMCG)', company: 'Vitality Consumer Brands', city: 'Multan', salary: 'PKR 175,000 – 230,000 + Car & Fuel', experience: 'Management', industry: 'FMCG & Operations', recipientEmail: 'job@kenniszone.online', workMode: 'Field & Office • Multan HQ', lastDateToApply: '2026-11-12', summary: 'Spearhead primary and secondary sales across Multan, Bahawalpur, and DG Khan networks. Company-maintained vehicle and quarterly performance bonuses included.' },
  { id: 'KZ-106', title: 'Graduate Trainee — Telecom & BPO Operations', company: 'Global Connect Telecom MNC', city: 'Lahore', salary: 'PKR 65,000 – 85,000 / mo', experience: 'Fresher / Entry', industry: 'Telecom, AI & IT', recipientEmail: 'job@kenniszone.online', workMode: 'On-Site • Thokar Niaz Baig, Lahore', lastDateToApply: '2026-11-08', summary: 'Structured 6-month rotational management trainee program for fresh graduates with direct absorption into Campaign Operations, Quality Assurance, or Client Success.' },
  { id: 'KZ-100', title: 'Senior Telecom Site Engineer (Past Intake)', company: 'Apex Infrastructure Group', city: 'Lahore', salary: 'PKR 130,000 – 170,000 / mo', experience: 'Mid-Senior', industry: 'Telecom, AI & IT', recipientEmail: 'job@kenniszone.online', workMode: 'On-Site • Lahore', lastDateToApply: '2026-10-05', summary: 'Led site installations and regional infrastructure commissioning across central Punjab clusters.' },
];

function corsHeaders(origin) {
  // Public portal API by design (anyone may post/apply); abuse is guarded
  // server-side (recipient locking, honeypot, dedupe), so CORS is permissive.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(origin, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
}

function clean(s, max = 500) {
  return String(s ?? '').trim().slice(0, max);
}

// Duplicate rule (owner's instruction): a job is a duplicate only when ALL
// of its details match an existing job — compared case-insensitively with
// whitespace collapsed.
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function jobKey(j) {
  return [
    j.title, j.company, j.city, j.salary, j.industry, j.experience,
    j.workMode, j.recipientEmail, j.lastDateToApply, j.summary,
  ].map(norm).join('|');
}

async function getStoredJobs(env) {
  const raw = await env.JOBS_KV.get('jobs:all');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function getApplications(env) {
  const raw = await env.JOBS_KV.get('apps:all');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function sendEmail(env, payload) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  return data;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function adminKeyOf(env) {
  return env.ADMIN_KEY || env.Admin_Key || '';
}
function adminAuthorized(request, env, url) {
  const adminKey = adminKeyOf(env);
  if (!adminKey) return false;
  const key = url.searchParams.get('key') || request.headers.get('x-admin-key') || '';
  return key.length > 0 && key === adminKey;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return json(origin, { ok: true, service: 'kennis-portal-api' });
      }

      // ---------- Admin: applications export (owner only) ----------
      if (url.pathname === '/admin/applications.csv' && request.method === 'GET') {
        if (!adminKeyOf(env)) return json(origin, { ok: false, error: 'Admin export is not configured.' }, 503);
        if (!adminAuthorized(request, env, url)) return json(origin, { ok: false, error: 'Unauthorized' }, 401);
        const apps = await getApplications(env);
        const header = ['Received At', 'Job ID', 'Job Title', 'Company', 'Sent To', 'Applicant Name', 'Applicant Email', 'Applicant Phone', 'Cover Note', 'CV File'];
        const lines = [header.join(',')];
        for (const a of apps) {
          lines.push([a.receivedAt, a.jobId, a.jobTitle, a.company, a.recipientEmail, a.applicantName, a.applicantEmail, a.applicantPhone, a.coverNote, a.cvFilename].map(csvCell).join(','));
        }
        return new Response(lines.join('\r\n'), {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="kennis-applications.csv"',
          },
        });
      }
      if (url.pathname === '/admin/applications/count' && request.method === 'GET') {
        if (!adminKeyOf(env)) return json(origin, { ok: false, error: 'Admin export is not configured.' }, 503);
        if (!adminAuthorized(request, env, url)) return json(origin, { ok: false, error: 'Unauthorized' }, 401);
        const apps = await getApplications(env);
        return json(origin, { ok: true, count: apps.length });
      }

      // ---------- Jobs: list ----------
      if (url.pathname === '/jobs' && request.method === 'GET') {
        const jobs = await getStoredJobs(env);
        return json(origin, { ok: true, jobs });
      }

      // ---------- Jobs: create (auto-publish, duplicates blocked) ----------
      if (url.pathname === '/jobs' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json(origin, { ok: false, error: 'Invalid JSON' }, 400);
        if (body.website) return json(origin, { ok: true }); // honeypot: silently drop

        const job = {
          title: clean(body.title, 120),
          company: clean(body.company, 120),
          city: clean(body.city, 80),
          salary: clean(body.salary, 120),
          industry: clean(body.industry, 120),
          experience: clean(body.experience, 60),
          workMode: clean(body.workMode, 60),
          summary: clean(body.summary, 4000),
          recipientEmail: clean(body.recipientEmail, 160),
          lastDateToApply: clean(body.lastDateToApply, 40),
        };
        if (!job.title || !job.company || !job.city || !isEmail(job.recipientEmail)) {
          return json(origin, { ok: false, error: 'Missing required fields or invalid application email.' }, 422);
        }

        const key = jobKey(job);
        const stored = await getStoredJobs(env);
        const dupeStored = stored.find(j => jobKey(j) === key);
        const dupeSeeded = SEEDED_JOBS.find(j => jobKey(j) === key);
        if (dupeStored || dupeSeeded) {
          const existing = dupeStored || dupeSeeded;
          return json(origin, {
            ok: false,
            duplicate: true,
            error: `This exact job is already posted (${existing.id}). Duplicate postings are not allowed.`,
          }, 409);
        }

        let counter = parseInt((await env.JOBS_KV.get('jobs:counter')) || '1000', 10);
        if (Number.isNaN(counter) || counter < 1000) counter = 1000;
        counter += 1;
        await env.JOBS_KV.put('jobs:counter', String(counter));

        job.id = `KZ-${counter}`;
        job.postedDate = new Date().toISOString();

        stored.unshift(job);
        await env.JOBS_KV.put('jobs:all', JSON.stringify(stored.slice(0, 300)));

        return json(origin, { ok: true, id: job.id, job });
      }


      // ---------- Jobs: renew / bring to top (max 5 per month, owner only) ----------
      if (url.pathname === '/jobs/bump' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json(origin, { ok: false, error: 'Invalid JSON' }, 400);
        const id = clean(body.id, 40);
        const email = clean(body.email, 160);
        if (!id || !isEmail(email)) {
          return json(origin, { ok: false, error: 'Job reference and a valid email are required.' }, 422);
        }
        const jobs = await getStoredJobs(env);
        const idx = jobs.findIndex(j => j.id === id);
        if (idx === -1) {
          return json(origin, { ok: false, error: 'This post could not be found.' }, 404);
        }
        const job = jobs[idx];
        if (norm(job.recipientEmail) !== norm(email)) {
          return json(origin, { ok: false, error: 'This email does not match the email used to post this job.' }, 403);
        }
        const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM
        if (job.bumpMonth !== monthKey) { job.bumpMonth = monthKey; job.bumpCount = 0; }
        if ((job.bumpCount || 0) >= 5) {
          return json(origin, { ok: false, error: 'Renewal limit reached — this post has used its 5 renewals for this month.', renewalsLeft: 0 }, 429);
        }
        job.bumpCount = (job.bumpCount || 0) + 1;
        job.postedDate = new Date().toISOString(); // fresh 1-month life
        jobs.splice(idx, 1);
        jobs.unshift(job); // back to the top
        await env.JOBS_KV.put('jobs:all', JSON.stringify(jobs));
        return json(origin, { ok: true, renewalsLeft: 5 - job.bumpCount, job });
      }

      // ---------- Apply ----------
      if (url.pathname === '/apply' && request.method === 'POST') {
        const form = await request.formData();
        if (form.get('website')) return json(origin, { ok: true }); // honeypot

        const jobId = clean(form.get('jobId'), 40);
        const applicantName = clean(form.get('applicantName'), 120);
        const applicantEmail = clean(form.get('applicantEmail'), 160);
        const applicantPhone = clean(form.get('applicantPhone'), 40);
        const coverNote = clean(form.get('coverNote'), 3000);
        if (!jobId || !applicantName || !isEmail(applicantEmail)) {
          return json(origin, { ok: false, error: 'Name, a valid email and a job reference are required.' }, 422);
        }

        // Resolve the recipient server-side (never trust a client-supplied address):
        //  - a job stored in the backend -> its own recipientEmail
        //  - built-in site jobs / talent bank -> job@kenniszone.online
        let jobTitle = clean(form.get('jobTitle'), 160);
        let company = clean(form.get('company'), 160);
        let recipient = null;
        if (jobId === 'TALENT-BANK') {
          recipient = SELF_INBOX;
          jobTitle = jobTitle || 'Central Talent Bank CV submission';
          company = company || 'Kennis Zone';
        } else {
          const jobs = await getStoredJobs(env);
          const stored = jobs.find(j => j.id === jobId);
          if (stored) {
            recipient = stored.recipientEmail;
            jobTitle = stored.title;
            company = stored.company;
          } else if (/^KZ-10[0-6]$/.test(jobId)) {
            recipient = SELF_INBOX; // built-in listings KZ-100..KZ-106 apply to job@
          }
        }
        if (!recipient) {
          return json(origin, { ok: false, error: 'This job could not be found.' }, 404);
        }

        const attachments = [];
        let cvFilename = '';
        const cv = form.get('cv');
        if (cv && typeof cv === 'object' && cv.size > 0) {
          const ext = (cv.name.split('.').pop() || '').toLowerCase();
          if (!ALLOWED_CV_EXT.includes(ext)) {
            return json(origin, { ok: false, error: 'CV must be a PDF or Word document.' }, 422);
          }
          if (cv.size > MAX_CV_BYTES) {
            return json(origin, { ok: false, error: 'CV file is too large (max 10 MB).' }, 422);
          }
          const buf = await cv.arrayBuffer();
          attachments.push({ filename: cv.name, content: arrayBufferToBase64(buf) });
          cvFilename = cv.name;
        }

        const text = [
          `New application via kenniszone.online`,
          ``,
          `Position: ${jobTitle} (${jobId})`,
          `Company: ${company}`,
          ``,
          `Candidate: ${applicantName}`,
          `Email: ${applicantEmail}`,
          applicantPhone ? `Phone: ${applicantPhone}` : null,
          ``,
          coverNote ? `Candidate note:\n${coverNote}` : null,
          attachments.length ? `` : `(No CV file was attached.)`,
        ].filter(v => v !== null).join('\n');

        const data = await sendEmail(env, {
          from: FROM,
          to: [recipient],
          bcc: [BCC],
          reply_to: applicantEmail,
          subject: `Application: ${jobTitle} (${jobId}) — ${applicantName}`,
          text,
          ...(attachments.length ? { attachments } : {}),
        });

        // Log the application for the owner's admin export (metadata only —
        // the CV itself travels with the email).
        const apps = await getApplications(env);
        apps.unshift({
          receivedAt: new Date().toISOString(),
          jobId,
          jobTitle,
          company,
          recipientEmail: recipient,
          applicantName,
          applicantEmail,
          applicantPhone,
          coverNote,
          cvFilename,
          emailId: data.id || null,
        });
        await env.JOBS_KV.put('apps:all', JSON.stringify(apps.slice(0, 2000)));

        return json(origin, { ok: true, id: data.id || null });
      }

      // ---------- Contact ----------
      if (url.pathname === '/contact' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json(origin, { ok: false, error: 'Invalid JSON' }, 400);
        if (body.website) return json(origin, { ok: true }); // honeypot
        const name = clean(body.name, 120);
        const email = clean(body.email, 160);
        const message = clean(body.message, 4000);
        if (!name || !isEmail(email) || !message) {
          return json(origin, { ok: false, error: 'Name, a valid email and a message are required.' }, 422);
        }
        const data = await sendEmail(env, {
          from: FROM,
          to: [CONTACT_INBOX],
          reply_to: email,
          subject: `Website inquiry from ${name}`,
          text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
        });
        return json(origin, { ok: true, id: data.id || null });
      }

      return json(origin, { ok: false, error: 'Not found' }, 404);
    } catch (err) {
      return json(origin, { ok: false, error: String(err && err.message || err) }, 500);
    }
  },
};
