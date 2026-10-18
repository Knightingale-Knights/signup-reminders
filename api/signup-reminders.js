// Daily sign-up reminder agent for Knightingale carers.
// Runs via Vercel cron. Sends only when it is 10am in Melbourne (unless ?force=1).
// Manual test: /api/signup-reminders?secret=CRON_SECRET&dry=1&force=1

const TZ = 'Australia/Melbourne';
const BASE = process.env.BUBBLE_BASE || 'https://knightingale.com.au/api/1.1';
const FROM_EMAIL = 'care@knightingale.com.au';
const FROM_NAME = process.env.FROM_NAME || 'Paul at Knightingale';

const SUBJECT_1 = process.env.SUBJECT_1 || 'Finishing your Knightingale application';
const SUBJECT_2 = process.env.SUBJECT_2 || 'Next step: your application video';

function email1(first) {
  return `Good morning ${first},

Hope you're having a nice morning.

I noticed you started applying for a role but haven't finished uploading your documents. Please let me know if there's anything I can do to help. I'd love the opportunity to hire you 🙂

Have a great day!

Paul`;
}

function email2(first, last) {
  return `Good morning ${first},

Thank you for uploading your documentation. Before we can move you forward in the hiring process, we need to review your application video. When you have time, please:

• Record yourself answering the four questions below.
• Use WeTransfer to email your recording to; care@knightingale.com.au.
• Title it "${first} ${last} Application Video"

Quick Tip: Don’t read a written script. Instead, talk spontaneously as you would to a friend. Reading a written script works against your application and doesn’t convey good communication skills.

1. Tell us about you. Your life, your experience. Why did you choose a care profession and why are you the best candidate for this role?

2. Have you made a mistake at work? Describe what happened and what you did next?

3. What is something you think the care sector gets wrong? What would you do to change it? (Don't include an answer discussing task focus or task orientation, everyone knows that. Be creative.)

4. Why did you decide to work with Knightingale specifically?

All my best.

Paul`;
}

// ---------- Time helpers ----------
function melbParts(date) {
  const f = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  const m = (o.timeZoneName || '').match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const off = m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10)) : 0;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, off };
}

function melbMidnight(y, mo, d) {
  const n = new Date(Date.UTC(y, mo - 1, d));
  const guess = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  const off = melbParts(new Date(guess - 12 * 3600000)).off;
  return new Date(guess - off * 60000);
}

// ---------- Bubble ----------
async function bubbleGet(path, params = {}) {
  const url = new URL(`${BASE}/obj/${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const r = await fetch(url, { headers: { Authorization: `Bearer ${process.env.BUBBLE_API_TOKEN}` } });
  if (!r.ok) throw new Error(`Bubble ${path} ${r.status}: ${await r.text()}`);
  return (await r.json()).response;
}

async function bubbleSearch(type, constraints) {
  const out = [];
  let cursor = 0;
  while (true) {
    const res = await bubbleGet(type, { constraints, cursor: String(cursor), limit: '100' });
    out.push(...res.results);
    if (!res.remaining) break;
    cursor += res.results.length;
  }
  return out;
}

const accountCache = new Map();
async function isCarer(v) {
  if (!v || typeof v !== 'string') return false;
  if (v.toLowerCase() === 'carer') return true;
  if (/^\d+x\d+$/.test(v)) {
    if (!accountCache.has(v)) {
      let ok = false;
      try {
        const obj = await bubbleGet(`account/${v}`);
        ok = Object.values(obj).some((x) => typeof x === 'string' && x.toLowerCase() === 'carer');
      } catch (e) { /* treat as not carer */ }
      accountCache.set(v, ok);
    }
    return accountCache.get(v);
  }
  return false;
}

async function hasShift(userId) {
  const res = await bubbleGet('shift', {
    constraints: [{ key: 'carer', constraint_type: 'equals', value: userId }],
    limit: '1',
  });
  return res.results.length > 0;
}

// ---------- Gmail ----------
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function gmailToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gmail token: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function sendEmail(token, to, subject, body) {
  const mime = [
    `From: =?UTF-8?B?${b64(FROM_NAME)}?= <${FROM_EMAIL}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(body).replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(mime, 'utf8').toString('base64url') }),
  });
  if (!r.ok) throw new Error(`Gmail send ${r.status}: ${await r.text()}`);
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  const q = req.query || {};
  const secret = process.env.CRON_SECRET;
  if (!secret || (req.headers.authorization !== `Bearer ${secret}` && q.secret !== secret)) {
    return res.status(401).json({ error: 'unauthorised' });
  }
  const dry = q.dry === '1';
  const force = q.force === '1';

  const now = melbParts(new Date());
  if (!force && now.h !== 10) {
    return res.status(200).json({ skipped: true, melbourneHour: now.h });
  }

  try {
    const start = melbMidnight(now.y, now.mo, now.d - 7);
    const end = melbMidnight(now.y, now.mo, now.d - 6);

    const users = await bubbleSearch('user', [
      { key: 'Created Date', constraint_type: 'greater than', value: new Date(start.getTime() - 1).toISOString() },
      { key: 'Created Date', constraint_type: 'less than', value: end.toISOString() },
      { key: 'account status', constraint_type: 'not equal', value: true },
    ]);

    const toSend = [];
    for (const u of users) {
      if (!(await isCarer(u['account type']))) continue;
      const to = (u.authentication && u.authentication.email && u.authentication.email.email) || u.email;
      if (!to) continue;
      const first = (u['first name'] || '').trim() || 'there';
      const last = (u['last name'] || '').trim();

      if (!u['profile photo']) {
        toSend.push({ id: u._id, to, type: 1, subject: SUBJECT_1, body: email1(first) });
      } else if (!(await hasShift(u._id))) {
        toSend.push({ id: u._id, to, type: 2, subject: SUBJECT_2, body: email2(first, last) });
      }
    }

    const results = [];
    const token = dry || !toSend.length ? null : await gmailToken();
    for (const m of toSend) {
      try {
        if (!dry) await sendEmail(token, m.to, m.subject, m.body);
        results.push({ id: m.id, to: m.to, email: m.type, status: dry ? 'dry-run' : 'sent' });
      } catch (e) {
        results.push({ id: m.id, to: m.to, email: m.type, status: 'error', error: e.message });
      }
    }

    console.log(JSON.stringify({ window: [start, end], checked: users.length, results }));
    return res.status(200).json({ window: { start, end }, checked: users.length, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
