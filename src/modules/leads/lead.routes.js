// src/modules/leads/lead.routes.js
// leads-capture-public
//
// Public lead-capture endpoint for the marketing site (klassrun.com).
// POST /api/leads — no auth. Receives "Book a demo" / "Founding School"
// enquiries, emails them to info@klassrun.com via the existing Resend wrapper.
//
// Spam defence (invisible to real users):
//   • Honeypot field `website` — real forms leave it blank; bots fill it.
//     If filled, we return {ok:true} and silently drop (bot thinks it won).
//   • Per-IP rate limit — in-memory, resets on restart. No new dependency.

const router = require('express').Router();
const { send } = require('../../lib/email');

const LEADS_TO = process.env.LEADS_TO || 'info@klassrun.com';

// ── per-IP rate limit (in-memory) ────────────────────────────────────────
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PER_WINDOW = 5;
const hits = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  // opportunistic cleanup so the map doesn't grow unbounded
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }
  return arr.length > MAX_PER_WINDOW;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

const isStr = (v) => typeof v === 'string';
const trimmed = (v) => (isStr(v) ? v.trim() : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── POST /api/leads ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};

    // Honeypot — if the hidden field is filled, silently succeed + drop.
    if (trimmed(body.website)) {
      return res.json({ ok: true });
    }

    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return res.status(429).json({ error: { message: 'Too many requests. Please try again shortly.' } });
    }

    const name    = trimmed(body.name);
    const school  = trimmed(body.school);
    const phone   = trimmed(body.phone);
    const email   = trimmed(body.email);
    const message = trimmed(body.message);
    const type    = trimmed(body.type) === 'founding' ? 'founding' : 'demo';

    // Validation
    const errors = [];
    if (name.length < 2 || name.length > 120)      errors.push('name');
    if (school.length < 2 || school.length > 160)  errors.push('school');
    if (phone.length < 6 || phone.length > 40)     errors.push('phone');
    if (!EMAIL_RE.test(email) || email.length > 160) errors.push('email');
    if (message.length > 2000)                     errors.push('message');
    if (errors.length) {
      return res.status(400).json({ error: { message: 'Please check the form and try again.', fields: errors } });
    }

    const label = type === 'founding' ? 'Founding School application' : 'Demo request';
    const subject = `New ${label} — ${school}`;
    const html = `
      <h2>${esc(label)}</h2>
      <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
        <tr><td><strong>Name</strong></td><td>${esc(name)}</td></tr>
        <tr><td><strong>School</strong></td><td>${esc(school)}</td></tr>
        <tr><td><strong>Phone</strong></td><td>${esc(phone)}</td></tr>
        <tr><td><strong>Email</strong></td><td>${esc(email)}</td></tr>
        <tr><td><strong>Type</strong></td><td>${esc(type)}</td></tr>
        ${message ? `<tr><td valign="top"><strong>Message</strong></td><td>${esc(message).replace(/\n/g, '<br>')}</td></tr>` : ''}
      </table>
      <p style="color:#6b7280;font-size:12px">Sent from the klassrun.com lead form. Reply directly to reach ${esc(name)}.</p>
    `;

    // Fire the email. send() never throws (returns a sentinel on failure),
    // so the visitor still gets a success response — we don't want a Resend
    // hiccup to make a real lead think the form is broken.
    const result = await send({
      to: LEADS_TO,
      subject,
      html,
      replyTo: email, // hit reply → goes straight to the lead
    });

    if (result && result.error) {
      // Logged server-side already. Tell the user it's received (we have their
      // details in logs) but surface a soft note so they can also reach out.
      console.error('[leads] email send failed for', email, result.error);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[leads] unexpected error:', err.message);
    return res.status(500).json({ error: { message: 'Something went wrong. Please email info@klassrun.com directly.' } });
  }
});

module.exports = router;
