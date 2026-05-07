// src/lib/email-templates/password-changed.js
//
// Confirmation email sent after a successful password reset. Helps the
// user notice if someone else changed their password without them knowing.

function passwordChangedEmail({ firstName, ipAddress, userAgent, when }) {
  const subject = 'Your Klassrun password was changed';

  const formattedDate = when.toLocaleString('en-NG', {
    dateStyle: 'full',
    timeStyle: 'short',
  });

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
              <p style="margin:8px 0 0 0; font-size:14px; opacity:0.9;">Security notification</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px 0; font-size:22px;">Your password was changed</h2>
              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                Hi ${firstName},
              </p>
              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                We're letting you know that your Klassrun password was successfully changed.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0; background:#f9fafb; border-radius:8px; padding:16px;">
                <tr>
                  <td style="padding:16px;">
                    <p style="margin:0 0 8px 0; font-size:14px; color:#666;"><strong>When:</strong> ${formattedDate}</p>
                    ${ipAddress ? `<p style="margin:0 0 8px 0; font-size:14px; color:#666;"><strong>IP address:</strong> ${ipAddress}</p>` : ''}
                    ${userAgent ? `<p style="margin:0; font-size:14px; color:#666;"><strong>Device:</strong> ${userAgent}</p>` : ''}
                  </td>
                </tr>
              </table>

              <div style="background:#fef3c7; border-left:4px solid #f59e0b; padding:16px; margin:24px 0; border-radius:4px;">
                <p style="margin:0; font-size:14px; line-height:1.6; color:#78350f;">
                  <strong>Wasn't you?</strong> Someone may have access to your account.
                  Contact us right away at
                  <a href="mailto:info@klassrun.com" style="color:#3DB54A;">info@klassrun.com</a>
                  so we can help you secure it.
                </p>
              </div>
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

module.exports = { passwordChangedEmail };
