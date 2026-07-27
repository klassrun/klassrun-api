// src/lib/email-templates/billing-reminder.js
// phaseb1-reminder-template
//
// One template, five kinds. Copy is deliberately plain and non-alarming:
// these go to principals, and a payment reminder that reads like a threat
// costs more goodwill than the naira it recovers.

const COPY = {
  'trial-ends-2d': {
    subject: 'Your Klassrun free trial ends in 2 days',
    heading: 'Two days left on your trial',
    body: 'Your free trial of Klassrun ends in two days. Subscribe before then and nothing changes - your lesson notes, schemes and question bank stay exactly where they are.',
    note: 'When a trial ends, your school keeps read access to everything it has created. Creating new content resumes as soon as you subscribe.',
    cta: 'Choose a plan',
  },
  'renewal-2d': {
    subject: 'Your Klassrun subscription renews in 2 days',
    heading: 'Your subscription ends in 2 days',
    body: 'Your current Klassrun month ends in two days. Renew any time before then and the days you have left are added on top - you never lose paid time.',
    note: 'If it lapses, you get a 3-day grace period before the account becomes view-only.',
    cta: 'Renew now',
  },
  'grace-1': {
    subject: 'Klassrun: your subscription has lapsed (day 1 of 3)',
    heading: 'Your subscription has lapsed',
    body: 'Your Klassrun subscription ended. You are in a 3-day grace period - this is day 1 of 3, and everything still works normally.',
    note: 'After day 3 the account becomes view-only: your work stays safe and readable, but new content pauses until you renew.',
    cta: 'Renew now',
  },
  'grace-2': {
    subject: 'Klassrun: 2 days of grace left',
    heading: 'Day 2 of 3',
    body: 'Your Klassrun subscription ended and you are on day 2 of the 3-day grace period. Everything still works today.',
    note: 'After tomorrow the account becomes view-only until you renew. Nothing is deleted.',
    cta: 'Renew now',
  },
  'grace-3': {
    subject: 'Klassrun: last day of grace',
    heading: 'Last day of grace',
    body: 'This is the final day of your 3-day grace period. Renew today to keep creating lesson notes, schemes and exam questions without interruption.',
    note: 'From tomorrow the account is view-only. Every note, scheme and question you have made stays safe and readable, and renewing restores everything instantly.',
    cta: 'Renew now',
  },
};

function billingReminderEmail({ kind, schoolName, planLabel, dateLabel, billingUrl }) {
  const c = COPY[kind];
  if (!c) return null;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${c.subject}</title>
</head>
<body style="margin:0; padding:0; background:#f5f5f5; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#1A2332;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f5; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff; border-radius:12px; max-width:600px; overflow:hidden;">

          <tr>
            <td style="background:#3DB54A; padding:32px 40px; color:#ffffff;">
              <h1 style="margin:0; font-size:24px; font-weight:700;">Klassrun</h1>
              <p style="margin:8px 0 0 0; font-size:14px; opacity:0.9;">Billing</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px 0; font-size:22px;">${c.heading}</h2>
              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                Hello ${schoolName},
              </p>
              <p style="margin:0 0 24px 0; font-size:16px; line-height:1.6; color:#444;">
                ${c.body}
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="padding:10px 0; font-size:14px; color:#6b7280; border-bottom:1px solid #f0f0f0;">Plan</td>
                  <td style="padding:10px 0; font-size:14px; color:#1A2332; font-weight:600; text-align:right; border-bottom:1px solid #f0f0f0;">${planLabel}</td>
                </tr>
                <tr>
                  <td style="padding:10px 0; font-size:14px; color:#6b7280; border-bottom:1px solid #f0f0f0;">Date</td>
                  <td style="padding:10px 0; font-size:14px; color:#1A2332; font-weight:600; text-align:right; border-bottom:1px solid #f0f0f0;">${dateLabel}</td>
                </tr>
              </table>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px 0;">
                <tr>
                  <td style="background:#3DB54A; border-radius:8px;">
                    <a href="${billingUrl}" style="display:inline-block; padding:14px 32px; color:#ffffff; text-decoration:none; font-weight:600; font-size:16px;">
                      ${c.cta}
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0; font-size:13px; line-height:1.6; color:#999; padding-top:16px; border-top:1px solid #eee;">
                ${c.note}
              </p>
            </td>
          </tr>

          <tr>
            <td style="background:#f9fafb; padding:24px 40px; border-top:1px solid #e5e7eb; font-size:13px; color:#6b7280;">
              <p style="margin:0; color:#9ca3af; font-size:12px;">
                Klassrun Technologies Ltd &middot; RC 9463863 &middot; Lagos, Nigeria
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject: c.subject, html };
}

module.exports = { billingReminderEmail, REMINDER_KINDS: Object.keys(COPY) };
