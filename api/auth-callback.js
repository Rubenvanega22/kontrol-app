// /api/auth-callback.js
// Recibe el código OAuth de Google/Microsoft y guarda tokens

const { google } = require('googleapis');
const supabase = require('../lib/supabase');

module.exports = async function handler(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect('/?auth_error=' + encodeURIComponent(error));
  }

  try {
    if (state === 'gmail' || !state || state.startsWith('gmail')) {
      // Gmail OAuth
      const oauth2Client = new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI
      );

      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      // Obtener email del usuario
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data: userInfo } = await oauth2.userinfo.get();
      const email = userInfo.email;

      // Guardar en Supabase
      await supabase.from('email_accounts').upsert({
        email,
        tipo: 'gmail',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        activo: true
      }, { onConflict: 'email' });

      return res.redirect('/?auth_success=gmail&email=' + encodeURIComponent(email));

    } else if (state === 'outlook') {
      // Outlook OAuth
      const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.OUTLOOK_CLIENT_ID,
          client_secret: process.env.OUTLOOK_CLIENT_SECRET,
          code,
          redirect_uri: process.env.OUTLOOK_REDIRECT_URI,
          grant_type: 'authorization_code'
        })
      });
      const tokens = await tokenRes.json();

      // Obtener email del usuario
      const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const profile = await profileRes.json();
      const email = profile.mail || profile.userPrincipalName;

      await supabase.from('email_accounts').upsert({
        email,
        tipo: 'outlook',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expiry: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        activo: true
      }, { onConflict: 'email' });

      return res.redirect('/?auth_success=outlook&email=' + encodeURIComponent(email));
    }
  } catch (err) {
    console.error('Auth callback error:', err);
    return res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
};
