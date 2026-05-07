// src/lib/email-templates/teacher-revoked.js
//
// Email sent when school admin revokes a teacher's access.

function teacherRevokedEmail({ firstName, schoolName }) {
  const subject = `Your access to ${schoolName} on Klassrun has been revoked`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${subject}</title>
</head>
<body style="margin:0; padding:0; background:#f5f5f5; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#1A2332;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f5f5; padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff; border-radius:12px; max-width:600px; overflow:hidden;">

          <tr>
            <td style="background:#1A2332; padding:32px 40px; color:#ffffff;">
              <h1 style="margin:0; font-size:24px; font-weight:700;">Klassrun</h1>
            </td>
          </tr>

          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px 0; font-size:22px;">Hi ${firstName},</h2>
              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                Your access to <strong>${schoolName}</strong> on Klassrun has been revoked by the school administrator.
              </p>
              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                This means you can no longer log in to view or generate content for this school.
              </p>
              <p style="margin:24px 0 0 0; font-size:14px; line-height:1.6; color:#666; padding-top:16px; border-top:1px solid #eee;">
                If you believe this was a mistake, please contact your school administrator directly.
              </p>
            </td>
          </tr>

          <tr>
            <td style="background:#f9fafb; padding:24px 40px; border-top:1px solid #e5e7eb; font-size:13px; color:#6b7280;">
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

module.exports = { teacherRevokedEmail };
