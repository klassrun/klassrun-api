// src/lib/email-templates/invite.js
//
// Email sent to a teacher when their school's admin invites them.
// The link in this email contains a one-time token that expires in 7 days.

function inviteEmail({ teacherFirstName, schoolName, inviterName, inviteUrl, expiresAt }) {
  const expiryDate = new Date(expiresAt).toLocaleDateString('en-NG', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const subject = `${inviterName} invited you to join ${schoolName} on Klassrun`;

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
              <p style="margin:8px 0 0 0; font-size:14px; opacity:0.9;">The school operating system for Nigerian schools</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px 0; font-size:22px; color:#1A2332;">You're invited, ${teacherFirstName}</h2>

              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                <strong>${inviterName}</strong> from <strong>${schoolName}</strong> has invited you to join their school on Klassrun.
              </p>

              <p style="margin:0 0 24px 0; font-size:16px; line-height:1.6; color:#444;">
                Klassrun helps you generate curriculum-aligned lesson notes, schemes of work, and WAEC/NECO-style exam questions in seconds. No more late-night planning.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#3DB54A; border-radius:8px;">
                    <a href="${inviteUrl}" style="display:inline-block; padding:14px 32px; color:#ffffff; text-decoration:none; font-weight:600; font-size:16px;">
                      Accept invite & set password →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0; font-size:14px; line-height:1.6; color:#666;">
                This invite link is for <strong>your eyes only</strong> — it can only be used once and expires on <strong>${expiryDate}</strong>.
              </p>

              <p style="margin:16px 0 0 0; font-size:13px; line-height:1.6; color:#9ca3af;">
                If you weren't expecting this invitation, you can safely ignore this email. If you think this is a mistake, please reply to this email so we can investigate.
              </p>
            </td>
          </tr>

          <tr>
            <td style="background:#f9fafb; padding:24px 40px; border-top:1px solid #e5e7eb; font-size:13px; color:#6b7280;">
              <p style="margin:0 0 8px 0;">
                Questions? Email us at
                <a href="mailto:info@klassrun.com" style="color:#3DB54A; text-decoration:none;">info@klassrun.com</a>.
              </p>
              <p style="margin:0; color:#9ca3af; font-size:12px;">
                Klassrun Technologies Ltd · RC 9463863 · Lagos, Nigeria
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

module.exports = { inviteEmail };
