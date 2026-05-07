// src/lib/email-templates/password-reset.js
//
// Email sent when a user requests a password reset. Contains a one-time
// link that expires in 1 hour.

function passwordResetEmail({ firstName, resetUrl, expiresInMinutes = 60 }) {
  const subject = 'Reset your Klassrun password';

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
              <p style="margin:8px 0 0 0; font-size:14px; opacity:0.9;">Password reset request</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px 0; font-size:22px; color:#1A2332;">Hi ${firstName},</h2>
              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                We received a request to reset your Klassrun password. Click the button below to choose a new one.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#3DB54A; border-radius:8px;">
                    <a href="${resetUrl}" style="display:inline-block; padding:14px 32px; color:#ffffff; text-decoration:none; font-weight:600; font-size:16px;">
                      Reset my password
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px 0; font-size:14px; line-height:1.6; color:#666;">
                This link expires in <strong>${expiresInMinutes} minutes</strong> and can only be used once.
              </p>

              <p style="margin:24px 0 0 0; font-size:14px; line-height:1.6; color:#666; padding-top:16px; border-top:1px solid #eee;">
                <strong>Didn't request this?</strong> You can safely ignore this email — your password won't change. If you're worried someone else is trying to access your account, please contact us immediately at
                <a href="mailto:info@klassrun.com" style="color:#3DB54A; text-decoration:none;">info@klassrun.com</a>.
              </p>

              <p style="margin:16px 0 0 0; font-size:12px; line-height:1.6; color:#999;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <span style="word-break:break-all; color:#3DB54A;">${resetUrl}</span>
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

module.exports = { passwordResetEmail };
