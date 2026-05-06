// src/lib/email-templates/welcome.js
//
// Email sent immediately after a school signs up. Confirms the account,
// celebrates them onboarding, and tells them how to find their portal.

function welcomeEmail({ firstName, schoolName, portalUrl, trialEndsAt }) {
  const trialDate = new Date(trialEndsAt).toLocaleDateString('en-NG', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const subject = `Welcome to Klassrun, ${firstName}!`;

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
          <!-- Header with brand color -->
          <tr>
            <td style="background:#3DB54A; padding:32px 40px; color:#ffffff;">
              <h1 style="margin:0; font-size:24px; font-weight:700;">Klassrun</h1>
              <p style="margin:8px 0 0 0; font-size:14px; opacity:0.9;">The school operating system for Nigerian schools</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 16px 0; font-size:22px; color:#1A2332;">Welcome aboard, ${firstName} 👋</h2>
              <p style="margin:0 0 16px 0; font-size:16px; line-height:1.6; color:#444;">
                <strong>${schoolName}</strong> is now set up on Klassrun. Your 14-day free trial has started — no card required.
              </p>
              <p style="margin:0 0 24px 0; font-size:16px; line-height:1.6; color:#444;">
                Here's what to do first:
              </p>

              <ol style="margin:0 0 24px 0; padding-left:20px; font-size:16px; line-height:1.8; color:#444;">
                <li>Add your classes (JSS 1, SS 2, etc.)</li>
                <li>Invite your first teacher</li>
                <li>Generate your first AI lesson note</li>
              </ol>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#3DB54A; border-radius:8px;">
                    <a href="${portalUrl}" style="display:inline-block; padding:14px 32px; color:#ffffff; text-decoration:none; font-weight:600; font-size:16px;">
                      Open your dashboard →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0 0; font-size:14px; line-height:1.6; color:#666;">
                Your trial ends on <strong>${trialDate}</strong>. We'll remind you a few days before — no surprise charges.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f9fafb; padding:24px 40px; border-top:1px solid #e5e7eb; font-size:13px; color:#6b7280;">
              <p style="margin:0 0 8px 0;">
                Need help? Reply to this email or message us at
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

module.exports = { welcomeEmail };
