// src/lib/email-templates/invite.js
//
// Email sent when a school admin invites a teacher, OR when a school admin
// resets a teacher's password (which generates a new invite link).

function inviteEmail({ firstName, schoolName, inviteUrl, expiresAt, isReset = false }) {
  const expiresDate = new Date(expiresAt).toLocaleDateString('en-NG', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });

  const subject = isReset
    ? `Set a new password for your ${schoolName} Klassrun account`
    : `You're invited to join ${schoolName} on Klassrun`;

  const heading = isReset ? 'Set your new password' : `Welcome to ${schoolName}`;

  const body = isReset
    ? `Your school administrator at <strong>${schoolName}</strong> has reset your password. Click the button below to choose a new one and regain access to Klassrun.`
    : `You've been invited to join <strong>${schoolName}</strong> on Klassrun — the school operating system that helps teachers automate lesson notes, exam questions, and schemes of work. Click the button below to set up your account.`;

  const buttonText = isReset ? 'Set new password' : 'Set up my account';

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
              <p style="margin:8px 0 0 0; font-size:14px; opacity:0.9;">${isReset ? 'Password reset' : 'Teacher invitation'}</p>
            </td>
          </tr>

          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px 0; font-size:22px;">${heading}</h2>
              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                Hi ${firstName},
              </p>
              <p style="margin:0 0 24px 0; font-size:16px; line-height:1.6; color:#444;">
                ${body}
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#3DB54A; border-radius:8px;">
                    <a href="${inviteUrl}" style="display:inline-block; padding:14px 32px; color:#ffffff; text-decoration:none; font-weight:600; font-size:16px;">
                      ${buttonText} →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px 0; font-size:14px; line-height:1.6; color:#666;">
                This link expires on <strong>${expiresDate}</strong>.
              </p>

              <p style="margin:24px 0 0 0; font-size:13px; line-height:1.6; color:#999; padding-top:16px; border-top:1px solid #eee;">
                If the button doesn't work, copy and paste this link into your browser:<br>
                <span style="word-break:break-all; color:#3DB54A;">${inviteUrl}</span>
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

module.exports = { inviteEmail };
