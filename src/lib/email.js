// src/lib/email.js
//
// Email service wrapper. Sends transactional emails (signup welcome,
// teacher invites, password resets) via Resend.
//
// STUB MODE: If RESEND_API_KEY is not set, emails are logged to the console
// instead of being sent. This lets developers run the API locally without
// needing real email credentials. In production, RESEND_API_KEY must be set
// — the module logs a startup warning if it isn't.

const { Resend } = require('resend');

const FROM_ADDRESS = process.env.EMAIL_FROM || 'Klassrun <info@klassrun.com>';
const REPLY_TO     = process.env.EMAIL_REPLY_TO || 'info@klassrun.com';
const RESEND_KEY   = process.env.RESEND_API_KEY;

// Initialise client only if we have a key. Otherwise we go into stub mode.
let resend = null;
if (RESEND_KEY) {
  resend = new Resend(RESEND_KEY);
} else if (process.env.NODE_ENV === 'production') {
  // Production should never run without a real provider — loud warning.
  console.error('⚠️  RESEND_API_KEY is not set in production. Emails will NOT be sent.');
} else {
  console.log('✉️  Email service in STUB MODE — emails will be logged, not sent. Set RESEND_API_KEY to enable real sending.');
}

/**
 * Send an email via Resend (or log it to the console in stub mode).
 *
 * @param {Object} opts
 * @param {string} opts.to       — recipient email address
 * @param {string} opts.subject  — email subject line
 * @param {string} opts.html     — HTML body
 * @param {string} [opts.text]   — plain text body (auto-generated if omitted)
 * @param {string} [opts.replyTo] — overrides default reply-to
 *
 * @returns {Promise<{ id: string|null, stubbed: boolean }>}
 */
async function send({ to, subject, html, text, replyTo }) {
  if (!to || !subject || !html) {
    throw new Error('email.send requires to, subject, and html');
  }

  // Auto-derive a plain-text version if none provided
  const plainText = text || htmlToPlainText(html);

  if (!resend) {
    // Stub mode — write to console so devs can see what would have been sent
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✉️  STUB EMAIL`);
    console.log(`   From:    ${FROM_ADDRESS}`);
    console.log(`   To:      ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Body:`);
    console.log(plainText.split('\n').map((line) => `   │ ${line}`).join('\n'));
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return { id: null, stubbed: true };
  }

  try {
    const result = await resend.emails.send({
      from:    FROM_ADDRESS,
      to,
      subject,
      html,
      text:    plainText,
      replyTo: replyTo || REPLY_TO,
    });

    if (result.error) {
      throw new Error(`Resend error: ${result.error.message || JSON.stringify(result.error)}`);
    }

    return { id: result.data?.id ?? null, stubbed: false };
  } catch (err) {
    // Don't throw — email failures should not break the user-facing request.
    // Log loudly and return a sentinel so callers can choose to retry.
    console.error('✗ Email send failed:', err.message);
    return { id: null, stubbed: false, error: err.message };
  }
}

/**
 * Crude HTML → plain text converter for fallback bodies.
 * Replace anchors with "text (url)" so links remain readable.
 */
function htmlToPlainText(html) {
  return html
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

module.exports = { send, FROM_ADDRESS, REPLY_TO };
