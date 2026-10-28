// Kennis Zone job portal backend — Cloudflare Worker (v5)
// Bindings / secrets:
//   JOBS_KV        (KV namespace)  — posted jobs + application log + poster accounts
//   RESEND_API_KEY (secret)        — Resend API key
//   ADMIN_KEY      (secret)        — Khurram's private key for the admin Excel exports
// Routes:
//   GET  /health                          -> { ok: true }
//   GET  /jobs                            -> { ok: true, jobs: [...] }  (newest first)
//   POST /jobs                            -> JSON job posting; auto-publishes; exact
//                                          duplicates (ALL details matching) rejected
//   POST /jobs/bump                       -> { id, email } renews a post (owner email
//                                          must match), max 5 renewals per month
//   PUT  /jobs/:id                        -> edit a post (poster account session
//                                          required; account email must own the post)
//   POST /jobs/:id/share-image            -> stores the job's share-card PNG
//                                          (poster email header must own the post)
//   GET  /jobs/:id/share.png              -> the stored share-card PNG
//   GET  /s/:id                           -> share landing page with Open Graph card
//                                          tags; redirects to the live job
//   POST /auth/signup                     -> { name, email, password } creates a poster
//                                          account (unverified) + emails a 6-digit code
//   POST /auth/verify                     -> { email, code } verifies the account
//   POST /auth/resend                     -> { email } re-sends the verification code
//   POST /auth/login                      -> { email, password } -> session token
//   GET  /auth/me                         -> current account (Bearer token)
//   GET  /jobs/mine                       -> the signed-in poster's own posts
//   POST /apply                           -> multipart application; emails the poster,
//                                          BCCs the owner, and logs the application
//   POST /contact                         -> JSON { name, email, message } -> info@
//   GET  /admin/applications.csv?key=...  -> Excel-ready CSV of ALL applications (admin only)
//   GET  /admin/applications/count?key=.. -> { ok: true, count }
//   GET  /admin/posts.csv?key=...        -> Excel-ready CSV of ALL stored posts (admin only)
//   GET  /admin/logins.csv?key=...       -> Excel-ready CSV of ALL poster accounts (admin only)

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
  { id: 'KZ-1003', title: 'Assistant Manager – Admin', company: 'Imarat', city: 'Karachi', salary: 'PKR 60,000 – 90,000 / mo', experience: 'Mid-Senior', industry: 'Real Estate & Investment', recipientEmail: 'khurram.asif@imarat.com.pk', workMode: 'On-Site / Hybrid • Karachi', lastDateToApply: '2026-11-21', summary: 'Imarat is hiring an Assistant Manager – Admin for its Karachi office. The role covers day-to-day office administration, facilities and vendor management, fleet and logistics coordination, procurement support, and supervision of admin staff to keep operations running smoothly. Candidates should have solid experience in administration, preferably in a large real-estate or corporate setup, with strong coordination and MS Office skills.' },
  { id: 'KZ-1001', title: 'Senior Investment Advisor', company: 'Imarat', city: 'Lahore', salary: 'PKR 60,000 – 90,000 / mo', experience: 'Fresher / Entry', industry: 'Real Estate & Investment', recipientEmail: 'khurram.asif@imarat.com.pk', workMode: 'On-Site / Hybrid • Lahore', lastDateToApply: '2026-11-11', summary: 'Imarat is hiring a Senior Investment Advisor for its Lahore office to advise clients on real-estate investment opportunities and grow long-term client relationships.' },
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Poster-Email',
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

// ---------- Poster accounts (v5) ----------
// Anyone may post a job; editing a post requires a signed-up account whose
// email matches the email the post receives applications at (recipientEmail).
async function getUsers(env) {
  const raw = await env.JOBS_KV.get('users:all');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveUsers(env, users) {
  await env.JOBS_KV.put('users:all', JSON.stringify(users.slice(0, 2000)));
}

function findUser(users, email) {
  return users.find(u => norm(u.email) === norm(email)) || null;
}

async function hashPassword(password, saltB64) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return arrayBufferToBase64(bits);
}

async function makePasswordRecord(password) {
  const saltB64 = arrayBufferToBase64(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const hash = await hashPassword(password, saltB64);
  return `pbkdf2$100000$${saltB64}$${hash}`;
}

async function checkPassword(password, record) {
  const parts = String(record || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const hash = await hashPassword(password, parts[2]);
  return hash === parts[3];
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function issueVerifyCode(env, email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const record = {
    h: await sha256Hex(`${code}:${norm(email)}`),
    exp: Date.now() + 15 * 60 * 1000,
    tries: 0,
  };
  await env.JOBS_KV.put(`verify:${norm(email)}`, JSON.stringify(record), { expirationTtl: 960 });
  await sendEmail(env, {
    from: FROM,
    to: [email],
    subject: 'Your Kennis Zone verification code',
    text: [
      `Your Kennis Zone poster account verification code is: ${code}`,
      ``,
      `It expires in 15 minutes. Enter it on the website to verify your account — a verified account lets you edit the job posts made with this email address.`,
      ``,
      `If you did not request this code, you can ignore this email.`,
    ].join('\n'),
  });
  return code;
}

async function accountFromRequest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const email = await env.JOBS_KV.get(`sess:${m[1].trim()}`);
  if (!email) return null;
  const users = await getUsers(env);
  return findUser(users, email);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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

      // ---------- Admin: posts + logins exports (owner only, v5) ----------
      if (url.pathname === '/admin/posts.csv' && request.method === 'GET') {
        if (!adminKeyOf(env)) return json(origin, { ok: false, error: 'Admin export is not configured.' }, 503);
        if (!adminAuthorized(request, env, url)) return json(origin, { ok: false, error: 'Unauthorized' }, 401);
        const jobs = await getStoredJobs(env);
        const header = ['Job ID', 'Posted Date', 'Title', 'Company', 'City', 'Salary', 'Industry', 'Experience', 'Work Mode', 'Applications Email', 'Last Date To Apply', 'Renewals Used This Month'];
        const lines = [header.join(',')];
        for (const j of jobs) {
          lines.push([j.id, j.postedDate, j.title, j.company, j.city, j.salary, j.industry, j.experience, j.workMode, j.recipientEmail, j.lastDateToApply, j.bumpCount || 0].map(csvCell).join(','));
        }
        return new Response(lines.join('\r\n'), {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="kennis-posts.csv"',
          },
        });
      }
      if (url.pathname === '/admin/logins.csv' && request.method === 'GET') {
        if (!adminKeyOf(env)) return json(origin, { ok: false, error: 'Admin export is not configured.' }, 503);
        if (!adminAuthorized(request, env, url)) return json(origin, { ok: false, error: 'Unauthorized' }, 401);
        const users = await getUsers(env);
        const header = ['Name', 'Email', 'Signed Up', 'Verified'];
        const lines = [header.join(',')];
        for (const u of users) {
          lines.push([u.name, u.email, u.createdAt, u.verified ? 'Yes' : 'No'].map(csvCell).join(','));
        }
        return new Response(lines.join('\r\n'), {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="kennis-logins.csv"',
          },
        });
      }

      // ---------- Poster accounts: sign up / verify / login (v5) ----------
      if (url.pathname === '/auth/signup' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json(origin, { ok: false, error: 'Invalid JSON' }, 400);
        if (body.website) return json(origin, { ok: true }); // honeypot
        const name = clean(body.name, 120);
        const email = clean(body.email, 160);
        const password = String(body.password || '');
        if (!name || !isEmail(email)) {
          return json(origin, { ok: false, error: 'Your name and a valid email are required.' }, 422);
        }
        if (password.length < 8) {
          return json(origin, { ok: false, error: 'Password must be at least 8 characters.' }, 422);
        }
        const users = await getUsers(env);
        const existing = findUser(users, email);
        if (existing && existing.verified) {
          return json(origin, { ok: false, error: 'An account with this email already exists — please sign in instead.' }, 409);
        }
        if (existing) {
          existing.name = name;
          existing.pass = await makePasswordRecord(password);
          await saveUsers(env, users);
        } else {
          users.push({
            name,
            email,
            pass: await makePasswordRecord(password),
            verified: false,
            createdAt: new Date().toISOString(),
          });
          await saveUsers(env, users);
        }
        try {
          await issueVerifyCode(env, email);
        } catch (err) {
          return json(origin, { ok: false, error: 'Account saved, but the verification email could not be sent. Please try "Resend code".' }, 502);
        }
        return json(origin, { ok: true, needsVerify: true, email });
      }

      if (url.pathname === '/auth/verify' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json(origin, { ok: false, error: 'Invalid JSON' }, 400);
        const email = clean(body.email, 160);
        const code = clean(body.code, 10);
        if (!isEmail(email) || !code) {
          return json(origin, { ok: false, error: 'Email and the 6-digit code are required.' }, 422);
        }
        const raw = await env.JOBS_KV.get(`verify:${norm(email)}`);
        if (!raw) return json(origin, { ok: false, error: 'This code has expired — please request a new one.' }, 410);
        let record;
        try { record = JSON.parse(raw); } catch { record = null; }
        if (!record || Date.now() > record.exp) {
          return json(origin, { ok: false, error: 'This code has expired — please request a new one.' }, 410);
        }
        if ((record.tries || 0) >= 5) {
          return json(origin, { ok: false, error: 'Too many attempts — please request a new code.' }, 429);
        }
        const h = await sha256Hex(`${code}:${norm(email)}`);
        if (h !== record.h) {
          record.tries = (record.tries || 0) + 1;
          await env.JOBS_KV.put(`verify:${norm(email)}`, JSON.stringify(record), { expirationTtl: 960 });
          return json(origin, { ok: false, error: 'That code does not match. Please check and try again.' }, 403);
        }
        const users = await getUsers(env);
        const user = findUser(users, email);
        if (!user) return json(origin, { ok: false, error: 'Account not found — please sign up first.' }, 404);
        user.verified = true;
        await saveUsers(env, users);
        await env.JOBS_KV.delete(`verify:${norm(email)}`);
        const token = randomToken();
        await env.JOBS_KV.put(`sess:${token}`, user.email, { expirationTtl: 2592000 });
        return json(origin, { ok: true, token, email: user.email, name: user.name });
      }

      if (url.pathname === '/auth/resend' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json(origin, { ok: false, error: 'Invalid JSON' }, 400);
        const email = clean(body.email, 160);
        if (!isEmail(email)) return json(origin, { ok: false, error: 'A valid email is required.' }, 422);
        const users = await getUsers(env);
        const user = findUser(users, email);
        if (!user) return json(origin, { ok: false, error: 'No account found with this email.' }, 404);
        if (user.verified) return json(origin, { ok: false, error: 'This account is already verified — please sign in.' }, 409);
        try {
          await issueVerifyCode(env, email);
        } catch (err) {
          return json(origin, { ok: false, error: 'The verification email could not be sent. Please try again.' }, 502);
        }
        return json(origin, { ok: true, needsVerify: true, email });
      }

      if (url.pathname === '/auth/login' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json(origin, { ok: false, error: 'Invalid JSON' }, 400);
        const email = clean(body.email, 160);
        const password = String(body.password || '');
        if (!isEmail(email) || !password) {
          return json(origin, { ok: false, error: 'Email and password are required.' }, 422);
        }
        const users = await getUsers(env);
        const user = findUser(users, email);
        if (!user || !(await checkPassword(password, user.pass))) {
          return json(origin, { ok: false, error: 'Email or password is incorrect.' }, 401);
        }
        if (!user.verified) {
          return json(origin, { ok: false, needsVerify: true, error: 'Please verify your email first — enter the 6-digit code we emailed you.' }, 403);
        }
        const token = randomToken();
        await env.JOBS_KV.put(`sess:${token}`, user.email, { expirationTtl: 2592000 });
        return json(origin, { ok: true, token, email: user.email, name: user.name });
      }

      if (url.pathname === '/auth/me' && request.method === 'GET') {
        const account = await accountFromRequest(request, env);
        if (!account) return json(origin, { ok: false, error: 'Not signed in.' }, 401);
        return json(origin, { ok: true, email: account.email, name: account.name });
      }

      // ---------- Jobs: the signed-in poster's own posts (v5) ----------
      if (url.pathname === '/jobs/mine' && request.method === 'GET') {
        const account = await accountFromRequest(request, env);
        if (!account) return json(origin, { ok: false, error: 'Not signed in.' }, 401);
        const jobs = await getStoredJobs(env);
        const mine = jobs.filter(j => norm(j.recipientEmail) === norm(account.email));
        return json(origin, { ok: true, jobs: mine });
      }

      // ---------- Jobs: edit a post (signed-in owner only, v5) ----------
      const jobIdMatch = url.pathname.match(/^\/jobs\/(KZ-\d+)$/);
      if (jobIdMatch && request.method === 'PUT') {
        const account = await accountFromRequest(request, env);
        if (!account) return json(origin, { ok: false, error: 'Please sign in to edit this post.' }, 401);
        const body = await request.json().catch(() => null);
        if (!body) return json(origin, { ok: false, error: 'Invalid JSON' }, 400);
        const id = jobIdMatch[1];
        const jobs = await getStoredJobs(env);
        const idx = jobs.findIndex(j => j.id === id);
        if (idx === -1) return json(origin, { ok: false, error: 'This post could not be found.' }, 404);
        const job = jobs[idx];
        if (norm(job.recipientEmail) !== norm(account.email)) {
          return json(origin, { ok: false, error: 'You can only edit posts made with your own account email.' }, 403);
        }
        const updated = {
          ...job,
          title: clean(body.title, 120) || job.title,
          company: clean(body.company, 120) || job.company,
          city: clean(body.city, 80) || job.city,
          salary: clean(body.salary, 120) || job.salary,
          industry: clean(body.industry, 120) || job.industry,
          experience: clean(body.experience, 60) || job.experience,
          workMode: clean(body.workMode, 60) || job.workMode,
          summary: clean(body.summary, 4000) || job.summary,
          lastDateToApply: clean(body.lastDateToApply, 40) || job.lastDateToApply,
          // recipientEmail never changes — it is the ownership anchor.
        };
        const key = jobKey(updated);
        const dupe = jobs.find(j => j.id !== id && jobKey(j) === key)
          || SEEDED_JOBS.find(j => jobKey(j) === key);
        if (dupe) {
          return json(origin, { ok: false, duplicate: true, error: `These details exactly match another live post (${dupe.id}). Duplicate postings are not allowed.` }, 409);
        }
        jobs[idx] = updated;
        await env.JOBS_KV.put('jobs:all', JSON.stringify(jobs));
        return json(origin, { ok: true, job: updated });
      }

      // ---------- Share-card images (v5) ----------
      const shareImgMatch = url.pathname.match(/^\/jobs\/(KZ-\d+)\/share-image$/);
      if (shareImgMatch && request.method === 'POST') {
        const id = shareImgMatch[1];
        const jobs = await getStoredJobs(env);
        const job = jobs.find(j => j.id === id);
        if (!job) return json(origin, { ok: false, error: 'This post could not be found.' }, 404);
        const posterEmail = clean(request.headers.get('X-Poster-Email'), 160);
        if (!posterEmail || norm(posterEmail) !== norm(job.recipientEmail)) {
          return json(origin, { ok: false, error: 'Poster email does not match this post.' }, 403);
        }
        const ctype = request.headers.get('Content-Type') || '';
        if (!ctype.startsWith('image/png')) {
          return json(origin, { ok: false, error: 'Share image must be a PNG.' }, 415);
        }
        const buf = await request.arrayBuffer();
        if (!buf || buf.byteLength === 0 || buf.byteLength > 3 * 1024 * 1024) {
          return json(origin, { ok: false, error: 'Share image is empty or too large (max 3 MB).' }, 413);
        }
        await env.JOBS_KV.put(`shareimg:${id}`, buf);
        return json(origin, { ok: true, id });
      }
      const sharePngMatch = url.pathname.match(/^\/jobs\/(KZ-\d+)\/share\.png$/);
      if (sharePngMatch && request.method === 'GET') {
        const buf = await env.JOBS_KV.get(`shareimg:${sharePngMatch[1]}`, 'arrayBuffer');
        if (!buf) return json(origin, { ok: false, error: 'No share image for this job yet.' }, 404);
        return new Response(buf, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600',
            ...corsHeaders(origin),
          },
        });
      }

      // ---------- Share landing page with Open Graph card tags (v5) ----------
      const sharePageMatch = url.pathname.match(/^\/s\/(KZ-\d+)$/);
      if (sharePageMatch && request.method === 'GET') {
        const id = sharePageMatch[1];
        const jobs = await getStoredJobs(env);
        const job = jobs.find(j => j.id === id) || SEEDED_JOBS.find(j => j.id === id);
        if (!job) return new Response('Job not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
        const jobUrl = `https://www.kenniszone.online/?job=${encodeURIComponent(id)}`;
        const imgUrl = `${url.origin}/jobs/${encodeURIComponent(id)}/share.png`;
        const title = `${job.title} — ${job.company}`;
        const desc = `${job.city} • ${job.salary} • Last date to apply: ${job.lastDateToApply || 'Open until filled'}. Apply online via the Kennis Zone verified portal.`;
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} | Kennis Zone</title>
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Kennis Zone" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(desc)}" />
<meta property="og:image" content="${escapeHtml(imgUrl)}" />
<meta property="og:url" content="${escapeHtml(jobUrl)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta http-equiv="refresh" content="0; url=${escapeHtml(jobUrl)}" />
</head>
<body>
<p>Opening this job on the Kennis Zone portal… <a href="${escapeHtml(jobUrl)}">Tap here if it does not open automatically.</a></p>
<script>window.location.replace(${JSON.stringify(jobUrl)});</script>
</body>
</html>`;
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
        });
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
