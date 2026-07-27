// src/lib/email-templates/receipt.js
// phaseb1-receipt-template
//
// Sent on every successful activation (Paystack charge OR a super-admin
// manual extension). The Terms of Service promise the school a billing
// record for every payment - this is that record.

function receiptEmail({ schoolName, plan, amountNaira, reference, endDate, manual = false }) {
  const planLabel = String(plan || '').charAt(0).toUpperCase() + String(plan || '').slice(1);

  const endLabel = new Date(endDate).toLocaleDateString('en-NG', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const subject = manual
    ? `Your Klassrun subscription has been extended`
    : `Payment received - your Klassrun ${planLabel} plan is active`;

  const heading = manual ? 'Subscription extended' : 'Payment received';

  const intro = manual
    ? `We have extended <strong>${schoolName}</strong>'s Klassrun subscription. Here are the details for your records.`
    : `Thank you. We have received your payment for <strong>${schoolName}</strong>. Your Klassrun subscription is active and this email is your receipt.`;

  const rows = [
    ['School', schoolName],
    ['Plan', planLabel],
    ['Amount', amountNaira],
    ['Reference', reference],
    ['Active until', endLabel],
  ];

  const rowsHtml = rows.map(function (r) {
    return `<tr>
                  <td style="padding:10px 0; font-size:14px; color:#6b7280; border-bottom:1px solid #f0f0f0;">${r[0]}</td>
                  <td style="padding:10px 0; font-size:14px; color:#1A2332; font-weight:600; text-align:right; border-bottom:1px solid #f0f0f0;">${r[1]}</td>
                </tr>`;
  }).join('\n                ');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${subject}</title>
</head>
<body style="margin:0; padding:0; background:#f5f5f5; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#1A2332;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f5; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff; border-radius:12px; max-width:600px; overflow:hidden;">

          <tr>
            <td style="background:#3DB54A; padding:32px 40px; color:#ffffff;">
              <h1 style="margin:0; font-size:24px; font-weight:700;">Klassrun</h1>
              <p style="margin:8px 0 0 0; font-size:14px; opacity:0.9;">Billing receipt</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px 0; font-size:22px;">${heading}</h2>
              <p style="margin:0 0 24px 0; font-size:16px; line-height:1.6; color:#444;">
                ${intro}
              </p>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px 0;">
                ${rowsHtml}
              </table>

              <p style="margin:0 0 16px 0; font-size:14px; line-height:1.6; color:#666;">
                Your subscription runs until <strong>${endLabel}</strong>. Renew any time before then and the days you have left are added on top - you never lose paid time.
              </p>

              <p style="margin:24px 0 0 0; font-size:13px; line-height:1.6; color:#999; padding-top:16px; border-top:1px solid #eee;">
                Keep this email for your records. If anything here looks wrong, reply to this message and we will sort it out.
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

  return { subject, html };
}

module.exports = { receiptEmail };
